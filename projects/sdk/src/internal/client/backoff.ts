/**
 * Connection retry timing for shard startup and established-session recovery.
 * Invariant: Startup and recovery use separate backoff steps with full jitter under a capped exponential ceiling, a
 * server-required wait always wins over a shorter jittered delay, and only a connection that stayed healthy resets the
 * recovery sequence. Socket-cleanup time never counts as healthy connected time. Recovery timing comes from the
 * validated connection.recovery settings, while startup keeps fixed timing bounded by the startup deadline.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import type * as Schedule from "effect/Schedule"
import type { ConnectionFailure } from "#sdk/errors"

/** Validated recovery timing for established sessions */
export interface RecoveryConfiguration {
    /** Ceiling for the first recovery retry, doubled for each later step */
    readonly minDelayMs: number
    /** Largest backoff ceiling */
    readonly maxDelayMs: number
    /** Budget for one recovery attempt, covering discovery and the handshake */
    readonly attemptTimeoutMs: number
    /** Connected time after which the next loss restarts the recovery sequence */
    readonly healthyResetMs: number
    /** Native schedule that replaces the backoff delays, when configured */
    readonly schedule: Schedule.Schedule<unknown, ConnectionFailure> | undefined
}

/** Documented connection.recovery defaults */
export const defaultRecovery: RecoveryConfiguration = Object.freeze({
    minDelayMs: 1_000,
    maxDelayMs: 30_000,
    attemptTimeoutMs: 30_000,
    healthyResetMs: 60_000,
    schedule: undefined,
})

/** Fixed startup backoff: 1 s doubling to 30 s, always bounded by the startup deadline */
const startupBackoff = Object.freeze({ minDelayMs: 1_000, maxDelayMs: 30_000 })

/** Doublings after which the ceiling stops growing, far past any configurable maximum */
const maximumBackoffDoublings = 31
/** Minimum spacing between Identify sends across this client's shards, unless an identify coordinator paces them */
export const identifySpacingMs = 1_000
/** Longest delay host timers accept */
const maximumTimerMs = 2_147_483_647

/**
 * Startup budget for one shard group: The configured deadline plus the Identify spacing the SDK itself adds between
 * the group's shards, so the SDK's own pacing never fails a larger plan. Spacing is added only for spaced shards
 */
export function startupBudgetMs(configuredMs: number, spacedShards: number): number {
    return Math.min(maximumTimerMs, configuredMs + Math.max(0, spacedShards - 1) * identifySpacingMs)
}

/** Capped exponential ceiling for a zero-based backoff step */
export function backoffCeiling(
    step: number,
    timing: { readonly minDelayMs: number; readonly maxDelayMs: number } = startupBackoff,
): number {
    return Math.min(timing.maxDelayMs, timing.minDelayMs * 2 ** Math.min(step, maximumBackoffDoublings))
}

/** Full-jitter delay under the ceiling, never shorter than a server-required wait */
export function retryDelay(ceiling: number, random: number, requiredWaitMs: number): number {
    return Math.max(random * ceiling, requiredWaitMs)
}

/** Whether a connection that ended at endedAt had been healthy long enough to restart the recovery sequence */
export function stayedHealthy(connectedAt: number, endedAt: number, healthyResetMs: number): boolean {
    return endedAt - connectedAt >= healthyResetMs
}
