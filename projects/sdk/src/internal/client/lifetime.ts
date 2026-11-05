/**
 * Client lifetime helpers: The shard group under one startup deadline, service cleanup that keeps every defect, and
 * shutdown records.
 * Invariant: The group awaits every assigned shard for initial readiness under one deadline, a healthy shard's work
 * stays independent of another shard's transient gap, and terminal supervision preserves sibling cleanup failures.
 * Shutdown shares cleanup across callers and reports completion only after owned resources are released.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
    AuthenticationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
    ShardConnectionError,
    type ConnectError,
    type ConnectionFailure,
} from "#sdk/errors"
import { cleanupOwner } from "../cleanup-owner.js"
import { nowMs } from "../clock.js"
import { failures, holdsReason, mapFailureCause } from "../effect-failures.js"
import type { ClientLogger } from "../logging.js"

/** The classes of ConnectionFailure, for mapping a shard's run failures */
const connectionFailures = failures(
    AuthenticationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
    ShardConnectionError,
)

/** Short readable duration for log messages. Each range ends where rounding would reach the next unit */
export function formatDuration(milliseconds: number): string {
    if (milliseconds < 999.5) return `${Math.max(0, Math.round(milliseconds))} ms`
    if (milliseconds < 59_950) return `${(milliseconds / 1_000).toFixed(1)} s`
    const seconds = Math.round(milliseconds / 1_000)
    return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

/** The group's startup deadline. The group's first Identify extends it once by the wait Fluxer can impose on a session
 * start, when connection.startupTimeoutMs is left at its default
 */
export class StartupDeadline {
    #identifyWaitMs: number
    constructor(
        /** Clock time at which startup times out */
        public at: number,
        /** The startup budget the deadline was derived from, reported when startup times out */
        public timeoutMs: number,
        identifyWaitMs: number,
    ) {
        this.#identifyWaitMs = identifyWaitMs
    }

    /** Extend the deadline for the group's first Identify, and do nothing for later ones */
    identifySent(): void {
        this.at += this.#identifyWaitMs
        this.timeoutMs += this.#identifyWaitMs
        this.#identifyWaitMs = 0
    }
}

/** Run every shard loop until one fails permanently, bounded by the group startup deadline until startup completes.
 * Defects from losing loops, such as socket cleanup failures, are kept in the group's cause
 */
export function superviseShards<Shard extends { readonly shardId: number }>(options: {
    readonly shards: readonly Shard[]
    readonly startupTimeoutMs: number
    /** Time the group's first Identify adds to the startup deadline */
    readonly identifyWaitMs: number
    /** Wrap each shard failure with its shard ID, as configured sharding requires */
    readonly attributeShards: boolean
    /** Completed once every shard is ready */
    readonly startup: Deferred.Deferred<void, ConnectError>
    readonly runShard: (shard: Shard, deadline: StartupDeadline) => Effect.Effect<unknown, ConnectionFailure>
}) {
    const { shards, startupTimeoutMs, identifyWaitMs, attributeShards, startup, runShard } = options
    return Effect.gen(function* () {
        const exits: Exit.Exit<unknown, ConnectionFailure>[] = []
        const clock = yield* Clock.Clock
        const deadline = new StartupDeadline(nowMs(clock) + startupTimeoutMs, startupTimeoutMs, identifyWaitMs)
        const sessions = Effect.gen(function* () {
            return yield* Effect.forEach(
                shards,
                (shard) =>
                    runShard(shard, deadline).pipe(
                        mapFailureCause(connectionFailures, (failure) =>
                            attributeShards && !(failure instanceof ShardConnectionError)
                                ? new ShardConnectionError(shard.shardId, failure)
                                : failure,
                        ),
                        Effect.onExit((exit) =>
                            Effect.sync(() => {
                                exits.push(exit)
                            }),
                        ),
                    ),
                { concurrency: "unbounded", discard: true },
            )
        })
        // The deadline can move while startup waits, so the guard sleeps until the current deadline and checks again
        const expiry: Effect.Effect<never, ConnectionTimeoutError> = Effect.gen(function* () {
            while (true) {
                const remaining = deadline.at - nowMs(clock)
                if (remaining <= 0) return yield* Effect.fail(new ConnectionTimeoutError(deadline.timeoutMs))
                yield* Effect.sleep(remaining)
            }
        })
        const startupGuard = Effect.raceFirst(
            Deferred.await(startup).pipe(
                // allow-silent: The startup outcome itself is observed through the startup deferred
                Effect.ignore,
            ),
            expiry,
        ).pipe(Effect.andThen(Effect.never))
        return yield* Effect.raceFirst(sessions, startupGuard).pipe(
            // A losing session may defect during socket cleanup. Keep those causes across the race boundary
            Effect.onExit((outcome) => {
                const missing = exits.flatMap((exit) =>
                    Exit.isFailure(exit)
                        ? exit.cause.reasons.filter(
                              (reason) =>
                                  reason._tag !== "Interrupt" &&
                                  (!Exit.isFailure(outcome) || !holdsReason(outcome.cause, reason)),
                          )
                        : [],
                )
                return missing.length ? Effect.failCause(Cause.fromReasons(missing)) : Effect.void
            }),
        )
    })
}

/** Keep only defects from a set of cleanup exits, as one cause */
export function defectsOnly(exits: readonly Exit.Exit<unknown, unknown>[]): Exit.Exit<void> {
    const reasons = exits.flatMap((exit) =>
        Exit.isFailure(exit) ? exit.cause.reasons.filter((reason) => reason._tag === "Die") : [],
    )
    return reasons.length ? Exit.failCause(Cause.fromReasons<never>(reasons)) : Exit.void
}

/** Run service cleanups concurrently and fail with every reason any of them produced */
export function closeAll(services: readonly Effect.Effect<Exit.Exit<unknown, never>>[]): Effect.Effect<void> {
    return Effect.all(services, { concurrency: "unbounded" }).pipe(
        Effect.flatMap((exits) => {
            const reasons = exits.flatMap((exit) => (Exit.isFailure(exit) ? exit.cause.reasons : []))
            return reasons.length ? Effect.failCause(Cause.fromReasons<never>(reasons)) : Effect.void
        }),
    )
}

/** Log the start of shutdown for a client that connected or ran */
export function logShutdownStart(
    logging: ClientLogger,
    context: Context.Context<never>,
    everStarted: boolean,
    reason: string | undefined,
) {
    if (!everStarted) return
    logging.log(
        {
            level: "info",
            category: "lifecycle",
            code: "lifecycle.shutdown",
            message: reason === undefined ? "Shutting down" : `Shutting down because ${reason}`,
        },
        context,
    )
}

/** Log each cleanup failure, flush deduplicated records and log completion for a client that connected or ran */
export function logShutdownEnd(
    logging: ClientLogger,
    context: Context.Context<never>,
    options: { readonly everStarted: boolean; readonly startedAt: number; readonly services: Exit.Exit<void, unknown> },
) {
    const { everStarted, startedAt, services } = options
    const durationMs = Date.now() - startedAt
    let failedSteps = 0
    if (Exit.isFailure(services)) {
        const faults = services.cause.reasons.filter((reason) => reason._tag !== "Interrupt")
        failedSteps = Math.max(1, faults.length)
        logging.count("cleanupFailures", failedSteps)
        faults.forEach((reason, index) => {
            const owner = cleanupOwner(reason)
            logging.log(
                {
                    level: "error",
                    category: "lifecycle",
                    code: "lifecycle.cleanupFailed",
                    message: `Cleanup step ${index + 1} of ${faults.length} failed during shutdown${owner === undefined ? "" : ` in ${owner.subject}`}`,
                    error: reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : undefined,
                    cause: Cause.fromReasons([reason]),
                    // Undefined fields are omitted from the record
                    fields: { task: owner?.task },
                },
                context,
            )
        })
    }
    logging.flush(context)
    if (!everStarted) return
    logging.log(
        {
            level: "info",
            category: "lifecycle",
            code: "lifecycle.shutdownComplete",
            message: Exit.isFailure(services)
                ? `Shutdown finished in ${formatDuration(durationMs)}, but ${failedSteps} cleanup step${failedSteps === 1 ? "" : "s"} failed`
                : `Shutdown complete in ${formatDuration(durationMs)}`,
            durationMs,
        },
        context,
    )
}
