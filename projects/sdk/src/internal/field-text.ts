/**
 * Request-only text normalization for names and nicknames, following pinned Fluxer schema rules.
 * Invariant: Normalization applies only to text sent to Fluxer, never to received values. The test transport also
 * applies it to message content it stores in Fluxer's place.
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
// Request-only rules from Fluxer schema primitives at 70e1ce682ac1da6502ea08253296aa4727330ce8
// Validate the provider's normalized view without rewriting caller-owned wire values
export function normalizedText(value: unknown, minimum: number, maximum: number): value is string {
    if (typeof value !== "string") return false
    const length = normalizeText(value).length
    return length >= minimum && length <= maximum
}

/** Fluxer's base string normalization, which message content also receives before it is stored and delivered */
export function normalizeText(value: string): string {
    // oxlint-disable-next-line no-control-regex -- the provider strips form feed before measuring text
    return value.replace(/[\u000c\u202e]/g, "").trim()
}

export function rawText(value: unknown, minimum: number, maximum: number): value is string {
    return typeof value === "string" && value.length >= minimum && value.length <= maximum
}

/** A member nickname to send: Fluxer turns an empty or blank nickname into null, which clears it
 * (packages/schema/src/domains/guild/GuildRequestSchemas.ts:45-50, 133-135 at 0098958f)
 */
export function memberNickname(value: unknown): value is string {
    return typeof value === "string" && (value.trim().length === 0 || normalizedText(value, 1, 32))
}

export function channelName(value: unknown): value is string {
    if (typeof value !== "string" || value.length > 10_000) return false
    // GeneralChannelNameType removes these invisible ranges, but retains variation selectors and lone surrogates
    const normalized = normalizeText(value)
        .replace(
            // oxlint-disable-next-line no-control-regex, no-misleading-character-class -- removes each provider-listed code point, including the zero-width joiner, individually
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200c\u200d\u2060\ufeff\u200e\u200f\u202a-\u202e\u2066-\u2069\u00ad\u180e\ufffe\uffff\u{e0000}-\u{e007f}]/gu,
            "",
        )
        .replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, " ")
        .trim()
    return normalized.length >= 1 && normalized.length <= 100
}

/** Whether Fluxer's URLType accepts a URL, checked after Fluxer's normalization: 1 through 2048 UTF-16 code units,
 * http:// or https:// in lowercase, a parse with that protocol, and the host rules of validator.isURL that Fluxer
 * applies (packages/schema/src/primitives/UrlValidators.ts:8-21, 28-51, 77-80 at 0098958f). Fluxer drops the
 * top-level domain rule on a development server (UrlValidators.ts:22-26, 44-49 and fluxer_api/src/api/App.ts:45 at
 * 0098958f), which the SDK cannot see, so it applies the rule only for hosted Fluxer, through RequireTopLevelDomain,
 * and leaves it to a custom instance's server
 */
export function fluxerHttpUrl(value: unknown): value is string {
    if (!normalizedText(value, 1, 2048)) return false
    const normalized = normalizeText(value)
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) return false
    try {
        const parsed = new URL(normalized)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    } catch {
        // allow-silent: An unparsable URL is reported as invalid input by the caller
        return false
    }
    return allowedHttpUrl(normalized, Fiber.getCurrent()?.getRef(RequireTopLevelDomain) ?? true)
}

/**
 * Whether fluxerHttpUrl applies the top-level domain rule. Client and webhook client operations provide it from the
 * client's instance: True for hosted Fluxer and false for a custom instance. Code outside such an operation keeps the
 * hosted rule
 */
const RequireTopLevelDomain = Context.Reference<boolean>("@neontechspace/fluxerly/RequireTopLevelDomain", {
    defaultValue: () => true,
})

/** Run a client operation with the URL host rule of the client's instance, where hosted is whether it targets hosted Fluxer */
export const withInstanceUrlRule = <A, E, R>(effect: Effect.Effect<A, E, R>, hosted: boolean): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, RequireTopLevelDomain, hosted)

// The rest of this file ports validator 13.15.35, the version in Fluxer's lockfile, for the options Fluxer passes:
// require_protocol, require_host and disallow_auth set, require_tld as above, no trailing dot, no underscores, no
// numeric top-level domain and fragments allowed (validator src/lib/isURL.js, isFQDN.js and isIP.js)

/** validator.isURL for a URL that starts with http:// or https://, whose protocol is then always allowed */
function allowedHttpUrl(url: string, requireTld: boolean): boolean {
    if (/[\s<>]/.test(url)) return false
    // A URL of at most 2048 code units is within the 2084 that validate_length allows
    const address = url.split("#", 1)[0]!.split("?", 1)[0]!
    const authority = address.slice(address.indexOf("//") + 2).split("/", 1)[0]!
    if (authority === "") return false
    // disallow_auth refuses any @ in the authority, even with an empty user name
    if (authority.includes("@")) return false
    let host: string
    let port: string | undefined
    let ipv6: string | undefined
    const wrapped = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(authority)
    if (wrapped) {
        host = ""
        ipv6 = wrapped[1]
        port = wrapped[2]
    } else {
        const parts = authority.split(":")
        host = parts.shift()!
        if (parts.length > 0) port = parts.join(":")
    }
    if (port !== undefined && port.length > 0) {
        if (!/^[0-9]+$/.test(port)) return false
        const number = Number.parseInt(port, 10)
        if (number <= 0 || number > 65_535) return false
    }
    return (
        ipv4.test(host) ||
        ipv6Address.test(host) ||
        fqdn(host, requireTld) ||
        (ipv6 !== undefined && ipv6Address.test(ipv6))
    )
}

/** validator.isFQDN with no trailing dot, underscore, numeric top-level domain or wildcard. Without require_tld, only
 * the label count, top-level domain pattern and whitespace checks are skipped
 */
function fqdn(host: string, requireTld: boolean): boolean {
    const parts = host.split(".")
    const tld = parts.at(-1)!
    if (requireTld) {
        if (parts.length < 2) return false
        if (!/^([a-z\u00A1-\u00A8\u00AA-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]{2,}|xn[a-z0-9-]{2,})$/i.test(tld))
            return false
        if (/\s/.test(tld)) return false
    }
    if (/^\d+$/.test(tld)) return false
    return parts.every(
        (part) =>
            part.length <= 63 &&
            /^[a-z_\u00a1-\uffff0-9-]+$/i.test(part) &&
            !/[\uff01-\uff5e]/.test(part) &&
            !/^-|-$/.test(part) &&
            !part.includes("_"),
    )
}

const ipv4Segment = "(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])"
const ipv4Address = `(${ipv4Segment}[.]){3}${ipv4Segment}`
const ipv4 = new RegExp(`^${ipv4Address}$`)
const ipv6Segment = "(?:[0-9a-fA-F]{1,4})"
const ipv6Address = new RegExp(
    "^(" +
        `(?:${ipv6Segment}:){7}(?:${ipv6Segment}|:)|` +
        `(?:${ipv6Segment}:){6}(?:${ipv4Address}|:${ipv6Segment}|:)|` +
        `(?:${ipv6Segment}:){5}(?::${ipv4Address}|(:${ipv6Segment}){1,2}|:)|` +
        `(?:${ipv6Segment}:){4}(?:(:${ipv6Segment}){0,1}:${ipv4Address}|(:${ipv6Segment}){1,3}|:)|` +
        `(?:${ipv6Segment}:){3}(?:(:${ipv6Segment}){0,2}:${ipv4Address}|(:${ipv6Segment}){1,4}|:)|` +
        `(?:${ipv6Segment}:){2}(?:(:${ipv6Segment}){0,3}:${ipv4Address}|(:${ipv6Segment}){1,5}|:)|` +
        `(?:${ipv6Segment}:){1}(?:(:${ipv6Segment}){0,4}:${ipv4Address}|(:${ipv6Segment}){1,6}|:)|` +
        `(?::((?::${ipv6Segment}){0,5}:${ipv4Address}|(?::${ipv6Segment}){1,7}|:))` +
        ")(%[0-9a-zA-Z.]{1,})?$",
)
