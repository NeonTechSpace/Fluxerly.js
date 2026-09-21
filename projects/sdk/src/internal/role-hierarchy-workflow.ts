import { Effect } from "effect"
import type { GuildOperationFailure, GuildOperationOptions, MemberReference } from "#sdk/guilds"
import { GuildOperationError } from "#sdk/guilds"
import type { ClientOwner } from "./client.js"
import { mapFailureCause } from "./effect-failures.js"
import { guildFetch, memberFetch, memberSelf, roleList } from "./guilds.js"
import { identifier, record } from "./message.js"
import { evaluateMemberHierarchy } from "./role-hierarchy.js"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"

const inputFailure = (failure: InputValidationFailure) =>
    new GuildOperationError("members.fetchHierarchyCheck", "input", "notDispatched", null, null, null, failure.detail)
const timeoutFailure = () => new GuildOperationError("members.fetchHierarchyCheck", "timeout", "notDispatched")

function target(value: unknown): MemberReference | InputValidationFailure {
    if (!record(value)) return inputValidationFailure("target", "type", "Hierarchy target must be an object")
    if (Object.keys(value).some((key) => key !== "guildId" && key !== "userId"))
        return inputValidationFailure("target", "allowedFields", "Hierarchy target may contain only guildId and userId")
    if (!identifier(value.guildId))
        return inputValidationFailure("target.guildId", "format", "Guild IDs must be decimal strings")
    if (!identifier(value.userId))
        return inputValidationFailure("target.userId", "format", "User IDs must be decimal strings")
    return { guildId: value.guildId, userId: value.userId }
}

function options(value: unknown): GuildOperationOptions | InputValidationFailure {
    if (value === undefined) return {}
    if (!record(value)) return inputValidationFailure("options", "type", "Hierarchy options must be an object")
    if (Object.keys(value).some((key) => key !== "timeoutMs" && key !== "signal"))
        return inputValidationFailure(
            "options",
            "allowedFields",
            "Hierarchy options may contain only timeoutMs and signal",
        )
    if (
        value.timeoutMs !== undefined &&
        (typeof value.timeoutMs !== "number" ||
            !Number.isSafeInteger(value.timeoutMs) ||
            value.timeoutMs < 1 ||
            value.timeoutMs > 2_147_483_647)
    )
        return inputValidationFailure(
            "options.timeoutMs",
            "range",
            "Hierarchy timeout must be an integer from 1 through 2,147,483,647",
        )
    if (
        value.signal !== undefined &&
        (!record(value.signal) ||
            typeof value.signal.aborted !== "boolean" ||
            typeof value.signal.addEventListener !== "function" ||
            typeof value.signal.removeEventListener !== "function")
    )
        return inputValidationFailure("options.signal", "type", "Hierarchy signal must be an AbortSignal")
    return value
}

function remaining(deadline: number, now: () => number): GuildOperationOptions | undefined {
    const timeoutMs = Math.floor(deadline - now())
    return timeoutMs > 0 ? { timeoutMs } : undefined
}

function remoteFailure(error: GuildOperationFailure): GuildOperationFailure {
    if (error instanceof GuildOperationError)
        return new GuildOperationError(
            "members.fetchHierarchyCheck",
            error.reason === "input" ? "response" : error.reason,
            error.outcome,
            error.status,
            error.retryAfterMs,
            error.apiError,
        )
    return error
}

/** Fetches the four independent hierarchy inputs in parallel under one deadline, then evaluates the pure local rule */
export function fetchHierarchyCheck(
    owner: Pick<ClientOwner, "guild" | "logical">,
    input: MemberReference,
    suppliedOptions?: GuildOperationOptions,
): Effect.Effect<boolean, GuildOperationFailure> {
    return Effect.suspend(() => {
        const member = target(input)
        const validOptions = options(suppliedOptions)
        if (member instanceof InputValidationFailure) return Effect.fail(inputFailure(member))
        if (validOptions instanceof InputValidationFailure) return Effect.fail(inputFailure(validOptions))
        return Effect.gen(function* () {
            const now = () => owner.logical.now()
            const deadline = now() + (validOptions.timeoutMs ?? 30_000)
            const guildOptions = remaining(deadline, now)
            const selfOptions = remaining(deadline, now)
            const targetOptions = remaining(deadline, now)
            const roleOptions = remaining(deadline, now)
            if (!guildOptions || !selfOptions || !targetOptions || !roleOptions)
                return yield* Effect.fail(timeoutFailure())
            const [guild, actor, targetMember, roles] = yield* Effect.all(
                [
                    owner.guild("guilds.fetch", () => guildFetch(member.guildId), guildOptions),
                    owner.guild("members.fetchSelf", () => memberSelf(member.guildId), selfOptions),
                    owner.guild("members.fetch", () => memberFetch(member), targetOptions),
                    owner.guild("roles.fetchAll", () => roleList(member.guildId), roleOptions),
                ],
                { concurrency: "unbounded" },
            ).pipe(mapFailureCause(remoteFailure))
            const manageable = evaluateMemberHierarchy({ guild, actor, target: targetMember, roles })
            return manageable === undefined
                ? yield* Effect.fail(new GuildOperationError("members.fetchHierarchyCheck", "response", "unknown"))
                : manageable
        })
    })
}
