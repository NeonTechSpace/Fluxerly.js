/**
 * Guild, member, role and voice-state operations and their gateway projections.
 * Invariant: Operations validate requests and convert REST and gateway data without storing guild state, use separate rate-limit
 * groups for guild and message routes, and never enter the message cache or synthesize gateway events after HTTP responses.
 * Multi-step resource workflows are not transactions, and uncertain writes are never replayed as reads. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type {
    DeletedMessageMember,
    Guild,
    GuildDeletion,
    GuildContentWarningLevel,
    GuildDefaultMessageNotification,
    GuildExplicitContentFilter,
    GuildMember,
    MemberProfileEdit,
    GuildSplashCardAlignment,
    GuildVerificationLevel,
    GuildMfaLevel,
    GuildNsfwLevel,
    GuildRole,
    RoleCreate,
    RoleEdit,
    MemberQuery,
    MemberReference,
    RolePosition,
    RoleHoistPosition,
    RoleReference,
} from "#sdk/guilds"
import { GuildNsfwLevels, GuildVerificationLevels } from "#sdk/guilds"
import type { GuildCreate, VoiceState, VoiceStateSnapshot } from "#sdk/events"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import {
    count as nonNegativeInt32,
    identifier,
    inputId,
    base64Image,
    base64ImageExplanation,
    clearsImage,
    int32,
    nonNegativeInteger,
    record,
} from "./decode/primitives.js"
import { rejectCheck } from "./decode/trace.js"
import type { ResourceRequest } from "./guild-cache.js"
import type { ChannelCacheRequest } from "./channel-cache.js"
import type { InstanceEndpointContext } from "./instance.js"
import { timestamp } from "./decode/timestamp.js"
import { memberNickname, normalizedText as text } from "./field-text.js"
import { decodeUser } from "./users.js"
import { memberProfileBodyLimit } from "./request-body-limits.js"

/** Validated request description. The shared REST owner retains admission, cleanup and rate state */
export interface GuildRequest<A> {
    readonly guildId: string
    readonly bucket: string
    readonly path: string
    readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
    readonly status: 200 | 202 | 204
    readonly json?: string
    /** Allows the shared REST owner to validate and send an operation audit reason */
    readonly audited?: true
    readonly moderation?: true
    readonly auditReason?: string
    /** Permits timeoutReason only on timeout and clear-timeout operation options */
    readonly timeoutReason?: true
    readonly deleteAuthorId?: string
    readonly invalidateMessages?: true
    /** A POST that only reads, so its failures count as reads like those of a GET */
    readonly read?: true
    /** Private client capabilities required for one explicit provider-gated replacement */
    readonly features?: readonly string[]
    /** REST supplies the immutable endpoint snapshot after request admission. One-argument decoders ignore it */
    readonly decode: (value: unknown, instance?: InstanceEndpointContext) => A | undefined
    readonly cache?: ResourceRequest
    readonly channelCache?: ChannelCacheRequest
}

type GuildValidationResult<A> = GuildRequest<A> | InputValidationFailure

const nullableText = (value: unknown) => value === undefined || value === null || typeof value === "string"
/** The trimmed positive ID for a caller ID, or undefined when it is refused or 0 */
const positiveId = (value: unknown): string | undefined => {
    const id = inputId(value)
    return id === "0" ? undefined : id
}
const color = (value: unknown): value is number => nonNegativeInt32(value) && value <= 0xffffff
const mentionPreference = (value: unknown): value is 0 | 1 | 2 => value === 0 || value === 1 || value === 2
const guildDefaultMessageNotification = (value: unknown): value is GuildDefaultMessageNotification =>
    value === 0 || value === 1
const guildVerificationLevel = (value: unknown): value is GuildVerificationLevel =>
    value === 0 || value === 1 || value === 2 || value === 3
const guildMfaLevel = (value: unknown): value is GuildMfaLevel => value === 0 || value === 1
const guildExplicitContentFilter = (value: unknown): value is GuildExplicitContentFilter =>
    value === 0 || value === 1 || value === 2
const guildContentWarningLevel = (value: unknown): value is GuildContentWarningLevel => value === 0 || value === 1
// Fluxer's own range for this level is 0 and 3, and it normalizes the retired 1 and 2 on load
const guildNsfwLevel = (value: unknown): value is GuildNsfwLevel | 1 | 2 =>
    value === 0 || value === 1 || value === 2 || value === 3
const identifierList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(identifier)
const guildSplashCardAlignment = (value: unknown): value is GuildSplashCardAlignment =>
    value === 0 || value === 1 || value === 2

export const guildEvents = {
    GUILD_MEMBER_ADD: "guildMemberAdd",
    GUILD_MEMBER_UPDATE: "guildMemberUpdate",
    GUILD_MEMBER_REMOVE: "guildMemberRemove",
    GUILD_BAN_ADD: "guildBanAdd",
    GUILD_BAN_REMOVE: "guildBanRemove",
    GUILD_ROLE_DELETE: "guildRoleDelete",
    GUILD_ROLE_CREATE: "guildRoleCreate",
    GUILD_ROLE_UPDATE: "guildRoleUpdate",
    GUILD_ROLE_UPDATE_BULK: "guildRoleUpdateBulk",
} as const

export const guildLifecycleEvents = {
    GUILD_CREATE: "guildCreate",
    GUILD_UPDATE: "guildUpdate",
    GUILD_DELETE: "guildDelete",
} as const

export function decodeGuildEvent(event: keyof typeof guildEvents, value: unknown) {
    if (!record(value) || !identifier(value.guild_id)) return undefined
    if (event === "GUILD_ROLE_CREATE" || event === "GUILD_ROLE_UPDATE") return decodeRole(value.role, value.guild_id)
    if (event === "GUILD_ROLE_UPDATE_BULK") {
        const roles = decodeRoles(value.roles, value.guild_id)
        return roles ? Object.freeze({ guildId: value.guild_id, roles }) : undefined
    }
    if (event === "GUILD_ROLE_DELETE") {
        if (!identifier(value.role_id)) return undefined
        return Object.freeze({ guildId: value.guild_id, id: value.role_id })
    }
    if (event === "GUILD_MEMBER_REMOVE" || event === "GUILD_BAN_ADD" || event === "GUILD_BAN_REMOVE") {
        if (!record(value.user) || !identifier(value.user.id)) return undefined
        return Object.freeze({ guildId: value.guild_id, userId: value.user.id })
    }
    return decodeMember(value, value.guild_id)
}

/**
 * The counts and join time of a GUILD_CREATE, or undefined when one is malformed. Fluxer documents them on every create,
 * but a body without them was accepted before they were read, so each is optional and checked only when present
 */
function guildCreateDetails(
    value: Record<string, unknown>,
): Pick<GuildCreate, "memberCount" | "onlineCount" | "joinedAt"> | undefined {
    if (
        (value.member_count !== undefined && !nonNegativeInt32(value.member_count)) ||
        (value.online_count !== undefined && !nonNegativeInt32(value.online_count)) ||
        (value.joined_at !== undefined && value.joined_at !== null && !timestamp(value.joined_at))
    )
        return undefined
    return {
        ...(value.member_count === undefined ? {} : { memberCount: value.member_count }),
        ...(value.online_count === undefined ? {} : { onlineCount: value.online_count }),
        ...(value.joined_at === undefined ? {} : { joinedAt: value.joined_at }),
    }
}

/** Decodes the documented complete snapshot/update forms without retaining gateway collections */
export function decodeGuildLifecycleEvent(event: keyof typeof guildLifecycleEvents, value: unknown) {
    if (event === "GUILD_CREATE") {
        if (!record(value) || (Object.hasOwn(value, "unavailable") && value.unavailable !== false)) return undefined
        const guild = decodeGuildSnapshot(value)
        const details = guild && guildCreateDetails(value)
        return guild && details
            ? Object.freeze({
                  ...guild,
                  isNewJoin: !Object.hasOwn(value, "unavailable"),
                  ...details,
              } satisfies GuildCreate)
            : undefined
    }
    if (event === "GUILD_DELETE") {
        if (
            !record(value) ||
            !identifier(value.id) ||
            (value.guild_id !== undefined && (!identifier(value.guild_id) || value.guild_id !== value.id)) ||
            (value.unavailable !== undefined && typeof value.unavailable !== "boolean") ||
            (value.unavailable_hidden !== undefined && typeof value.unavailable_hidden !== "boolean") ||
            (value.unavailable_hidden === true && value.unavailable !== true)
        )
            return undefined
        return Object.freeze({
            id: value.id,
            unavailable: value.unavailable ?? false,
            unavailableHidden: value.unavailable_hidden ?? false,
        } satisfies GuildDeletion)
    }
    if (
        event === "GUILD_UPDATE" &&
        (!record(value) ||
            (value.guild_id !== undefined && (!identifier(value.guild_id) || value.guild_id !== value.id)))
    )
        return undefined
    return decodeGuild(value)
}

/** Decodes a complete nested GUILD_CREATE snapshot while leaving its collections unretained */
export function decodeGuildSnapshot(value: unknown): Guild | undefined {
    if (!record(value) || !identifier(value.id) || !record(value.properties) || value.properties.id !== value.id)
        return undefined
    return decodeGuild(value.properties)
}

// oxlint-disable-next-line complexity -- a flat decoder, one check and one field mapping per voice state field
export function decodeVoiceState(value: unknown, expectedGuildId?: string): VoiceState | undefined {
    if (
        !record(value) ||
        !identifier(value.guild_id) ||
        (expectedGuildId !== undefined && value.guild_id !== expectedGuildId) ||
        (value.channel_id !== null && !identifier(value.channel_id)) ||
        !identifier(value.user_id) ||
        typeof value.connection_id !== "string" ||
        // oxlint-disable-next-line typescript/no-misused-spread -- the length limit counts Unicode code points
        [...value.connection_id].length < 1 ||
        // oxlint-disable-next-line typescript/no-misused-spread -- the length limit counts Unicode code points
        [...value.connection_id].length > 32 ||
        (value.session_id !== undefined &&
            value.session_id !== null &&
            (typeof value.session_id !== "string" || value.session_id.length === 0)) ||
        typeof value.mute !== "boolean" ||
        typeof value.deaf !== "boolean" ||
        typeof value.self_mute !== "boolean" ||
        typeof value.self_deaf !== "boolean" ||
        typeof value.is_mobile !== "boolean" ||
        typeof value.suppress !== "boolean" ||
        (value.self_video !== undefined && typeof value.self_video !== "boolean") ||
        (value.self_stream !== undefined && typeof value.self_stream !== "boolean") ||
        (value.e2ee_capable !== undefined && typeof value.e2ee_capable !== "boolean") ||
        (value.p2p !== undefined && typeof value.p2p !== "boolean") ||
        (value.version !== undefined && !nonNegativeInteger(value.version)) ||
        (value.viewer_stream_keys !== undefined &&
            value.viewer_stream_keys !== null &&
            (!Array.isArray(value.viewer_stream_keys) ||
                !value.viewer_stream_keys.every((key) => typeof key === "string")))
    )
        return undefined
    // Fluxer sends member null where no community member applies, such as in a private call
    const hasMember = value.member !== undefined && value.member !== null
    const member = hasMember ? decodeMember(value.member, value.guild_id) : undefined
    if (hasMember && !member) return undefined
    return Object.freeze({
        guildId: value.guild_id,
        channelId: value.channel_id,
        userId: value.user_id,
        connectionId: value.connection_id,
        ...(typeof value.session_id === "string" ? { sessionId: value.session_id } : {}),
        isMuted: value.mute,
        isDeafened: value.deaf,
        isSelfMuted: value.self_mute,
        isSelfDeafened: value.self_deaf,
        isMobile: value.is_mobile,
        isSuppressed: value.suppress,
        isSelfVideoOn: value.self_video === true,
        isSelfStreaming: value.self_stream === true,
        isE2eeCapable: value.e2ee_capable === true,
        isPeerToPeer: value.p2p === true,
        ...(value.version === undefined ? {} : { version: value.version }),
        viewerStreamKeys: Object.freeze(
            Array.isArray(value.viewer_stream_keys) ? ([...value.viewer_stream_keys] as string[]) : [],
        ),
        ...(member ? { member } : {}),
    })
}

export function decodeVoiceStateSnapshot(value: unknown): VoiceStateSnapshot | undefined {
    if (!record(value) || !identifier(value.id) || !Array.isArray(value.voice_states)) return undefined
    const connectionIds = new Set<string>()
    const voiceStates: VoiceState[] = []
    for (const item of value.voice_states) {
        const state = decodeVoiceState(item, value.id)
        if (!state || state.channelId === null || connectionIds.has(state.connectionId)) return undefined
        connectionIds.add(state.connectionId)
        voiceStates.push(state)
    }
    return Object.freeze({ guildId: value.id, voiceStates: Object.freeze(voiceStates) })
}

// oxlint-disable-next-line complexity -- a flat decoder, one check and one field mapping per guild field
export function decodeGuild(value: unknown): Guild | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        !identifier(value.owner_id) ||
        typeof value.name !== "string" ||
        !Array.isArray(value.features) ||
        !value.features.every((item) => typeof item === "string") ||
        !nullableText(value.icon) ||
        !nullableText(value.banner) ||
        !nullableText(value.splash) ||
        !nullableText(value.embed_splash) ||
        (value.splash_card_alignment !== undefined && !guildSplashCardAlignment(value.splash_card_alignment)) ||
        (value.system_channel_id !== undefined &&
            value.system_channel_id !== null &&
            !identifier(value.system_channel_id)) ||
        (value.system_channel_flags !== undefined && !nonNegativeInt32(value.system_channel_flags)) ||
        (value.rules_channel_id !== undefined &&
            value.rules_channel_id !== null &&
            !identifier(value.rules_channel_id)) ||
        !nullableText(value.vanity_url_code) ||
        (value.nsfw_level !== undefined && !guildNsfwLevel(value.nsfw_level)) ||
        (value.badge_ids !== undefined && !identifierList(value.badge_ids)) ||
        (value.afk_channel_id !== undefined && value.afk_channel_id !== null && !identifier(value.afk_channel_id)) ||
        (value.afk_timeout !== undefined && !nonNegativeInt32(value.afk_timeout)) ||
        (value.default_message_notifications !== undefined &&
            !guildDefaultMessageNotification(value.default_message_notifications)) ||
        (value.verification_level !== undefined &&
            value.verification_level !== 4 &&
            !guildVerificationLevel(value.verification_level)) ||
        (value.mfa_level !== undefined && !guildMfaLevel(value.mfa_level)) ||
        (value.nsfw !== undefined && typeof value.nsfw !== "boolean") ||
        (value.content_warning_level !== undefined && !guildContentWarningLevel(value.content_warning_level)) ||
        !nullableText(value.content_warning_text) ||
        (value.explicit_content_filter !== undefined && !guildExplicitContentFilter(value.explicit_content_filter)) ||
        (value.message_history_cutoff !== undefined &&
            value.message_history_cutoff !== null &&
            !timestamp(value.message_history_cutoff))
    )
        return undefined
    return Object.freeze({
        id: value.id,
        name: value.name,
        ownerId: value.owner_id,
        features: Object.freeze([...value.features] as string[]),
        ...(value.icon === undefined ? {} : { icon: value.icon as string | null }),
        ...(value.banner === undefined ? {} : { banner: value.banner as string | null }),
        ...(value.splash === undefined ? {} : { splash: value.splash as string | null }),
        ...(value.embed_splash === undefined ? {} : { embedSplash: value.embed_splash as string | null }),
        ...(value.splash_card_alignment === undefined
            ? {}
            : { splashCardAlignment: value.splash_card_alignment as GuildSplashCardAlignment }),
        ...(value.system_channel_id === undefined ? {} : { systemChannelId: value.system_channel_id as string | null }),
        ...(value.system_channel_flags === undefined
            ? {}
            : { systemChannelFlags: value.system_channel_flags as number }),
        ...(value.rules_channel_id === undefined ? {} : { rulesChannelId: value.rules_channel_id as string | null }),
        ...(value.vanity_url_code === undefined ? {} : { vanityUrlCode: value.vanity_url_code as string | null }),
        ...(value.afk_channel_id === undefined ? {} : { afkChannelId: value.afk_channel_id as string | null }),
        ...(value.afk_timeout === undefined ? {} : { afkTimeoutSeconds: value.afk_timeout as number }),
        ...(value.default_message_notifications === undefined
            ? {}
            : { defaultMessageNotifications: value.default_message_notifications as GuildDefaultMessageNotification }),
        // Legacy level 4 follows Fluxer's stored-guild normalization to High
        // https://github.com/fluxerapp/fluxer/blob/597116a0b4bf3a212789bdebe7f284babc33b445/fluxer_api/src/api/models/Guild.ts
        ...(value.verification_level === undefined
            ? {}
            : {
                  verificationLevel:
                      value.verification_level === 4
                          ? GuildVerificationLevels.High
                          : (value.verification_level as GuildVerificationLevel),
              }),
        ...(value.mfa_level === undefined ? {} : { mfaLevel: value.mfa_level as GuildMfaLevel }),
        ...(value.nsfw === undefined ? {} : { nsfw: value.nsfw as boolean }),
        // Legacy levels 1 and 2 follow Fluxer's stored-guild normalization to AgeRestricted and Safe
        // https://github.com/fluxerapp/fluxer/blob/5f3fc0b1c66925ab032aa6bb1ef7ab49c1f71c58/packages/constants/src/GuildConstants.ts
        ...(value.nsfw_level === undefined
            ? {}
            : {
                  nsfwLevel:
                      value.nsfw_level === 1
                          ? GuildNsfwLevels.AgeRestricted
                          : value.nsfw_level === 2
                            ? GuildNsfwLevels.Safe
                            : (value.nsfw_level as GuildNsfwLevel),
              }),
        ...(value.content_warning_level === undefined
            ? {}
            : { contentWarningLevel: value.content_warning_level as GuildContentWarningLevel }),
        ...(value.content_warning_text === undefined
            ? {}
            : { contentWarningText: value.content_warning_text as string | null }),
        ...(value.explicit_content_filter === undefined
            ? {}
            : { explicitContentFilter: value.explicit_content_filter as GuildExplicitContentFilter }),
        ...(value.message_history_cutoff === undefined
            ? {}
            : { messageHistoryCutoff: value.message_history_cutoff as string | null }),
        ...(value.badge_ids === undefined
            ? {}
            : { badgeIds: Object.freeze([...(value.badge_ids as readonly string[])]) }),
    })
}

// oxlint-disable-next-line complexity -- a flat decoder, one check and one field mapping per member field
export function decodeMember(value: unknown, guildId: string): GuildMember | undefined {
    if (
        !record(value) ||
        !record(value.user) ||
        !identifier(value.user.id) ||
        typeof value.user.username !== "string" ||
        (value.user.bot !== undefined && typeof value.user.bot !== "boolean") ||
        !Array.isArray(value.roles) ||
        value.roles.length > 250 ||
        !value.roles.every(identifier) ||
        new Set(value.roles).size !== value.roles.length ||
        !timestamp(value.joined_at) ||
        !nullableText(value.nick) ||
        !nullableText(value.avatar) ||
        !nullableText(value.banner) ||
        (value.accent_color !== undefined && value.accent_color !== null && !color(value.accent_color)) ||
        (value.profile_flags !== undefined && value.profile_flags !== null && !nonNegativeInt32(value.profile_flags)) ||
        (value.mute !== undefined && typeof value.mute !== "boolean") ||
        (value.deaf !== undefined && typeof value.deaf !== "boolean") ||
        (value.communication_disabled_until !== undefined &&
            value.communication_disabled_until !== null &&
            !timestamp(value.communication_disabled_until))
    )
        return undefined
    // A partial account, such as the ID and name a dispatch completes, keeps the member and leaves the account out
    const user = decodeUser(value.user)
    return Object.freeze({
        guildId,
        userId: value.user.id,
        username: value.user.username,
        isBot: value.user.bot === true,
        ...(user ? { user } : {}),
        roleIds: Object.freeze([...value.roles] as string[]),
        joinedAt: value.joined_at,
        ...(value.communication_disabled_until === undefined
            ? {}
            : { communicationDisabledUntil: value.communication_disabled_until as string | null }),
        ...(value.nick === undefined ? {} : { nickname: value.nick as string | null }),
        ...(value.avatar === undefined ? {} : { avatar: value.avatar as string | null }),
        ...(value.banner === undefined ? {} : { banner: value.banner as string | null }),
        ...(value.accent_color === undefined ? {} : { accentColor: value.accent_color as number | null }),
        ...(value.profile_flags === undefined ? {} : { profileFlags: value.profile_flags as number | null }),
        // A preference this SDK version does not know is left out, so a new Fluxer value cannot fail the read
        ...(value.mention_flags === null || mentionPreference(value.mention_flags)
            ? { mentionFlags: value.mention_flags }
            : {}),
        ...(value.mute === undefined ? {} : { isMuted: value.mute as boolean }),
        ...(value.deaf === undefined ? {} : { isDeafened: value.deaf as boolean }),
    })
}

/** Dispatch types that Fluxer decorates with the acting member, read from the guild's state at dispatch time */
export const memberDecoratedDispatches: ReadonlySet<string> = new Set([
    "MESSAGE_CREATE",
    "MESSAGE_UPDATE",
    "MESSAGE_REACTION_ADD",
    "MESSAGE_REACTION_REMOVE",
    "TYPING_START",
])

/**
 * The community and account that a message, reaction or typing dispatch's member describes, or undefined when the dispatch
 * attaches no member, has no usable guild ID, or comes from a webhook, whose author is never a member
 */
export function dispatchMemberTarget(
    type: string,
    body: unknown,
): { readonly guildId: string; readonly userId: string } | undefined {
    if (!record(body) || body.member === undefined || body.member === null || !identifier(body.guild_id))
        return undefined
    if (type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE") {
        const author = body.author
        if (!record(author) || !identifier(author.id) || (body.webhook_id !== undefined && body.webhook_id !== null))
            return undefined
        return { guildId: body.guild_id, userId: author.id }
    }
    return identifier(body.user_id) ? { guildId: body.guild_id, userId: body.user_id } : undefined
}

/**
 * The member that Fluxer attached to a message, reaction or typing dispatch, or undefined when it sent none or sent one that
 * does not decode. A message carries its member without a user, so the author completes it. A reaction or typing member
 * carries its user, which must be the acting user and have a username. When Fluxer sends it with the ID only, the name
 * resolver may supply the name from a member already held, and otherwise the member is left out rather than invented.
 * Unlike a voice state, which is rejected whole, a malformed member only leaves the decoration out, because it must never
 * cost the event itself
 */
export function decodeDispatchMember(
    type: string,
    body: unknown,
    known?: (guildId: string, userId: string) => GuildMember | undefined,
): GuildMember | undefined {
    const target = dispatchMemberTarget(type, body)
    if (!target || !record(body) || !record(body.member)) return undefined
    if (type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE") {
        const author = body.author as Record<string, unknown>
        return decodeMember({ ...body.member, user: author }, target.guildId)
    }
    let source: Record<string, unknown> = body.member
    const user = source.user
    // Only an absent name may come from a held member. A name or bot flag that is present and invalid is malformed
    if (record(user) && user.id === target.userId && user.username === undefined) {
        const held = known?.(target.guildId, target.userId)
        if (held)
            source = {
                ...source,
                user: { ...user, username: held.username, bot: user.bot === undefined ? held.isBot : user.bot },
            }
    }
    const member = decodeMember(source, target.guildId)
    return member?.userId === target.userId ? member : undefined
}

/**
 * The author's member of a MESSAGE_DELETE dispatch, or undefined when it sent none, names no community or author, or sent
 * a member that does not decode. Fluxer removes the member's user, so the author_id supplies the account and a stand-in
 * name lets the shared member rules validate the rest, after which the account fields are dropped again. Like the member
 * of a message, reaction or typing dispatch it is a decoration that must never cost the event
 */
export function decodeDeletionMember(value: unknown): DeletedMessageMember | undefined {
    if (!record(value) || !record(value.member) || !identifier(value.guild_id) || !identifier(value.author_id))
        return undefined
    const member = decodeMember({ ...value.member, user: { id: value.author_id, username: "" } }, value.guild_id)
    if (!member) return undefined
    const { username: _username, isBot: _isBot, user: _user, ...rest } = member
    return Object.freeze(rest)
}

export function guildFetch(rawGuildId: string): GuildValidationResult<Guild> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        guildId,
        bucket: "guild:read",
        cache: { selection: { kind: "guilds", guildId } },
        path: `/guilds/${guildId}`,
        method: "GET",
        status: 200,
        decode: (value) => {
            const guild = decodeGuild(value)
            return guild === undefined || guild.id === guildId ? guild : rejectCheck("targetMismatch")
        },
    }
}

/** The trimmed guild and user IDs of a member target, or the failure for the first refused one */
export function memberIds(target: MemberReference): { guildId: string; userId: string } | InputValidationFailure {
    if (!record(target)) return inputValidationFailure("target", "type", "Member targets must be objects")
    const guildId = inputId(target.guildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "target.guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const userId = inputId(target.userId)
    if (userId === undefined)
        return inputValidationFailure(
            "target.userId",
            "format",
            "User IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return { guildId, userId }
}

export function memberFetch(target: MemberReference): GuildValidationResult<GuildMember> {
    const ids = memberIds(target)
    if (ids instanceof InputValidationFailure) return ids
    const { guildId, userId } = ids
    return {
        guildId,
        bucket: "guild:members",
        path: `/guilds/${guildId}/members/${userId}`,
        cache: { selection: { kind: "members", guildId, id: userId } },
        method: "GET",
        status: 200,
        decode: (value) => {
            const member = decodeMember(value, guildId)
            return member === undefined || member.userId === userId ? member : rejectCheck("targetMismatch")
        },
    }
}

export function memberSelf(rawGuildId: string): GuildValidationResult<GuildMember> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        guildId,
        bucket: "guild:members",
        path: `/guilds/${guildId}/members/@me`,
        cache: { selection: { kind: "members", guildId } },
        method: "GET",
        status: 200,
        decode: (value) => decodeMember(value, guildId),
    }
}

// oxlint-disable-next-line complexity -- a flat validator, one check per member profile field
export function memberEditSelf(rawGuildId: string, input: MemberProfileEdit): GuildValidationResult<GuildMember> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (!record(input)) return inputValidationFailure("input", "type", "Member profile input must be an object")
    if (Object.keys(input).length === 0)
        return inputValidationFailure("input", "required", "Member profile input must contain at least one field")
    const unsupported = unsupportedKeyFailure(
        input,
        ["nickname", "avatar", "banner", "bio", "pronouns", "accentColor", "profileFlags", "mentionFlags"],
        "input",
        "the member profile input",
    )
    if (unsupported) return unsupported
    if (input.nickname !== undefined && input.nickname !== null && !memberNickname(input.nickname))
        return inputValidationFailure(
            "nickname",
            "length",
            "Nickname must contain 1 through 32 UTF-16 code units after Fluxer's normalization, or be empty or only whitespace to clear it",
        )
    if (input.avatar !== undefined && !clearsImage(input.avatar) && !base64Image(input.avatar))
        return inputValidationFailure("avatar", "format", base64ImageExplanation("Avatar", input.avatar))
    if (input.banner !== undefined && !clearsImage(input.banner) && !base64Image(input.banner))
        return inputValidationFailure("banner", "format", base64ImageExplanation("Banner", input.banner))
    // Fluxer reads an empty bio or pronouns as null, which clears it (fluxer_api/src/api/Validator.ts:59-63 at 0098958f)
    if (input.bio !== undefined && input.bio !== null && input.bio !== "" && !text(input.bio, 1, 320))
        return inputValidationFailure(
            "bio",
            "length",
            "Bio must be empty to clear it or contain 1 through 320 UTF-16 code units after Fluxer's normalization",
        )
    if (
        input.pronouns !== undefined &&
        input.pronouns !== null &&
        input.pronouns !== "" &&
        !text(input.pronouns, 1, 40)
    )
        return inputValidationFailure(
            "pronouns",
            "length",
            "Pronouns must be empty to clear them or contain 1 through 40 UTF-16 code units after Fluxer's normalization",
        )
    if (input.accentColor !== undefined && input.accentColor !== null && !color(input.accentColor))
        return inputValidationFailure(
            "accentColor",
            "range",
            "Accent color must be an integer from 0 through 16,777,215",
        )
    if (input.profileFlags !== undefined && input.profileFlags !== null && !nonNegativeInt32(input.profileFlags))
        return inputValidationFailure(
            "profileFlags",
            "range",
            "Profile flags must be an integer from 0 through 2,147,483,647",
        )
    if (input.mentionFlags !== undefined && input.mentionFlags !== null && !mentionPreference(input.mentionFlags))
        return inputValidationFailure("mentionFlags", "allowedValue", "Mention flags must be 0, 1, or 2")
    const json = JSON.stringify({
        nick: input.nickname,
        avatar: input.avatar,
        banner: input.banner,
        bio: input.bio,
        pronouns: input.pronouns,
        accent_color: input.accentColor,
        profile_flags: input.profileFlags,
        mention_flags: input.mentionFlags,
    })
    if (json === "{}")
        return inputValidationFailure(
            "input",
            "required",
            "Member profile input must set at least one field to a defined value",
        )
    if (Buffer.byteLength(json) > memberProfileBodyLimit)
        return inputValidationFailure(
            "input",
            "size",
            "Member profile input must not exceed 29,010,604 encoded bytes, the most Fluxer accepts",
        )
    return {
        guildId,
        bucket: "guild:member:self:update",
        audited: true,
        cache: { selection: { kind: "members", guildId }, mutation: true },
        path: `/guilds/${guildId}/members/@me`,
        method: "PATCH",
        status: 200,
        json,
        decode: (value) => decodeMember(value, guildId),
    }
}

/** Build the one-field member PATCH used for a moderator-controlled nickname change */
export function memberNicknameEdit(
    target: MemberReference,
    nickname: string | null,
): GuildValidationResult<GuildMember> {
    const ids = memberIds(target)
    if (ids instanceof InputValidationFailure) return ids
    if (nickname !== null && !memberNickname(nickname))
        return inputValidationFailure(
            "nickname",
            "length",
            "Nickname must be null, empty or only whitespace to clear it, or contain 1 through 32 UTF-16 code units after Fluxer's normalization",
        )
    const { guildId, userId } = ids
    return {
        guildId,
        bucket: "guild:member:nickname:update",
        audited: true,
        cache: { selection: { kind: "members", guildId, id: userId }, mutation: true },
        path: `/guilds/${guildId}/members/${userId}`,
        method: "PATCH",
        status: 200,
        json: JSON.stringify({ nick: nickname }),
        decode: (value) => {
            const member = decodeMember(value, guildId)
            return member === undefined || member.userId === userId ? member : rejectCheck("targetMismatch")
        },
    }
}

/** Build the complete role-set PATCH for one member without reading or merging an existing role set */
export function memberRolesSet(
    target: MemberReference,
    roleIds: readonly string[],
): GuildValidationResult<GuildMember> {
    if (!record(target)) return inputValidationFailure("target", "type", "Member targets must be objects")
    const guildId = positiveId(target.guildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "target.guildId",
            "format",
            "Guild IDs must be decimal strings from 1 through 9,223,372,036,854,775,807, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const userId = positiveId(target.userId)
    if (userId === undefined)
        return inputValidationFailure(
            "target.userId",
            "format",
            "User IDs must be decimal strings from 1 through 9,223,372,036,854,775,807, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (!Array.isArray(roleIds)) return inputValidationFailure("roleIds", "type", "Role IDs must be an array")
    const count = roleIds.length
    if (count > 250) return inputValidationFailure("roleIds", "length", "A member role set may contain at most 250 IDs")
    // oxlint-disable-next-line unicorn/no-new-array -- preallocates the counted length once, and the loop below assigns every index
    const roles = new Array<string>(count)
    for (let index = 0; index < count; index++) {
        const roleId = positiveId(roleIds[index])
        if (roleId === undefined)
            return inputValidationFailure(
                "roleIds[]",
                "format",
                "Role IDs must be decimal strings from 1 through 9,223,372,036,854,775,807, because JavaScript numbers cannot hold Fluxer IDs exactly",
            )
        roles[index] = roleId
    }
    if (new Set(roles).size !== roles.length)
        return inputValidationFailure("roleIds", "unique", "Role IDs must be unique")
    if (roles.some((roleId) => roleId === guildId))
        return inputValidationFailure(
            "roleIds[]",
            "relationship",
            "Role IDs must not include the community's default role, whose ID equals the guild ID",
        )
    return {
        guildId,
        bucket: "guild:member:roles:set",
        audited: true,
        cache: { selection: { kind: "members", guildId, id: userId }, mutation: true },
        path: `/guilds/${guildId}/members/${userId}`,
        method: "PATCH",
        status: 200,
        json: JSON.stringify({ roles }),
        decode: (value) => {
            const member = decodeMember(value, guildId)
            return member === undefined || member.userId === userId ? member : rejectCheck("targetMismatch")
        },
    }
}

export function memberPage(rawGuildId: string, query?: MemberQuery): GuildValidationResult<readonly GuildMember[]> {
    const input = query === undefined ? {} : query
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (!record(input)) return inputValidationFailure("query", "type", "Member query must be an object")
    const unsupported = unsupportedKeyFailure(input, ["limit", "after"], "query", "the member query")
    if (unsupported) return unsupported
    const limit = input.limit === undefined ? 100 : input.limit
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000)
        return inputValidationFailure("query.limit", "range", "Member limit must be an integer from 1 through 1,000")
    const after = input.after === undefined ? undefined : inputId(input.after)
    if (input.after !== undefined && after === undefined)
        return inputValidationFailure("query.after", "format", "Member cursor must be a decimal user ID string")
    const params = new URLSearchParams({ limit: String(limit) })
    if (after !== undefined) params.set("after", after)
    return {
        guildId,
        bucket: "guild:members",
        path: `/guilds/${guildId}/members?${params}`,
        cache: { selection: { kind: "members", guildId } },
        method: "GET",
        status: 200,
        decode: (value) => {
            if (!Array.isArray(value) || value.length > limit) return undefined
            const members: GuildMember[] = []
            let previous = after === undefined ? undefined : BigInt(after)
            for (const item of value) {
                const member = decodeMember(item, guildId)
                if (!member) return undefined
                if (previous !== undefined && BigInt(member.userId) <= previous) return rejectCheck("order")
                previous = BigInt(member.userId)
                members.push(member)
            }
            return Object.freeze(members)
        },
    }
}

export function memberRole(target: MemberReference, rawRoleId: string, add: boolean): GuildValidationResult<void> {
    const ids = memberIds(target)
    if (ids instanceof InputValidationFailure) return ids
    const roleId = inputId(rawRoleId)
    if (roleId === undefined)
        return inputValidationFailure(
            "roleId",
            "format",
            "Role IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const { guildId, userId } = ids
    if (roleId === guildId)
        return inputValidationFailure(
            "roleId",
            "relationship",
            "The community's default role, whose ID equals the guild ID, cannot be assigned explicitly",
        )
    return {
        guildId,
        bucket: add ? "guild:member:role:add" : "guild:member:role:remove",
        audited: true,
        path: `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
        cache: { selection: { kind: "members", guildId, id: userId }, mutation: true },
        method: add ? "PUT" : "DELETE",
        status: 204,
        decode: () => undefined,
    }
}

const maxUnsignedPermission = 18_446_744_073_709_551_615n
const maxWritablePermission = 9_223_372_036_854_775_807n
const unsignedPermission = (value: unknown): value is bigint =>
    typeof value === "bigint" && value >= 0n && value <= maxUnsignedPermission
const writablePermission = (value: unknown): value is bigint =>
    typeof value === "bigint" && value >= 0n && value <= maxWritablePermission

function decodeRole(value: unknown, guildId: string): GuildRole | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.name !== "string" ||
        !nonNegativeInt32(value.color) ||
        !nonNegativeInt32(value.position) ||
        typeof value.permissions !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/.test(value.permissions) ||
        !unsignedPermission(BigInt(value.permissions)) ||
        typeof value.hoist !== "boolean" ||
        typeof value.mentionable !== "boolean" ||
        (value.hoist_position !== undefined && value.hoist_position !== null && !int32(value.hoist_position)) ||
        !nullableText(value.icon) ||
        !nullableText(value.unicode_emoji)
    )
        return undefined
    return Object.freeze({
        guildId,
        id: value.id,
        name: value.name,
        color: value.color,
        position: value.position,
        permissions: BigInt(value.permissions),
        hoist: value.hoist,
        mentionable: value.mentionable,
        ...(value.hoist_position === undefined ? {} : { hoistPosition: value.hoist_position as number | null }),
        ...(value.icon === undefined ? {} : { icon: value.icon as string | null }),
        ...(value.unicode_emoji === undefined ? {} : { unicodeEmoji: value.unicode_emoji as string | null }),
    })
}

export function decodeRoles(value: unknown, guildId: string): readonly GuildRole[] | undefined {
    if (!Array.isArray(value)) return undefined
    const roles: GuildRole[] = []
    const ids = new Set<string>()
    for (const item of value) {
        const role = decodeRole(item, guildId)
        if (!role || ids.has(role.id)) return undefined
        ids.add(role.id)
        roles.push(role)
    }
    return Object.freeze(roles)
}

export function roleList(rawGuildId: string): GuildValidationResult<readonly GuildRole[]> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        guildId,
        bucket: "guild:role:list",
        cache: { selection: { kind: "roles", guildId }, replace: true },
        path: `/guilds/${guildId}/roles`,
        method: "GET",
        status: 200,
        decode: (value) => decodeRoles(value, guildId),
    }
}

/** Fluxer takes one of an image, an emoji or a role to copy from, and null clears, so only non-null values conflict.
 * Fluxer reads an empty string as null on the role routes (fluxer_api/src/api/Validator.ts:59-63,
 * GuildRoleController.ts:51, 136 at 0098958f), so it clears too
 */
function roleIconFailure(icon: unknown, unicodeEmoji: unknown, sourceRoleId: unknown) {
    const hasIcon = icon !== undefined && !clearsImage(icon)
    const hasEmoji = unicodeEmoji !== undefined && unicodeEmoji !== null && unicodeEmoji !== ""
    if (hasIcon && !base64Image(icon))
        return inputValidationFailure("icon", "format", base64ImageExplanation("Role icon", icon))
    if (hasEmoji && (typeof unicodeEmoji !== "string" || unicodeEmoji.length < 1 || unicodeEmoji.length > 64))
        return inputValidationFailure(
            "unicodeEmoji",
            "length",
            "Role emoji must be null, an empty string or 1 through 64 UTF-16 code units",
        )
    if (sourceRoleId !== undefined && inputId(sourceRoleId) === undefined)
        return inputValidationFailure(
            "iconSourceRoleId",
            "format",
            "Role IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (hasIcon && hasEmoji)
        return inputValidationFailure("input", "relationship", "A role icon can be an image or an emoji, not both")
    if (sourceRoleId !== undefined && (hasIcon || hasEmoji))
        return inputValidationFailure("input", "relationship", "A role can set an icon or copy one, not both")
    return undefined
}

function roleBody(input: RoleCreate | RoleEdit, create: boolean): string | InputValidationFailure {
    if (!record(input)) return inputValidationFailure("input", "type", "Role input must be an object")
    const keys = create
        ? ["name", "color", "permissions", "icon", "unicodeEmoji", "iconSourceRoleId"]
        : ["name", "color", "permissions", "hoist", "hoistPosition", "mentionable", "icon", "unicodeEmoji"]
    const unsupported = unsupportedKeyFailure(input, keys, "input", "the role input")
    if (unsupported) return unsupported
    const { name, color, permissions, hoist, hoistPosition, mentionable, icon, unicodeEmoji, iconSourceRoleId } = input
    if (create && name === undefined) return inputValidationFailure("name", "required", "Role name is required")
    if (name !== undefined && !text(name, 1, 100))
        return inputValidationFailure(
            "name",
            "length",
            "Role name must contain 1 through 100 UTF-16 code units after Fluxer's normalization",
        )
    if (color !== undefined && (!int32(color) || color < 0 || color > 0xffffff))
        return inputValidationFailure("color", "range", "Role color must be an integer from 0 through 16,777,215")
    if (permissions !== undefined && !writablePermission(permissions))
        return inputValidationFailure(
            "permissions",
            "range",
            "Role permissions must be a bigint from 0 through 9,223,372,036,854,775,807",
        )
    if (hoist !== undefined && typeof hoist !== "boolean")
        return inputValidationFailure("hoist", "type", "Role hoist must be a boolean")
    if (mentionable !== undefined && typeof mentionable !== "boolean")
        return inputValidationFailure("mentionable", "type", "Role mentionable must be a boolean")
    if (hoistPosition !== undefined && hoistPosition !== null && !int32(hoistPosition))
        return inputValidationFailure(
            "hoistPosition",
            "range",
            "Role hoist position must be null or an integer from -2,147,483,648 through 2,147,483,647",
        )
    const iconFailure = roleIconFailure(icon, unicodeEmoji, iconSourceRoleId)
    if (iconFailure) return iconFailure
    const body = {
        name,
        color: create ? (color ?? 0) : color,
        permissions: create ? (permissions ?? 0n).toString() : permissions?.toString(),
        hoist,
        hoist_position: hoistPosition,
        mentionable,
        icon,
        unicode_emoji: unicodeEmoji,
        icon_source_role_id: iconSourceRoleId === undefined ? undefined : inputId(iconSourceRoleId),
    }
    const json = JSON.stringify(body)
    return json === "{}" ? inputValidationFailure("input", "required", "Role edit must contain a change") : json
}

export function roleCreate(rawGuildId: string, input: RoleCreate): GuildValidationResult<GuildRole> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const json = roleBody(input, true)
    if (json instanceof InputValidationFailure) return json
    return {
        guildId,
        bucket: "guild:role:create",
        audited: true,
        cache: { selection: { kind: "roles", guildId }, mutation: true },
        path: `/guilds/${guildId}/roles`,
        method: "POST",
        status: 200,
        json,
        ...(input.permissions === undefined ? {} : { features: ["view_channel_members_permission"] }),
        decode: (value) => {
            const role = decodeRole(value, guildId)
            return role?.id !== guildId ? role : undefined
        },
    }
}

/** The trimmed guild and role IDs of a role target, or the failure for the first refused one */
function roleTarget(target: RoleReference): { guildId: string; id: string } | InputValidationFailure {
    if (!record(target)) return inputValidationFailure("target", "type", "Role targets must be objects")
    const guildId = inputId(target.guildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "target.guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const id = inputId(target.id)
    if (id === undefined)
        return inputValidationFailure(
            "target.id",
            "format",
            "Role IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return { guildId, id }
}

export function roleEdit(target: RoleReference, input: RoleEdit): GuildValidationResult<GuildRole> {
    const ids = roleTarget(target)
    if (ids instanceof InputValidationFailure) return ids
    const { guildId, id } = ids
    const json = roleBody(input, false)
    if (json instanceof InputValidationFailure) return json
    if (
        id === guildId &&
        (input.name !== undefined ||
            input.hoist !== undefined ||
            input.hoistPosition !== undefined ||
            input.mentionable !== undefined ||
            input.icon !== undefined ||
            input.unicodeEmoji !== undefined)
    )
        return inputValidationFailure(
            "input",
            "relationship",
            "The community's default role supports only color and permissions edits",
        )
    return {
        guildId,
        bucket: "guild:role:update",
        audited: true,
        cache: {
            selection: { kind: "roles", guildId, ...(input.hoistPosition === undefined ? { id } : {}) },
            mutation: true,
        },
        path: `/guilds/${guildId}/roles/${id}`,
        method: "PATCH",
        status: 200,
        json,
        ...(input.permissions === undefined ? {} : { features: ["view_channel_members_permission"] }),
        decode: (value) => {
            const role = decodeRole(value, guildId)
            return role === undefined || role.id === id ? role : rejectCheck("targetMismatch")
        },
    }
}

export function roleDelete(target: RoleReference): GuildValidationResult<void> {
    const ids = roleTarget(target)
    if (ids instanceof InputValidationFailure) return ids
    const { guildId, id } = ids
    if (id === guildId)
        return inputValidationFailure("target.id", "relationship", "The community's default role cannot be deleted")
    return {
        guildId,
        bucket: "guild:role:delete",
        audited: true,
        cache: { selection: { kind: "roles", guildId }, mutation: true, members: true },
        path: `/guilds/${guildId}/roles/${id}`,
        method: "DELETE",
        status: 204,
        decode: () => undefined,
    }
}

/** Fluxer refuses more than 10,000 entries in a role position or hoist position update
 * (packages/schema/src/domains/guild/GuildRequestSchemas.ts:376, 385 at 0098958f). 10,000 entries stay far below
 * either route's body limit, so these lists need no byte check of their own
 */
const maxRolePositionEntries = 10_000

export function roleReorder(rawGuildId: string, positions: readonly RolePosition[]): GuildValidationResult<void> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (!Array.isArray(positions)) return inputValidationFailure("positions", "type", "Role positions must be an array")
    if (positions.length === 0)
        return inputValidationFailure("positions", "length", "Role positions must contain at least one entry")
    if (positions.length > maxRolePositionEntries)
        return inputValidationFailure("positions", "length", "Role positions must contain at most 10,000 entries")
    const ids = new Set<string>()
    const updates: RolePosition[] = []
    for (const item of positions) {
        if (!record(item)) return inputValidationFailure("positions[]", "type", "Role position entries must be objects")
        const unsupported = unsupportedKeyFailure(item, ["id", "position"], "positions[]", "a role position entry")
        if (unsupported) return unsupported
        const id = inputId(item.id)
        if (id === undefined)
            return inputValidationFailure(
                "positions[].id",
                "format",
                "Role IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
            )
        if (id === guildId)
            return inputValidationFailure(
                "positions[].id",
                "relationship",
                "The community's default role cannot be reordered",
            )
        if (ids.has(id)) return inputValidationFailure("positions[].id", "unique", "Role position IDs must be unique")
        if (typeof item.position !== "number" || !Number.isSafeInteger(item.position) || item.position < 0)
            return inputValidationFailure(
                "positions[].position",
                "range",
                "Role positions must be nonnegative safe integers",
            )
        const copy = { id, position: item.position }
        ids.add(id)
        updates.push(copy)
    }
    return {
        guildId,
        bucket: "guild:role:positions",
        audited: true,
        cache: { selection: { kind: "roles", guildId }, mutation: true },
        path: `/guilds/${guildId}/roles`,
        method: "PATCH",
        status: 204,
        json: JSON.stringify(updates),
        decode: () => undefined,
    }
}

export function roleSetHoistPositions(
    rawGuildId: string,
    positions: readonly RoleHoistPosition[],
): GuildValidationResult<void> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (!Array.isArray(positions))
        return inputValidationFailure("positions", "type", "Role hoist positions must be an array")
    if (positions.length === 0)
        return inputValidationFailure("positions", "length", "Role hoist positions must contain at least one entry")
    if (positions.length > maxRolePositionEntries)
        return inputValidationFailure("positions", "length", "Role hoist positions must contain at most 10,000 entries")
    const ids = new Set<string>()
    const updates: { id: string; hoist_position: number }[] = []
    for (const item of positions) {
        if (!record(item))
            return inputValidationFailure("positions[]", "type", "Role hoist position entries must be objects")
        const unsupported = unsupportedKeyFailure(
            item,
            ["id", "hoistPosition"],
            "positions[]",
            "a role hoist position entry",
        )
        if (unsupported) return unsupported
        const id = inputId(item.id)
        if (id === undefined)
            return inputValidationFailure(
                "positions[].id",
                "format",
                "Role IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
            )
        if (id === guildId)
            return inputValidationFailure(
                "positions[].id",
                "relationship",
                "The community's default role cannot be hoisted",
            )
        if (ids.has(id))
            return inputValidationFailure("positions[].id", "unique", "Role hoist position IDs must be unique")
        if (!int32(item.hoistPosition))
            return inputValidationFailure(
                "positions[].hoistPosition",
                "range",
                "Role hoist positions must be integers from -2,147,483,648 through 2,147,483,647",
            )
        const copy = { id, hoist_position: item.hoistPosition }
        ids.add(id)
        updates.push(copy)
    }
    return {
        guildId,
        bucket: "guild:role:hoist-positions",
        audited: true,
        cache: { selection: { kind: "roles", guildId }, mutation: true },
        path: `/guilds/${guildId}/roles/hoist-positions`,
        method: "PATCH",
        status: 204,
        json: JSON.stringify(updates),
        decode: () => undefined,
    }
}

export function roleResetHoistPositions(rawGuildId: string): GuildValidationResult<void> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        guildId,
        bucket: "guild:role:hoist-positions",
        audited: true,
        cache: { selection: { kind: "roles", guildId }, mutation: true },
        path: `/guilds/${guildId}/roles/hoist-positions`,
        method: "DELETE",
        status: 204,
        decode: () => undefined,
    }
}
