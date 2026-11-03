/**
 * Scheduled tasks: Application work that client.schedule runs once or repeatedly within the client's lifetime.
 * Invariant: Every wait uses the client's logical scheduler, and each task runs in a fiber of its own, never in an event
 * handler or command slot. A failed run reaches the client failure reporter, and a repeating task keeps its schedule. A
 * draining shutdown starts no new run and waits for running ones, and shutdown interrupts the rest, awaits their cleanup
 * and records in one summary how many tasks it ended with a run waiting or in progress. Implements [SDK contracts: User-handler failures](/docs/SDK-CONTRACTS.md#user-handler-failures)
 */
import * as Cause from "effect/Cause"
import type * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import { ownCleanup } from "./cleanup-owner.js"
import { record } from "./decode/primitives.js"
import type { FailureReporter } from "./failures.js"
import type { LogicalScheduler } from "./logical-scheduler.js"
import type { ClientLogger } from "./logging.js"
import { CallbackRuns } from "./rejection-scope.js"
import { unsupportedKeyHint } from "./suggest.js"

/** Longest delay or interval, the longest single timer delay */
const maximumMs = 2_147_483_647
const optionKeys = ["delayMs", "intervalMs", "name"]
/** Longest task name, in UTF-16 code units */
const maximumNameLength = 100

/** When a task first runs, for a repeating task how long it waits after each run ends, and its name for failure reports */
export interface ScheduleTiming {
    readonly delayMs: number
    readonly intervalMs: number | undefined
    readonly name?: string | undefined
}

function milliseconds(value: unknown, minimum: number): boolean {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximumMs
}

/**
 * Read client.schedule options. Misuse returns ConfigurationError without the rejected value.
 * Reading the options is application input, so the caller runs this under a defect boundary
 */
export function scheduleTiming(options: unknown): ScheduleTiming | ConfigurationError {
    if (options === undefined) return { delayMs: 0, intervalMs: undefined, name: undefined }
    if (!record(options)) return new ConfigurationError("configuration", "Schedule options must be an object")
    const unsupported = Object.keys(options).find((key) => !optionKeys.includes(key))
    if (unsupported !== undefined)
        return new ConfigurationError("configuration", `Unsupported schedule option ${JSON.stringify(unsupported)}`, {
            hint: unsupportedKeyHint(unsupported, optionKeys),
        })
    const { delayMs, intervalMs, name } = options
    if (delayMs !== undefined && !milliseconds(delayMs, 0))
        return new ConfigurationError(
            "delayMs",
            'The option "delayMs" must be an integer from 0 through 2,147,483,647 milliseconds',
        )
    if (intervalMs !== undefined && !milliseconds(intervalMs, 1))
        return new ConfigurationError(
            "intervalMs",
            'The option "intervalMs" must be an integer from 1 through 2,147,483,647 milliseconds',
        )
    if (
        name !== undefined &&
        (typeof name !== "string" || name.length === 0 || name.length > maximumNameLength || /\p{Cc}/u.test(name))
    )
        return new ConfigurationError(
            "name",
            'The option "name" must be a string of 1 through 100 characters without control characters',
        )
    return {
        delayMs: (delayMs ?? intervalMs ?? 0) as number,
        intervalMs: intervalMs as number | undefined,
        name: name as string | undefined,
    }
}

/** The client's scheduled tasks. Each one is a fiber that waits on the logical scheduler and then runs its work */
export class ScheduledTasks {
    /** Each task's fiber, with whether the application closed it and whether a run is in progress */
    readonly #tasks = new Map<Fiber.Fiber<void>, { closed: boolean; running: boolean }>()
    /** Task runs in progress, which a draining shutdown waits for */
    #running = 0
    /** Released and replaced whenever a run ends, so a drain can wait for progress */
    #progress = Deferred.makeUnsafe<void>()
    /** Set when shutdown begins, draining or not: No task starts another run and no task can be added */
    #closing = false
    /** Tasks that ended during a draining shutdown with runs still to come, reported when the tasks stop */
    #ended = 0
    #stopped = false
    /** Defects of runs that shutdown interrupted, such as a failed resource release, which make shutdown fail */
    readonly #cleanupDefects: Cause.Reason<never>[] = []
    /** Default-API task runs in progress as callback runs, so a manual test clock can see which await an SDK call */
    readonly callbackRuns = new CallbackRuns()

    constructor(
        private readonly logical: LogicalScheduler,
        private readonly failures: FailureReporter,
        private readonly logging: ClientLogger,
    ) {}

    /** Task runs in progress */
    get running(): number {
        return this.#running
    }

    /** Wait until the next run ends */
    progress(): Effect.Effect<void> {
        return Effect.suspend(() => Deferred.await(this.#progress))
    }

    /** Whether the fiber runs a task, so a task that requests shutdown does not wait for itself */
    owns(fiberId: number): boolean {
        for (const fiber of this.#tasks.keys()) if (fiber.id === fiberId) return true
        return false
    }

    /**
     * Start a task in a fiber of its own with the given services. It first runs after timing.delayMs and, when it repeats,
     * again intervalMs after each run ends. Returns a close function that cancels later runs without interrupting a run
     * in progress. Throws ClientClosedError once shutdown has begun
     */
    start(run: Effect.Effect<unknown, unknown>, timing: ScheduleTiming, context: Context.Context<never>): () => void {
        if (this.#closing) throw new ClientClosedError()
        const owner = this
        const state = { closed: false, running: false }
        const wait = (delayMs: number) =>
            Effect.callback<void>((resume) => {
                const timer = owner.logical.set(() => resume(Effect.void), delayMs, "scheduled task")
                return Effect.sync(() => owner.logical.clear(timer))
            })
        const report = (cause: Cause.Cause<unknown>) =>
            Effect.withFiber((fiber) =>
                Effect.sync(() => owner.failures.report({ kind: "task", cause, taskName: timing.name }, fiber.context)),
            )
        // A failed run is reported and the task continues. Interruption ends the task, after reporting any failure with it.
        // A defect in the cleanup of a run that shutdown interrupted is a cleanup fault, so shutdown fails with it instead
        const once = Effect.uninterruptibleMask((restore) => {
            state.running = true
            owner.#running++
            return restore(run).pipe(
                Effect.catchCause((cause) => {
                    if (!Cause.hasInterrupts(cause)) return report(cause)
                    let reasons = cause.reasons.filter((reason) => !Cause.isInterruptReason(reason))
                    if (owner.#stopped) {
                        // The cleanup record names the task, so faults of tasks sharing a release helper stay apart
                        const subject =
                            timing.name === undefined
                                ? "a scheduled task"
                                : `the scheduled task ${JSON.stringify(timing.name)}`
                        owner.#cleanupDefects.push(
                            ...reasons
                                .filter(Cause.isDieReason)
                                .map((reason) => ownCleanup(reason, { subject, task: timing.name })),
                        )
                        reasons = reasons.filter((reason) => !Cause.isDieReason(reason))
                    }
                    return (reasons.length ? report(Cause.fromReasons(reasons)) : Effect.void).pipe(
                        Effect.andThen(Effect.interrupt),
                    )
                }),
                Effect.ensuring(
                    Effect.sync(() => {
                        state.running = false
                        owner.#running--
                        owner.#signalProgress()
                    }),
                ),
            )
        })
        const task = Effect.gen(function* () {
            let delayMs = timing.delayMs
            while (true) {
                yield* wait(delayMs)
                if (state.closed) return
                // During a draining shutdown a due run never starts, and stop reports the task as cancelled
                if (owner.#closing) {
                    owner.#ended++
                    return
                }
                yield* once
                if (timing.intervalMs === undefined || state.closed) return
                // Likewise a repeating task whose run ended during the drain gets no later run
                if (owner.#closing) {
                    owner.#ended++
                    return
                }
                delayMs = timing.intervalMs
            }
        })
        const fiber: Fiber.Fiber<void> = Effect.runForkWith(context)(
            task.pipe(Effect.ensuring(Effect.sync(() => void owner.#tasks.delete(fiber)))),
        )
        this.#tasks.set(fiber, state)
        return () => {
            if (state.closed) return
            state.closed = true
            // A run in progress finishes first, and the task then ends instead of waiting for another run
            if (!state.running) fiber.interruptUnsafe()
        }
    }

    /** Start no new run and accept no new task, while runs in progress continue. A draining shutdown begins with this */
    seal(): void {
        this.#closing = true
    }

    /**
     * Stop every task and wait until their fibers end. Fails only with defects raised while they stopped, including
     * those in the cleanup of runs it interrupted
     */
    shutdown(): Effect.Effect<void> {
        return Effect.suspend(() => {
            this.stop()
            return Effect.forEach([...this.#tasks.keys()], (fiber) => Fiber.await(fiber), {
                concurrency: "unbounded",
            }).pipe(
                Effect.flatMap((exits) => {
                    const reasons = [
                        ...this.#cleanupDefects,
                        ...exits.flatMap((exit) =>
                            Exit.isFailure(exit) ? exit.cause.reasons.filter((reason) => reason._tag === "Die") : [],
                        ),
                    ]
                    return reasons.length ? Effect.failCause(Cause.fromReasons<never>(reasons)) : Effect.void
                }),
            )
        })
    }

    /**
     * Accept no new task and interrupt every task, including runs in progress, without waiting. The first call records
     * in one Info record how many tasks shutdown ended with a run waiting or in progress, so none ends unrecorded
     */
    stop(): void {
        this.#closing = true
        if (this.#stopped) return
        this.#stopped = true
        const running = this.#running
        let cancelled = this.#ended
        for (const [fiber, state] of this.#tasks) {
            // A task the application closed has no run waiting, unless its last run is still in progress
            if (state.running || !state.closed) cancelled++
            fiber.interruptUnsafe()
        }
        if (cancelled === 0) return
        this.logging.log({
            level: "info",
            category: "lifecycle",
            code: "lifecycle.tasksCancelled",
            message: `The client is closing, so it cancelled ${cancelled} scheduled ${cancelled === 1 ? "task" : "tasks"} that had a run waiting or in progress${running ? `, including ${running} ${running === 1 ? "run" : "runs"} in progress` : ""}`,
            fields: { cancelled, running },
        })
    }

    #signalProgress() {
        const released = this.#progress
        this.#progress = Deferred.makeUnsafe<void>()
        Deferred.doneUnsafe(released, Effect.void)
    }
}
