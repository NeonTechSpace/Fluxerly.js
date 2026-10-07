import * as Effect from "effect/Effect"
import type { NativePrefixCommandContext, NativePrefixCommandGuard } from "#sdk/native-commands"
import type { PrefixCommandGuardResult } from "#sdk/commands"
import type { PermissionName } from "#sdk/helpers"
import type { Message, MessageCore } from "#sdk/messages"
import type { ChannelOperationFailure } from "#sdk/channels"
import type { GuildOperationFailure, GuildRole } from "#sdk/guilds"
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
    readChannelOverwrites,
    withKnownOverwrites,
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
     * direct messages. The guard reads the community, member, roles and channel from enabled caches first and fetches only
     * what is missing, at most once each per invocation, then applies permissions.calculate.
     * A cached channel without its overwrite list is read again instead of being treated as having no overwrites.
     * A channel read that Fluxer answers without an overwrite list has no channel overwrites, so the member's role
     * permissions decide. A channel of a type this SDK version does not know, such as a thread, can take its permissions
     * from elsewhere, so a read of one without an overwrite list denies the command rather than guessing.
     * A failed read fails the command, which is reported with the command name.
     * The decision does not guarantee that Fluxer allows a later action
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
        return (context) =>
            inGuild(context.message)
                ? memberPermissions(context).pipe(
                      Effect.map((bits) => {
                          if (bits === undefined) return { deny: guardDenials.unconfirmedChannel }
                          const missing = missingPermissions(bits, required)
                          return missing.length === 0 || { deny: guardDenials.missing(missing) }
                      }),
                  )
                : Effect.succeed({ deny: guardDenials.guildOnly })
    },
})

/**
 * Calculate the invoking member's channel permissions, reading each resource from the cache before fetching it.
 * Undefined means the channel's permissions cannot be confirmed
 */
function memberPermissions<M extends MessageCore>(
    context: NativePrefixCommandContext<M>,
): Effect.Effect<bigint | undefined, GuildOperationFailure | ChannelOperationFailure> {
    const { client, message } = context
    const guildId = message.guildId!
    const target = { guildId, userId: message.author.id }
    const cachedOr = <A, E>(cached: Effect.Effect<A | undefined>, fetch: () => Effect.Effect<A, E>) =>
        cached.pipe(Effect.flatMap((value) => (value === undefined ? fetch() : Effect.succeed(value))))
    return Effect.gen(function* () {
        const guild = yield* cachedOr(client.guilds.get(guildId), () => client.guilds.fetch(guildId))
        const member = yield* cachedOr(client.members.get(target), () => client.members.fetch(target))
        const cached = yield* Effect.forEach([guildId, ...member.roleIds], (id) => client.roles.get({ guildId, id }))
        const roles = cached.every((role): role is GuildRole => role !== undefined)
            ? cached
            : yield* client.roles.fetchAll(guildId)
        const cachedChannel = client.channels.get(message.channelId).pipe(Effect.map(withKnownOverwrites))
        const channel = yield* cachedOr(cachedChannel, () =>
            client.channels.fetch(message.channelId).pipe(Effect.map(readChannelOverwrites)),
        )
        return channel && client.permissions.calculate({ guild, member, roles, channel })
    })
}
