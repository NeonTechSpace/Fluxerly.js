/**
 * The SDK's default User-Agent: Product token, installed version and homepage from the package manifest.
 * Invariant: The manifest is read at most once, on the first request rather than at import, and a missing or malformed
 * manifest only removes the version or homepage comment from the value.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { readFileSync } from "node:fs"
import { record } from "../decode/primitives.js"
import { sdkVersion } from "../logging.js"

/** Longest caller-supplied User-Agent */
export const userAgentMaxLength = 512

let cached: string | undefined

/** The package homepage, or undefined when the manifest cannot supply an HTTPS URL */
function homepage(): string | undefined {
    try {
        const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as unknown
        const value = record(manifest) ? manifest.homepage : undefined
        return typeof value === "string" && /^https:\/\/[\x21-\x7e]+$/.test(value) ? value : undefined
    } catch {
        // allow-silent: A missing manifest only removes the homepage comment from the User-Agent
        return undefined
    }
}

/** `Fluxerly.js/<version> (+<homepage>)`, read once from the SDK manifest */
export function defaultUserAgent(): string {
    if (cached !== undefined) return cached
    const version = sdkVersion()
    const home = homepage()
    cached = `Fluxerly.js/${/^[\x21-\x7e]+$/.test(version) ? version : "unknown"}${home === undefined ? "" : ` (+${home})`}`
    return cached
}

/** Whether a caller value is a usable User-Agent: Printable ASCII, bounded, without surrounding spaces */
export function validUserAgent(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length >= 1 &&
        value.length <= userAgentMaxLength &&
        /^[\x20-\x7e]+$/.test(value) &&
        value.trim() === value
    )
}
