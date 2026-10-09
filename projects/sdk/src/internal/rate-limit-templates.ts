/**
 * Registry of pinned Fluxer route-template hashes and their declared resource parameters, not rate values.
 * Invariant: Fluxer hashes unresolved templates but enforces resolved resources, so a hash alone never establishes cross-resource
 * sharing. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { createHash } from "node:crypto"

// Matches the parameterized buckets in the Fluxer rate-limit configs at the commit pinned by
// projects/release/upstream/manifest.json, except the oauth_dev buckets of session-only developer routes.
// The daily upstream drift check reports bucket changes.
// Fluxer hashes the unresolved template for the response header, then resolves these parameters for storage,
// so the hash alone does not distinguish independently limited resources
const parameterizedTemplates = [
    "channel:attachment:upload::channel_id",
    "channel:call:get::channel_id",
    "channel:call:ring::channel_id",
    "channel:call:stop_ringing::channel_id",
    "channel:call:update::channel_id",
    "channel:delete::channel_id",
    "channel:follow::channel_id",
    "channel:follower_stats::channel_id",
    "channel:forum_tags::channel_id",
    "channel:message:ack::channel_id",
    "channel:message:bulk_delete::channel_id",
    "channel:message:create::channel_id",
    "channel:message:crosspost::channel_id",
    "channel:message:crosspost_source::channel_id",
    "channel:message:delete::channel_id",
    "channel:message:purge::channel_id",
    "channel:message:read::channel_id",
    "channel:message:update::channel_id",
    "channel:messages:read::channel_id",
    "channel:pins::channel_id",
    "channel:post_data::channel_id",
    "channel:reactions::channel_id",
    "channel:read_state:delete::channel_id",
    "channel:read::channel_id",
    "channel:search::channel_id",
    "channel:stream:preview:delete::stream_key",
    "channel:stream:preview:get::stream_key",
    "channel:stream:preview:post::stream_key",
    "channel:stream:preview:upload_url::stream_key",
    "channel:stream:update::stream_key",
    "channel:thread:create::channel_id",
    "channel:thread:member:delete::channel_id",
    "channel:thread:member:get::channel_id",
    "channel:thread:member:put::channel_id",
    "channel:thread:member:settings::channel_id",
    "channel:thread:members:list::channel_id",
    "channel:threads:archived:list::channel_id",
    "channel:threads:search::channel_id",
    "channel:typing::channel_id",
    "channel:update::channel_id",
    "discovery:apply::guild_id",
    "discovery:status::guild_id",
    "guild:audit_logs::guild_id",
    "guild:channel:create::guild_id",
    "guild:channel:positions::guild_id",
    "guild:channels:list::guild_id",
    "guild:delete::guild_id",
    "guild:emoji:bulk_create::guild_id",
    "guild:emoji:clone::guild_id",
    "guild:emoji:create::guild_id",
    "guild:emoji:delete::guild_id",
    "guild:emoji:delete:daily::guild_id",
    "guild:emoji:metadata::user_id",
    "guild:emoji:source::user_id",
    "guild:emoji:update::guild_id",
    "guild:emojis:list::guild_id",
    "guild:leave::guild_id",
    "guild:member:remove::guild_id",
    "guild:member:role:add::guild_id",
    "guild:member:role:remove::guild_id",
    "guild:member:update::guild_id",
    "guild:members::guild_id",
    "guild:read::guild_id",
    "guild:role:create::guild_id",
    "guild:role:delete::guild_id",
    "guild:role:hoist_positions_reset::guild_id",
    "guild:role:hoist_positions::guild_id",
    "guild:role:list::guild_id",
    "guild:role:positions::guild_id",
    "guild:role:update::guild_id",
    "guild:search::guild_id",
    "guild:sticker:bulk_create::guild_id",
    "guild:sticker:clone::guild_id",
    "guild:sticker:create::guild_id",
    "guild:sticker:delete::guild_id",
    "guild:sticker:delete:daily::guild_id",
    "guild:sticker:list::guild_id",
    "guild:sticker:metadata::user_id",
    "guild:sticker:source::user_id",
    "guild:sticker:update::guild_id",
    "guild:threads:active::guild_id",
    "guild:update::guild_id",
    "guild:vanity_url:get::guild_id",
    "guild:vanity_url:patch::guild_id",
    "invite:create::channel_id",
    "invite:delete::invite_code",
    "invite:list::channel_id",
    "invite:list::guild_id",
    "invite:read::invite_code",
    "user:profile::target_id",
    "user:read::user_id",
    "voice:entrance_sound:play::user_id::channel_id",
    "webhook:create::channel_id",
    "webhook:delete::webhook_id",
    "webhook:execute::webhook_id",
    "webhook:github::webhook_id",
    "webhook:instatus::webhook_id",
    "webhook:list::channel_id",
    "webhook:list::guild_id",
    "webhook:message_delete::webhook_id",
    "webhook:message_edit::webhook_id",
    "webhook:message_get::webhook_id",
    "webhook:read::webhook_id",
    "webhook:update::webhook_id",
] as const

// Fluxer fills placeholders only from path parameters. These routes have no user_id parameter, so the placeholder
// stays literal and one bucket covers every expression the caller looks up
const callerWideTemplates: ReadonlySet<string> = new Set([
    "guild:emoji:metadata::user_id",
    "guild:emoji:source::user_id",
    "guild:sticker:metadata::user_id",
    "guild:sticker:source::user_id",
])

const parameterNames = (template: string): readonly string[] =>
    callerWideTemplates.has(template)
        ? Object.freeze([])
        : Object.freeze([...template.matchAll(/::([a-z_]+)/g)].map((match) => match[1]!))

export const rateLimitParameters: ReadonlyMap<string, readonly string[]> = new Map(
    parameterizedTemplates.map((template) => [
        createHash("sha256").update(template).digest("hex").slice(0, 16),
        parameterNames(template),
    ]),
)
