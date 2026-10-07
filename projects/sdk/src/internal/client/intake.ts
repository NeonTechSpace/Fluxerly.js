/**
 * Gateway cache intake: How decoded events, raw guild dispatches and skipped malformed dispatches update or invalidate
 * the client's message, guild, channel and user caches.
 * Invariant: Fluxer is the source of truth, and intake runs before subscriber delivery, so a subscriber never observes
 * a cache older than the event it is handling. A skipped dispatch clears every entry it could have changed.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { EventMap, EventName } from "#sdk/events"
import type { MessageCore } from "#sdk/messages"
import type { MessageCache } from "../cache.js"
import type { ChannelCache } from "../channel-cache.js"
import { identifier, record } from "../decode/primitives.js"
import { isMessageEvent } from "../events.js"
import type { GuildCache } from "../guild-cache.js"
import type { UserCache } from "../user-cache.js"

/** The caches one client owns. Only the user cache is always present */
export interface ClientCaches<M extends MessageCore> {
    readonly cache: MessageCache<M> | undefined
    readonly resources: GuildCache | undefined
    readonly channelCache: ChannelCache | undefined
    readonly userCache: UserCache
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
    if (event === "guildChannelDelete" && "id" in message) cache?.deleteChannel(message.id)
    if (isMessageEvent<typeof event, M>(event, message)) cache?.observe(message)
    else if ("ids" in message) {
        for (const id of message.ids) cache?.delete({ id, channelId: message.channelId })
    } else if (event === "messageDelete" && "id" in message && "channelId" in message) cache?.delete(message)
}

/** Raw guild lifecycle, expression and thread intake, or undefined when no cache can use it */
export function guildIntake<M extends MessageCore>(
    caches: ClientCaches<M>,
): ((event: string, value: unknown) => void) | undefined {
    const { cache, resources, channelCache } = caches
    if (!resources && !channelCache && !cache) return undefined
    return (event, value) => {
        if (event === "THREAD_UPDATE" || event === "THREAD_DELETE") {
            // Without typed threads, a changed thread is evicted rather than updated, and a deleted one takes its messages
            const id = record(value) && identifier(value.id) ? value.id : undefined
            if (id === undefined) channelCache?.gap()
            else channelCache?.delete(id)
            if (event === "THREAD_DELETE") {
                if (id === undefined) cache?.gap()
                else cache?.deleteChannel(id)
            }
            return
        }
        resources?.guildEvent(event, value)
        if (event !== "GUILD_EMOJIS_UPDATE" && event !== "GUILD_STICKERS_UPDATE") channelCache?.guildEvent(event, value)
        if (event === "GUILD_DELETE")
            cache?.gap((guildId) => guildId === undefined || (record(value) && value.id === guildId))
    }
}

/** Clear cached observations that a skipped malformed dispatch could have changed */
export function invalidateDispatch<M extends MessageCore>(caches: ClientCaches<M>, type: string, body: unknown) {
    const { cache, resources, channelCache, userCache } = caches
    const value = record(body) ? body : undefined
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
