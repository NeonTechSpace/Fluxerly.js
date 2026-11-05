/**
 * Guild settings edits.
 * Invariant: The edit is the bot-permitted settings patch, and REST owns dispatch, retry, audit headers and cache invalidation.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { GuildFeatureToggles, type Guild, type GuildEdit, type GuildFeatureToggle } from "#sdk/guilds"
import { decodeGuild, type GuildRequest } from "./guilds.js"
import { base64Image, base64ImageExplanation, clearsImage, inputId, record } from "./decode/primitives.js"
import { rejectCheck } from "./decode/trace.js"
import { auditSettings } from "./moderation.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { timestamp } from "./decode/timestamp.js"
import { guildSettingsBodyLimit } from "./request-body-limits.js"
import { normalizedText as text } from "./field-text.js"
import {
    booleanField,
    checkFields,
    choiceField,
    distinct,
    checkedField,
    field,
    type FieldRules,
    idField,
    integerField,
    listField,
    nullable,
    nullOrEmpty,
    oneOf,
    textField,
    wireFields,
} from "./field-rules.js"
import type { AuditedRequestOptions } from "#sdk/client"

const guildFeatureToggles = new Set<GuildFeatureToggle>(Object.values(GuildFeatureToggles))
const image = (key: string, label: string) =>
    checkedField((value) =>
        clearsImage(value) || base64Image(value)
            ? value
            : inputValidationFailure(key, "format", base64ImageExplanation(`Guild ${label}`, value)),
    )

/** Settings rules in the order Fluxerly checks them and sends them */
const settingRules: FieldRules = {
    name: field(
        (value) => text(value, 1, 100),
        "length",
        "Community name must contain 1 through 100 UTF-16 code units after Fluxer's normalization",
    ),
    icon: image("icon", "icon"),
    banner: image("banner", "banner"),
    splash: image("splash", "splash"),
    embedSplash: image("embedSplash", "embed splash"),
    systemChannelId: nullOrEmpty(
        idField(
            "System channel ID must be null, empty or a decimal string, because JavaScript numbers cannot hold Fluxer IDs exactly",
        ),
    ),
    systemChannelFlags: choiceField([0, 1], "System channel flags must be 0 or 1"),
    afkChannelId: nullOrEmpty(
        idField(
            "AFK channel ID must be null, empty or a decimal string, because JavaScript numbers cannot hold Fluxer IDs exactly",
        ),
    ),
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
    messageHistoryCutoff: nullOrEmpty(
        field(
            timestamp,
            "format",
            "Message history cutoff must be null, empty or an ISO 8601 timestamp with seconds and a Z or ±hh:mm offset",
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

/** Fluxer reads the cutoff with z.iso.datetime(), which accepts only a Z suffix and hours 00 to 23
 * (packages/schema/src/domains/guild/GuildRequestSchemas.ts:120-124 at 0098958f, Zod 4.6.7). A validated ±hh:mm value,
 * or an end-of-day 24:00:00, becomes the same instant in UTC, keeping its fraction digits unchanged. Any other Z value
 * is sent as given
 */
export function utcTimestamp(value: string): string {
    if (value.endsWith("Z") && !value.includes("T24:")) return value
    const match = /^(.*T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    if (match === null) return value
    const whole = new Date(Date.parse(`${match[1]}${match[3]}`)).toISOString()
    return `${whole.slice(0, -".000Z".length)}${match[2] ?? ""}Z`
}

/** Builds the bot-permitted guild settings patch. REST owns dispatch, retry, audit headers and cache invalidation */
export function guildEdit(
    rawGuildId: string,
    input: GuildEdit,
    options?: AuditedRequestOptions,
): GuildRequest<Guild> | InputValidationFailure {
    const audit = auditSettings(options)
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (!record(input)) return inputValidationFailure("input", "type", "Guild settings input must be an object")
    if (audit instanceof InputValidationFailure) return audit
    const unsupported = unsupportedKeyFailure(input, Object.keys(settingRules), "input", "the guild settings input")
    if (unsupported) return unsupported
    const checked = checkFields(input, settingRules, "")
    if (checked instanceof InputValidationFailure) return checked
    const featureToggles = checked.featureToggles as readonly unknown[] | undefined
    const cutoff = checked.messageHistoryCutoff
    if (typeof cutoff === "string" && cutoff !== "") checked.messageHistoryCutoff = utcTimestamp(cutoff)
    const json = JSON.stringify(wireFields(checked, wireNames))
    if (json === "{}") return inputValidationFailure("input", "required", "Guild settings input must contain a change")
    if (Buffer.byteLength(json) > guildSettingsBodyLimit)
        return inputValidationFailure(
            "input",
            "size",
            "Guild settings input must not exceed 56,972,632 encoded bytes, the most Fluxer accepts",
        )
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
            return guild === undefined || guild.id === guildId ? guild : rejectCheck("targetMismatch")
        },
    }
}
