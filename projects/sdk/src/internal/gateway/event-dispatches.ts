/**
 * Event filtering for Identify: Which dispatch types deliver each public event, which types SDK-owned state needs, and
 * the ignored_events list the SDK sends for explicit and automatic filtering.
 * Invariant: Automatic filtering never suppresses a dispatch that a registered event, an enabled cache category,
 * presence member selection, reaction pages, READY or RESUMED needs, and suppresses nothing while a raw subscriber exists. Types
 * without an entry here, such as correlated request replies and types this SDK version does not know, are never
 * suppressed automatically.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { EventName } from "#sdk/events"

/**
 * Dispatch types that can deliver each public event, keyed by event name.
 * Several events share one dispatch type, such as GUILD_CREATE for guildCreate and voiceStateSnapshot, so a type is
 * suppressed only when none of its events is needed. The map is typed by string so it compiles while event additions
 * land separately. The event-filter test checks it against the event bus names
 */
const eventDispatchMap = {
    userUpdate: ["USER_UPDATE"],
    directMessageCreate: ["CHANNEL_CREATE"],
    directMessageUpdate: ["CHANNEL_UPDATE"],
    directMessageDelete: ["CHANNEL_DELETE"],
    directMessageRecipientAdd: ["CHANNEL_RECIPIENT_ADD"],
    directMessageRecipientRemove: ["CHANNEL_RECIPIENT_REMOVE"],
    guildCreate: ["GUILD_CREATE"],
    guildUpdate: ["GUILD_UPDATE"],
    guildDelete: ["GUILD_DELETE"],
    guildHealthUpdate: ["GUILD_HEALTH_UPDATE"],
    webhooksUpdate: ["WEBHOOKS_UPDATE"],
    inviteCreate: ["INVITE_CREATE"],
    inviteDelete: ["INVITE_DELETE"],
    guildAuditLogEntryCreate: ["GUILD_AUDIT_LOG_ENTRY_CREATE"],
    guildEmojisUpdate: ["GUILD_EMOJIS_UPDATE"],
    guildStickersUpdate: ["GUILD_STICKERS_UPDATE"],
    guildChannelCreate: ["CHANNEL_CREATE"],
    guildChannelUpdate: ["CHANNEL_UPDATE"],
    guildChannelDelete: ["CHANNEL_DELETE"],
    guildChannelUpdateBulk: ["CHANNEL_UPDATE_BULK"],
    threadCreate: ["THREAD_CREATE"],
    threadUpdate: ["THREAD_UPDATE"],
    threadDelete: ["THREAD_DELETE"],
    threadListSync: ["THREAD_LIST_SYNC"],
    threadMembersUpdate: ["THREAD_MEMBERS_UPDATE"],
    channelPinsUpdate: ["CHANNEL_PINS_UPDATE"],
    guildMemberAdd: ["GUILD_MEMBER_ADD"],
    guildMemberUpdate: ["GUILD_MEMBER_UPDATE"],
    guildMemberRemove: ["GUILD_MEMBER_REMOVE"],
    presenceUpdate: ["PRESENCE_UPDATE"],
    presenceUpdateBulk: ["PRESENCE_UPDATE_BULK"],
    voiceStateSnapshot: ["GUILD_CREATE"],
    voiceStateUpdate: ["VOICE_STATE_UPDATE"],
    guildBanAdd: ["GUILD_BAN_ADD"],
    guildBanRemove: ["GUILD_BAN_REMOVE"],
    guildRoleDelete: ["GUILD_ROLE_DELETE"],
    guildRoleCreate: ["GUILD_ROLE_CREATE"],
    guildRoleUpdate: ["GUILD_ROLE_UPDATE"],
    guildRoleUpdateBulk: ["GUILD_ROLE_UPDATE_BULK"],
    typingStart: ["TYPING_START"],
    messageCreate: ["MESSAGE_CREATE"],
    messageUpdate: ["MESSAGE_UPDATE"],
    messageDelete: ["MESSAGE_DELETE"],
    messageDeleteBulk: ["MESSAGE_DELETE_BULK"],
    messageReactionAdd: ["MESSAGE_REACTION_ADD"],
    // Fluxer filters ADD before buffering it, then generates MANY without filtering its name. Filtering follows ADD
    // (session_dispatch and session_dispatch_voice at fluxerapp/fluxer commit 841fb7af4174fc8fc025307776e87e7dba51a669)
    messageReactionAddMany: ["MESSAGE_REACTION_ADD"],
    messageReactionRemove: ["MESSAGE_REACTION_REMOVE"],
    messageReactionRemoveAll: ["MESSAGE_REACTION_REMOVE_ALL"],
    messageReactionRemoveEmoji: ["MESSAGE_REACTION_REMOVE_EMOJI"],
    entranceSoundPlay: ["ENTRANCE_SOUND_PLAY"],
    callCreate: ["CALL_CREATE"],
    callUpdate: ["CALL_UPDATE"],
    callDelete: ["CALL_DELETE"],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Event names with a mapping, for the completeness check against the public event names */
export type MappedEvent = keyof typeof eventDispatchMap

export const eventDispatchTypes: Readonly<Record<string, readonly string[]>> = Object.freeze(eventDispatchMap)

/** Every dispatch type that automatic filtering may suppress, in a stable order */
const filterableTypes: readonly string[] = Object.freeze([...new Set(Object.values(eventDispatchTypes).flat())].sort())

/**
 * Dispatch types SDK-owned state needs whatever the application registers.
 * GUILD_CREATE replays presence member selections for guilds that become available, and GUILD_DELETE clears every
 * cache category for a removed or unavailable guild. Both arrive about once per guild per session
 */
const alwaysNeeded: readonly string[] = ["GUILD_CREATE", "GUILD_DELETE"]

/**
 * Dispatch types reaction pages read for clicks. Pages can start after Identify from any handler, through
 * ctx.paginate, a multi-page ctx.sendHelp or messages.paginate, so automatic filtering keeps them in every session
 */
const reactionPageNeeds: readonly string[] = ["MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE"]

/**
 * Dispatch types SDK-internal owners always need. Suppressing them would stop session control, member requests or
 * count requests, so an explicit list naming them fails creation
 */
export const protectedDispatchTypes: ReadonlySet<string> = new Set([
    "READY",
    "RESUMED",
    "GUILD_MEMBERS_CHUNK",
    "RATE_LIMITED",
    "GUILD_COUNTS_UPDATE",
    "CHANNEL_MEMBER_COUNTS_UPDATE",
])

/** Cache categories that consume gateway dispatches, as configured at creation */
export type FilterCacheKind =
    "messages" | "guilds" | "members" | "roles" | "channels" | "users" | "directMessages" | "emojis" | "stickers"

/** Dispatch types each enabled cache category reads to stay consistent with Fluxer */
const cacheDispatchTypes: Readonly<Record<FilterCacheKind, readonly string[]>> = Object.freeze({
    // THREAD_DELETE removes a deleted thread's messages, and CHANNEL_DELETE those of a channel and of its threads
    messages: [
        "MESSAGE_CREATE",
        "MESSAGE_UPDATE",
        "MESSAGE_DELETE",
        "MESSAGE_DELETE_BULK",
        "CHANNEL_DELETE",
        "THREAD_DELETE",
    ],
    guilds: ["GUILD_UPDATE"],
    members: [
        "GUILD_MEMBER_ADD",
        "GUILD_MEMBER_UPDATE",
        "GUILD_MEMBER_REMOVE",
        "GUILD_BAN_ADD",
        "GUILD_BAN_REMOVE",
        "GUILD_ROLE_DELETE",
    ],
    roles: ["GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE", "GUILD_ROLE_UPDATE_BULK", "GUILD_ROLE_DELETE"],
    // The channel cache also holds threads. THREAD_MEMBER_UPDATE has no public event, so it is never filtered
    // automatically, and listing it here keeps an explicit ignored list from dropping it
    channels: [
        "CHANNEL_CREATE",
        "CHANNEL_UPDATE",
        "CHANNEL_DELETE",
        "CHANNEL_UPDATE_BULK",
        "THREAD_CREATE",
        "THREAD_UPDATE",
        "THREAD_DELETE",
        "THREAD_LIST_SYNC",
        "THREAD_MEMBERS_UPDATE",
        "THREAD_MEMBER_UPDATE",
    ],
    users: ["USER_UPDATE", "GUILD_MEMBER_UPDATE"],
    directMessages: [
        "CHANNEL_CREATE",
        "CHANNEL_UPDATE",
        "CHANNEL_DELETE",
        "CHANNEL_RECIPIENT_ADD",
        "CHANNEL_RECIPIENT_REMOVE",
        "USER_UPDATE",
        "GUILD_MEMBER_UPDATE",
    ],
    emojis: ["GUILD_EMOJIS_UPDATE"],
    stickers: ["GUILD_STICKERS_UPDATE"],
})

/**
 * Dispatch types the enabled cache categories need to avoid keeping stale snapshots, fixed at creation.
 * Every category with guild-scoped entries also needs GUILD_DELETE, which clears a removed or unavailable guild's entries
 */
export function cacheNeeds(kinds: readonly FilterCacheKind[]): ReadonlySet<string> {
    const guildScoped = kinds.some((kind) => kind !== "users" && kind !== "directMessages")
    return new Set([...(guildScoped ? ["GUILD_DELETE"] : []), ...kinds.flatMap((kind) => cacheDispatchTypes[kind])])
}

/** Dispatch types automatic filtering keeps whatever the application registers */
export function automaticNeeds(kinds: readonly FilterCacheKind[]): ReadonlySet<string> {
    return new Set([...alwaysNeeded, ...reactionPageNeeds, ...cacheNeeds(kinds)])
}

/**
 * The automatic ignored_events list for one Identify: Every filterable type that no registered event, cache category or
 * SDK owner needs. A raw subscriber needs every type, so the list is then empty
 */
export function automaticIgnoredEvents(
    registered: ReadonlySet<EventName>,
    needed: ReadonlySet<string>,
): readonly string[] {
    if (registered.has("raw")) return []
    const wanted = new Set(needed)
    for (const event of registered) for (const type of eventDispatchTypes[event] ?? []) wanted.add(type)
    return Object.freeze(filterableTypes.filter((type) => !wanted.has(type)))
}

/** Registered events whose every dispatch type an explicit ignored list suppresses */
export function suppressedRegistrations(
    registered: ReadonlySet<EventName>,
    ignored: ReadonlySet<string>,
): readonly string[] {
    if (ignored.size === 0) return []
    return [...registered].filter((event) => {
        const types = eventDispatchTypes[event]
        return types !== undefined && types.length > 0 && types.every((type) => ignored.has(type))
    })
}
