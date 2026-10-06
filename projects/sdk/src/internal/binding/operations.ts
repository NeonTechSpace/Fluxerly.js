/**
 * Operation table: The single definition of every client namespace member shared by the default and Effect APIs.
 * Each entry names its kind and the shared Effect it runs, and the [default](/projects/sdk/src/internal/binding/default.ts)
 * and [native](/projects/sdk/src/internal/binding/native.ts) binders adapt it by kind.
 * Invariant: Both APIs run the same Effect for a member, the default operation ID is the table key unless an entry names
 * an existing Operation, and public member types stay in the hand-written interfaces under src/api/.
 * Implements [SDK contracts: Public API model](/docs/SDK-CONTRACTS.md#public-api-model)
 */
import type * as Effect from "effect/Effect"
import type { Operation } from "#sdk/errors"
import type {
    EditMessageInput,
    ForwardMessageInput,
    MessageCore,
    MessageHistoryQuery,
    MessageInput,
    MessageAuditOperationOptions,
    MessageOperationOptions,
    MessageReference,
    OwnMessageDeletionOptions,
    ReplyInput,
    SendOptions,
} from "#sdk/messages"
import type { MessageSearchContext, MessageSearchIterationLimits, MessageSearchQuery } from "#sdk/message-search"
import type { MessagePinsQuery } from "#sdk/pins"
import type { ReactionEmojiInput, ReactionUsersQuery } from "#sdk/reactions"
import type { MessageCleanupOptions, MessageCleanupPlan, MessageCleanupSelection } from "#sdk/message-cleanup"
import { cleanup, previewCleanup } from "#sdk/internal/message-cleanup"
import { searchMessagePagination } from "#sdk/internal/message-search-workflow"
import type {
    BanInput,
    GuildAuditOperationOptions,
    GuildEdit,
    GuildListQuery,
    GuildOperationOptions,
    CanManageOptions,
    MemberProfileEdit,
    MemberQuery,
    MemberReference,
    ModerationOptions,
    RoleCreate,
    RoleEdit,
    RoleHoistPosition,
    RolePosition,
    RoleReference,
    TimeoutOptions,
    VoiceConnectionReference,
    VoiceDeafenInput,
    VoiceMuteInput,
} from "#sdk/guilds"
import type { DiscoveryApplicationEdit, DiscoveryApplicationInput, DiscoverySearchQuery } from "#sdk/discovery"
import type { PresenceInput } from "#sdk/presence"
import type { BotApplicationOperationOptions } from "#sdk/application"
import type { DirectMessageGroupEdit, UserOperationOptions, UserProfileQuery } from "#sdk/users"
import type { WebhookCreate, WebhookEdit, WebhookOperationOptions } from "#sdk/webhooks"
import type {
    EmojiCreate,
    EmojiEdit,
    ExpressionDeleteOptions,
    ExpressionReference,
    StickerCreate,
    StickerEdit,
} from "#sdk/expressions"
import type { AuditLogIterationQuery, AuditLogQuery } from "#sdk/audit-logs"
import type { InviteCreate } from "#sdk/invites"
import type { CountOperationOptions } from "#sdk/counts"
import type {
    GuildIterationQuery,
    HistoryIterationQuery,
    PaginationError,
    PinIterationQuery,
    UserIterationQuery,
} from "#sdk/pagination"
import type {
    ChannelAuditOperationOptions,
    ChannelCreate,
    ChannelEdit,
    ChannelFollowInput,
    ChannelOperationOptions,
    ChannelPosition,
    PermissionOverwrite,
} from "#sdk/channels"
import type { MemberSearchIterationLimits, MemberSearchQuery } from "#sdk/member-search"
import type { PermissionInput, PermissionTarget } from "#sdk/permissions"
import type { Attachment, AttachmentDownloadOptions, AttachmentRefreshOptions } from "#sdk/attachments"
import type { ClientOwner } from "#sdk/internal/client"
import { defaultCacheOnChange, nativeCacheOnChange } from "#sdk/internal/cache-changes"
import {
    auditLogPagination,
    guildPagination,
    historyPagination,
    memberPagination,
    pinPagination,
    reactionUserPagination,
    type Pagination,
} from "#sdk/internal/pagination"
import { applicationCurrent } from "#sdk/internal/application"
import { auditLogPage } from "#sdk/internal/audit-logs"
import {
    channelCreate,
    channelDelete,
    channelEdit,
    channelFetch,
    channelFollow,
    channelFollowerStats,
    channelList,
    channelReorder,
    permissionRemove,
    permissionSet,
} from "#sdk/internal/channels"
import {
    expressionBatch,
    expressionClone,
    expressionCreate,
    expressionDelete,
    expressionEdit,
    expressionList,
    expressionMetadata,
    expressionSource,
} from "#sdk/internal/expressions"
import {
    discoveryCategories,
    discoverySearch,
    discoveryStatus,
    discoveryWithdraw,
    discoveryWrite,
} from "#sdk/internal/guild-discovery"
import { guildList } from "#sdk/internal/guild-lifecycle"
import { guildEdit } from "#sdk/internal/guild-settings"
import {
    guildFetch,
    memberEditSelf,
    memberFetch,
    memberNicknameEdit,
    memberPage,
    memberRole,
    memberRolesSet,
    memberSelf,
    roleCreate,
    roleDelete,
    roleEdit,
    roleList,
    roleReorder,
    roleResetHoistPositions,
    roleSetHoistPositions,
} from "#sdk/internal/guilds"
import { inviteCreate, inviteDelete, inviteFetch, inviteList } from "#sdk/internal/invites"
import { searchMemberPagination, searchMembers } from "#sdk/internal/member-search-workflow"
import {
    guildBan,
    guildBans,
    guildUnban,
    memberKick,
    memberTimeout,
    memberVoiceFlag,
    memberVoiceMove,
} from "#sdk/internal/moderation"
import { calculatePermissions, fetchPermissions } from "#sdk/internal/permissions"
import { fetchCanManage } from "#sdk/internal/role-hierarchy-workflow"
import {
    directMessageClose,
    directMessageEdit,
    directMessageFetch,
    directMessageLatestMessages,
    directMessageList,
    directMessageOpen,
    userFetch,
    userProfile,
} from "#sdk/internal/users"
import { vanityUrlEdit, vanityUrlFetch } from "#sdk/internal/vanity-url"
import { webhookCreate, webhookDelete, webhookEdit, webhookFetch, webhookList } from "#sdk/internal/webhooks"
import {
    defaultAttachmentStream,
    defaultCacheClear,
    defaultCacheEntries,
    defaultCollect,
    defaultCollectReactions,
    defaultInstanceResolve,
    defaultKeepTyping,
    defaultMemberChunks,
    defaultRestRequest,
} from "./default-adapters.js"
import type { DefaultContext } from "./execute.js"
import {
    nativeAttachmentStream,
    nativeCacheClear,
    nativeCacheEntries,
    nativeCollect,
    nativeCollectReactions,
    nativeInstanceResolve,
    nativeKeepTyping,
    nativeMemberChunks,
    nativeRestRequest,
} from "./native-adapters.js"

/** An asynchronous remote operation. The default API executes it with the options argument at optionsAt */
export interface OperationEntry<M extends MessageCore, Args extends readonly unknown[], A, E> {
    readonly kind: "op"
    readonly optionsAt: number
    readonly run: (owner: ClientOwner<M>, ...args: Args) => Effect.Effect<A, E>
}

/** A synchronous local command whose failure is a runtime outcome, such as a presence update, returned as Result by the default API */
export interface LookupEntry<M extends MessageCore, Args extends readonly unknown[], A, E> {
    readonly kind: "lookup"
    readonly run: (owner: ClientOwner<M>, ...args: Args) => Effect.Effect<A, E>
}

/**
 * A local cache lookup. The default API returns the value or undefined and throws for invalid input, and the native API
 * returns an Effect without an error channel whose misuse is a defect. A closing or closed client has no cache, so both
 * APIs read undefined instead of failing
 */
export interface GetEntry<M extends MessageCore, Args extends readonly unknown[], A, E> {
    readonly kind: "get"
    readonly run: (owner: ClientOwner<M>, ...args: Args) => Effect.Effect<A, E>
}

/** A pure local calculation that both APIs return directly, throwing its error for invalid input */
export interface PureEntry<M extends MessageCore, Args extends readonly unknown[], A, E> {
    readonly kind: "pure"
    readonly run: (owner: ClientOwner<M>, ...args: Args) => Effect.Effect<A, E>
}

/** A paged traversal, iterated by the default API and streamed by the native API */
export interface PageEntry<M extends MessageCore, Args extends readonly unknown[], A, E> {
    readonly kind: "page"
    readonly optionsAt: number
    readonly run: (owner: ClientOwner<M>, ...args: Args) => Effect.Effect<Pagination<A, E>, PaginationError>
}

/** A member whose two API styles need their own adapters, such as byte streams, collectors and callbacks */
export interface CustomEntry<M extends MessageCore, D, N> {
    readonly kind: "stream" | "custom"
    readonly default: (context: DefaultContext<M>) => D
    readonly native: (owner: ClientOwner<M>) => N
}

/** Any table entry, as the binders read it */
export type BindableEntry<M extends MessageCore> =
    | OperationEntry<M, readonly unknown[], unknown, unknown>
    | LookupEntry<M, readonly unknown[], unknown, unknown>
    | GetEntry<M, readonly unknown[], unknown, unknown>
    | PureEntry<M, readonly unknown[], unknown, unknown>
    | PageEntry<M, readonly unknown[], unknown, unknown>
    | CustomEntry<M, unknown, unknown>

type EntryId<NS extends string, K extends string, E> = E extends { readonly kind: "stream" | "custom" }
    ? Operation
    : E extends { readonly id: infer I }
      ? I
      : `${NS}.${K}`

// Each default operation ID must be an existing Operation, so SdkDefect attribution stays stable
type CheckedTable<T> = {
    readonly [NS in keyof T & string]: {
        readonly [K in keyof T[NS] & string]: EntryId<NS, K, T[NS][K]> extends Operation
            ? T[NS][K]
            : { readonly unknownOperationId: `${NS}.${K}` }
    }
}

const checked = <T>(table: T & CheckedTable<T>): T => table

/** Keep an operation ID that differs from the table key, such as the message operations' unqualified IDs */
const named = <const I extends Operation, E>(id: I, entry: E): E & { readonly id: I } => Object.freeze({ ...entry, id })

function defineOperations<M extends MessageCore>() {
    type Owner = ClientOwner<M>
    const op = <Args extends readonly unknown[], A, E>(
        optionsAt: number,
        run: (owner: Owner, ...args: Args) => Effect.Effect<A, E>,
    ): OperationEntry<M, Args, A, E> => Object.freeze({ kind: "op", optionsAt, run })
    const lookup = <Args extends readonly unknown[], A, E>(
        run: (owner: Owner, ...args: Args) => Effect.Effect<A, E>,
    ): LookupEntry<M, Args, A, E> => Object.freeze({ kind: "lookup", run })
    const get = <Args extends readonly unknown[], A, E>(
        run: (owner: Owner, ...args: Args) => Effect.Effect<A, E>,
    ): GetEntry<M, Args, A, E> => Object.freeze({ kind: "get", run })
    const pure = <Args extends readonly unknown[], A, E>(
        run: (owner: Owner, ...args: Args) => Effect.Effect<A, E>,
    ): PureEntry<M, Args, A, E> => Object.freeze({ kind: "pure", run })
    const page = <Args extends readonly unknown[], A, E>(
        optionsAt: number,
        run: (owner: Owner, ...args: Args) => Effect.Effect<Pagination<A, E>, PaginationError>,
    ): PageEntry<M, Args, A, E> => Object.freeze({ kind: "page", optionsAt, run })
    const custom = <D, N>(
        kind: "stream" | "custom",
        defaultAdapter: (context: DefaultContext<M>) => D,
        nativeAdapter: (owner: Owner) => N,
    ): CustomEntry<M, D, N> => Object.freeze({ kind, default: defaultAdapter, native: nativeAdapter })
    return checked({
        instance: {
            resolve: custom("custom", defaultInstanceResolve<M>, nativeInstanceResolve<M>),
        },
        presence: {
            set: lookup((owner: Owner, input: PresenceInput) => owner.setPresence(input)),
            setMembers: lookup((owner: Owner, guildId: string, memberIds: readonly string[]) =>
                owner.setPresenceMembers(guildId, memberIds),
            ),
        },
        cache: {
            entries: custom("custom", defaultCacheEntries<M>, nativeCacheEntries<M>),
            clear: custom("custom", defaultCacheClear<M>, nativeCacheClear<M>),
            onChange: custom("custom", defaultCacheOnChange<M>, nativeCacheOnChange<M>),
        },
        rest: {
            // Generic in the response body and typed with each API's own request shape, so each API adapts it
            request: custom("custom", defaultRestRequest<M>, nativeRestRequest<M>),
        },
        gateway: {
            // The default API passes its options as a fourth argument, which the public Effect member does not have
            send: op(3, (owner: Owner, shardId: number, opcode: number, data: unknown, ...options: readonly []) =>
                owner.gatewaySend(shardId, opcode, data, (options as readonly unknown[])[0]),
            ),
        },
        application: {
            fetch: op(0, (owner: Owner, options?: BotApplicationOperationOptions) =>
                owner.application("application.fetch", () => applicationCurrent(), options),
            ),
        },
        users: {
            get: get((owner: Owner, id: string) => owner.getUserResource("users", id)),
            getSelf: get((owner: Owner) => owner.getSelf()),
            fetch: op(1, (owner: Owner, id: string, options?: UserOperationOptions) =>
                owner.user("users.fetch", () => userFetch(id), options),
            ),
            fetchSelf: op(0, (owner: Owner, options?: UserOperationOptions) =>
                owner.user("users.fetchSelf", () => userFetch("@me"), options),
            ),
            fetchProfile: op(2, (owner: Owner, id: string, query?: UserProfileQuery, options?: UserOperationOptions) =>
                owner.user("users.fetchProfile", () => userProfile(id, query), options),
            ),
        },
        directMessages: {
            send: op(2, (owner: Owner, userId: string, input: ReplyInput | string, options?: SendOptions) =>
                owner.sendDirectMessage(userId, input, options),
            ),
            get: get((owner: Owner, id: string) => owner.getUserResource("directMessages", id)),
            open: op(1, (owner: Owner, userId: string, options?: UserOperationOptions) =>
                owner.user("directMessages.open", () => directMessageOpen(userId), options),
            ),
            fetch: op(1, (owner: Owner, id: string, options?: UserOperationOptions) =>
                owner.user("directMessages.fetch", () => directMessageFetch(id), options),
            ),
            fetchAll: op(0, (owner: Owner, options?: UserOperationOptions) =>
                owner.user("directMessages.fetchAll", () => directMessageList(), options),
            ),
            fetchLatestMessages: op(1, (owner: Owner, channelIds: readonly string[], options?: UserOperationOptions) =>
                owner.user(
                    "directMessages.fetchLatestMessages",
                    () => directMessageLatestMessages(channelIds, owner.decodeMessage),
                    options,
                ),
            ),
            editGroup: op(
                2,
                (owner: Owner, id: string, input: DirectMessageGroupEdit, options?: UserOperationOptions) =>
                    owner.user("directMessages.editGroup", () => directMessageEdit(id, input), options),
            ),
            close: op(1, (owner: Owner, id: string, options?: UserOperationOptions) =>
                owner.user("directMessages.close", () => directMessageClose(id), options),
            ),
            removeRecipient: op(2, (owner: Owner, id: string, userId: string, options?: UserOperationOptions) =>
                owner.user("directMessages.removeRecipient", () => directMessageClose(id, userId), options),
            ),
        },
        webhooks: {
            create: op(2, (owner: Owner, channelId: string, input: WebhookCreate, options?: WebhookOperationOptions) =>
                owner.webhook("webhooks.create", () => webhookCreate(channelId, input, options), options),
            ),
            fetch: op(1, (owner: Owner, id: string, options?: WebhookOperationOptions) =>
                owner.webhook("webhooks.fetch", () => webhookFetch(id), options),
            ),
            fetchForChannel: op(1, (owner: Owner, channelId: string, options?: WebhookOperationOptions) =>
                owner.webhook("webhooks.fetchForChannel", () => webhookList(channelId, "channels"), options),
            ),
            fetchForGuild: op(1, (owner: Owner, guildId: string, options?: WebhookOperationOptions) =>
                owner.webhook("webhooks.fetchForGuild", () => webhookList(guildId, "guilds"), options),
            ),
            edit: op(2, (owner: Owner, id: string, input: WebhookEdit, options?: WebhookOperationOptions) =>
                owner.webhook("webhooks.edit", () => webhookEdit(id, input, options), options),
            ),
            delete: op(1, (owner: Owner, id: string, options?: WebhookOperationOptions) =>
                owner.webhook("webhooks.delete", () => webhookDelete(id, options), options),
            ),
        },
        emojis: {
            get: get((owner: Owner, target: ExpressionReference) => owner.getResource("emojis", target)),
            fetchAll: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.guild("emojis.fetchAll", () => expressionList("emojis", guildId), options),
            ),
            fetchMetadata: op(1, (owner: Owner, id: string, options?: GuildOperationOptions) =>
                owner.guild("emojis.fetchMetadata", () => expressionMetadata("emojis", id), options),
            ),
            fetchSource: op(1, (owner: Owner, id: string, options?: GuildOperationOptions) =>
                owner.guild("emojis.fetchSource", () => expressionSource("emojis", id), options),
            ),
            create: op(2, (owner: Owner, guildId: string, input: EmojiCreate, options?: ModerationOptions) =>
                owner.guild("emojis.create", () => expressionCreate("emojis", guildId, input, options), options),
            ),
            createMany: op(
                2,
                (owner: Owner, guildId: string, input: readonly EmojiCreate[], options?: ModerationOptions) =>
                    owner.guild("emojis.createMany", () => expressionBatch("emojis", guildId, input, options), options),
            ),
            clone: op(2, (owner: Owner, guildId: string, sourceId: string, options?: ModerationOptions) =>
                owner.guild("emojis.clone", () => expressionClone("emojis", guildId, sourceId, options), options),
            ),
            edit: op(2, (owner: Owner, target: ExpressionReference, input: EmojiEdit, options?: ModerationOptions) =>
                owner.guild("emojis.edit", () => expressionEdit("emojis", target, input, options), options),
            ),
            delete: op(1, (owner: Owner, target: ExpressionReference, options?: ExpressionDeleteOptions) =>
                owner.guild("emojis.delete", () => expressionDelete("emojis", target, options), options),
            ),
        },
        stickers: {
            get: get((owner: Owner, target: ExpressionReference) => owner.getResource("stickers", target)),
            fetchAll: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.guild("stickers.fetchAll", () => expressionList("stickers", guildId), options),
            ),
            fetchMetadata: op(1, (owner: Owner, id: string, options?: GuildOperationOptions) =>
                owner.guild("stickers.fetchMetadata", () => expressionMetadata("stickers", id), options),
            ),
            fetchSource: op(1, (owner: Owner, id: string, options?: GuildOperationOptions) =>
                owner.guild("stickers.fetchSource", () => expressionSource("stickers", id), options),
            ),
            create: op(2, (owner: Owner, guildId: string, input: StickerCreate, options?: ModerationOptions) =>
                owner.guild("stickers.create", () => expressionCreate("stickers", guildId, input, options), options),
            ),
            createMany: op(
                2,
                (owner: Owner, guildId: string, input: readonly StickerCreate[], options?: ModerationOptions) =>
                    owner.guild(
                        "stickers.createMany",
                        () => expressionBatch("stickers", guildId, input, options),
                        options,
                    ),
            ),
            clone: op(2, (owner: Owner, guildId: string, sourceId: string, options?: ModerationOptions) =>
                owner.guild("stickers.clone", () => expressionClone("stickers", guildId, sourceId, options), options),
            ),
            edit: op(2, (owner: Owner, target: ExpressionReference, input: StickerEdit, options?: ModerationOptions) =>
                owner.guild("stickers.edit", () => expressionEdit("stickers", target, input, options), options),
            ),
            delete: op(1, (owner: Owner, target: ExpressionReference, options?: ExpressionDeleteOptions) =>
                owner.guild("stickers.delete", () => expressionDelete("stickers", target, options), options),
            ),
        },
        auditLogs: {
            fetchPage: op(2, (owner: Owner, guildId: string, query: AuditLogQuery, options?: GuildOperationOptions) =>
                owner.guild("auditLogs.fetchPage", () => auditLogPage(guildId, query), options),
            ),
            iterate: page(
                2,
                (owner: Owner, guildId: string, query: AuditLogIterationQuery, options?: GuildOperationOptions) =>
                    auditLogPagination(owner, guildId, query, options),
            ),
        },
        invites: {
            fetch: op(1, (owner: Owner, code: string, options?: GuildOperationOptions) =>
                owner.guild("invites.fetch", () => inviteFetch(code), options),
            ),
            create: op(2, (owner: Owner, channelId: string, input?: InviteCreate, options?: ModerationOptions) =>
                owner.guild("invites.create", () => inviteCreate(channelId, input, options), options),
            ),
            fetchForChannel: op(1, (owner: Owner, channelId: string, options?: GuildOperationOptions) =>
                owner.guild("invites.fetchForChannel", () => inviteList("channels", channelId), options),
            ),
            fetchForGuild: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.guild("invites.fetchForGuild", () => inviteList("guilds", guildId), options),
            ),
            delete: op(1, (owner: Owner, code: string, options?: ModerationOptions) =>
                owner.guild("invites.delete", () => inviteDelete(code, options), options),
            ),
        },
        discovery: {
            search: op(1, (owner: Owner, query?: DiscoverySearchQuery, options?: GuildOperationOptions) =>
                owner.guild("discovery.search", () => discoverySearch(query), options),
            ),
            fetchStatus: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.guild("discovery.fetchStatus", () => discoveryStatus(guildId), options),
            ),
            fetchCategories: op(0, (owner: Owner, options?: GuildOperationOptions) =>
                owner.guild("discovery.fetchCategories", discoveryCategories, options),
            ),
            apply: op(
                2,
                (owner: Owner, guildId: string, input: DiscoveryApplicationInput, options?: GuildOperationOptions) =>
                    owner.guild("discovery.apply", () => discoveryWrite(guildId, input), options),
            ),
            edit: op(
                2,
                (owner: Owner, guildId: string, input: DiscoveryApplicationEdit, options?: GuildOperationOptions) =>
                    owner.guild("discovery.edit", () => discoveryWrite(guildId, input, true), options),
            ),
            withdraw: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.guild("discovery.withdraw", () => discoveryWithdraw(guildId), options),
            ),
        },
        guilds: {
            fetchCounts: op(1, (owner: Owner, guildIds: readonly string[], options?: CountOperationOptions) =>
                owner.counts.fetchGuilds(guildIds, options),
            ),
            fetchPage: op(1, (owner: Owner, query?: GuildListQuery, options?: GuildOperationOptions) =>
                owner.guild("guilds.fetchPage", () => guildList(query), options),
            ),
            iterate: page(1, (owner: Owner, query: GuildIterationQuery, options?: GuildOperationOptions) =>
                guildPagination(owner, query, options),
            ),
            leave: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.leaveGuild(guildId, options),
            ),
            deleteOwnMessages: op(1, (owner: Owner, guildId: string, options: OwnMessageDeletionOptions) =>
                owner.deleteOwnGuildMessages(guildId, options),
            ),
            fetchVanityUrl: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.guild("guilds.fetchVanityUrl", () => vanityUrlFetch(guildId), options),
            ),
            editVanityUrl: op(2, (owner: Owner, guildId: string, code: string | null, options?: ModerationOptions) =>
                owner.guild("guilds.editVanityUrl", () => vanityUrlEdit(guildId, code, options), options),
            ),
            edit: op(2, (owner: Owner, guildId: string, input: GuildEdit, options?: ModerationOptions) =>
                owner.guild("guilds.edit", () => guildEdit(guildId, input, options), options),
            ),
            get: get((owner: Owner, guildId: string) => owner.getResource("guilds", guildId)),
            fetch: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.guild("guilds.fetch", () => guildFetch(guildId), options),
            ),
        },
        channels: {
            follow: op(
                2,
                (owner: Owner, channelId: string, input: ChannelFollowInput, options?: ChannelAuditOperationOptions) =>
                    owner.channel("channels.follow", () => channelFollow(channelId, input), options),
            ),
            fetchFollowerStats: op(1, (owner: Owner, channelId: string, options?: ChannelOperationOptions) =>
                owner.channel("channels.fetchFollowerStats", () => channelFollowerStats(channelId), options),
            ),
            fetchMemberCounts: op(
                2,
                (owner: Owner, guildId: string, channelIds: readonly string[], options?: CountOperationOptions) =>
                    owner.counts.fetchChannels(guildId, channelIds, options),
            ),
            get: get((owner: Owner, channelId: string) => owner.getChannel(channelId)),
            fetch: op(1, (owner: Owner, channelId: string, options?: ChannelOperationOptions) =>
                owner.channel("channels.fetch", () => channelFetch(channelId), options),
            ),
            fetchAll: op(1, (owner: Owner, guildId: string, options?: ChannelOperationOptions) =>
                owner.channel("channels.fetchAll", () => channelList(guildId), options),
            ),
            create: op(
                2,
                (owner: Owner, guildId: string, input: ChannelCreate, options?: ChannelAuditOperationOptions) =>
                    owner.channel("channels.create", () => channelCreate(guildId, input), options),
            ),
            edit: op(2, (owner: Owner, channelId: string, input: ChannelEdit, options?: ChannelAuditOperationOptions) =>
                owner.channel("channels.edit", () => channelEdit(channelId, input), options),
            ),
            delete: op(1, (owner: Owner, channelId: string, options?: ChannelAuditOperationOptions) =>
                owner.channel("channels.delete", () => channelDelete(channelId), options),
            ),
            reorder: op(
                2,
                (
                    owner: Owner,
                    guildId: string,
                    positions: readonly ChannelPosition[],
                    options?: ChannelAuditOperationOptions,
                ) => owner.channel("channels.reorder", () => channelReorder(guildId, positions), options),
            ),
            setPermissionOverwrite: op(
                2,
                (owner: Owner, channelId: string, input: PermissionOverwrite, options?: ChannelAuditOperationOptions) =>
                    owner.channel("channels.setPermissionOverwrite", () => permissionSet(channelId, input), options),
            ),
            removePermissionOverwrite: op(
                2,
                (owner: Owner, channelId: string, targetId: string, options?: ChannelAuditOperationOptions) =>
                    owner.channel(
                        "channels.removePermissionOverwrite",
                        () => permissionRemove(channelId, targetId),
                        options,
                    ),
            ),
        },
        members: {
            iterateChunks: custom("stream", defaultMemberChunks<M>, nativeMemberChunks<M>),
            setRoles: op(
                2,
                (
                    owner: Owner,
                    member: MemberReference,
                    roleIds: readonly string[],
                    options?: GuildAuditOperationOptions,
                ) => owner.guild("members.setRoles", () => memberRolesSet(member, roleIds), options),
            ),
            search: op(
                2,
                (owner: Owner, guildId: string, filters?: MemberSearchQuery, options?: GuildOperationOptions) =>
                    searchMembers(owner, guildId, filters, options),
            ),
            iterateSearch: page(
                3,
                (
                    owner: Owner,
                    guildId: string,
                    filters: Omit<MemberSearchQuery, "limit">,
                    limits: MemberSearchIterationLimits,
                    options?: GuildOperationOptions,
                ) => searchMemberPagination(owner, guildId, filters, limits, options),
            ),
            editSelf: op(
                2,
                (owner: Owner, guildId: string, input: MemberProfileEdit, options?: GuildAuditOperationOptions) =>
                    owner.guild("members.editSelf", () => memberEditSelf(guildId, input), options),
            ),
            setNickname: op(
                2,
                (
                    owner: Owner,
                    member: MemberReference,
                    nickname: string | null,
                    options?: GuildAuditOperationOptions,
                ) => owner.guild("members.setNickname", () => memberNicknameEdit(member, nickname), options),
            ),
            move: op(
                2,
                (owner: Owner, target: VoiceConnectionReference, channelId: string, options?: ModerationOptions) =>
                    owner.guild("members.move", () => memberVoiceMove(target, channelId, options), options),
            ),
            disconnect: op(1, (owner: Owner, target: VoiceConnectionReference, options?: ModerationOptions) =>
                owner.guild("members.disconnect", () => memberVoiceMove(target, null, options), options),
            ),
            setMute: op(
                2,
                (owner: Owner, target: MemberReference, input: VoiceMuteInput, options?: ModerationOptions) =>
                    owner.guild("members.setMute", () => memberVoiceFlag(target, "mute", input, options), options),
            ),
            setDeaf: op(
                2,
                (owner: Owner, target: MemberReference, input: VoiceDeafenInput, options?: ModerationOptions) =>
                    owner.guild("members.setDeaf", () => memberVoiceFlag(target, "deaf", input, options), options),
            ),
            timeout: op(2, (owner: Owner, target: MemberReference, durationMs: number, options?: TimeoutOptions) =>
                owner.guild("members.timeout", () => memberTimeout(target, durationMs, options), options),
            ),
            clearTimeout: op(1, (owner: Owner, target: MemberReference, options?: TimeoutOptions) =>
                owner.guild("members.clearTimeout", () => memberTimeout(target, null, options, true), options),
            ),
            kick: op(1, (owner: Owner, target: MemberReference, options?: ModerationOptions) =>
                owner.guild("members.kick", () => memberKick(target, options), options),
            ),
            ban: op(2, (owner: Owner, target: MemberReference, input?: BanInput, options?: ModerationOptions) =>
                owner.guild("members.ban", () => guildBan(target, input, options), options),
            ),
            unban: op(1, (owner: Owner, target: MemberReference, options?: ModerationOptions) =>
                owner.guild("members.unban", () => guildUnban(target, options), options),
            ),
            fetchBans: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.guild("members.fetchBans", () => guildBans(guildId), options),
            ),
            iterate: page(
                2,
                (owner: Owner, guildId: string, query: UserIterationQuery, options?: GuildOperationOptions) =>
                    memberPagination(owner, guildId, query, options),
            ),
            get: get((owner: Owner, member: MemberReference) => owner.getResource("members", member)),
            fetch: op(1, (owner: Owner, member: MemberReference, options?: GuildOperationOptions) =>
                owner.guild("members.fetch", () => memberFetch(member), options),
            ),
            fetchSelf: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.guild("members.fetchSelf", () => memberSelf(guildId), options),
            ),
            fetchCanManage: op(1, (owner: Owner, target: MemberReference, options?: CanManageOptions) =>
                fetchCanManage(owner, target, options),
            ),
            fetchPage: op(2, (owner: Owner, guildId: string, query?: MemberQuery, options?: GuildOperationOptions) =>
                owner.guild("members.fetchPage", () => memberPage(guildId, query), options),
            ),
            addRole: op(
                2,
                (owner: Owner, member: MemberReference, roleId: string, options?: GuildAuditOperationOptions) =>
                    owner.guild("members.addRole", () => memberRole(member, roleId, true), options),
            ),
            removeRole: op(
                2,
                (owner: Owner, member: MemberReference, roleId: string, options?: GuildAuditOperationOptions) =>
                    owner.guild("members.removeRole", () => memberRole(member, roleId, false), options),
            ),
        },
        permissions: {
            calculate: pure((_owner: Owner, input: PermissionInput) => calculatePermissions(input)),
            fetch: op(1, (owner: Owner, target: PermissionTarget, options?: GuildOperationOptions) =>
                fetchPermissions(owner, target, options),
            ),
        },
        roles: {
            setHoistPositions: op(
                2,
                (
                    owner: Owner,
                    guildId: string,
                    positions: readonly RoleHoistPosition[],
                    options?: GuildAuditOperationOptions,
                ) => owner.guild("roles.setHoistPositions", () => roleSetHoistPositions(guildId, positions), options),
            ),
            resetHoistPositions: op(1, (owner: Owner, guildId: string, options?: GuildAuditOperationOptions) =>
                owner.guild("roles.resetHoistPositions", () => roleResetHoistPositions(guildId), options),
            ),
            get: get((owner: Owner, role: RoleReference) => owner.getResource("roles", role)),
            fetchAll: op(1, (owner: Owner, guildId: string, options?: GuildOperationOptions) =>
                owner.guild("roles.fetchAll", () => roleList(guildId), options),
            ),
            create: op(2, (owner: Owner, guildId: string, input: RoleCreate, options?: GuildAuditOperationOptions) =>
                owner.guild("roles.create", () => roleCreate(guildId, input), options),
            ),
            edit: op(2, (owner: Owner, role: RoleReference, input: RoleEdit, options?: GuildAuditOperationOptions) =>
                owner.guild("roles.edit", () => roleEdit(role, input), options),
            ),
            delete: op(1, (owner: Owner, role: RoleReference, options?: GuildAuditOperationOptions) =>
                owner.guild("roles.delete", () => roleDelete(role), options),
            ),
            reorder: op(
                2,
                (
                    owner: Owner,
                    guildId: string,
                    positions: readonly RolePosition[],
                    options?: GuildAuditOperationOptions,
                ) => owner.guild("roles.reorder", () => roleReorder(guildId, positions), options),
            ),
        },
        attachments: {
            refreshUrls: op(1, (owner: Owner, urls: readonly string[], options?: AttachmentRefreshOptions) =>
                owner.refreshAttachmentUrls(urls, options),
            ),
            download: op(1, (owner: Owner, attachment: Attachment, options: AttachmentDownloadOptions) =>
                owner.downloadAttachment(attachment, options),
            ),
            stream: custom("stream", defaultAttachmentStream<M>, nativeAttachmentStream<M>),
        },
        messages: {
            publish: named(
                "publish",
                op(1, (owner: Owner, target: MessageReference, options?: MessageOperationOptions) =>
                    owner.publish(target, options),
                ),
            ),
            fetchCrosspostSource: named(
                "fetchCrosspostSource",
                op(1, (owner: Owner, target: MessageReference, options?: MessageOperationOptions) =>
                    owner.fetchCrosspostSource(target, options),
                ),
            ),
            iterateHistory: named(
                "iterateHistory",
                page(
                    2,
                    (
                        owner: Owner,
                        channelId: string,
                        query: HistoryIterationQuery,
                        options?: MessageOperationOptions,
                    ) => historyPagination(owner, channelId, query, options),
                ),
            ),
            search: named(
                "search",
                op(
                    2,
                    (
                        owner: Owner,
                        context: MessageSearchContext,
                        query?: MessageSearchQuery,
                        options?: MessageOperationOptions,
                    ) => owner.searchMessages(context, query, options),
                ),
            ),
            iterateSearch: page(
                3,
                (
                    owner: Owner,
                    context: MessageSearchContext,
                    filters: Omit<MessageSearchQuery, "limit" | "page">,
                    limits: MessageSearchIterationLimits,
                    options?: MessageOperationOptions,
                ) => searchMessagePagination(owner, context, filters, limits, options),
            ),
            iterateReactionUsers: named(
                "iterateReactionUsers",
                page(
                    3,
                    (
                        owner: Owner,
                        message: MessageReference,
                        emoji: ReactionEmojiInput,
                        query: UserIterationQuery,
                        options?: MessageOperationOptions,
                    ) => reactionUserPagination(owner, message, emoji, query, options),
                ),
            ),
            iteratePins: named(
                "iteratePins",
                page(
                    2,
                    (owner: Owner, channelId: string, query: PinIterationQuery, options?: MessageOperationOptions) =>
                        pinPagination(owner, channelId, query, options),
                ),
            ),
            removeUserReaction: named(
                "removeUserReaction",
                op(
                    3,
                    (
                        owner: Owner,
                        message: MessageReference,
                        emoji: ReactionEmojiInput,
                        userId: string,
                        options?: MessageOperationOptions,
                    ) => owner.reaction("removeUserReaction", message, emoji, options, userId),
                ),
            ),
            clearReaction: named(
                "clearReaction",
                op(
                    2,
                    (
                        owner: Owner,
                        message: MessageReference,
                        emoji: ReactionEmojiInput,
                        options?: MessageOperationOptions,
                    ) => owner.reaction("clearReaction", message, emoji, options),
                ),
            ),
            clearReactions: named(
                "clearReactions",
                op(1, (owner: Owner, message: MessageReference, options?: MessageOperationOptions) =>
                    owner.reaction("clearReactions", message, undefined, options),
                ),
            ),
            pin: named(
                "pin",
                op(1, (owner: Owner, message: MessageReference, options?: MessageAuditOperationOptions) =>
                    owner.pin("pin", message, options),
                ),
            ),
            unpin: named(
                "unpin",
                op(1, (owner: Owner, message: MessageReference, options?: MessageAuditOperationOptions) =>
                    owner.pin("unpin", message, options),
                ),
            ),
            fetchPins: named(
                "fetchPins",
                op(2, (owner: Owner, channelId: string, query?: MessagePinsQuery, options?: MessageOperationOptions) =>
                    owner.fetchPins(channelId, query, options),
                ),
            ),
            fetchReactionUsers: named(
                "fetchReactionUsers",
                op(
                    3,
                    (
                        owner: Owner,
                        message: MessageReference,
                        emoji: ReactionEmojiInput,
                        query?: ReactionUsersQuery,
                        options?: MessageOperationOptions,
                    ) => owner.fetchReactionUsers(message, emoji, query, options),
                ),
            ),
            addReaction: named(
                "addReaction",
                op(
                    2,
                    (
                        owner: Owner,
                        message: MessageReference,
                        emoji: ReactionEmojiInput,
                        options?: MessageOperationOptions,
                    ) => owner.reaction("addReaction", message, emoji, options),
                ),
            ),
            removeReaction: named(
                "removeReaction",
                op(
                    2,
                    (
                        owner: Owner,
                        message: MessageReference,
                        emoji: ReactionEmojiInput,
                        options?: MessageOperationOptions,
                    ) => owner.reaction("removeReaction", message, emoji, options),
                ),
            ),
            collect: custom("custom", defaultCollect<M>, nativeCollect<M>),
            collectReactions: custom("custom", defaultCollectReactions<M>, nativeCollectReactions<M>),
            get: get((owner: Owner, message: MessageReference) => owner.get(message)),
            send: named(
                "send",
                op(2, (owner: Owner, channelId: string, input: MessageInput | string, options?: SendOptions) =>
                    owner.send(channelId, input, options),
                ),
            ),
            forward: named(
                "forward",
                op(2, (owner: Owner, channelId: string, input: ForwardMessageInput, options?: SendOptions) =>
                    owner.forward(channelId, input, options),
                ),
            ),
            typing: named(
                "typing",
                op(1, (owner: Owner, channelId: string, options?: MessageOperationOptions) =>
                    owner.typing(channelId, options),
                ),
            ),
            keepTyping: custom("custom", defaultKeepTyping<M>, nativeKeepTyping<M>),
            reply: named(
                "reply",
                op(2, (owner: Owner, message: MessageReference, input: ReplyInput | string, options?: SendOptions) =>
                    owner.reply(message, input, options),
                ),
            ),
            fetch: named(
                "fetch",
                op(1, (owner: Owner, message: MessageReference, options?: MessageOperationOptions) =>
                    owner.fetch(message, options),
                ),
            ),
            fetchHistory: named(
                "fetchHistory",
                op(
                    2,
                    (owner: Owner, channelId: string, query?: MessageHistoryQuery, options?: MessageOperationOptions) =>
                        owner.fetchHistory(channelId, query, options),
                ),
            ),
            previewCleanup: named(
                "previewCleanup",
                op(
                    2,
                    (
                        owner: Owner,
                        channelId: string,
                        selection: MessageCleanupSelection<M>,
                        options?: MessageOperationOptions,
                    ) => previewCleanup(owner, channelId, selection, options),
                ),
            ),
            cleanup: named(
                "cleanup",
                op(1, (owner: Owner, plan: MessageCleanupPlan<M>, options?: MessageCleanupOptions) =>
                    cleanup(owner, plan, options),
                ),
            ),
            edit: named(
                "edit",
                op(
                    2,
                    (
                        owner: Owner,
                        message: MessageReference,
                        input: EditMessageInput | string,
                        options?: MessageOperationOptions,
                    ) => owner.edit(message, input, options),
                ),
            ),
            delete: named(
                "delete",
                op(1, (owner: Owner, message: MessageReference, options?: MessageAuditOperationOptions) =>
                    owner.delete(message, options),
                ),
            ),
            deleteAttachment: named(
                "deleteAttachment",
                op(
                    2,
                    (
                        owner: Owner,
                        message: MessageReference,
                        attachmentId: string,
                        options?: MessageOperationOptions,
                    ) => owner.deleteAttachment(message, attachmentId, options),
                ),
            ),
            deleteMany: named(
                "deleteMany",
                op(
                    2,
                    (
                        owner: Owner,
                        channelId: string,
                        messageIds: readonly string[],
                        options?: MessageAuditOperationOptions,
                    ) => owner.deleteMany(channelId, messageIds, options),
                ),
            ),
            deleteOwnMessages: named(
                "deleteOwnMessages",
                op(1, (owner: Owner, channelId: string, options: OwnMessageDeletionOptions) =>
                    owner.deleteOwnMessages(channelId, options),
                ),
            ),
        },
    })
}

/** The operation table for one client's selected message type */
export type OperationTable<M extends MessageCore> = ReturnType<typeof defineOperations<M>>

/** Build the table for one client. Entries hold no client state until a binder supplies the owner */
export const operationTable = <M extends MessageCore>(): OperationTable<M> => defineOperations<M>()

/** Iterate table entries with their default operation IDs */
export function eachEntry<M extends MessageCore>(
    table: OperationTable<M>,
    bind: (entry: BindableEntry<M>, id: Operation) => unknown,
): Record<string, Readonly<Record<string, unknown>>> {
    const namespaces: Record<string, Readonly<Record<string, unknown>>> = {}
    for (const [namespace, members] of Object.entries(table)) {
        const bound: Record<string, unknown> = {}
        for (const [member, entry] of Object.entries(
            members as Record<string, BindableEntry<M> & { readonly id?: Operation }>,
        ))
            bound[member] = bind(entry, entry.id ?? (`${namespace}.${member}` as Operation))
        namespaces[namespace] = Object.freeze(bound)
    }
    return namespaces
}
