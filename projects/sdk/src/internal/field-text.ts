// Request-only rules from Fluxer schema primitives at 70e1ce682ac1da6502ea08253296aa4727330ce8
// Validate the provider's normalized view without rewriting caller-owned wire values
export function normalizedText(value: unknown, minimum: number, maximum: number): value is string {
    if (typeof value !== "string") return false
    const length = normalizeText(value).length
    return length >= minimum && length <= maximum
}

function normalizeText(value: string): string {
    return value.replace(/[\u000c\u202e]/g, "").trim()
}

export function rawText(value: unknown, minimum: number, maximum: number): value is string {
    return typeof value === "string" && value.length >= minimum && value.length <= maximum
}

export function memberNickname(value: unknown): value is string {
    // Preserve the explicit-null SDK reset API while matching provider preprocessing of nonempty blank input
    return typeof value === "string" && value.length > 0 && (value.trim().length === 0 || normalizedText(value, 1, 32))
}

export function channelName(value: unknown): value is string {
    if (typeof value !== "string" || value.length > 10_000) return false
    // GeneralChannelNameType removes these invisible ranges, but retains variation selectors and lone surrogates
    const normalized = normalizeText(value)
        .replace(
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200c\u200d\u2060\ufeff\u200e\u200f\u202a-\u202e\u2066-\u2069\u00ad\u180e\ufffe\uffff\u{e0000}-\u{e007f}]/gu,
            "",
        )
        .replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, " ")
        .trim()
    return normalized.length >= 1 && normalized.length <= 100
}
