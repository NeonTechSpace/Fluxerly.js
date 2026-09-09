import type { GuildVanityUrl, GuildVanityUrlUsage, ModerationOptions } from "#sdk/guilds"
import type { GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"
import { auditSettings } from "./moderation.js"

const codeValue = (value: unknown): value is string =>
    typeof value === "string" && value.length >= 2 && value.length <= 32 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)

function decode(value: unknown): GuildVanityUrl | undefined {
    if (!record(value) || (value.code !== null && !codeValue(value.code))) return undefined
    return Object.freeze({
        code: value.code,
        url: value.code === null ? null : `https://fluxer.gg/${encodeURIComponent(value.code)}`,
    })
}

export function vanityUrlFetch(guildId: string): GuildRequest<GuildVanityUrlUsage> | undefined {
    if (!identifier(guildId)) return undefined
    return {
        guildId,
        bucket: "guild:vanity:read",
        path: `/guilds/${guildId}/vanity-url`,
        method: "GET",
        status: 200,
        decode: (value) => {
            const result = decode(value)
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
): GuildRequest<GuildVanityUrl> | undefined {
    const base = vanityUrlFetch(guildId)
    const audit = auditSettings(options)
    if (!base || !audit || (code !== null && !codeValue(code))) return undefined
    return {
        ...base,
        ...audit,
        bucket: "guild:vanity:update",
        method: "PATCH",
        json: JSON.stringify({ code }),
        cache: { selection: { kind: "guilds", guildId }, mutation: true },
        decode: (value) => {
            const result = decode(value)
            return result?.code === code ? result : undefined
        },
    }
}
