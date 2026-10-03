/**
 * Guild settings edits.
 * Invariant: The edit is the bot-permitted settings patch, and REST owns dispatch, retry, audit headers and cache invalidation.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import {
    GuildFeatureToggles,
    type Guild,
    type GuildEdit,
    type GuildFeatureToggle,
    type ModerationOptions,
} from "#sdk/guilds"
import { decodeGuild, type GuildRequest } from "./guilds.js"
import { identifier, record, snapshotArray } from "./decode/primitives.js"
import { auditSettings } from "./moderation.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { timestamp } from "./decode/timestamp.js"
import { normalizedText as text, rawText } from "./field-text.js"

const imageDataUri = (value: unknown): value is string =>
    typeof value === "string" &&
    /^data:image\/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9.+-]+(?:=[a-zA-Z0-9!#$&^_.+-]+)?)*;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/.test(
        value,
    )
const nullableIdentifier = (value: unknown): value is string | null => value === null || identifier(value)
const guildFeatureToggles = new Set<GuildFeatureToggle>(Object.values(GuildFeatureToggles))

/** Builds the bot-permitted guild settings patch. REST owns dispatch, retry, audit headers and cache invalidation */
export function guildEdit(
    guildId: string,
    input: GuildEdit,
    options?: ModerationOptions,
): GuildRequest<Guild> | InputValidationFailure {
    const audit = auditSettings(options)
    if (!identifier(guildId)) return inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings")
    if (!record(input)) return inputValidationFailure("input", "type", "Guild settings input must be an object")
    if (audit instanceof InputValidationFailure) return audit
    const rawFeatureToggles = input.featureToggles
    const messageHistoryCutoff = input.messageHistoryCutoff
    const featureToggles =
        rawFeatureToggles === undefined ? undefined : snapshotArray(rawFeatureToggles, guildFeatureToggles.size)
    const unsupported = unsupportedKeyFailure(
        input,
        [
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
        ],
        "input",
        "the guild settings input",
    )
    if (unsupported) return unsupported
    if (input.name !== undefined && !text(input.name, 1, 100))
        return inputValidationFailure(
            "name",
            "length",
            "Community name must contain 1 through 100 UTF-16 code units after Fluxer's normalization",
        )
    for (const [path, label, value] of [
        ["icon", "icon", input.icon],
        ["banner", "banner", input.banner],
        ["splash", "splash", input.splash],
        ["embedSplash", "embed splash", input.embedSplash],
    ] as const)
        if (value !== undefined && value !== null && !imageDataUri(value))
            return inputValidationFailure(path, "format", `Guild ${label} must be null or a base64 image data URI`)
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
        input.verificationLevel !== 3
    )
        return inputValidationFailure("verificationLevel", "allowedValue", "Verification level must be 0, 1, 2, or 3")
    if (input.nsfw !== undefined && typeof input.nsfw !== "boolean")
        return inputValidationFailure("nsfw", "type", "NSFW must be a boolean")
    if (input.contentWarningLevel !== undefined && input.contentWarningLevel !== 0 && input.contentWarningLevel !== 1)
        return inputValidationFailure("contentWarningLevel", "allowedValue", "Content warning level must be 0 or 1")
    if (
        input.contentWarningText !== undefined &&
        input.contentWarningText !== null &&
        !rawText(input.contentWarningText, 0, 200)
    )
        return inputValidationFailure(
            "contentWarningText",
            "length",
            "Content warning text must be null or contain at most 200 raw UTF-16 code units",
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
        rawFeatureToggles !== undefined &&
        (!featureToggles ||
            !featureToggles.every((feature) => guildFeatureToggles.has(feature as GuildFeatureToggle)) ||
            new Set(featureToggles).size !== featureToggles.length)
    )
        return inputValidationFailure(
            "featureToggles[]",
            "allowedValue",
            "Feature toggles must be unique supported values",
        )
    if (messageHistoryCutoff !== undefined && messageHistoryCutoff !== null && !timestamp(messageHistoryCutoff))
        return inputValidationFailure(
            "messageHistoryCutoff",
            "format",
            "Message history cutoff must be null or an ISO 8601 timestamp with seconds and a Z or ±hh:mm offset",
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
        message_history_cutoff: messageHistoryCutoff,
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
