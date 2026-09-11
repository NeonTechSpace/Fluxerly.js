import { Effect } from "effect"
import type { GuildOperationFailure, GuildOperationOptions, MemberReference } from "#sdk/guilds"
import { GuildOperationError } from "#sdk/guilds"
import type { ClientOwner } from "./client.js"
import { mapFailureCause } from "./effect-failures.js"
import { guildFetch, memberFetch, memberSelf, roleList } from "./guilds.js"
import { identifier, record } from "./message.js"
import { evaluateMemberHierarchy } from "./role-hierarchy.js"

const inputFailure = () => new GuildOperationError("members.fetchHierarchyCheck", "input", "notDispatched")
const timeoutFailure = () => new GuildOperationError("members.fetchHierarchyCheck", "timeout", "notDispatched")

function target(value: unknown): MemberReference | undefined {
    if (
        !record(value) ||
        Object.keys(value).some((key) => key !== "guildId" && key !== "userId") ||
        !identifier(value.guildId) ||
        !identifier(value.userId)
    )
        return undefined
    return { guildId: value.guildId, userId: value.userId }
}

function options(value: unknown): GuildOperationOptions | undefined {
    if (value === undefined) return {}
    if (
        !record(value) ||
        Object.keys(value).some((key) => key !== "timeoutMs" && key !== "signal") ||
        (value.timeoutMs !== undefined &&
            (typeof value.timeoutMs !== "number" ||
                !Number.isSafeInteger(value.timeoutMs) ||
                value.timeoutMs < 1 ||
                value.timeoutMs > 2_147_483_647)) ||
        (value.signal !== undefined &&
            (!record(value.signal) ||
                typeof value.signal.aborted !== "boolean" ||
                typeof value.signal.addEventListener !== "function" ||
                typeof value.signal.removeEventListener !== "function"))
    )
        return undefined
    return value
}

function remaining(deadline: number): GuildOperationOptions | undefined {
    const timeoutMs = Math.floor(deadline - performance.now())
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
    owner: ClientOwner,
    input: MemberReference,
    suppliedOptions?: GuildOperationOptions,
): Effect.Effect<boolean, GuildOperationFailure> {
    return Effect.suspend(() => {
        const member = target(input)
        const validOptions = options(suppliedOptions)
        if (!member || !validOptions) return Effect.fail(inputFailure())
        const deadline = performance.now() + (validOptions.timeoutMs ?? 30_000)
        const guildOptions = remaining(deadline)
        const selfOptions = remaining(deadline)
        const targetOptions = remaining(deadline)
        const roleOptions = remaining(deadline)
        if (!guildOptions || !selfOptions || !targetOptions || !roleOptions) return Effect.fail(timeoutFailure())
        return Effect.all(
            [
                owner.guild("guilds.fetch", () => guildFetch(member.guildId), guildOptions),
                owner.guild("members.fetchSelf", () => memberSelf(member.guildId), selfOptions),
                owner.guild("members.fetch", () => memberFetch(member), targetOptions),
                owner.guild("roles.fetchAll", () => roleList(member.guildId), roleOptions),
            ],
            { concurrency: "unbounded" },
        ).pipe(
            mapFailureCause(remoteFailure),
            Effect.flatMap(([guild, actor, targetMember, roles]) => {
                const manageable = evaluateMemberHierarchy({ guild, actor, target: targetMember, roles })
                return manageable === undefined
                    ? Effect.fail(new GuildOperationError("members.fetchHierarchyCheck", "response", "unknown"))
                    : Effect.succeed(manageable)
            }),
        )
    })
}
