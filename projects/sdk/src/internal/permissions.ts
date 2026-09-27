/**
 * Permission calculation from explicit guild, member, role and channel data.
 * Invariant: Results are checks for the supplied data, never action authorization, and Fluxer stays authoritative.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Effect from "effect/Effect"
import type { ChannelOperationFailure, GuildChannel, PermissionOverwrite } from "#sdk/channels"
import type { GuildOperationFailure, GuildOperationOptions } from "#sdk/guilds"
import { GuildOperationError } from "#sdk/guilds"
import { composedStepFacts } from "#sdk/api-errors"
import type { PermissionInput, PermissionTarget } from "#sdk/permissions"
import { channelFetch } from "./channels.js"
import type { ClientOwner } from "./client.js"
import { guildFetch, memberFetch, roleList } from "./guilds.js"
import { identifier, record } from "./decode/primitives.js"
import { readCaller, suspendInput, suspendMarked } from "./defects.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"

const allPermissions = (1n << 64n) - 1n
const administrator = 1n << 3n

const unsigned64 = (value: unknown): value is bigint =>
    typeof value === "bigint" && value >= 0n && value <= allPermissions

const inputFailure = (operation: "permissions.calculate" | "permissions.fetch", failure: InputValidationFailure) =>
    new GuildOperationError({ operation, reason: "input", outcome: "notDispatched", inputValidation: failure.detail })

const timeoutFailure = () =>
    new GuildOperationError({ operation: "permissions.fetch", reason: "timeout", outcome: "notDispatched" })

interface ValidatedInput {
    readonly guild: PermissionGuild
    readonly member: PermissionMember
    readonly roles: ReadonlyMap<string, PermissionRole>
    readonly channel: PermissionChannel | undefined
}

interface PermissionGuild {
    readonly id: string
    readonly ownerId: string
}

interface PermissionMember {
    readonly guildId: string
    readonly userId: string
    readonly roleIds: readonly string[]
}

interface PermissionRole {
    readonly id: string
    readonly guildId: string
    readonly permissions: bigint
}

interface PermissionChannel {
    readonly id: string
    readonly guildId: string
    readonly permissionOverwrites: readonly PermissionOverwrite[]
}

interface ValidatedTarget {
    readonly guildId: string
    readonly userId: string
    readonly channelId: string | undefined
}

// Each validator reads a caller field once, so the validated value is the one calculated

function validateMember(value: unknown, guildId: string): PermissionMember | undefined {
    if (!record(value) || value.guildId !== guildId) return undefined
    const userId = value.userId
    const roleInput = value.roleIds
    if (!identifier(userId) || !Array.isArray(roleInput)) return undefined
    const roleIds: string[] = []
    const seen = new Set<string>()
    for (const roleId of roleInput) {
        if (!identifier(roleId) || roleId === guildId || seen.has(roleId)) return undefined
        seen.add(roleId)
        roleIds.push(roleId)
    }
    return { guildId, userId, roleIds }
}

function validateRoles(
    value: unknown,
    guildId: string,
    member: PermissionMember,
): ReadonlyMap<string, PermissionRole> | undefined {
    if (!Array.isArray(value)) return undefined
    const roles = new Map<string, PermissionRole>()
    for (const role of value) {
        if (!record(role) || role.guildId !== guildId) return undefined
        const id = role.id
        const permissions = role.permissions
        if (!identifier(id) || !unsigned64(permissions) || roles.has(id)) return undefined
        roles.set(id, { id, guildId, permissions })
    }
    if (!roles.has(guildId) || member.roleIds.some((roleId) => !roles.has(roleId))) return undefined
    return roles
}

function decodeOverwrite(value: unknown, seen: Set<string>): PermissionOverwrite | undefined {
    if (!record(value)) return undefined
    const id = value.id
    const type = value.type
    const allow = value.allow
    const deny = value.deny
    if (!identifier(id) || (type !== "role" && type !== "member") || !unsigned64(allow) || !unsigned64(deny))
        return undefined
    const key = `${type}:${id}`
    if (seen.has(key)) return undefined
    seen.add(key)
    return { id, type, allow, deny }
}

function validateChannel(value: unknown, guildId: string): PermissionChannel | undefined {
    if (!record(value) || value.guildId !== guildId) return undefined
    const id = value.id
    if (!identifier(id) || !("permissionOverwrites" in value)) return undefined
    const overwrites = value.permissionOverwrites
    if (!Array.isArray(overwrites)) return undefined
    const seen = new Set<string>()
    const decoded: PermissionOverwrite[] = []
    for (const overwrite of overwrites) {
        const valid = decodeOverwrite(overwrite, seen)
        if (!valid) return undefined
        decoded.push(valid)
    }
    return { id, guildId, permissionOverwrites: decoded }
}

function validateInput(value: unknown): ValidatedInput | InputValidationFailure {
    if (!record(value)) return inputValidationFailure("input", "type", "Permission input must be an object")
    const guildInput = value.guild
    if (!record(guildInput)) return inputValidationFailure("input.guild", "type", "Permission guild must be an object")
    const guildId = guildInput.id
    if (!identifier(guildId))
        return inputValidationFailure("input.guild.id", "format", "Permission guild ID must be a decimal string")
    const ownerId = guildInput.ownerId
    if (!identifier(ownerId))
        return inputValidationFailure(
            "input.guild.ownerId",
            "format",
            "Permission guild owner ID must be a decimal string",
        )
    const guild: PermissionGuild = { id: guildId, ownerId }
    const member = validateMember(value.member, guild.id)
    if (!member)
        return inputValidationFailure(
            "input.member",
            "format",
            "Permission member must match the guild and contain a decimal user ID and unique non-default role IDs",
        )
    const roles = validateRoles(value.roles, guild.id, member)
    if (!roles)
        return inputValidationFailure(
            "input.roles[]",
            "format",
            "Permission roles must be unique same-guild roles with unsigned 64-bit permissions and cover the member roles",
        )
    const channelInput = value.channel
    const channel = channelInput === undefined ? undefined : validateChannel(channelInput, guild.id)
    if (channelInput !== undefined && !channel)
        return inputValidationFailure(
            "input.channel",
            "format",
            "Permission channel must match the guild and contain unique valid role or member overwrites",
        )
    return { guild, member, roles, channel }
}

function applyOverwrite(permissions: bigint, overwrite: PermissionOverwrite): bigint {
    return (permissions & ~overwrite.deny) | overwrite.allow
}

function calculate(input: ValidatedInput): bigint {
    const { guild, member, roles, channel } = input
    if (member.userId === guild.ownerId) return allPermissions

    let permissions = roles.get(guild.id)!.permissions
    for (const roleId of member.roleIds) permissions |= roles.get(roleId)!.permissions
    if ((permissions & administrator) === administrator) return allPermissions
    if (!channel) return permissions

    const overwrites = channel.permissionOverwrites!
    for (const overwrite of overwrites)
        if (overwrite.type === "role" && overwrite.id === guild.id) permissions = applyOverwrite(permissions, overwrite)

    let roleAllow = 0n
    let roleDeny = 0n
    const memberRoles = new Set(member.roleIds)
    for (const overwrite of overwrites)
        if (overwrite.type === "role" && memberRoles.has(overwrite.id)) {
            roleAllow |= overwrite.allow
            roleDeny |= overwrite.deny
        }
    permissions = (permissions & ~roleDeny) | roleAllow

    for (const overwrite of overwrites)
        if (overwrite.type === "member" && overwrite.id === member.userId)
            permissions = applyOverwrite(permissions, overwrite)

    return permissions
}

/** Calculates Fluxer's raw guild or explicit-channel permission bitfield from one validated local snapshot */
export function calculatePermissions(input: PermissionInput): Effect.Effect<bigint, GuildOperationError> {
    // Only reading the caller input is marked, so a fault in the calculation stays an SDK fault
    return suspendMarked(() => {
        const validated = readCaller(() => validateInput(input))
        return validated instanceof InputValidationFailure
            ? Effect.fail(inputFailure("permissions.calculate", validated))
            : Effect.succeed(calculate(validated))
    })
}

function validateTarget(value: unknown): ValidatedTarget | InputValidationFailure {
    if (!record(value)) return inputValidationFailure("target", "type", "Permission target must be an object")
    const unsupported = unsupportedKeyFailure(
        value,
        ["guildId", "userId", "channelId"],
        "target",
        "the permission target",
    )
    if (unsupported) return unsupported
    const guildId = value.guildId
    if (!identifier(guildId))
        return inputValidationFailure("target.guildId", "format", "Guild IDs must be decimal strings")
    const userId = value.userId
    if (!identifier(userId))
        return inputValidationFailure("target.userId", "format", "User IDs must be decimal strings")
    const channelId = value.channelId
    if (channelId !== undefined && !identifier(channelId))
        return inputValidationFailure("target.channelId", "format", "Channel IDs must be decimal strings")
    return { guildId, userId, channelId }
}

function validateOptions(value: unknown): GuildOperationOptions | InputValidationFailure {
    if (value === undefined) return {}
    if (!record(value)) return inputValidationFailure("options", "type", "Permission fetch options must be an object")
    const unsupported = unsupportedKeyFailure(value, ["timeoutMs", "signal"], "options", "the permission fetch options")
    if (unsupported) return unsupported
    const signal = value.signal
    if (
        signal !== undefined &&
        (!record(signal) ||
            typeof signal.aborted !== "boolean" ||
            typeof signal.addEventListener !== "function" ||
            typeof signal.removeEventListener !== "function")
    )
        return inputValidationFailure("options.signal", "type", "Permission fetch signal must be an AbortSignal")
    const timeoutMs = value.timeoutMs
    if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs <= 0 ||
            timeoutMs > 2_147_483_647)
    )
        return inputValidationFailure(
            "options.timeoutMs",
            "range",
            "Permission fetch timeout must be an integer from 1 through 2,147,483,647 ms",
        )
    // Keep only the validated timeout: The requests use their own remaining deadlines
    return timeoutMs === undefined ? {} : { timeoutMs }
}

function remainingOptions(deadline: number, now: () => number): GuildOperationOptions | undefined {
    const remaining = Math.floor(deadline - now())
    return remaining > 0 ? { timeoutMs: remaining } : undefined
}

function remoteCalculationFailure(error: GuildOperationError): GuildOperationError {
    return new GuildOperationError({
        operation: "permissions.fetch",
        reason: error.reason === "input" ? "response" : error.reason,
        outcome: error.outcome,
        status: error.status,
        retryAfterMs: error.retryAfterMs,
        apiError: error.apiError,
        ...composedStepFacts(error),
    })
}

/**
 * Fetches independent guild, member, role, and optional channel observations, then calculates their raw bitfield
 *
 * This always reads remotely without consulting local caches. Its deadline covers the whole composition, but the
 * resulting observations are not transactional and do not establish access, hierarchy, timeouts, or action success
 */
export function fetchPermissions(
    owner: Pick<ClientOwner, "guild" | "channel" | "logical"> & { readonly defaultTimeoutMs?: number },
    target: PermissionTarget,
    options?: GuildOperationOptions,
): Effect.Effect<bigint, GuildOperationFailure | ChannelOperationFailure> {
    // Reading and validating the caller target and options is marked as application input
    return suspendInput(() => {
        const targetSnapshot = validateTarget(target)
        if (targetSnapshot instanceof InputValidationFailure)
            return Effect.fail(inputFailure("permissions.fetch", targetSnapshot))
        const validatedOptions = validateOptions(options)
        if (validatedOptions instanceof InputValidationFailure)
            return Effect.fail(inputFailure("permissions.fetch", validatedOptions))
        const timedOut = () => Effect.fail(timeoutFailure())
        return Effect.gen(function* () {
            const now = () => owner.logical.now()
            const deadline = now() + (validatedOptions.timeoutMs ?? owner.defaultTimeoutMs ?? 30_000)
            const requestOptions = () => remainingOptions(deadline, now)
            const guildOptions = requestOptions()
            if (!guildOptions) return yield* timedOut()
            const guild = yield* owner.guild("guilds.fetch", () => guildFetch(targetSnapshot.guildId), guildOptions)

            const memberOptions = requestOptions()
            if (!memberOptions) return yield* timedOut()
            const member = yield* owner.guild("members.fetch", () => memberFetch(targetSnapshot), memberOptions)

            const roleOptions = requestOptions()
            if (!roleOptions) return yield* timedOut()
            const roles = yield* owner.guild("roles.fetchAll", () => roleList(targetSnapshot.guildId), roleOptions)

            let channel: GuildChannel | undefined
            const channelId = targetSnapshot.channelId
            if (channelId !== undefined) {
                const channelOptions = requestOptions()
                if (!channelOptions) return yield* timedOut()
                channel = yield* owner.channel("channels.fetch", () => channelFetch(channelId), channelOptions)
            }

            return yield* calculatePermissions({
                guild,
                member,
                roles,
                ...(channel === undefined ? {} : { channel }),
            }).pipe(Effect.mapError(remoteCalculationFailure))
        })
    })
}
