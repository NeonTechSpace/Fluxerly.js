/**
 * Draining shutdown: Stop event intake and new scheduled task runs, then let running handlers, waiting handler events,
 * running scheduled tasks and REST requests finish until a deadline, before shutdown cancels the rest.
 * Invariant: The drain only waits. It never cancels work itself, so the ordinary shutdown that follows cancels whatever
 * is left, and a drain that ends early changes nothing but the time shutdown starts. Waiting follows progress signals,
 * so an idle client ends the drain at once. Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import type * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { ConfigurationError } from "#sdk/errors"
import { record } from "../decode/primitives.js"
import type { EventBus } from "../events.js"
import type { ClientLogger } from "../logging.js"
import type { ScheduledTasks } from "../scheduled-tasks.js"
import { unsupportedKeyHint } from "../suggest.js"
import { formatDuration } from "./lifetime.js"

/** Longest drain, the longest single timer delay */
const maximumDrainMs = 2_147_483_647

/**
 * Read the drain time from shutdown options, 0 when omitted. Misuse returns ConfigurationError without the rejected value.
 * Reading the options is application input, so the caller runs this under a defect boundary
 */
export function shutdownDrainMs(options: unknown): number | ConfigurationError {
    if (options === undefined) return 0
    if (!record(options)) return new ConfigurationError("configuration", "Shutdown options must be an object")
    const unsupported = Object.keys(options).find((key) => key !== "drainMs")
    if (unsupported !== undefined)
        return new ConfigurationError("configuration", `Unsupported shutdown option ${JSON.stringify(unsupported)}`, {
            hint: unsupportedKeyHint(unsupported, ["drainMs"]),
        })
    const value = options.drainMs
    if (value === undefined) return 0
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximumDrainMs)
        return new ConfigurationError(
            "drainMs",
            'The option "drainMs" must be an integer from 0 through 2,147,483,647 milliseconds',
        )
    return value
}

/** Work a drain waits for */
interface DrainWork {
    readonly running: number
    readonly waiting: number
    readonly tasks: number
    readonly requests: number
}

function plural(count: number, one: string, many: string) {
    return `${count} ${count === 1 ? one : many}`
}

function describeWork(work: DrainWork): string {
    const parts = [
        ...(work.running ? [plural(work.running, "running handler", "running handlers")] : []),
        ...(work.waiting ? [plural(work.waiting, "waiting event", "waiting events")] : []),
        ...(work.tasks ? [plural(work.tasks, "running scheduled task", "running scheduled tasks")] : []),
        ...(work.requests ? [plural(work.requests, "REST request", "REST requests")] : []),
    ]
    return parts.length < 2 ? (parts[0] ?? "no work") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
}

/**
 * Seal the event bus and scheduled tasks, then wait until no handler or task is running, no event is waiting and no REST
 * request is in flight, or until drainMs passes. Logs the start and the result. Runs with the caller's Clock and never fails
 */
export function drainWork(options: {
    readonly events: Pick<EventBus, "seal" | "drainState" | "progress">
    readonly tasks: Pick<ScheduledTasks, "seal" | "running" | "progress">
    /** Completion signals of the REST operations in flight now */
    readonly requests: () => readonly Deferred.Deferred<void>[]
    readonly logging: ClientLogger
    readonly drainMs: number
    readonly context: Context.Context<never>
}): Effect.Effect<void> {
    const { events, tasks, requests, logging, drainMs, context } = options
    return Effect.suspend(() => {
        events.seal()
        tasks.seal()
        const work = (): DrainWork => ({ ...events.drainState(), tasks: tasks.running, requests: requests().length })
        const initial = work()
        if (initial.running + initial.waiting + initial.tasks + initial.requests === 0) return Effect.void
        const startedAt = Date.now()
        logging.log(
            {
                level: "info",
                category: "lifecycle",
                code: "lifecycle.draining",
                message: `Shutting down after the current work: No new events are accepted, and ${describeWork(initial)} get up to ${formatDuration(drainMs)} to finish`,
                fields: { ...initial, drainMs },
            },
            context,
        )
        // Handlers and tasks can start REST requests and REST responses can let them finish, so check all of them until
        // none has work
        const settled = Effect.gen(function* () {
            while (true) {
                const { running, waiting } = events.drainState()
                if (running + waiting > 0) {
                    yield* events.progress()
                    continue
                }
                if (tasks.running > 0) {
                    yield* tasks.progress()
                    continue
                }
                const inFlight = requests()
                if (inFlight.length === 0) return
                yield* Effect.forEach(inFlight, (request) => Deferred.await(request), { discard: true })
            }
        })
        return settled.pipe(
            // Shutdown itself is uninterruptible, and the deadline must still be able to stop this wait
            Effect.interruptible,
            Effect.timeoutOption(drainMs),
            Effect.map((finished) => {
                const durationMs = Date.now() - startedAt
                if (Option.isSome(finished)) {
                    logging.log(
                        {
                            level: "info",
                            category: "lifecycle",
                            code: "lifecycle.drained",
                            message: `The current work finished in ${formatDuration(durationMs)}, so shutdown continues without cancelling any`,
                            durationMs,
                        },
                        context,
                    )
                    return
                }
                const left = work()
                logging.log(
                    {
                        level: "warn",
                        category: "lifecycle",
                        code: "lifecycle.drainTimedOut",
                        message: `The ${formatDuration(drainMs)} drain time (drainMs) ran out, so shutdown cancels ${describeWork(left)}`,
                        durationMs,
                        fields: { ...left, drainMs },
                    },
                    context,
                )
            }),
        )
    })
}
