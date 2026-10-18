/**
 * Permission calculation from explicit guild, member, role and channel data.
 * Invariant: Results are checks for the supplied data, never action authorization, and Fluxer stays authoritative.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Effect from "effect/Effect"
import { isThreadChannel } from "#sdk/channels"
import type { ChannelOperationFailure, GuildChannel, PermissionOverwrite } from "#sdk/channels"
import type { GuildOperationFailure, GuildOperationOptions, GuildRole } from "#sdk/guilds"
import { ClientClosedError } from "#sdk/errors"
import { GuildOperationError, Permissions } from "#sdk/guilds"
import { closedBeforeSend } from "#sdk/internal/rest/closed"
import { composedStepFacts } from "#sdk/api-errors"
import type { PermissionFetchOptions, PermissionInput, PermissionTarget } from "#sdk/permissions"
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
    /** The target channel, or a thread's parent channel when inThread is set */
    readonly channel: PermissionChannel | undefined
    readonly inThread: boolean
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

/** The parent channel ID of a thread in the guild, or undefined when the thread's guild or IDs are invalid */
function threadParentId(value: unknown, guildId: string): string | undefined {
    if (!record(value) || value.guildId !== guildId || !identifier(value.id)) return undefined
    const parentId = value.parentId
    return identifier(parentId) ? parentId : undefined
}

function validateChannels(
    channelInput: unknown,
    parentInput: unknown,
    guildId: string,
): Pick<ValidatedInput, "channel" | "inThread"> | InputValidationFailure {
    if (channelInput === undefined || !isThreadChannel(channelInput as GuildChannel)) {
        if (parentInput !== undefined)
            return inputValidationFailure(
                "input.parentChannel",
                "relationship",
                "Permission parentChannel is supported only when channel is a thread",
            )
        if (channelInput === undefined) return { channel: undefined, inThread: false }
        const channel = validateChannel(channelInput, guildId)
        if (!channel)
            return inputValidationFailure(
                "input.channel",
                "format",
                "Permission channel must match the guild and contain unique valid role or member overwrites",
            )
        return { channel, inThread: false }
    }
    // A thread has no overwrites of its own, so Fluxer calculates its permissions in the parent channel
    const parentId = threadParentId(channelInput, guildId)
    if (parentId === undefined)
        return inputValidationFailure(
            "input.channel",
            "format",
            "Permission thread must match the guild and contain decimal thread and parent channel IDs",
        )
    if (parentInput === undefined)
        return inputValidationFailure(
            "input.parentChannel",
            "required",
            "Permission parentChannel is required when channel is a thread, because a thread takes its parent's permissions",
        )
    const parent = validateChannel(parentInput, guildId)
    if (!parent)
        return inputValidationFailure(
            "input.parentChannel",
            "format",
            "Permission parentChannel must match the guild and contain unique valid role or member overwrites",
        )
    if (parent.id !== parentId)
        return inputValidationFailure(
            "input.parentChannel",
            "relationship",
            "Permission parentChannel must be the channel that the thread's parentId names",
        )
    return { channel: parent, inThread: true }
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
    const channels = validateChannels(value.channel, value.parentChannel, guild.id)
    if (channels instanceof InputValidationFailure) return channels
    return { guild, member, roles, ...channels }
}

function applyOverwrite(permissions: bigint, overwrite: PermissionOverwrite): bigint {
    return (permissions & ~overwrite.deny) | overwrite.allow
}

/** Fluxer's thread rule: SendMessages in a thread follows SendMessagesInThreads in its parent, whichever way it is set */
function threadPermissions(parentPermissions: bigint): bigint {
    const withoutSend = parentPermissions & ~Permissions.SendMessages
    return (parentPermissions & Permissions.SendMessagesInThreads) === Permissions.SendMessagesInThreads
        ? withoutSend | Permissions.SendMessages
        : withoutSend
}

function calculate(input: ValidatedInput): bigint {
    const { guild, member, roles, channel, inThread } = input
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

    return inThread ? threadPermissions(permissions) : permissions
}

/**
 * Calculates Fluxer's raw guild, explicit-channel or thread permission bitfield from one validated local snapshot.
 * A thread is calculated in its parent channel, matching upstream threadViewPermissions in
 * packages/constants/src/ThreadPermissionUtils.ts at 4749eb7f
 */
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

function validateOptions(value: unknown): PermissionFetchOptions | InputValidationFailure {
    if (value === undefined) return {}
    if (!record(value)) return inputValidationFailure("options", "type", "Permission fetch options must be an object")
    const unsupported = unsupportedKeyFailure(
        value,
        ["timeoutMs", "signal", "preferCache"],
        "options",
        "the permission fetch options",
    )
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
    const preferCache = value.preferCache
    if (preferCache !== undefined && typeof preferCache !== "boolean")
        return inputValidationFailure("options.preferCache", "type", "Permission fetch preferCache must be a boolean")
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
    // Keep only the validated settings: The requests use their own remaining deadlines
    return { ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(preferCache === undefined ? {} : { preferCache }) }
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
 * A cached channel observation usable for permission calculation, or undefined when it must be read.
 * A thread needs only its parent ID, because it takes its permissions from its parent channel, which is read
 * separately. A cached channel without its overwrite list is read again, because calculating without unknown overwrites
 * could grant a permission that the channel denies
 */
const cachedPermissionChannel = (channel: GuildChannel | undefined): GuildChannel | undefined =>
    isThreadChannel(channel) || channel?.permissionOverwrites !== undefined ? channel : undefined

/**
 * Failures of permissions.fetch whose channel permissions cannot be confirmed: Fluxer sent a non-thread channel without
 * its permission overwrite list. Fluxer sends the list empty when there are no overwrites, so a missing list is never
 * read as "none"
 */
const unconfirmedFailures = new WeakSet<object>()

/** Whether an error is a permissions.fetch failure because the channel's permissions cannot be confirmed */
export const isUnconfirmedPermissions = (error: unknown): boolean =>
    typeof error === "object" && error !== null && unconfirmedFailures.has(error)

function unconfirmedFailure(channelId: string): GuildOperationError {
    // The channel read was sent and answered, so the failure follows other unusable responses of a read: Unknown outcome,
    // marked as a read, so it cannot have changed anything
    const failure = new GuildOperationError({
        operation: "permissions.fetch",
        reason: "response",
        outcome: "unknown",
        status: 200,
        responseField: "permissionOverwrites",
        read: true,
    })
    // Name the channel and the way out, which the shared error options have no place for
    Object.assign(failure, {
        hint: "Fluxer sent this channel without its permission overwrite list, so its permissions cannot be confirmed. Check the channel's permissions in Fluxer, or update the SDK if its channel type is new",
        details: Object.freeze({ ...failure.details, channelId }),
    })
    unconfirmedFailures.add(failure)
    return failure
}

/** Map a cache lookup refused by a closing client to the closure that REST reads report, as no request was sent */
const closedBeforeRead = <A, E>(lookup: Effect.Effect<A, E>) =>
    lookup.pipe(Effect.mapError((error) => (error instanceof ClientClosedError ? closedBeforeSend() : error)))

/**
 * Fetches independent guild, member, role, and optional channel observations, then calculates their raw bitfield.
 * A thread channel adds a read of its parent channel, whose permissions the thread takes
 *
 * By default this reads remotely without consulting local caches. With preferCache, each observation comes from an
 * enabled cache when it can be used and is read remotely otherwise. Its deadline covers the whole composition and
 * is checked only before a remote read. The resulting observations are not transactional and do not establish access,
 * hierarchy, timeouts, or action success
 */
export function fetchPermissions(
    owner: Pick<ClientOwner, "guild" | "channel" | "logical" | "getResource" | "getChannel"> & {
        readonly defaultTimeoutMs?: number
    },
    target: PermissionTarget,
    options?: PermissionFetchOptions,
): Effect.Effect<bigint, GuildOperationFailure | ChannelOperationFailure> {
    // Reading and validating the caller target and options is marked as application input
    return suspendInput(() => {
        const targetSnapshot = validateTarget(target)
        if (targetSnapshot instanceof InputValidationFailure)
            return Effect.fail(inputFailure("permissions.fetch", targetSnapshot))
        const validatedOptions = validateOptions(options)
        if (validatedOptions instanceof InputValidationFailure)
            return Effect.fail(inputFailure("permissions.fetch", validatedOptions))
        const { guildId, userId, channelId } = targetSnapshot
        const preferCache = validatedOptions.preferCache === true
        return Effect.gen(function* () {
            const now = () => owner.logical.now()
            const deadline = now() + (validatedOptions.timeoutMs ?? owner.defaultTimeoutMs ?? 30_000)
            // Each remote read gets the time left, and none starts once the deadline has passed. Cache reads need no time
            const remote = <A, E>(run: (budget: GuildOperationOptions) => Effect.Effect<A, E>) => {
                const remaining = remainingOptions(deadline, now)
                return remaining ? run(remaining) : Effect.fail(timeoutFailure())
            }
            const readChannel = (id: string) =>
                Effect.gen(function* () {
                    const cached = preferCache
                        ? cachedPermissionChannel(yield* closedBeforeRead(owner.getChannel(id)))
                        : undefined
                    if (cached) return cached
                    const fetched = yield* remote((budget) =>
                        owner.channel("channels.fetch", () => channelFetch(id), budget),
                    )
                    // Only a thread takes its permissions from elsewhere, so any other channel needs its overwrite list
                    if (!isThreadChannel(fetched) && fetched.permissionOverwrites === undefined)
                        return yield* Effect.fail(unconfirmedFailure(id))
                    return fetched
                })

            const guild =
                (preferCache ? yield* closedBeforeRead(owner.getResource("guilds", guildId)) : undefined) ??
                (yield* remote((budget) => owner.guild("guilds.fetch", () => guildFetch(guildId), budget)))

            const member =
                (preferCache
                    ? yield* closedBeforeRead(owner.getResource("members", { guildId, userId }))
                    : undefined) ??
                (yield* remote((budget) => owner.guild("members.fetch", () => memberFetch(targetSnapshot), budget)))

            // The everyone role and every member role must be cached, or one list read replaces them all
            let roles: GuildRole[] | undefined
            if (preferCache) {
                const cached = yield* Effect.forEach([guildId, ...member.roleIds], (id) =>
                    closedBeforeRead(owner.getResource("roles", { guildId, id })),
                )
                if (cached.every((role): role is GuildRole => role !== undefined)) roles = cached
            }
            roles ??= [...(yield* remote((budget) => owner.guild("roles.fetchAll", () => roleList(guildId), budget)))]

            const channel = channelId === undefined ? undefined : yield* readChannel(channelId)
            // A thread takes its permissions from its parent channel, read under the same deadline
            const parentChannel = isThreadChannel(channel) ? yield* readChannel(channel.parentId) : undefined

            return yield* calculatePermissions({
                guild,
                member,
                roles,
                ...(channel === undefined ? {} : { channel }),
                ...(parentChannel === undefined ? {} : { parentChannel }),
            }).pipe(Effect.mapError(remoteCalculationFailure))
        })
    })
}
