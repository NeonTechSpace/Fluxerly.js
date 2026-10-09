/**
 * Testing fixtures: Deterministic Fluxer wire payloads for application tests and the documented fixture token.
 * Invariant: Every builder returns a fresh plain JSON object in the Fluxer wire shape (snake_case), accepted by the SDK's
 * real decoders without overrides, and one fixture set always produces the same IDs in the same call order.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */

/**
 * A token-shaped value used by test clients by default. It is not a credential, and the fake transport never sends it anywhere
 *
 * @category Testing
 */
export const fixtureToken = "fixture-only-not-a-credential"

/** Fluxer's snowflake epoch, 2015-01-01T00:00:00.000Z */
const snowflakeEpochMs = 1_420_070_400_000n
/** Creation time encoded in every fixture ID and used for fixture timestamps */
const fixtureTimeMs = 1_767_225_600_000n
/** ISO 8601 form of the fixture creation time, 2026-01-01T00:00:00.000Z */
export const fixtureTimestamp = new Date(Number(fixtureTimeMs)).toISOString()

/**
 * Wire-field overrides for a fixture builder. Listed fields keep their wire types, and any other field is copied unchanged,
 * so a test can add fields this SDK version does not model or pass undefined to leave a default field out of the payload
 *
 * @category Testing
 */
export type WireOverrides<T> = { readonly [K in keyof T]?: T[K] | undefined } & { readonly [key: string]: unknown }

/**
 * A public Fluxer account in the wire shape used by message authors, members and user reads
 *
 * @category Testing
 */
export interface WireUser {
    /** Account snowflake ID */
    readonly id: string
    /** Account username */
    readonly username: string
    /** Four-digit discriminator string */
    readonly discriminator: string
    /** Display name, or null when unset */
    readonly global_name: string | null
    /** Avatar hash, or null when unset */
    readonly avatar: string | null
    /** Generated avatar color, or null when unset */
    readonly avatar_color: number | null
    /** Public account flag bits */
    readonly flags: number
    /** Whether the account is a bot, present on bot accounts */
    readonly bot?: boolean
}

/**
 * A community record in the wire shape of guild reads, GUILD_UPDATE and the properties of GUILD_CREATE
 *
 * @category Testing
 */
export interface WireGuild {
    /** Guild snowflake ID */
    readonly id: string
    /** Community name */
    readonly name: string
    /** Icon hash, or null when unset */
    readonly icon: string | null
    /** Banner hash, or null when unset */
    readonly banner: string | null
    /** Invite splash hash, or null when unset */
    readonly splash: string | null
    /** Embed splash hash, or null when unset */
    readonly embed_splash: string | null
    /** Splash card alignment, 0 for center */
    readonly splash_card_alignment: number
    /** Vanity invite code, or null when unset */
    readonly vanity_url_code: string | null
    /** Owner account ID */
    readonly owner_id: string
    /** System message channel ID, or null when unset */
    readonly system_channel_id: string | null
    /** System channel flag bits */
    readonly system_channel_flags: number
    /** Rules channel ID, or null when unset */
    readonly rules_channel_id: string | null
    /** AFK voice channel ID, or null when unset */
    readonly afk_channel_id: string | null
    /** AFK timeout in seconds */
    readonly afk_timeout: number
    /** Enabled community feature names */
    readonly features: readonly string[]
    /** Verification level */
    readonly verification_level: number
    /** MFA requirement level */
    readonly mfa_level: number
    /** NSFW classification level */
    readonly nsfw_level: number
    /** Whether the community is marked NSFW */
    readonly nsfw: boolean
    /** Content warning level */
    readonly content_warning_level: number
    /** Content warning text, or null when unset */
    readonly content_warning_text: string | null
    /** Explicit content filter level */
    readonly explicit_content_filter: number
    /** Default notification level */
    readonly default_message_notifications: number
    /** Disabled community operation bits */
    readonly disabled_operations: number
}

/**
 * A community role in the wire shape of role reads and role events
 *
 * @category Testing
 */
export interface WireRole {
    /** Role snowflake ID. The everyone role uses the guild ID */
    readonly id: string
    /** Role name */
    readonly name: string
    /** RGB color as an integer, 0 for none */
    readonly color: number
    /** Position in the role list */
    readonly position: number
    /** Member-list hoist position, or null when unset */
    readonly hoist_position: number | null
    /** Permission bits as a decimal string */
    readonly permissions: string
    /** Whether members are shown separately */
    readonly hoist: boolean
    /** Whether anyone may mention the role */
    readonly mentionable: boolean
    /** Unicode emoji shown with the role, or null when unset */
    readonly unicode_emoji: string | null
}

/**
 * A community channel in the wire shape of channel reads and channel events
 *
 * @category Testing
 */
export interface WireChannel {
    /** Channel snowflake ID */
    readonly id: string
    /** Guild ID. Private channels omit it */
    readonly guild_id: string
    /** Channel type, 0 for a text channel */
    readonly type: number
    /** Channel name */
    readonly name: string
    /** Topic, or null when unset */
    readonly topic: string | null
    /** Sorting position */
    readonly position: number
    /** Parent category ID, or null when uncategorized */
    readonly parent_id: string | null
    /** Whether the channel is marked NSFW */
    readonly nsfw: boolean
    /** Slow-mode interval in seconds */
    readonly rate_limit_per_user: number
    /** Latest message ID, or null when none is known */
    readonly last_message_id: string | null
    /** Latest pin time, or null when nothing is pinned */
    readonly last_pin_timestamp: string | null
    /** Role and member permission overwrites */
    readonly permission_overwrites: readonly unknown[]
}

/**
 * A thread in the wire shape of thread reads, thread lists and THREAD_CREATE and THREAD_UPDATE
 *
 * @category Testing
 */
export interface WireThread {
    /** Thread snowflake ID */
    readonly id: string
    /** Guild ID */
    readonly guild_id: string
    /** Thread type: 10 announcement, 11 public or 12 private */
    readonly type: number
    /** ID of the text, announcement, forum or media channel holding the thread */
    readonly parent_id: string
    /** ID of the user or webhook that created the thread */
    readonly owner_id: string
    /** Thread name */
    readonly name: string
    /** Latest message ID, or null when the thread has none */
    readonly last_message_id: string | null
    /** Latest pin time, or null when nothing was pinned */
    readonly last_pin_timestamp: string | null
    /** Slow-mode interval in seconds */
    readonly rate_limit_per_user: number
    /** Channel flag bits, where 2 pins a forum post */
    readonly flags: number
    /** Archive and lock state */
    readonly thread_metadata: {
        /** Whether the thread is archived */
        readonly archived: boolean
        /** Inactivity period in minutes before Fluxer archives the thread */
        readonly auto_archive_duration: number
        /** ISO 8601 time the archive state last changed */
        readonly archive_timestamp: string
        /** Whether only thread moderators can act in the thread */
        readonly locked: boolean
        /** Whether members may invite others, present only on a private thread */
        readonly invitable?: boolean
        /** ISO 8601 creation time */
        readonly create_timestamp: string
    }
    /** Messages in the thread */
    readonly message_count: number
    /** Messages ever sent in the thread */
    readonly total_message_sent: number
    /** Thread member count, capped at 50 */
    readonly member_count: number
    /** IDs of the tags applied to a forum or media post */
    readonly applied_tags?: readonly string[]
    /** The bot's own membership, present when the bot joined the thread */
    readonly member?: {
        /** ISO 8601 time the bot last joined */
        readonly join_timestamp: string
        /** Thread member flag bits */
        readonly flags: number
    }
}

/**
 * A forum or media channel in the wire shape of channel reads and channel events
 *
 * @category Testing
 */
export interface WireForumChannel {
    /** Channel snowflake ID */
    readonly id: string
    /** Guild ID */
    readonly guild_id: string
    /** Channel type, 15 for a forum channel or 16 for a media channel */
    readonly type: number
    /** Channel name */
    readonly name: string
    /** Posting guidelines, or null when unset */
    readonly topic: string | null
    /** Sorting position */
    readonly position: number
    /** Parent category ID, or null when uncategorized */
    readonly parent_id: string | null
    /** Whether the channel is marked NSFW */
    readonly nsfw: boolean
    /** Delay in seconds between one member's posts */
    readonly rate_limit_per_user: number
    /** Newest post ID, or null when the channel never had one */
    readonly last_message_id: string | null
    /** Latest pin time, or null */
    readonly last_pin_timestamp: string | null
    /** Role and member permission overwrites */
    readonly permission_overwrites: readonly unknown[]
    /** Channel flag bits, where 16 requires a tag on every post */
    readonly flags: number
    /** Tags that posts can carry */
    readonly available_tags: readonly {
        /** Tag snowflake ID */
        readonly id: string
        /** Tag name */
        readonly name: string
        /** Whether only thread moderators can apply the tag */
        readonly moderated: boolean
        /** Custom emoji ID, or null */
        readonly emoji_id: string | null
        /** Unicode emoji, or null */
        readonly emoji_name: string | null
    }[]
    /** Reaction suggested on each post, or null when unset */
    readonly default_reaction_emoji: {
        /** Custom emoji ID, or null for a Unicode emoji */
        readonly emoji_id: string | null
        /** Unicode emoji, or null for a custom emoji */
        readonly emoji_name: string | null
    } | null
    /** Default post order, or null when unset */
    readonly default_sort_order: number | null
    /** Default post layout, present only on a forum channel */
    readonly default_forum_layout?: number
    /** Default tag matching of a post search */
    readonly default_tag_setting: string
    /** Stored default auto-archive period in minutes, or null when unset */
    readonly default_auto_archive_duration: number | null
    /** Slow-mode interval in seconds that new posts copy */
    readonly default_thread_rate_limit_per_user: number
}

/**
 * A community membership in the wire shape of GUILD_MEMBER_ADD and GUILD_MEMBER_UPDATE.
 * Member reads return the same fields without guild_id, and the SDK ignores that extra field there
 *
 * @category Testing
 */
export interface WireMember {
    /** Guild ID carried by member events */
    readonly guild_id: string
    /** Member account */
    readonly user: WireUser
    /** Community nickname, or null when unset */
    readonly nick: string | null
    /** Community avatar hash, or null when unset */
    readonly avatar: string | null
    /** Community banner hash, or null when unset */
    readonly banner: string | null
    /** Community profile accent color, or null when unset */
    readonly accent_color: number | null
    /** Assigned role IDs, excluding the everyone role */
    readonly roles: readonly string[]
    /** ISO 8601 join time */
    readonly joined_at: string
    /** Whether the member is community-muted */
    readonly mute: boolean
    /** Whether the member is community-deafened */
    readonly deaf: boolean
    /** ISO 8601 end of a timeout, or null when not timed out */
    readonly communication_disabled_until: string | null
}

/**
 * A complete GUILD_CREATE dispatch body: The community ready object with its roles, channels, threads and members
 *
 * @category Testing
 */
export interface WireGuildCreate {
    /** Guild snowflake ID, equal to properties.id */
    readonly id: string
    /** The community record */
    readonly properties: WireGuild
    /** Every role, including the everyone role */
    readonly roles: readonly WireRole[]
    /** Channels the bot can view, including forum and media channels */
    readonly channels: readonly (WireChannel | WireForumChannel)[]
    /** Active threads the bot can view, each with member when the bot joined it */
    readonly threads: readonly WireThread[]
    /** Community emojis */
    readonly emojis: readonly unknown[]
    /** Community stickers */
    readonly stickers: readonly unknown[]
    /** Members sent with the community, without guild_id */
    readonly members: readonly unknown[]
    /** Total member count */
    readonly member_count: number
    /** Online member count */
    readonly online_count: number
    /** Always empty. Presences arrive as separate dispatches */
    readonly presences: readonly unknown[]
    /** Voice states in visible channels */
    readonly voice_states: readonly unknown[]
    /** ISO 8601 time the bot joined, or null */
    readonly joined_at: string | null
    /** False in the startup burst after READY. Leave it out to describe a community the bot has just joined */
    readonly unavailable?: boolean
}

/**
 * A message in the wire shape of message reads, MESSAGE_CREATE and MESSAGE_UPDATE
 *
 * @category Testing
 */
export interface WireMessage {
    /** Message snowflake ID */
    readonly id: string
    /** Channel ID */
    readonly channel_id: string
    /** Guild ID. Direct messages omit it */
    readonly guild_id?: string
    /** Message author */
    readonly author: WireUser
    /** Message type, 0 for a default message */
    readonly type: number
    /** Message flag bits */
    readonly flags: number
    /** Text content */
    readonly content: string
    /** ISO 8601 creation time */
    readonly timestamp: string
    /** ISO 8601 edit time, or null when never edited */
    readonly edited_timestamp: string | null
    /** Whether the message is pinned */
    readonly pinned: boolean
    /** Whether the message mentions everyone */
    readonly mention_everyone: boolean
    /** Whether the message was sent as text-to-speech */
    readonly tts: boolean
    /** Mentioned accounts */
    readonly mentions: readonly WireUser[]
    /** Mentioned role IDs */
    readonly mention_roles: readonly string[]
    /** Rich embeds */
    readonly embeds: readonly unknown[]
    /** Attachments */
    readonly attachments: readonly unknown[]
    /** Stickers */
    readonly stickers: readonly unknown[]
}

/**
 * Overrides for a GUILD_CREATE fixture. The guild field merges into the default community record, and the other fields
 * replace the default body fields
 *
 * @category Testing
 */
export type WireGuildCreateOverrides = WireOverrides<Omit<WireGuildCreate, "properties">> & {
    /** Community record fields merged into the default community, whose ID also becomes the body ID */
    readonly guild?: WireOverrides<WireGuild>
}

/**
 * A set of wire payload builders sharing one deterministic ID sequence.
 * Each builder returns a fresh object whose unspecified fields take sensible defaults linked to one default community,
 * channel and author, so payloads from one set refer to each other without extra setup.
 * IDs come from a counter over a fixed 2026-01-01 creation time, so the same calls in the same order always produce
 * the same IDs and timestamps
 *
 * @category Testing
 */
export interface Fixtures {
    /** The IDs that builders use by default: One community, one text channel, one human author and the test bot account */
    readonly ids: {
        /** Default guild ID for guild, channel, member, message and GUILD_CREATE payloads */
        readonly guild: string
        /** Default text channel ID for channel and message payloads, also the community's system channel */
        readonly channel: string
        /** Default human account ID for user, member and message author payloads, also the community owner */
        readonly user: string
        /** The test bot account ID, reported in READY by test clients */
        readonly bot: string
    }
    /** Return the next unused snowflake ID from this set's sequence. Each call returns a new, larger ID */
    nextId(): string
    /** Build a human account, by default the default author */
    user(overrides?: WireOverrides<WireUser>): WireUser
    /** Build the test bot account, the user that test clients report in READY */
    botUser(overrides?: WireOverrides<WireUser>): WireUser
    /** Build a community record, by default the default community owned by the default author */
    guild(overrides?: WireOverrides<WireGuild>): WireGuild
    /**
     * Build a GUILD_CREATE body for the default community, as sent in the startup burst after READY.
     * By default it holds the everyone role, the default text channel and the bot's own membership
     */
    guildCreate(overrides?: WireGuildCreateOverrides): WireGuildCreate
    /** Build a community text channel, by default the default channel in the default community */
    channel(overrides?: WireOverrides<WireChannel>): WireChannel
    /**
     * Build a public thread with a new ID in the default channel, started by the default author, active and without
     * the bot's membership. Pass type 12 for a private thread, whose default metadata then includes invitable, or a
     * member field to describe the bot's membership
     */
    thread(overrides?: WireOverrides<WireThread>): WireThread
    /**
     * Build a forum channel with a new ID in the default community, without tags. Pass type 16 for a media channel,
     * which then leaves out default_forum_layout as Fluxer does
     */
    forumChannel(overrides?: WireOverrides<WireForumChannel>): WireForumChannel
    /** Build a role with a new ID in the default community's role list, without permissions */
    role(overrides?: WireOverrides<WireRole>): WireRole
    /** Build a membership of the default author in the default community, carrying guild_id as member events do */
    member(overrides?: WireOverrides<WireMember>): WireMember
    /** Build a message with a new ID from the default author in the default channel and community */
    message(overrides?: WireOverrides<WireMessage>): WireMessage
}

function merge<T>(defaults: T, overrides: WireOverrides<T> | undefined): T {
    if (overrides === undefined) return defaults
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))
        throw new TypeError("Fixture overrides must be a plain object of wire fields")
    return { ...defaults, ...overrides } as T
}

/**
 * Create an independent fixture set whose ID sequence starts from the beginning.
 * Use one set per test, or the fixtures property of a test client, when IDs must not depend on other tests
 *
 * @example
 * ```ts
 * import { createFixtures } from "@neontechspace/fluxerly/testing"
 * const fixtures = createFixtures()
 * export const command = fixtures.message({ content: "!ping" })
 * ```
 *
 * @category Testing
 */
export function createFixtures(): Fixtures {
    let sequence = 0n
    const nextId = () => String(((fixtureTimeMs - snowflakeEpochMs) << 22n) + ++sequence)
    const ids = Object.freeze({ guild: nextId(), channel: nextId(), user: nextId(), bot: nextId() })
    const user = (overrides?: WireOverrides<WireUser>): WireUser =>
        merge<WireUser>(
            {
                id: ids.user,
                username: "fixture-user",
                discriminator: "0001",
                global_name: null,
                avatar: null,
                avatar_color: null,
                flags: 0,
            },
            overrides,
        )
    const botUser = (overrides?: WireOverrides<WireUser>): WireUser =>
        merge<WireUser>(user({ id: ids.bot, username: "fixture-bot", discriminator: "0000", bot: true }), overrides)
    const guild = (overrides?: WireOverrides<WireGuild>): WireGuild =>
        merge<WireGuild>(
            {
                id: ids.guild,
                name: "Fixture Guild",
                icon: null,
                banner: null,
                splash: null,
                embed_splash: null,
                splash_card_alignment: 0,
                vanity_url_code: null,
                owner_id: ids.user,
                system_channel_id: ids.channel,
                system_channel_flags: 0,
                rules_channel_id: null,
                afk_channel_id: null,
                afk_timeout: 300,
                features: [],
                verification_level: 0,
                mfa_level: 0,
                nsfw_level: 0,
                nsfw: false,
                content_warning_level: 0,
                content_warning_text: null,
                explicit_content_filter: 0,
                default_message_notifications: 0,
                disabled_operations: 0,
            },
            overrides,
        )
    const channel = (overrides?: WireOverrides<WireChannel>): WireChannel =>
        merge<WireChannel>(
            {
                id: ids.channel,
                guild_id: ids.guild,
                type: 0,
                name: "general",
                topic: null,
                position: 0,
                parent_id: null,
                nsfw: false,
                rate_limit_per_user: 0,
                last_message_id: null,
                last_pin_timestamp: null,
                permission_overwrites: [],
            },
            overrides,
        )
    const thread = (overrides?: WireOverrides<WireThread>): WireThread => {
        const isPrivate = overrides?.type === 12
        return merge<WireThread>(
            {
                id: nextId(),
                guild_id: ids.guild,
                type: 11,
                parent_id: ids.channel,
                owner_id: ids.user,
                name: "fixture-thread",
                last_message_id: null,
                last_pin_timestamp: null,
                rate_limit_per_user: 0,
                flags: 0,
                thread_metadata: {
                    archived: false,
                    auto_archive_duration: 4320,
                    archive_timestamp: fixtureTimestamp,
                    locked: false,
                    ...(isPrivate ? { invitable: true } : {}),
                    create_timestamp: fixtureTimestamp,
                },
                message_count: 0,
                total_message_sent: 0,
                member_count: 1,
            },
            overrides,
        )
    }
    const forumChannel = (overrides?: WireOverrides<WireForumChannel>): WireForumChannel =>
        merge<WireForumChannel>(
            {
                id: nextId(),
                guild_id: ids.guild,
                type: 15,
                name: "fixture-forum",
                topic: null,
                position: 1,
                parent_id: null,
                nsfw: false,
                rate_limit_per_user: 0,
                last_message_id: null,
                last_pin_timestamp: null,
                permission_overwrites: [],
                flags: 0,
                available_tags: [],
                default_reaction_emoji: null,
                default_sort_order: null,
                ...(overrides?.type === 16 ? {} : { default_forum_layout: 0 }),
                default_tag_setting: "match_some",
                default_auto_archive_duration: null,
                default_thread_rate_limit_per_user: 0,
            },
            overrides,
        )
    const role = (overrides?: WireOverrides<WireRole>): WireRole =>
        merge<WireRole>(
            {
                id: nextId(),
                name: "fixture-role",
                color: 0,
                position: 1,
                hoist_position: null,
                permissions: "0",
                hoist: false,
                mentionable: false,
                unicode_emoji: null,
            },
            overrides,
        )
    const member = (overrides?: WireOverrides<WireMember>): WireMember =>
        merge<WireMember>(
            {
                guild_id: ids.guild,
                user: user(),
                nick: null,
                avatar: null,
                banner: null,
                accent_color: null,
                roles: [],
                joined_at: fixtureTimestamp,
                mute: false,
                deaf: false,
                communication_disabled_until: null,
            },
            overrides,
        )
    const guildCreate = (overrides?: WireGuildCreateOverrides): WireGuildCreate => {
        const { guild: guildOverrides, ...body } = overrides ?? {}
        const properties = guild(guildOverrides)
        const { guild_id: _, ...botMember } = member({ guild_id: properties.id, user: botUser() })
        return merge<WireGuildCreate>(
            {
                id: properties.id,
                properties,
                roles: [role({ id: properties.id, name: "@everyone", position: 0 })],
                channels: [channel({ guild_id: properties.id })],
                threads: [],
                emojis: [],
                stickers: [],
                members: [botMember],
                member_count: 2,
                online_count: 1,
                presences: [],
                voice_states: [],
                joined_at: fixtureTimestamp,
                unavailable: false,
            },
            body,
        )
    }
    const message = (overrides?: WireOverrides<WireMessage>): WireMessage =>
        merge<WireMessage>(
            {
                id: nextId(),
                channel_id: ids.channel,
                guild_id: ids.guild,
                author: user(),
                type: 0,
                flags: 0,
                content: "fixture message",
                timestamp: fixtureTimestamp,
                edited_timestamp: null,
                pinned: false,
                mention_everyone: false,
                tts: false,
                mentions: [],
                mention_roles: [],
                embeds: [],
                attachments: [],
                stickers: [],
            },
            overrides,
        )
    return Object.freeze({
        ids,
        nextId,
        user,
        botUser,
        guild,
        guildCreate,
        channel,
        thread,
        forumChannel,
        role,
        member,
        message,
    })
}

/**
 * A shared fixture set for quick payloads. Its ID sequence continues across every caller in the process, so prefer
 * createFixtures or a test client's fixtures when a test compares exact message or role IDs
 *
 * @example
 * ```ts
 * import { fixtures } from "@neontechspace/fluxerly/testing"
 * export const ping = fixtures.message({ content: "!ping" })
 * ```
 *
 * @category Testing
 */
export const fixtures: Fixtures = createFixtures()
