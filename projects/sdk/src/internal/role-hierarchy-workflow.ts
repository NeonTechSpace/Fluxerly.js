/**
 * Role hierarchy checks that fetch the required guild data.
 * Invariant: Checks describe the fetched data and never authorize an action.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Effect from "effect/Effect"
import type { CanManageOptions, GuildOperationFailure, GuildOperationOptions, MemberReference } from "#sdk/guilds"
import { GuildOperationError } from "#sdk/guilds"
import { composedStepFacts } from "#sdk/api-errors"
import type { ClientOwner } from "./client.js"
import { mapFailureCause } from "./effect-failures.js"
import { guildFetch, memberFetch, memberSelf, roleList } from "./guilds.js"
import { identifier, record } from "./decode/primitives.js"
import { suspendInput } from "./defects.js"
import { evaluateMemberHierarchy } from "./role-hierarchy.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"

const inputFailure = (failure: InputValidationFailure) =>
    new GuildOperationError({
        operation: "members.fetchCanManage",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: failure.detail,
    })
const timeoutFailure = () =>
    new GuildOperationError({ operation: "members.fetchCanManage", reason: "timeout", outcome: "notDispatched" })

function target(value: unknown): MemberReference | InputValidationFailure {
    if (!record(value)) return inputValidationFailure("target", "type", "Hierarchy target must be an object")
    const unsupported = unsupportedKeyFailure(value, ["guildId", "userId"], "target", "the hierarchy target")
    if (unsupported) return unsupported
    // Read each field once, so the validated IDs are the ones fetched
    const guildId = value.guildId
    if (!identifier(guildId))
        return inputValidationFailure("target.guildId", "format", "Guild IDs must be decimal strings")
    const userId = value.userId
    if (!identifier(userId))
        return inputValidationFailure("target.userId", "format", "User IDs must be decimal strings")
    return { guildId, userId }
}

function options(value: unknown): CanManageOptions | InputValidationFailure {
    if (value === undefined) return {}
    if (!record(value)) return inputValidationFailure("options", "type", "Hierarchy options must be an object")
    const unsupported = unsupportedKeyFailure(
        value,
        ["timeoutMs", "signal", "actorUserId"],
        "options",
        "the hierarchy options",
    )
    if (unsupported) return unsupported
    const actorUserId = value.actorUserId
    if (actorUserId !== undefined && !identifier(actorUserId))
        return inputValidationFailure("options.actorUserId", "format", "User IDs must be decimal strings")
    const timeoutMs = value.timeoutMs
    if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 2_147_483_647)
    )
        return inputValidationFailure(
            "options.timeoutMs",
            "range",
            "Hierarchy timeout must be an integer from 1 through 2,147,483,647 ms",
        )
    const signal = value.signal
    if (
        signal !== undefined &&
        (!record(signal) ||
            typeof signal.aborted !== "boolean" ||
            typeof signal.addEventListener !== "function" ||
            typeof signal.removeEventListener !== "function")
    )
        return inputValidationFailure("options.signal", "type", "Hierarchy signal must be an AbortSignal")
    // Keep only the validated actor and timeout: The requests use their own remaining deadlines
    return { ...(actorUserId === undefined ? {} : { actorUserId }), ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}

function remaining(deadline: number, now: () => number): GuildOperationOptions | undefined {
    const timeoutMs = Math.floor(deadline - now())
    return timeoutMs > 0 ? { timeoutMs } : undefined
}

function remoteFailure(error: GuildOperationFailure): GuildOperationFailure {
    if (error instanceof GuildOperationError)
        return new GuildOperationError({
            operation: "members.fetchCanManage",
            reason: error.reason === "input" ? "response" : error.reason,
            outcome: error.outcome,
            status: error.status,
            retryAfterMs: error.retryAfterMs,
            apiError: error.apiError,
            ...composedStepFacts(error),
        })
    return error
}

/** Fetches the four independent hierarchy inputs in parallel under one deadline, then evaluates the pure local rule.
 * The actor is the bot unless actorUserId names another member of the target's guild
 */
export function fetchCanManage(
    owner: Pick<ClientOwner, "guild" | "logical"> & { readonly defaultTimeoutMs?: number },
    input: MemberReference,
    suppliedOptions?: CanManageOptions,
): Effect.Effect<boolean, GuildOperationFailure> {
    // Reading and validating the caller target and options is marked as application input
    return suspendInput(() => {
        const member = target(input)
        const validOptions = options(suppliedOptions)
        if (member instanceof InputValidationFailure) return Effect.fail(inputFailure(member))
        if (validOptions instanceof InputValidationFailure) return Effect.fail(inputFailure(validOptions))
        return Effect.gen(function* () {
            const now = () => owner.logical.now()
            const deadline = now() + (validOptions.timeoutMs ?? owner.defaultTimeoutMs ?? 30_000)
            const guildOptions = remaining(deadline, now)
            const selfOptions = remaining(deadline, now)
            const targetOptions = remaining(deadline, now)
            const roleOptions = remaining(deadline, now)
            if (!guildOptions || !selfOptions || !targetOptions || !roleOptions)
                return yield* Effect.fail(timeoutFailure())
            const [guild, actor, targetMember, roles] = yield* Effect.all(
                [
                    owner.guild("guilds.fetch", () => guildFetch(member.guildId), guildOptions),
                    validOptions.actorUserId === undefined
                        ? owner.guild("members.fetchSelf", () => memberSelf(member.guildId), selfOptions)
                        : owner.guild(
                              "members.fetch",
                              () => memberFetch({ guildId: member.guildId, userId: validOptions.actorUserId! }),
                              selfOptions,
                          ),
                    owner.guild("members.fetch", () => memberFetch(member), targetOptions),
                    owner.guild("roles.fetchAll", () => roleList(member.guildId), roleOptions),
                ],
                { concurrency: "unbounded" },
            ).pipe(mapFailureCause(remoteFailure))
            const manageable = evaluateMemberHierarchy({ guild, actor, target: targetMember, roles })
            return manageable === undefined
                ? yield* Effect.fail(
                      new GuildOperationError({
                          operation: "members.fetchCanManage",
                          reason: "response",
                          outcome: "unknown",
                      }),
                  )
                : manageable
        })
    })
}
