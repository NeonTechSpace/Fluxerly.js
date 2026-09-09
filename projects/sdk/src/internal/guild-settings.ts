import type { Guild, GuildEdit, GuildFeatureToggle, ModerationOptions } from "#sdk/guilds"
import { decodeGuild, type GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"
import { auditSettings } from "./moderation.js"

const text = (value: unknown, minimum: number, maximum: number): value is string =>
    typeof value === "string" && [...value].length >= minimum && [...value].length <= maximum
const imageDataUri = (value: unknown): value is string =>
    typeof value === "string" &&
    /^data:image\/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9.+-]+(?:=[a-zA-Z0-9!#$&^_.+-]+)?)*;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/.test(
        value,
    )
const nullableIdentifier = (value: unknown): value is string | null => value === null || identifier(value)
const timestamp = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
const guildFeatureToggles = new Set<GuildFeatureToggle>([
    "INVITES_DISABLED",
    "TEXT_CHANNEL_FLEXIBLE_NAMES",
    "DETACHED_BANNER",
    "CLONE_EMOJI_DISABLED",
    "CLONE_STICKER_DISABLED",
    "HIDE_OWNER_CROWN",
])

/** Builds the bot-permitted guild settings patch; REST owns dispatch, retry, audit headers and cache invalidation */
export function guildEdit(
    guildId: string,
    input: GuildEdit,
    options?: ModerationOptions,
): GuildRequest<Guild> | undefined {
    const audit = auditSettings(options)
    const rawFeatureToggles = record(input) ? input.featureToggles : undefined
    const featureToggles = Array.isArray(rawFeatureToggles) ? Array.from(rawFeatureToggles) : undefined
    if (
        !identifier(guildId) ||
        !record(input) ||
        !audit ||
        Object.keys(input).some(
            (key) =>
                ![
                    "name",
                    "icon",
                    "banner",
                    "splash",
                    "embedSplash",
                    "systemChannelId",
                    "systemChannelFlags",
                    "afkChannelId",
                    "afkTimeoutSeconds",
                    "defaultMessageNotifications",
                    "verificationLevel",
                    "nsfw",
                    "contentWarningLevel",
                    "contentWarningText",
                    "explicitContentFilter",
                    "splashCardAlignment",
                    "featureToggles",
                    "messageHistoryCutoff",
                ].includes(key),
        ) ||
        (input.name !== undefined && !text(input.name, 1, 100)) ||
        (input.icon !== undefined && input.icon !== null && !imageDataUri(input.icon)) ||
        (input.banner !== undefined && input.banner !== null && !imageDataUri(input.banner)) ||
        (input.splash !== undefined && input.splash !== null && !imageDataUri(input.splash)) ||
        (input.embedSplash !== undefined && input.embedSplash !== null && !imageDataUri(input.embedSplash)) ||
        (input.systemChannelId !== undefined && !nullableIdentifier(input.systemChannelId)) ||
        (input.systemChannelFlags !== undefined && input.systemChannelFlags !== 0 && input.systemChannelFlags !== 1) ||
        (input.afkChannelId !== undefined && !nullableIdentifier(input.afkChannelId)) ||
        (input.afkTimeoutSeconds !== undefined &&
            !(
                typeof input.afkTimeoutSeconds === "number" &&
                Number.isInteger(input.afkTimeoutSeconds) &&
                input.afkTimeoutSeconds >= 60 &&
                input.afkTimeoutSeconds <= 3600
            )) ||
        (input.defaultMessageNotifications !== undefined &&
            input.defaultMessageNotifications !== 0 &&
            input.defaultMessageNotifications !== 1) ||
        (input.verificationLevel !== undefined &&
            input.verificationLevel !== 0 &&
            input.verificationLevel !== 1 &&
            input.verificationLevel !== 2 &&
            input.verificationLevel !== 3 &&
            input.verificationLevel !== 4) ||
        (input.nsfw !== undefined && typeof input.nsfw !== "boolean") ||
        (input.contentWarningLevel !== undefined &&
            input.contentWarningLevel !== 0 &&
            input.contentWarningLevel !== 1) ||
        (input.contentWarningText !== undefined &&
            input.contentWarningText !== null &&
            !text(input.contentWarningText, 0, 200)) ||
        (input.explicitContentFilter !== undefined &&
            input.explicitContentFilter !== 0 &&
            input.explicitContentFilter !== 1 &&
            input.explicitContentFilter !== 2) ||
        (input.splashCardAlignment !== undefined &&
            input.splashCardAlignment !== 0 &&
            input.splashCardAlignment !== 1 &&
            input.splashCardAlignment !== 2) ||
        (input.featureToggles !== undefined &&
            (!Array.isArray(input.featureToggles) ||
                featureToggles!.length > guildFeatureToggles.size ||
                !featureToggles!.every((feature) => guildFeatureToggles.has(feature)) ||
                new Set(featureToggles).size !== featureToggles!.length)) ||
        (input.messageHistoryCutoff !== undefined &&
            input.messageHistoryCutoff !== null &&
            !timestamp(input.messageHistoryCutoff))
    )
        return undefined
    const json = JSON.stringify({
        name: input.name,
        icon: input.icon,
        banner: input.banner,
        splash: input.splash,
        embed_splash: input.embedSplash,
        system_channel_id: input.systemChannelId,
        system_channel_flags: input.systemChannelFlags,
        afk_channel_id: input.afkChannelId,
        afk_timeout: input.afkTimeoutSeconds,
        default_message_notifications: input.defaultMessageNotifications,
        verification_level: input.verificationLevel,
        nsfw: input.nsfw,
        content_warning_level: input.contentWarningLevel,
        content_warning_text: input.contentWarningText,
        explicit_content_filter: input.explicitContentFilter,
        splash_card_alignment: input.splashCardAlignment,
        features: featureToggles,
        message_history_cutoff: input.messageHistoryCutoff,
    })
    if (json === "{}" || Buffer.byteLength(json) > 4_194_304) return undefined
    return {
        guildId,
        bucket: "guild:settings:update",
        path: `/guilds/${guildId}`,
        method: "PATCH",
        status: 200,
        json,
        ...audit,
        cache: { selection: { kind: "guilds", guildId }, mutation: true },
        ...(featureToggles !== undefined && !featureToggles.includes("TEXT_CHANNEL_FLEXIBLE_NAMES")
            ? { channelCache: { guildId, mutation: true } }
            : {}),
        decode: (value) => {
            const guild = decodeGuild(value)
            return guild?.id === guildId ? guild : undefined
        },
    }
}
