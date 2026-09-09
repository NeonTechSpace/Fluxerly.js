import { Effect } from "effect"
import type { ChannelOperationFailure, GuildChannel, PermissionOverwrite } from "#sdk/channels"
import type { GuildOperationFailure, GuildOperationOptions } from "#sdk/guilds"
import { GuildOperationError } from "#sdk/guilds"
import type { PermissionInput, PermissionTarget } from "#sdk/permissions"
import { channelFetch } from "./channels.js"
import type { ClientOwner } from "./client.js"
import { guildFetch, memberFetch, roleList } from "./guilds.js"
import { identifier, record } from "./message.js"

const allPermissions = (1n << 64n) - 1n
const administrator = 1n << 3n

const unsigned64 = (value: unknown): value is bigint =>
    typeof value === "bigint" && value >= 0n && value <= allPermissions

const inputFailure = (operation: "permissions.calculate" | "permissions.fetch") =>
    new GuildOperationError(operation, "input", "notDispatched")

const timeoutFailure = () => new GuildOperationError("permissions.fetch", "timeout", "notDispatched")

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

function validateMember(value: unknown, guildId: string): PermissionMember | undefined {
    if (!record(value) || value.guildId !== guildId || !identifier(value.userId) || !Array.isArray(value.roleIds))
        return undefined
    const roleIds: string[] = []
    const seen = new Set<string>()
    for (const roleId of value.roleIds) {
        if (!identifier(roleId) || roleId === guildId || seen.has(roleId)) return undefined
        seen.add(roleId)
        roleIds.push(roleId)
    }
    return { guildId, userId: value.userId, roleIds }
}

function validateRoles(
    value: unknown,
    guildId: string,
    member: PermissionMember,
): ReadonlyMap<string, PermissionRole> | undefined {
    if (!Array.isArray(value)) return undefined
    const roles = new Map<string, PermissionRole>()
    for (const role of value) {
        if (
            !record(role) ||
            role.guildId !== guildId ||
            !identifier(role.id) ||
            !unsigned64(role.permissions) ||
            roles.has(role.id)
        )
            return undefined
        roles.set(role.id, { id: role.id, guildId: role.guildId, permissions: role.permissions })
    }
    if (!roles.has(guildId) || member.roleIds.some((roleId) => !roles.has(roleId))) return undefined
    return roles
}

function decodeOverwrite(value: unknown, seen: Set<string>): PermissionOverwrite | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        (value.type !== "role" && value.type !== "member") ||
        !unsigned64(value.allow) ||
        !unsigned64(value.deny)
    )
        return undefined
    const key = `${value.type}:${value.id}`
    if (seen.has(key)) return undefined
    seen.add(key)
    return { id: value.id, type: value.type, allow: value.allow, deny: value.deny }
}

function validateChannel(value: unknown, guildId: string): PermissionChannel | undefined {
    if (!record(value) || value.guildId !== guildId || !identifier(value.id) || !("permissionOverwrites" in value))
        return undefined
    const overwrites = value.permissionOverwrites
    if (!Array.isArray(overwrites)) return undefined
    const seen = new Set<string>()
    const decoded: PermissionOverwrite[] = []
    for (const overwrite of overwrites) {
        const valid = decodeOverwrite(overwrite, seen)
        if (!valid) return undefined
        decoded.push(valid)
    }
    return { id: value.id, guildId: value.guildId, permissionOverwrites: decoded }
}

function validateInput(value: unknown): ValidatedInput | undefined {
    if (!record(value) || !record(value.guild) || !identifier(value.guild.id) || !identifier(value.guild.ownerId))
        return undefined
    const guild: PermissionGuild = { id: value.guild.id, ownerId: value.guild.ownerId }
    const member = validateMember(value.member, guild.id)
    if (!member) return undefined
    const roles = validateRoles(value.roles, guild.id, member)
    if (!roles) return undefined
    const channel = value.channel === undefined ? undefined : validateChannel(value.channel, guild.id)
    if (value.channel !== undefined && !channel) return undefined
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
    return Effect.suspend(() => {
        const validated = validateInput(input)
        return validated ? Effect.succeed(calculate(validated)) : Effect.fail(inputFailure("permissions.calculate"))
    })
}

function validateTarget(value: unknown): ValidatedTarget | undefined {
    if (
        !record(value) ||
        Object.keys(value).some((key) => key !== "guildId" && key !== "userId" && key !== "channelId") ||
        !identifier(value.guildId) ||
        !identifier(value.userId) ||
        (value.channelId !== undefined && !identifier(value.channelId))
    )
        return undefined
    return { guildId: value.guildId, userId: value.userId, channelId: value.channelId }
}

function validOptions(value: unknown): value is GuildOperationOptions | undefined {
    return (
        value === undefined ||
        (record(value) &&
            Object.keys(value).every((key) => key === "timeoutMs" || key === "signal") &&
            (value.signal === undefined ||
                (record(value.signal) &&
                    typeof value.signal.aborted === "boolean" &&
                    typeof value.signal.addEventListener === "function" &&
                    typeof value.signal.removeEventListener === "function")) &&
            (value.timeoutMs === undefined ||
                (typeof value.timeoutMs === "number" &&
                    Number.isSafeInteger(value.timeoutMs) &&
                    value.timeoutMs > 0 &&
                    value.timeoutMs <= 2_147_483_647)))
    )
}

function remainingOptions(deadline: number): GuildOperationOptions | undefined {
    const remaining = Math.floor(deadline - performance.now())
    return remaining > 0 ? { timeoutMs: remaining } : undefined
}

function remoteCalculationFailure(error: GuildOperationError): GuildOperationError {
    return new GuildOperationError(
        "permissions.fetch",
        error.reason === "input" ? "response" : error.reason,
        error.outcome,
    )
}

/**
 * Fetches independent guild, member, role, and optional channel observations, then calculates their raw bitfield
 *
 * This always reads remotely without consulting local caches. Its deadline covers the whole composition, but the
 * resulting observations are not transactional and do not establish access, hierarchy, timeouts, or action success
 */
export function fetchPermissions(
    owner: ClientOwner,
    target: PermissionTarget,
    options?: GuildOperationOptions,
): Effect.Effect<bigint, GuildOperationFailure | ChannelOperationFailure> {
    return Effect.suspend(() => {
        const targetSnapshot = validateTarget(target)
        if (!targetSnapshot || !validOptions(options)) return Effect.fail(inputFailure("permissions.fetch"))
        const deadline = performance.now() + (options?.timeoutMs ?? 30_000)
        const requestOptions = () => remainingOptions(deadline)
        const timedOut = () => Effect.fail(timeoutFailure())
        return Effect.gen(function* () {
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
