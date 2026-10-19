/**
 * Gateway cache intake: How decoded events, raw guild dispatches and skipped malformed dispatches update or invalidate
 * the client's message, guild, channel and user caches.
 * Invariant: Fluxer is the source of truth, and intake runs before subscriber delivery, so a subscriber never observes
 * a cache older than the event it is handling. A skipped dispatch clears every entry it could have changed.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { GuildChannel } from "#sdk/channels"
import type { EventMap, EventName } from "#sdk/events"
import type { Message, MessageCore } from "#sdk/messages"
import type { User } from "#sdk/users"
import type { MessageCache } from "../cache.js"
import type { ChannelCache } from "../channel-cache.js"
import { identifier, record } from "../decode/primitives.js"
import { isMessageEvent } from "../events.js"
import type { GuildCache } from "../guild-cache.js"
import { memberDecoratedDispatches } from "../guilds.js"
import type { ClientLogger } from "../logging.js"
import { threadParentTypes } from "../thread-events.js"
import type { UserCache } from "../user-cache.js"

/** The caches one client owns. Only the user cache is always present */
export interface ClientCaches<M extends MessageCore> {
    readonly cache: MessageCache<M> | undefined
    readonly resources: GuildCache | undefined
    readonly channelCache: ChannelCache | undefined
    readonly userCache: UserCache
    /** Records threads that a community snapshot carried in a malformed form */
    readonly logging: ClientLogger
    /** The bot account ID once READY or a self read supplied it, which tells whether a thread member change is the bot's */
    readonly botUserId: string | undefined
    /** The bot's own account from READY, which completes its startup community memberships */
    readonly botUser: User | undefined
}

/** Clear every cache without closing it */
export function clearCaches<M extends MessageCore>(caches: ClientCaches<M>) {
    caches.cache?.clear()
    caches.resources?.clear()
    caches.channelCache?.clear()
    caches.userCache.clear()
}

/** Apply one decoded event to the caches before it is offered to subscribers */
export function applyEvent<M extends MessageCore, K extends EventName>(
    caches: ClientCaches<M>,
    event: K,
    message: EventMap<M>[K],
) {
    const { cache, resources, channelCache, userCache } = caches
    resources?.event(event, message)
    channelCache?.event(event, message)
    if (event === "userUpdate" && "discriminator" in message) {
        const guard = userCache.begin("users", { id: message.id })
        userCache.complete(guard, [message])
        userCache.invalidate("directMessages")
    }
    if (event === "guildMemberUpdate") {
        const member = message as EventMap["guildMemberUpdate"]
        // Member projections omit complete account fields, so evict rather than fabricate a User snapshot.
        // A collection fence also covers pending DM reads whose recipients are not known until completion
        userCache.invalidate("users", member.userId)
        userCache.invalidate("directMessages")
    }
    if ((event === "directMessageCreate" || event === "directMessageUpdate") && "recipients" in message) {
        const guard = userCache.begin("directMessages", { id: message.id })
        userCache.complete(guard, [message])
    }
    if (
        event === "directMessageRecipientAdd" ||
        event === "directMessageRecipientRemove" ||
        event === "directMessageDelete"
    ) {
        const id = "channelId" in message ? message.channelId : "id" in message ? message.id : undefined
        userCache.invalidate("directMessages", typeof id === "string" ? id : undefined)
    }
    if (event === "directMessageDelete" && "id" in message) cache?.deleteChannel(message.id)
    if (event === "guildChannelDelete" || event === "threadDelete" || event === "threadMembersUpdate")
        applyThreadEffects(caches, event, message)
    // The cache keeps no member snapshot: It would go stale unseen, and REST copies of the message never carry it.
    // The member cache holds the current one. The fields only MESSAGE_CREATE carries stay out too, so a cached message
    // never mixes them with the update that follows
    if (isMessageEvent<typeof event, M>(event, message)) cache?.observe(withoutMember(message))
    else if ("ids" in message) {
        for (const id of message.ids) cache?.delete({ id, channelId: message.channelId })
    } else if (event === "messageDelete" && "id" in message && "channelId" in message) cache?.delete(message)
}

/**
 * The message the handlers received, or a frozen copy without the fields only a gateway event carries, never mutating the
 * delivered object. Those are the member, which would go stale unseen, and the fields of a created message, which a later
 * update does not repeat
 */
function withoutMember<M extends MessageCore>(message: M): M {
    if (!gatewayOnlyFields.some((field) => field in message)) return message
    const {
        member: _member,
        mentionedHere: _here,
        channelType: _type,
        nicknames: _nicks,
        ...rest
    } = message as M & Partial<Pick<Message, "member" | "mentionedHere" | "channelType" | "nicknames">>
    return Object.freeze(rest) as unknown as M
}

const gatewayOnlyFields = ["member", "mentionedHere", "channelType", "nicknames"] as const

/** Apply a channel deletion's or thread event's effects on cached messages and on the bot's cached thread memberships */
function applyThreadEffects<M extends MessageCore>(
    caches: ClientCaches<M>,
    event: "guildChannelDelete" | "threadDelete" | "threadMembersUpdate",
    message: EventMap<M>[EventName],
) {
    const { cache, channelCache } = caches
    if (event === "guildChannelDelete") {
        const channel = message as GuildChannel
        cache?.deleteChannel(channel.id)
        // Fluxer deletes a parent's threads without THREAD_DELETE, and a message does not record its thread's parent.
        // The channel cache already evicted the parent's threads, so every channel it still holds is placed elsewhere
        if (threadParentTypes.has(channel.type))
            cache?.deleteUnplaced(channel.guildId, (channelId) => channelCache?.holds(channelId) === true)
    } else if (event === "threadDelete") cache?.deleteChannel((message as EventMap["threadDelete"]).id)
    else {
        const update = message as EventMap["threadMembersUpdate"]
        const self = caches.botUserId
        // The cached thread carries the bot's membership, so a change that may be the bot's makes it stale
        const named =
            self === undefined
                ? update.added.length > 0 || update.removedUserIds.length > 0
                : update.added.some((member) => member.userId === self) || update.removedUserIds.includes(self)
        if (named) channelCache?.evictThread(update.threadId, update.guildId)
    }
}

/**
 * Raw guild lifecycle, expression, own thread membership and attached member intake, or undefined when no cache can use it.
 * The members that message, reaction and typing dispatches carry reach only the member cache
 */
export function guildIntake<M extends MessageCore>(
    caches: ClientCaches<M>,
): ((event: string, value: unknown) => void) | undefined {
    const { cache, resources, channelCache, logging } = caches
    if (!resources && !channelCache && !cache) return undefined
    return (event, value) => {
        if (memberDecoratedDispatches.has(event)) {
            // Only the member cache reads the decoration, whatever message fields the subscribers selected
            if (resources?.decoratedEvent(event, value)) {
                const guildId = record(value) && identifier(value.guild_id) ? value.guild_id : undefined
                logging.log({
                    level: "warn",
                    category: "gateway",
                    code: "gateway.memberSkipped",
                    message: `Skipped the member of a ${event} dispatch${guildId === undefined ? "" : ` in community ${guildId}`} because its data did not match the expected shape. The member cache dropped its entry for the account, and handlers still receive the event without the member`,
                    fields: { dispatch: event, ...(guildId === undefined ? {} : { guildId }) },
                })
            }
            return
        }
        if (event === "THREAD_MEMBER_UPDATE") {
            // The dispatch table validated the body first. A cached thread carries the bot's membership, now stale
            if (record(value) && identifier(value.id) && identifier(value.guild_id))
                channelCache?.evictThread(value.id, value.guild_id)
            return
        }
        resources?.guildEvent(event, value, caches.botUser)
        if (event !== "GUILD_EMOJIS_UPDATE" && event !== "GUILD_STICKERS_UPDATE")
            for (const field of channelCache?.guildEvent(event, value) ?? [])
                logging.log({
                    level: "warn",
                    category: "gateway",
                    code: "gateway.threadSkipped",
                    message: `Skipped a thread in a ${event} dispatch because its data did not match the expected shape at ${field}. The channel cache does not hold it, and handlers still receive the community`,
                    fields: { dispatch: event, guildId: (value as { id: string }).id, field },
                })
        if (event === "GUILD_DELETE")
            cache?.gap((guildId) => guildId === undefined || (record(value) && value.id === guildId))
    }
}

/** Clear cached observations that a skipped malformed dispatch could have changed */
export function invalidateDispatch<M extends MessageCore>(caches: ClientCaches<M>, type: string, body: unknown) {
    const { cache, resources, channelCache, userCache } = caches
    const value = record(body) ? body : undefined
    if (memberDecoratedDispatches.has(type)) resources?.evictRejectedMember(type, value)
    if (type.startsWith("MESSAGE_")) {
        // Reactions never change cached message snapshots
        if (type.startsWith("MESSAGE_REACTION")) return
        if (value && identifier(value.channel_id)) {
            if (identifier(value.id)) cache?.delete({ id: value.id, channelId: value.channel_id })
            else cache?.deleteChannel(value.channel_id)
        } else if (value && identifier(value.id)) {
            // Without a usable channel the message can still be found by its ID, which is the cache key
            cache?.deleteId(value.id)
        } else if (value && identifier(value.guild_id)) {
            const guildId = value.guild_id
            cache?.gap((candidate) => candidate === undefined || candidate === guildId)
        } else cache?.gap()
        return
    }
    if (
        type === "TYPING_START" ||
        type.startsWith("PRESENCE_UPDATE") ||
        type.startsWith("INVITE_") ||
        type === "WEBHOOKS_UPDATE" ||
        type === "VOICE_STATE_UPDATE" ||
        type === "GUILD_AUDIT_LOG_ENTRY_CREATE" ||
        type === "GUILD_HEALTH_UPDATE" ||
        // Calls and entrance sounds feed no cache category
        type.startsWith("CALL_") ||
        type === "ENTRANCE_SOUND_PLAY"
    )
        return
    if (type === "USER_UPDATE") {
        userCache.invalidate("users")
        return
    }
    if (type.startsWith("THREAD_")) {
        invalidateThreadDispatch(caches, type, value)
        return
    }
    if (type === "GUILD_MEMBER_UPDATE") {
        const userId = value && record(value.user) && identifier(value.user.id) ? value.user.id : undefined
        userCache.invalidate("users", userId)
        userCache.invalidate("directMessages")
    }
    const guildId =
        value && identifier(value.guild_id)
            ? value.guild_id
            : value && type.startsWith("GUILD_") && identifier(value.id)
              ? value.id
              : undefined
    if (guildId !== undefined) {
        const affects = (candidate: string | null | undefined) => candidate === undefined || candidate === guildId
        cache?.gap(affects)
        resources?.gap(affects)
        channelCache?.gap(affects)
        return
    }
    if (type.startsWith("CHANNEL_")) {
        userCache.invalidate("directMessages")
        // Without a usable guild ID the affected guild is unknown, and a category change can reorder its siblings,
        // so the channel cache is cleared entirely
        channelCache?.gap()
        if (value && identifier(value.id)) cache?.deleteChannel(value.id)
        else cache?.gap()
        return
    }
    clearCaches(caches)
}

/**
 * Clear what a skipped thread dispatch could have changed: Only cached threads, and for a deletion also the thread's
 * messages. THREAD_LIST_SYNC names its guild in guild_id, and each other type also names its thread in id
 */
function invalidateThreadDispatch<M extends MessageCore>(
    caches: ClientCaches<M>,
    type: string,
    value: Record<string, unknown> | undefined,
) {
    const { cache, channelCache } = caches
    const guildId = value && identifier(value.guild_id) ? value.guild_id : undefined
    const threadId = type !== "THREAD_LIST_SYNC" && value && identifier(value.id) ? value.id : undefined
    const affects =
        guildId === undefined
            ? undefined
            : (candidate: string | null | undefined) => candidate === undefined || candidate === guildId
    if (threadId !== undefined) channelCache?.evictThread(threadId, guildId)
    else channelCache?.gap(affects)
    if (type !== "THREAD_DELETE") return
    if (threadId !== undefined) cache?.deleteChannel(threadId)
    else cache?.gap(affects)
}
