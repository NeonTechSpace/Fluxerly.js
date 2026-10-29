/**
 * Guild settings edits.
 * Invariant: The edit is the bot-permitted settings patch, and REST owns dispatch, retry, audit headers and cache invalidation.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { GuildFeatureToggles, type Guild, type GuildEdit, type GuildFeatureToggle } from "#sdk/guilds"
import { decodeGuild, type GuildRequest } from "./guilds.js"
import { identifier, record } from "./decode/primitives.js"
import { auditSettings } from "./moderation.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { timestamp } from "./decode/timestamp.js"
import { normalizedText as text } from "./field-text.js"
import {
    booleanField,
    checkFields,
    choiceField,
    distinct,
    field,
    type FieldRules,
    idField,
    integerField,
    listField,
    nullable,
    oneOf,
    textField,
    wireFields,
} from "./field-rules.js"
import type { AuditedRequestOptions } from "#sdk/client"

const imageDataUri = (value: unknown): value is string =>
    typeof value === "string" &&
    /^data:image\/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9.+-]+(?:=[a-zA-Z0-9!#$&^_.+-]+)?)*;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/.test(
        value,
    )
const guildFeatureToggles = new Set<GuildFeatureToggle>(Object.values(GuildFeatureToggles))
const image = (label: string) =>
    nullable(field(imageDataUri, "format", `Guild ${label} must be null or a base64 image data URI`))

/** Settings rules in the order Fluxerly checks them and sends them */
const settingRules: FieldRules = {
    name: field(
        (value) => text(value, 1, 100),
        "length",
        "Community name must contain 1 through 100 UTF-16 code units after Fluxer's normalization",
    ),
    icon: image("icon"),
    banner: image("banner"),
    splash: image("splash"),
    embedSplash: image("embed splash"),
    systemChannelId: nullable(idField("System channel ID must be null or a decimal string")),
    systemChannelFlags: choiceField([0, 1], "System channel flags must be 0 or 1"),
    afkChannelId: nullable(idField("AFK channel ID must be null or a decimal string")),
    afkTimeoutSeconds: integerField(60, 3600, "AFK timeout must be an integer from 60 through 3,600 seconds"),
    defaultMessageNotifications: choiceField([0, 1], "Default message notifications must be 0 or 1"),
    verificationLevel: choiceField([0, 1, 2, 3], "Verification level must be 0, 1, 2, or 3"),
    nsfw: booleanField("NSFW must be a boolean"),
    contentWarningLevel: choiceField([0, 1], "Content warning level must be 0 or 1"),
    contentWarningText: nullable(
        textField(0, 200, "Content warning text must be null or contain at most 200 raw UTF-16 code units"),
    ),
    explicitContentFilter: choiceField([0, 1, 2], "Explicit content filter must be 0, 1, or 2"),
    splashCardAlignment: choiceField([0, 1, 2], "Splash card alignment must be 0, 1, or 2"),
    featureToggles: distinct(
        listField(
            guildFeatureToggles.size,
            oneOf(guildFeatureToggles),
            "allowedValue",
            "Feature toggles must be unique supported values",
        ),
    ),
    messageHistoryCutoff: nullable(
        field(
            timestamp,
            "format",
            "Message history cutoff must be null or an ISO 8601 timestamp with seconds and a Z or ±hh:mm offset",
        ),
    ),
}
const wireNames: Readonly<Record<string, string>> = {
    name: "name",
    icon: "icon",
    banner: "banner",
    splash: "splash",
    embedSplash: "embed_splash",
    systemChannelId: "system_channel_id",
    systemChannelFlags: "system_channel_flags",
    afkChannelId: "afk_channel_id",
    afkTimeoutSeconds: "afk_timeout",
    defaultMessageNotifications: "default_message_notifications",
    verificationLevel: "verification_level",
    nsfw: "nsfw",
    contentWarningLevel: "content_warning_level",
    contentWarningText: "content_warning_text",
    explicitContentFilter: "explicit_content_filter",
    splashCardAlignment: "splash_card_alignment",
    featureToggles: "features",
    messageHistoryCutoff: "message_history_cutoff",
}

/** Builds the bot-permitted guild settings patch. REST owns dispatch, retry, audit headers and cache invalidation */
export function guildEdit(
    guildId: string,
    input: GuildEdit,
    options?: AuditedRequestOptions,
): GuildRequest<Guild> | InputValidationFailure {
    const audit = auditSettings(options)
    if (!identifier(guildId)) return inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings")
    if (!record(input)) return inputValidationFailure("input", "type", "Guild settings input must be an object")
    if (audit instanceof InputValidationFailure) return audit
    const unsupported = unsupportedKeyFailure(input, Object.keys(settingRules), "input", "the guild settings input")
    if (unsupported) return unsupported
    const checked = checkFields(input, settingRules, "")
    if (checked instanceof InputValidationFailure) return checked
    const featureToggles = checked.featureToggles as readonly unknown[] | undefined
    const json = JSON.stringify(wireFields(checked, wireNames))
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
