import type { DefaultPrefixCommandContext, DefaultPrefixCommandGuard } from "#sdk/default-commands"
import type { PermissionName } from "#sdk/helpers"
import type { Message, MessageCore } from "#sdk/messages"
import type { GuildRole } from "#sdk/guilds"
import {
    guardDenials,
    inGuild,
    missingPermissions,
    notPrivateChannel,
    ownerIds as validOwnerIds,
    permissionNames,
    readChannelOverwrites,
    withKnownOverwrites,
} from "#sdk/internal/command-guards"
import { orThrow } from "./results.js"

/**
 * Built-in command guards for the most common access rules. Pass one or a list as a command's `guard`.
 * Each denial carries a short reason that `onReject: "reply"` sends to the user.
 * Invalid guard settings throw ConfigurationError when the guard is created
 *
 * @example
 * ```ts
 * import { guards, runBot } from "@neontechspace/fluxerly"
 *
 * export function moderationBot(token: string | undefined) {
 *     return runBot({
 *         token,
 *         commands: {
 *             prefix: "!",
 *             commands: {
 *                 purge: {
 *                     guard: [guards.guildOnly(), guards.requirePermissions(["ManageMessages"])],
 *                     execute: ({ reply }) => reply("Purging"),
 *                 },
 *             },
 *         },
 *     })
 * }
 * ```
 *
 * @category Commands
 */
export interface DefaultGuards {
    /**
     * Allow the command only for a message that carries its community's guildId, and deny every other message without a
     * request. Fluxer's gateway supplies the guildId with every community message, so a message without one is denied even
     * when its channel belongs to a community
     */
    guildOnly<M extends MessageCore = Message>(): DefaultPrefixCommandGuard<M>
    /**
     * Allow the command only in a confirmed one-to-one or group conversation, and deny every other message.
     * A message with a guildId is denied without a request. For a message without one, the guard checks the
     * direct-message cache, then the channel cache, and otherwise reads the channel once with directMessages.fetch,
     * which also fills an enabled direct-message cache. Enable `cache.directMessages` to avoid a read for each
     * invocation in the same conversation.
     * A private conversation allows the command. A cached community channel, or a read that Fluxer answers with anything
     * other than a private conversation, denies it. Any other read failure, such as a network failure, timeout or
     * rejection, leaves the channel unconfirmed and fails the command, which is reported with the command name
     */
    dmOnly<M extends MessageCore = Message>(): DefaultPrefixCommandGuard<M>
    /** Allow the command only for the given decimal user IDs, such as the bot owner's */
    ownerOnly<M extends MessageCore = Message>(ownerIds: string | readonly string[]): DefaultPrefixCommandGuard<M>
    /**
     * Allow the command only when the invoking member has every named permission in the message's channel, and deny it in
     * direct messages. The guard reads the community, member, roles and channel from enabled caches first and fetches only
     * what is missing, at most once each per invocation, then applies permissions.calculate.
     * A cached channel without its overwrite list is read again instead of being treated as having no overwrites.
     * A channel read that Fluxer answers without an overwrite list has no channel overwrites, so the member's role
     * permissions decide.
     * A failed read fails the command, which is reported with the command name.
     * The decision does not guarantee that Fluxer allows a later action
     */
    requirePermissions<M extends MessageCore = Message>(names: readonly PermissionName[]): DefaultPrefixCommandGuard<M>
}

/**
 * Built-in command guards, namely guildOnly, dmOnly, ownerOnly and requirePermissions
 *
 * @category Commands
 */
export const guards: DefaultGuards = Object.freeze({
    guildOnly:
        <M extends MessageCore>(): DefaultPrefixCommandGuard<M> =>
        ({ message }) =>
            inGuild(message) || { deny: guardDenials.guildOnly },
    dmOnly:
        <M extends MessageCore>(): DefaultPrefixCommandGuard<M> =>
        async ({ client, message, signal }) => {
            const denied = { deny: guardDenials.dmOnly }
            if (inGuild(message)) return denied
            if (client.directMessages.get(message.channelId) !== undefined) return true
            if (client.channels.get(message.channelId) !== undefined) return denied
            const read = await client.directMessages.fetch(message.channelId, { signal })
            if (read.isOk()) return true
            // A non-private answer is the expected result in a community channel and becomes the reported denial
            if (notPrivateChannel(read.error)) return denied
            throw read.error
        },
    ownerOnly: <M extends MessageCore>(ownerIds: string | readonly string[]): DefaultPrefixCommandGuard<M> => {
        const owners = validOwnerIds(ownerIds)
        return ({ message }) => owners.has(message.author.id) || { deny: guardDenials.ownerOnly }
    },
    requirePermissions: <M extends MessageCore>(names: readonly PermissionName[]): DefaultPrefixCommandGuard<M> => {
        const required = permissionNames(names)
        return async (context) => {
            if (!inGuild(context.message)) return { deny: guardDenials.guildOnly }
            const missing = missingPermissions(await memberPermissions(context), required)
            return missing.length === 0 || { deny: guardDenials.missing(missing) }
        }
    },
})

/** Calculate the invoking member's channel permissions, reading each resource from the cache before fetching it */
async function memberPermissions<M extends MessageCore>(context: DefaultPrefixCommandContext<M>): Promise<bigint> {
    const { client, message, signal } = context
    const guildId = message.guildId!
    const target = { guildId, userId: message.author.id }
    const options = { signal }
    const guild = client.guilds.get(guildId) ?? orThrow(await client.guilds.fetch(guildId, options))
    const member = client.members.get(target) ?? orThrow(await client.members.fetch(target, options))
    const cached = [guildId, ...member.roleIds].map((id) => client.roles.get({ guildId, id }))
    const roles = cached.every((role): role is GuildRole => role !== undefined)
        ? cached
        : orThrow(await client.roles.fetchAll(guildId, options))
    const channel =
        withKnownOverwrites(client.channels.get(message.channelId)) ??
        readChannelOverwrites(orThrow(await client.channels.fetch(message.channelId, options)))
    return client.permissions.calculate({ guild, member, roles, channel })
}
