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
import { ConnectionTimeoutError, ShardConnectionError, type ConnectError, type ConnectionFailure } from "#sdk/errors"
import { nowMs } from "../clock.js"
import { mapFailureCause, withDeadline } from "../effect-failures.js"
import type { ClientLogger } from "../logging.js"

/** Short readable duration for log messages */
export function formatDuration(milliseconds: number): string {
    if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`
    if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`
    return `${Math.floor(milliseconds / 60_000)} min ${Math.round((milliseconds % 60_000) / 1_000)} s`
}

/** Run every shard loop until one fails permanently, bounded by the group startup deadline until startup completes.
 * Defects from losing loops, such as socket cleanup failures, are kept in the group's cause
 */
export function superviseShards<Shard extends { readonly shardId: number }>(options: {
    readonly shards: readonly Shard[]
    readonly startupTimeoutMs: number
    /** Wrap each shard failure with its shard ID, as configured sharding requires */
    readonly attributeShards: boolean
    /** Completed once every shard is ready */
    readonly startup: Deferred.Deferred<void, ConnectError>
    readonly runShard: (shard: Shard, deadline: number) => Effect.Effect<unknown, ConnectionFailure>
}) {
    const { shards, startupTimeoutMs, attributeShards, startup, runShard } = options
    return Effect.suspend(() => {
        const exits: Exit.Exit<unknown, ConnectionFailure>[] = []
        const sessions = Effect.gen(function* () {
            const clock = yield* Clock.Clock
            const deadline = nowMs(clock) + startupTimeoutMs
            return yield* Effect.forEach(
                shards,
                (shard) =>
                    runShard(shard, deadline).pipe(
                        mapFailureCause((failure) =>
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
        const startupGuard = Deferred.await(startup).pipe(
            // allow-silent: The startup outcome itself is observed through the startup deferred
            Effect.ignore,
            withDeadline(startupTimeoutMs, () => new ConnectionTimeoutError(startupTimeoutMs)),
            Effect.andThen(Effect.never),
        )
        return Effect.raceFirst(sessions, startupGuard).pipe(
            // A losing session may defect during socket cleanup. Keep those causes across the race boundary
            Effect.onExit((outcome) => {
                const missing = exits.flatMap((exit) =>
                    Exit.isFailure(exit)
                        ? exit.cause.reasons.filter(
                              (reason) =>
                                  reason._tag !== "Interrupt" &&
                                  (!Exit.isFailure(outcome) || !outcome.cause.reasons.includes(reason)),
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
        faults.forEach((reason, index) =>
            logging.log(
                {
                    level: "error",
                    category: "lifecycle",
                    code: "lifecycle.cleanupFailed",
                    message: `Cleanup step ${index + 1} of ${faults.length} failed during shutdown`,
                    error: reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : undefined,
                    cause: Cause.fromReasons([reason]),
                },
                context,
            ),
        )
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
