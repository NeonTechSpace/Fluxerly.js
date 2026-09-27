// Participant voice-state decisions used by the voice-controls harness. They are pure, so local tests check the
// recovery rules directly without a participant or the sandbox
import { HarnessCheckError } from "./harness.js"

/** Whether two observations agree on channel, mute and deafen state */
export const sameState = (left, right) =>
    left?.channelId === right?.channelId && left?.muted === right?.muted && left?.deafened === right?.deafened

/**
 * Resolves an uncertain journaled operation from a fresh observation: `intended` when it took effect, `before` when
 * it did not, and `conflict` when the participant is in neither state
 */
export const pendingResolution = (current, pending) =>
    sameState(current, pending.intended) ? "intended" : sameState(current, pending.before) ? "before" : "conflict"

/**
 * Whether a disconnected participant is back in the baseline channel. Rejoining with different mute or deafen flags
 * is a concurrent change by someone else, so it throws and recovery keeps its journal instead of overwriting it
 */
export function rejoinedBaseline(current, baseline) {
    if (current.channelId !== baseline.channelId) return false
    if (current.muted !== baseline.muted || current.deafened !== baseline.deafened)
        throw new HarnessCheckError(
            "participant_voice_conflict",
            "Concurrent participant voice-flag change after disconnect; retain recovery journal",
        )
    return true
}
