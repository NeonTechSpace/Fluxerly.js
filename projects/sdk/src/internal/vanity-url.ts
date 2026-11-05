/**
 * Vanity URL operations.
 * Invariant: Codes are validated locally, and URLs are built from the instance's discovered invite base.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { GuildVanityUrl, GuildVanityUrlUsage } from "#sdk/guilds"
import type { GuildRequest } from "./guilds.js"
import { inputId, record } from "./decode/primitives.js"
import { auditSettings } from "./moderation.js"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import type { AuditedRequestOptions } from "#sdk/client"
import { normalizeText } from "./field-text.js"

const hostedInvite = "https://fluxer.gg"

const codeValue = (value: unknown): value is string =>
    typeof value === "string" && value.length >= 2 && value.length <= 32 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)

const normalizeCode = (value: string): string =>
    normalizeText(value).toLowerCase().replace(/\s+/g, "-").replace(/-{2,}/g, "-")

function decode(value: unknown, inviteBase = hostedInvite): GuildVanityUrl | undefined {
    if (!record(value) || (value.code !== null && !codeValue(value.code))) return undefined
    return Object.freeze({
        code: value.code,
        url: value.code === null ? null : `${inviteBase}/${encodeURIComponent(value.code)}`,
    })
}

export function vanityUrlFetch(
    rawGuildId: string,
    inviteBase = hostedInvite,
): GuildRequest<GuildVanityUrlUsage> | InputValidationFailure {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
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
    rawGuildId: string,
    code: string | null,
    options?: AuditedRequestOptions,
    inviteBase = hostedInvite,
): GuildRequest<GuildVanityUrl> | InputValidationFailure {
    const base = vanityUrlFetch(rawGuildId, inviteBase)
    const audit = auditSettings(options)
    if (base instanceof InputValidationFailure) return base
    const { guildId } = base
    if (audit instanceof InputValidationFailure) return audit
    // Fluxer reads an empty code as null, which removes the vanity URL (fluxer_api/src/api/Validator.ts:59-63 and
    // fluxer_api/src/api/guild/controllers/GuildBaseController.ts:317-322 at 0098958f)
    // Fluxer stores and answers the normalized code: U+000C and U+202E removed, trimmed, lowercased, whitespace runs
    // turned into "-" and repeated "-" collapsed, then 2-32 characters of the vanity pattern. The raw code is sent
    // (packages/schema/src/primitives/ChannelValidators.ts:54-56, 110-118 and packages/schema/src/domains/guild/
    // GuildRequestSchemas.ts:355-358 at 0098958f, with fluxer_api/src/api/guild/controllers/GuildBaseController.ts:317-322
    // returning updateVanityURL's code)
    const normalized = code === null || code === "" ? null : typeof code === "string" ? normalizeCode(code) : code
    if (normalized !== null && !codeValue(normalized))
        return inputValidationFailure(
            "code",
            "format",
            "Vanity code must be null or empty to remove it, or contain 2 through 32 alphanumeric hyphen-separated characters after Fluxer's normalization",
        )
    // Fluxer refuses every code that contains fluxer, after checking only the permission and the vanity feature, which
    // refuse too (fluxer_api/src/api/guild/services/data/GuildVanityService.ts:62-72 at 0098958f)
    if (normalized?.includes("fluxer"))
        return inputValidationFailure(
            "code",
            "allowedValue",
            "Vanity code cannot contain fluxer after Fluxer's normalization, which lowercases it",
        )
    const expected = normalized
    return {
        ...base,
        ...audit,
        bucket: "guild:vanity:update",
        method: "PATCH",
        json: JSON.stringify({ code }),
        cache: { selection: { kind: "guilds", guildId }, mutation: true, evictOnly: true },
        decode: (value, instance) => {
            const result = decode(value, instance?.invite ?? inviteBase)
            return result?.code === expected ? result : undefined
        },
    }
}
