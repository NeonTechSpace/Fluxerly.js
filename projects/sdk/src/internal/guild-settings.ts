import type { Guild, GuildEdit, GuildFeatureToggle, ModerationOptions } from "#sdk/guilds"
import { decodeGuild, type GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"
import { auditSettings } from "./moderation.js"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"

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
): GuildRequest<Guild> | InputValidationFailure {
    const audit = auditSettings(options)
    const rawFeatureToggles = record(input) ? input.featureToggles : undefined
    const featureToggles = Array.isArray(rawFeatureToggles) ? Array.from(rawFeatureToggles) : undefined
    if (!identifier(guildId)) return inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings")
    if (!record(input)) return inputValidationFailure("input", "type", "Guild settings input must be an object")
    if (audit instanceof InputValidationFailure) return audit
    if (
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
        )
    )
        return inputValidationFailure("input", "allowedFields", "Guild settings input contains an unsupported field")
    if (input.name !== undefined && !text(input.name, 1, 100))
        return inputValidationFailure("name", "length", "Guild name must contain 1 through 100 Unicode code points")
    for (const [path, value] of [
        ["icon", input.icon],
        ["banner", input.banner],
        ["splash", input.splash],
        ["embedSplash", input.embedSplash],
    ] as const)
        if (value !== undefined && value !== null && !imageDataUri(value))
            return inputValidationFailure(path, "format", `${path} must be null or a base64 image data URI`)
    if (input.systemChannelId !== undefined && !nullableIdentifier(input.systemChannelId))
        return inputValidationFailure("systemChannelId", "format", "System channel ID must be null or a decimal string")
    if (input.systemChannelFlags !== undefined && input.systemChannelFlags !== 0 && input.systemChannelFlags !== 1)
        return inputValidationFailure("systemChannelFlags", "allowedValue", "System channel flags must be 0 or 1")
    if (input.afkChannelId !== undefined && !nullableIdentifier(input.afkChannelId))
        return inputValidationFailure("afkChannelId", "format", "AFK channel ID must be null or a decimal string")
    if (
        input.afkTimeoutSeconds !== undefined &&
        !(
            typeof input.afkTimeoutSeconds === "number" &&
            Number.isInteger(input.afkTimeoutSeconds) &&
            input.afkTimeoutSeconds >= 60 &&
            input.afkTimeoutSeconds <= 3600
        )
    )
        return inputValidationFailure(
            "afkTimeoutSeconds",
            "range",
            "AFK timeout must be an integer from 60 through 3,600 seconds",
        )
    if (
        input.defaultMessageNotifications !== undefined &&
        input.defaultMessageNotifications !== 0 &&
        input.defaultMessageNotifications !== 1
    )
        return inputValidationFailure(
            "defaultMessageNotifications",
            "allowedValue",
            "Default message notifications must be 0 or 1",
        )
    if (
        input.verificationLevel !== undefined &&
        input.verificationLevel !== 0 &&
        input.verificationLevel !== 1 &&
        input.verificationLevel !== 2 &&
        input.verificationLevel !== 3 &&
        input.verificationLevel !== 4
    )
        return inputValidationFailure(
            "verificationLevel",
            "allowedValue",
            "Verification level must be 0, 1, 2, 3, or 4",
        )
    if (input.nsfw !== undefined && typeof input.nsfw !== "boolean")
        return inputValidationFailure("nsfw", "type", "NSFW must be a boolean")
    if (input.contentWarningLevel !== undefined && input.contentWarningLevel !== 0 && input.contentWarningLevel !== 1)
        return inputValidationFailure("contentWarningLevel", "allowedValue", "Content warning level must be 0 or 1")
    if (
        input.contentWarningText !== undefined &&
        input.contentWarningText !== null &&
        !text(input.contentWarningText, 0, 200)
    )
        return inputValidationFailure(
            "contentWarningText",
            "length",
            "Content warning text must be null or contain at most 200 Unicode code points",
        )
    if (
        input.explicitContentFilter !== undefined &&
        input.explicitContentFilter !== 0 &&
        input.explicitContentFilter !== 1 &&
        input.explicitContentFilter !== 2
    )
        return inputValidationFailure(
            "explicitContentFilter",
            "allowedValue",
            "Explicit content filter must be 0, 1, or 2",
        )
    if (
        input.splashCardAlignment !== undefined &&
        input.splashCardAlignment !== 0 &&
        input.splashCardAlignment !== 1 &&
        input.splashCardAlignment !== 2
    )
        return inputValidationFailure("splashCardAlignment", "allowedValue", "Splash card alignment must be 0, 1, or 2")
    if (
        input.featureToggles !== undefined &&
        (!Array.isArray(input.featureToggles) ||
            featureToggles!.length > guildFeatureToggles.size ||
            !featureToggles!.every((feature) => guildFeatureToggles.has(feature)) ||
            new Set(featureToggles).size !== featureToggles!.length)
    )
        return inputValidationFailure(
            "featureToggles[]",
            "allowedValue",
            "Feature toggles must be unique supported values",
        )
    if (
        input.messageHistoryCutoff !== undefined &&
        input.messageHistoryCutoff !== null &&
        !timestamp(input.messageHistoryCutoff)
    )
        return inputValidationFailure(
            "messageHistoryCutoff",
            "format",
            "Message history cutoff must be null or an ISO 8601 UTC timestamp",
        )
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
    if (json === "{}") return inputValidationFailure("input", "required", "Guild settings input must contain a change")
    if (Buffer.byteLength(json) > 4_194_304)
        return inputValidationFailure("input", "size", "Guild settings input must not exceed 4,194,304 encoded bytes")
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
