/**
 * Pure member timeout state from a supplied member and time.
 * Invariant: The state follows the member's communicationDisabledUntil only, a missing field is unknown rather than
 * none, and the supplied or client time decides, with a timeout ending at its exact expiry
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */
import * as Effect from "effect/Effect"
import { GuildOperationError } from "#sdk/guilds"
import type { GuildMember, MemberTimeoutState, TimeoutStateOptions } from "#sdk/guilds"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { timestamp } from "./decode/timestamp.js"
import { record } from "./decode/primitives.js"
import { readCaller, suspendMarked } from "./defects.js"

function stateAt(member: unknown, options: unknown, clientNow: number): MemberTimeoutState | InputValidationFailure {
    if (!record(member)) return inputValidationFailure("member", "type", "Timeout state member must be an object")
    if (options !== undefined && !record(options))
        return inputValidationFailure("options", "type", "Timeout state options must be an object")
    if (options !== undefined) {
        const unsupported = unsupportedKeyFailure(options, ["now"], "options", "the timeout state options")
        if (unsupported) return unsupported
    }
    const suppliedNow = options?.now
    if (suppliedNow !== undefined && !(suppliedNow instanceof Date && Number.isFinite(suppliedNow.getTime())))
        return inputValidationFailure("options.now", "type", "Timeout state now must be a valid Date")
    const until = member.communicationDisabledUntil
    if (until === undefined) return "unknown"
    if (until === null) return "none"
    if (!timestamp(until))
        return inputValidationFailure(
            "member.communicationDisabledUntil",
            "format",
            "Timeout expiry must be null or an ISO 8601 timestamp",
        )
    const now = suppliedNow === undefined ? clientNow : suppliedNow.getTime()
    return Date.parse(until) > now ? "active" : "none"
}

/** Whether the member's timeout is active at the supplied time, or at the client's current time when none is supplied */
export function memberTimeoutState(
    member: Pick<GuildMember, "communicationDisabledUntil">,
    options: TimeoutStateOptions | undefined,
    clientNow: () => number,
): Effect.Effect<MemberTimeoutState, GuildOperationError> {
    // Only reading the caller input is marked, so a fault in the comparison stays an SDK fault
    return suspendMarked(() => {
        const state = readCaller(() => stateAt(member, options, clientNow()))
        return state instanceof InputValidationFailure
            ? Effect.fail(
                  new GuildOperationError({
                      operation: "members.timeoutState",
                      reason: "input",
                      outcome: "notDispatched",
                      inputValidation: state.detail,
                  }),
              )
            : Effect.succeed(state)
    })
}
