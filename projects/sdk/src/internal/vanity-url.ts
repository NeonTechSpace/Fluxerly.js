import type { GuildVanityUrl, GuildVanityUrlUsage, ModerationOptions } from "#sdk/guilds"
import type { GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"
import { auditSettings } from "./moderation.js"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"

const hostedInvite = "https://fluxer.gg"

const codeValue = (value: unknown): value is string =>
    typeof value === "string" && value.length >= 2 && value.length <= 32 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)

function decode(value: unknown, inviteBase = hostedInvite): GuildVanityUrl | undefined {
    if (!record(value) || (value.code !== null && !codeValue(value.code))) return undefined
    return Object.freeze({
        code: value.code,
        url: value.code === null ? null : `${inviteBase}/${encodeURIComponent(value.code)}`,
    })
}

export function vanityUrlFetch(
    guildId: string,
    inviteBase = hostedInvite,
): GuildRequest<GuildVanityUrlUsage> | InputValidationFailure {
    if (!identifier(guildId)) return inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings")
    return {
        guildId,
        bucket: "guild:vanity:read",
        path: `/guilds/${guildId}/vanity-url`,
        method: "GET",
        status: 200,
        decode: (value, instance) => {
            const result = decode(value, instance?.invite ?? inviteBase)
            if (
                !result ||
                !record(value) ||
                typeof value.uses !== "number" ||
                !Number.isSafeInteger(value.uses) ||
                value.uses < 0 ||
                value.uses > 2_147_483_647
            )
                return undefined
            return Object.freeze({ ...result, uses: value.uses })
        },
    }
}

export function vanityUrlEdit(
    guildId: string,
    code: string | null,
    options?: ModerationOptions,
    inviteBase = hostedInvite,
): GuildRequest<GuildVanityUrl> | InputValidationFailure {
    const base = vanityUrlFetch(guildId, inviteBase)
    const audit = auditSettings(options)
    if (base instanceof InputValidationFailure) return base
    if (audit instanceof InputValidationFailure) return audit
    if (code !== null && !codeValue(code))
        return inputValidationFailure(
            "code",
            "format",
            "Vanity code must be null or contain 2 through 32 lowercase alphanumeric hyphen-separated characters",
        )
    return {
        ...base,
        ...audit,
        bucket: "guild:vanity:update",
        method: "PATCH",
        json: JSON.stringify({ code }),
        cache: { selection: { kind: "guilds", guildId }, mutation: true },
        decode: (value, instance) => {
            const result = decode(value, instance?.invite ?? inviteBase)
            return result?.code === code ? result : undefined
        },
    }
}
