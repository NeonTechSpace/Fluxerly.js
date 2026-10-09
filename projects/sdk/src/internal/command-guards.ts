/**
 * Built-in command guard rules shared by both API styles: Deny reasons, owner and permission-name validation, the
 * application owner behind ownerOnly without IDs, the private-channel confirmation behind dmOnly and the cache-first
 * permission reads behind requirePermissions.
 * Invariant: Guards read at most the guild, member, roles, channel and a thread's parent channel once per invocation,
 * using enabled caches before a request, never allow on an unconfirmed channel kind, and never retain a decision. The
 * only retained read is the application owner ID, kept per client after its first successful read
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { isThreadChannel, type GuildChannel } from "#sdk/channels"
import { ConfigurationError } from "#sdk/errors"
import { Permissions } from "#sdk/guilds"
import type { PermissionName } from "#sdk/helpers"
import type { MessageCore } from "#sdk/messages"
import { UserOperationError } from "#sdk/users"

/** Deny reasons the built-in guards return, written for a reply to the invoking user */
export const guardDenials = Object.freeze({
    guildOnly: "This command works only in a community",
    dmOnly: "This command works only in direct messages",
    ownerOnly: "This command is restricted to the bot owner",
    missing: (names: readonly string[]) => `Using this command requires these permissions: ${names.join(", ")}`,
    unconfirmedChannel: "This command cannot check permissions in this kind of channel",
})

/** Validate owner IDs when the guard is created, so a misconfigured guard fails at startup rather than per message */
export function ownerIds(value: unknown): ReadonlySet<string> {
    const list = typeof value === "string" ? [value] : value
    if (!Array.isArray(list) || list.length === 0)
        throw new ConfigurationError("command", "The ownerOnly guard needs one or more owner user IDs")
    for (const id of list)
        if (typeof id !== "string" || !/^[1-9]\d*$/.test(id))
            throw new ConfigurationError("command", "The ownerOnly guard needs each owner user ID as a decimal string")
    return new Set(list as string[])
}

/**
 * Application owner IDs that ownerOnly without IDs has read, keyed by the public client object passed to the guard.
 * An ID stays for the client's lifetime, so an ownership transfer applies to a new client, and a failed read is never stored
 */
export const applicationOwners = new WeakMap<object, string>()

/** Validate permission names when the guard is created */
export function permissionNames(value: unknown): readonly PermissionName[] {
    if (!Array.isArray(value) || value.length === 0)
        throw new ConfigurationError("command", "The requirePermissions guard needs one or more permission names")
    for (const name of value)
        if (typeof name !== "string" || !Object.hasOwn(Permissions, name))
            throw new ConfigurationError(
                "command",
                typeof name === "string" && name.length <= 64
                    ? `The requirePermissions guard got an unknown permission name ${JSON.stringify(name)}`
                    : "The requirePermissions guard needs permission names as strings",
                { hint: "Use names from Permissions, such as ManageMessages or BanMembers" },
            )
    return Object.freeze([...(value as PermissionName[])])
}

/** Permission names absent from calculated bits, in the order they were required */
export function missingPermissions(bits: bigint, names: readonly PermissionName[]): readonly PermissionName[] {
    return names.filter((name) => (bits & Permissions[name]) !== Permissions[name])
}

/** Whether a gateway message came from a guild. Gateway messages carry their guild ID, unlike HTTP message responses */
export const inGuild = (message: MessageCore): message is MessageCore & { readonly guildId: string } =>
    typeof message.guildId === "string"

/**
 * Whether a failed private-channel read proved that the channel is not a private conversation.
 * Fluxer answered, but not with a one-to-one or group conversation, for example with a guild channel.
 * Other failures, such as network errors, timeouts or rejections, leave the channel unconfirmed and fail the command
 */
export const notPrivateChannel = (error: unknown): boolean =>
    error instanceof UserOperationError && error.reason === "response"

/**
 * A cached channel observation usable for permission calculation, or undefined when it must be read.
 * A thread needs only its parent ID, because it takes its permissions from its parent channel, which is read
 * separately. A cached channel without its overwrite list is read again, because calculating without unknown overwrites
 * could grant a permission that the channel denies
 */
export const cachedPermissionChannel = (channel: GuildChannel | undefined): GuildChannel | undefined =>
    isThreadChannel(channel) || channel?.permissionOverwrites !== undefined ? channel : undefined

/**
 * A freshly read channel prepared for permission calculation, or undefined when its permissions cannot be confirmed.
 * A thread is used as read, because its permissions come from its parent channel. Fluxer's own response is
 * authoritative for a channel that holds its own overwrites, so a read without an overwrite list has no channel
 * overwrites and the member's role permissions apply unchanged. A channel of a type this SDK version does not know may
 * take its permissions from elsewhere, so a missing list there leaves them unknown
 */
export const fetchedPermissionChannel = (channel: GuildChannel): GuildChannel | undefined => {
    if (isThreadChannel(channel) || channel.permissionOverwrites !== undefined) return channel
    if (channel.type === "unknown") return undefined
    return Object.freeze({ ...channel, permissionOverwrites: Object.freeze([]) }) as GuildChannel
}
