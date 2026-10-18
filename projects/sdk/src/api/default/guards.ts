import type { DefaultPrefixCommandGuard } from "#sdk/default-commands"
import type { PermissionName } from "#sdk/helpers"
import type { Message, MessageCore } from "#sdk/messages"
import {
    applicationOwners,
    guardDenials,
    inGuild,
    missingPermissions,
    notPrivateChannel,
    ownerIds as validOwnerIds,
    permissionNames,
    unconfirmedPermissions,
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
    /**
     * Allow the command only for the owner of the bot's application, as Fluxer reports it.
     * The first invocation reads the owner's user ID with application.fetch, and the guard keeps it for the rest of the
     * client's lifetime, so later invocations decide without a request and an ownership transfer applies to a new client.
     * Invocations that start before the first read completes each read it.
     * A failed read, such as a network failure, timeout or rejection, keeps nothing and fails the command, which is
     * reported with the command name, and the next invocation reads again
     */
    ownerOnly<M extends MessageCore = Message>(): DefaultPrefixCommandGuard<M>
    /**
     * Allow the command only for the given decimal user IDs, such as the bot owner's.
     * An undefined argument, such as an unset environment variable, throws ConfigurationError rather than falling back
     * to the application owner
     */
    ownerOnly<M extends MessageCore = Message>(ownerIds: string | readonly string[]): DefaultPrefixCommandGuard<M>
    /**
     * Allow the command only when the invoking member has every named permission in the message's channel, and deny it in
     * direct messages. The guard decides with permissions.fetch and preferCache: It reads the community, member, roles and
     * channel from enabled caches first and fetches only what is missing, at most once each per invocation, then applies
     * permissions.calculate. The reads share one deadline, rest.defaultTimeoutMs, and only fetches count toward it.
     * Cached observations reflect the last applied gateway events, so a permission change that Fluxer has made but the
     * gateway has not yet delivered is not seen. Where a stale grant matters, check again with permissions.fetch before acting.
     * A cached channel without its overwrite list is read again instead of being treated as having no overwrites.
     * In a thread, the guard also reads the thread's parent channel the same way, cache first, and decides as Fluxer
     * does: From the parent channel's permissions, with SendMessages granted exactly when SendMessagesInThreads is.
     * It does not check whether the member can see a private thread or whether the thread is archived or locked.
     * Fluxer sends a channel's permission overwrite list, empty when there are none. When Fluxer sent the channel
     * without its permission overwrite list, its permissions cannot be confirmed, so the guard denies the command
     * rather than guessing.
     * Every other failed read fails the command, which is reported with the command name.
     * The decision does not guarantee that Fluxer allows a later action. A timed-out member keeps its permission bits,
     * but Fluxer blocks sending, editing and publishing own messages, reacting, uploading, typing, changing the own
     * nickname, writing in threads and joining voice, so check members.timeoutState as well.
     * The denial names each missing permission by Fluxer's label, such as Manage community
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
    ownerOnly: <M extends MessageCore>(
        ...ownerIds: [] | [string | readonly string[]]
    ): DefaultPrefixCommandGuard<M> => {
        const denied = { deny: guardDenials.ownerOnly }
        if (ownerIds.length === 0)
            return async ({ client, message, signal }) => {
                let owner = applicationOwners.get(client)
                if (owner === undefined) {
                    owner = orThrow(await client.application.fetch({ signal })).ownerId
                    applicationOwners.set(client, owner)
                }
                return owner === message.author.id || denied
            }
        const owners = validOwnerIds(ownerIds[0])
        return ({ message }) => owners.has(message.author.id) || denied
    },
    requirePermissions: <M extends MessageCore>(names: readonly PermissionName[]): DefaultPrefixCommandGuard<M> => {
        const required = permissionNames(names)
        return async ({ client, message, signal }) => {
            if (!inGuild(message)) return { deny: guardDenials.guildOnly }
            const read = await client.permissions.fetch(
                { guildId: message.guildId, userId: message.author.id, channelId: message.channelId },
                { preferCache: true, signal },
            )
            if (read.isErr() && unconfirmedPermissions(read.error)) return { deny: guardDenials.unconfirmedChannel }
            const bits = orThrow(read)
            const missing = missingPermissions(bits, required)
            return missing.length === 0 || { deny: guardDenials.missing(missing) }
        }
    },
})
