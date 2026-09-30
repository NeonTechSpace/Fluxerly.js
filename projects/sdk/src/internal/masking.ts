/**
 * Credential masking and guarded value descriptions shared by logging, failure reports and error text.
 * Invariant: Tokens, authorization values, client secrets, webhook tokens and invite codes are masked in messages, fields and
 * error text, and describing any value never throws. Implements [SDK contracts: Logging](/docs/SDK-CONTRACTS.md#logging)
 */
import { inspect } from "node:util"

/** Credential masking and guarded value descriptions shared by logging, failure reports and SDK error text.
 * This module has no SDK imports, so the error classes can use it without an import cycle
 */

const redacted = "[redacted]"

const sensitiveKeys = new Set([
    "token",
    "access_token",
    "refresh_token",
    "client_secret",
    "secret",
    "password",
    "authorization",
    "cookie",
    "set-cookie",
    "vanity_url_code",
])
const inviteShapeKeys = ["inviter", "max_uses", "temporary", "uses", "max_age"]

function sensitiveKey(key: string): boolean {
    return sensitiveKeys.has(key.toLowerCase()) || /(?:token|secret)$/i.test(key)
}

type PayloadRange = { readonly start: number; readonly end: number }
type PayloadObject = { readonly keys: Set<string>; readonly codes: PayloadRange[] }

/** Mask credential-key values and invite-shaped codes in JSON-like text, including a truncated value */
function maskPayloadText(text: string, secrets: readonly string[]): string {
    const keys = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(\s*:\s*)/g
    const ranges: PayloadRange[] = []
    const objects: PayloadObject[] = []
    const finish = (object: PayloadObject) => {
        if (
            inviteShapeKeys.some((key) => object.keys.has(key)) ||
            (object.keys.has("channel") && object.keys.has("guild"))
        )
            ranges.push(...object.codes)
    }
    let scanned = 0
    let scanQuote: string | undefined
    // Track object boundaries outside strings so a nested diagnostic code does not become an invite code
    const scanObjects = (until: number) => {
        for (; scanned < until; scanned++) {
            const character = text[scanned]!
            if (scanQuote !== undefined) {
                if (character === "\\") scanned++
                else if (character === scanQuote) scanQuote = undefined
            } else if (character === '"' || character === "'") scanQuote = character
            else if (character === "{") objects.push({ keys: new Set(), codes: [] })
            else if (character === "}" && objects.length > 0) finish(objects.pop()!)
        }
    }
    for (let match = keys.exec(text); match !== null; match = keys.exec(text)) {
        scanObjects(match.index)
        if (scanQuote !== undefined) continue
        const quoted = match[1]!
        let key: string
        try {
            key = quoted[0] === '"' ? (JSON.parse(quoted) as string) : quoted.slice(1, -1)
        } catch {
            // allow-silent: An invalid quoted key is not a credential key, so free-text masking still applies below
            continue
        }
        const object = objects[objects.length - 1]
        object?.keys.add(key)
        const start = keys.lastIndex
        const first = text[start]
        const sensitive = sensitiveKey(key)
        if (!sensitive && first !== '"' && first !== "'") continue
        let end = start
        let quote: string | undefined
        let nesting = 0
        for (; end < text.length; end++) {
            const character = text[end]!
            if (quote !== undefined) {
                if (character === "\\") end++
                else if (character === quote) {
                    quote = undefined
                    if (nesting === 0) {
                        end++
                        break
                    }
                }
            } else if (character === '"' || character === "'") quote = character
            else if (character === "{" || character === "[") nesting++
            else if (character === "}" || character === "]") {
                if (nesting === 0) break
                if (--nesting === 0) {
                    end++
                    break
                }
            } else if (nesting === 0 && /[,\s]/.test(character)) break
        }
        end = Math.min(end, text.length)
        keys.lastIndex = end
        if (sensitive) ranges.push({ start, end })
        else if (key === "code") object?.codes.push({ start, end })
    }
    scanObjects(text.length)
    for (const object of objects) finish(object)
    let output = ""
    let copied = 0
    for (const { start, end } of ranges.sort((left, right) => left.start - right.start)) {
        output += text.slice(copied, start) + JSON.stringify(redacted)
        copied = end
    }
    return maskText(output + text.slice(copied), secrets)
}

// A standalone scheme word is masked only before a token-shaped value: 20 or more token characters including at
// least one digit or punctuation mark. Ordinary prose such as "Bot processSignals" or "Basic validation" stays readable,
// while Authorization contexts below mask any value
const schemeToken = /\b(Bot|Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{20,}/g

/** Replace credentials and invite codes in free text */
export function maskText(text: string, secrets: readonly string[] = []): string {
    let masked = text
    for (const secret of secrets) if (secret.length >= 6) masked = masked.split(secret).join(redacted)
    return (
        masked
            .replace(schemeToken, `$1 ${redacted}`)
            .replace(/(authorization["']?\s*[:=]\s*["']?)(?:(?:Bot|Bearer|Basic)\s+)?[^\s"',}]+/gi, `$1${redacted}`)
            // A key ending in token or secret hides its value in an assignment such as FLUXER_BOT_TOKEN= or
            // client_secret=, and after a quoted key such as "botToken":. The lookbehind starts matches only at word
            // starts, which keeps long words linear
            .replace(
                /(?<![A-Za-z0-9_])([A-Za-z0-9_]*(?:token|secret)(?:["']\s*[=:]|\s*=)\s*["']?)[^\s"'&,}]+/gi,
                `$1${redacted}`,
            )
            // After an unquoted key and a colon, such as clientSecret:, only a credential-shaped value is hidden: 8 or
            // more characters with a digit, or 20 or more. Prose such as "Missing token: check config" stays readable
            .replace(
                /(?<![A-Za-z0-9_])([A-Za-z0-9_]*(?:token|secret)\s*:\s*["']?)(?=[^\s"'&,}]*\d|[^\s"'&,}]{20})[^\s"'&,}]{8,}/gi,
                `$1${redacted}`,
            )
            // A bare Fluxer bot token is <application_id>.<secret>, whose secret is 32 random bytes in base64url.
            // The application ID stays readable, and snowflake pairs such as 123.456 never match
            .replace(/\b(\d{15,21})\.[A-Za-z0-9_-]{40,}/g, `$1.${redacted}`)
            // OAuth authorization codes travel in query strings, while ordinary code fields stay readable
            .replace(/([?&]code=)[^&\s"'#]+/g, `$1${redacted}`)
            .replace(/(\/webhooks\/\d+\/)[^\s/?#"']+/g, `$1${redacted}`)
            .replace(/((?:fluxer\.gg|\/invites?|\/invite)\/)[A-Za-z0-9-]+/g, `$1${redacted}`)
    )
}

/** Copy a payload with credential, secret and invite-code values masked, then render it as bounded JSON */
export function maskPayload(value: unknown, secrets: readonly string[] = [], limit = 65_536): string {
    const seen = new WeakSet<object>()
    const visit = (item: unknown, depth: number): unknown => {
        if (typeof item === "string") return maskPayloadText(item, secrets)
        if (typeof item === "bigint") return item.toString()
        if (typeof item !== "object" || item === null) return item
        if (seen.has(item) || depth > 32) return "[circular]"
        seen.add(item)
        if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1))
        const source = item as Record<string, unknown>
        const invite = inviteShapeKeys.some((key) => key in source) || ("channel" in source && "guild" in source)
        const copy: Record<string, unknown> = {}
        for (const [key, entry] of Object.entries(source))
            copy[key] =
                sensitiveKey(key) || (key === "code" && invite && typeof entry === "string")
                    ? redacted
                    : visit(entry, depth + 1)
        return copy
    }
    let text: string
    try {
        text = JSON.stringify(visit(value, 0)) ?? describeValue(value)
    } catch {
        // allow-silent: An unserializable payload is replaced by its guarded description in the same record
        text = maskText(describeValue(value), secrets)
    }
    return text.length > limit ? `${text.slice(0, limit)}… (${text.length - limit} more characters)` : text
}

/** Text for any thrown or logged value. Never throws, including for null-prototype objects, hostile proxies,
 * symbols and bigints. The result is not masked
 */
export function describeValue(value: unknown): string {
    if (typeof value === "string") return value
    try {
        return inspect(value, { depth: 2, breakLength: Infinity })
    } catch {
        try {
            // allow-silent: An uninspectable value falls back to its type tag in the same description
            return Object.prototype.toString.call(value)
        } catch {
            // allow-silent: A value that rejects every inspection is still named in the description
            return "[a value that cannot be described]"
        }
    }
}

/** One-line "Name: message" text for an Error, or the guarded description of another value. Never throws */
export function errorSummary(value: unknown): string {
    try {
        if (value instanceof Error) return `${String(value.name)}: ${String(value.message)}`
    } catch {
        // allow-silent: An Error whose name or message getters throw is described by the guarded fallback below
    }
    return describeValue(value)
}

/** The message of an Error, or the guarded description of another value. Never throws */
export function messageText(value: unknown): string {
    try {
        if (value instanceof Error) return String(value.message)
    } catch {
        // allow-silent: An Error whose message getter throws is described by the guarded fallback below
    }
    return describeValue(value)
}
