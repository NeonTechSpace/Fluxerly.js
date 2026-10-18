import * as Effect from "effect/Effect"
import type { NativePrefixCommandGuard } from "#sdk/native-commands"
import type { PrefixCommandGuardResult } from "#sdk/commands"
import type { PermissionName } from "#sdk/helpers"
import type { Message, MessageCore } from "#sdk/messages"
import type { ChannelOperationFailure } from "#sdk/channels"
import type { GuildOperationFailure } from "#sdk/guilds"
import type { UserOperationFailure } from "#sdk/users"
import type { BotApplicationOperationFailure } from "#sdk/application"
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

/**
 * Built-in native command guards for the most common access rules. Pass one or a list as a command's `guard`.
 * Each denial carries a short reason that `onReject: "reply"` sends to the user.
 * Invalid guard settings throw ConfigurationError when the guard is created
 *
 * @category Commands
 */
export interface NativeGuards {
    /**
     * Allow the command only for a message that carries its community's guildId, and deny every other message without a
     * request. Fluxer's gateway supplies the guildId with every community message, so a message without one is denied even
     * when its channel belongs to a community
     */
    guildOnly<M extends MessageCore = Message>(): NativePrefixCommandGuard<never, never, M>
    /**
     * Allow the command only in a confirmed one-to-one or group conversation, and deny every other message.
     * A message with a guildId is denied without a request. For a message without one, the guard checks the
     * direct-message cache, then the channel cache, and otherwise reads the channel once with directMessages.fetch,
     * which also fills an enabled direct-message cache. Enable `cache.directMessages` to avoid a read for each
     * invocation in the same conversation.
     * A private conversation allows the command. A cached community channel, or a read that Fluxer answers with anything
     * other than a private conversation, denies it. Any other read failure, such as a network failure, timeout or
     * rejection, leaves the channel unconfirmed and fails the guard's Effect with that UserOperationFailure, which is
     * reported with the command name
     */
    dmOnly<M extends MessageCore = Message>(): NativePrefixCommandGuard<UserOperationFailure, never, M>
    /**
     * Allow the command only for the owner of the bot's application, as Fluxer reports it.
     * The first invocation reads the owner's user ID with application.fetch, and the guard keeps it for the rest of the
     * client's lifetime, so later invocations decide without a request and an ownership transfer applies to a new client.
     * Invocations that start before the first read completes each read it.
     * A failed read, such as a network failure, timeout or rejection, keeps nothing and fails the guard's Effect with
     * that BotApplicationOperationFailure, which is reported with the command name, and the next invocation reads again
     */
    ownerOnly<M extends MessageCore = Message>(): NativePrefixCommandGuard<BotApplicationOperationFailure, never, M>
    /**
     * Allow the command only for the given decimal user IDs, such as the bot owner's.
     * An undefined argument, such as an unset environment variable, throws ConfigurationError rather than falling back
     * to the application owner
     */
    ownerOnly<M extends MessageCore = Message>(
        ownerIds: string | readonly string[],
    ): NativePrefixCommandGuard<never, never, M>
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
    requirePermissions<M extends MessageCore = Message>(
        names: readonly PermissionName[],
    ): NativePrefixCommandGuard<GuildOperationFailure | ChannelOperationFailure, never, M>
}

/**
 * Built-in native command guards, namely guildOnly, dmOnly, ownerOnly and requirePermissions
 *
 * @example
 * ```ts
 * import { guards, runBot } from "@neontechspace/fluxerly/effect"
 *
 * export const moderationBot = (token: string | undefined) =>
 *     runBot({
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
 * ```
 *
 * @category Commands
 */
export const guards: NativeGuards = Object.freeze({
    guildOnly:
        <M extends MessageCore>(): NativePrefixCommandGuard<never, never, M> =>
        ({ message }) =>
            Effect.succeed(inGuild(message) || { deny: guardDenials.guildOnly }),
    dmOnly:
        <M extends MessageCore>(): NativePrefixCommandGuard<UserOperationFailure, never, M> =>
        ({ client, message }) =>
            Effect.gen(function* () {
                const denied = { deny: guardDenials.dmOnly }
                if (inGuild(message)) return denied
                if ((yield* client.directMessages.get(message.channelId)) !== undefined) return true
                if ((yield* client.channels.get(message.channelId)) !== undefined) return denied
                // A non-private answer is the expected result in a community channel and becomes the reported denial
                return yield* client.directMessages.fetch(message.channelId).pipe(
                    Effect.as<PrefixCommandGuardResult>(true),
                    Effect.catchIf(notPrivateChannel, () => Effect.succeed(denied)),
                )
            }),
    // The explicit-ID overload cannot fail, which this single implementation signature does not express
    ownerOnly: (<M extends MessageCore>(
        ...ownerIds: [] | [string | readonly string[]]
    ): NativePrefixCommandGuard<BotApplicationOperationFailure, never, M> => {
        const decide = (allowed: boolean): PrefixCommandGuardResult => allowed || { deny: guardDenials.ownerOnly }
        if (ownerIds.length === 0)
            return ({ client, message }) =>
                Effect.suspend(() => {
                    const known = applicationOwners.get(client)
                    if (known !== undefined) return Effect.succeed(decide(known === message.author.id))
                    return client.application.fetch().pipe(
                        Effect.map(({ ownerId }) => {
                            applicationOwners.set(client, ownerId)
                            return decide(ownerId === message.author.id)
                        }),
                    )
                })
        const owners = validOwnerIds(ownerIds[0])
        return ({ message }) => Effect.succeed(decide(owners.has(message.author.id)))
    }) as NativeGuards["ownerOnly"],
    requirePermissions: <M extends MessageCore>(
        names: readonly PermissionName[],
    ): NativePrefixCommandGuard<GuildOperationFailure | ChannelOperationFailure, never, M> => {
        const required = permissionNames(names)
        return ({ client, message }) =>
            inGuild(message)
                ? client.permissions
                      .fetch(
                          { guildId: message.guildId, userId: message.author.id, channelId: message.channelId },
                          { preferCache: true },
                      )
                      .pipe(
                          Effect.map((bits): PrefixCommandGuardResult => {
                              const missing = missingPermissions(bits, required)
                              return missing.length === 0 || { deny: guardDenials.missing(missing) }
                          }),
                          // The unconfirmed channel is an expected denial, any other failure fails the command
                          Effect.catchIf(unconfirmedPermissions, () =>
                              Effect.succeed<PrefixCommandGuardResult>({ deny: guardDenials.unconfirmedChannel }),
                          ),
                      )
                : Effect.succeed({ deny: guardDenials.guildOnly })
    },
})
