/**
 * Audit-reason option shared by audited operations.
 * Invariant: A reason is well-formed Unicode text without control characters or line separators, trimmed, with 1 through 512
 * UTF-16 code units after Fluxer's normalization (which also removes U+202E), and sent only as the X-Audit-Log-Reason header, whose value carries its UTF-8 bytes.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import { record } from "./decode/primitives.js"
import { normalizeText } from "./field-text.js"

export interface AuditSettings {
    readonly auditReason?: string
}

/** Validate one optional provider audit header without retaining or encoding it */
export function auditSettings(options?: unknown): AuditSettings | InputValidationFailure {
    if (options !== undefined && !record(options))
        return inputValidationFailure("options", "type", "Operation options must be an object")
    const reason = options?.auditReason
    if (reason === undefined) return {}
    // C0 and C1 controls, DEL and the line and paragraph separators cannot appear in one header line of an audit entry
    if (typeof reason !== "string" || !reason.isWellFormed() || /[\p{Cc}\u2028\u2029]/u.test(reason))
        return inputValidationFailure(
            "options.auditReason",
            "format",
            "Audit reason must be well-formed text without control characters or line separators",
        )
    // Fluxer reads the header without failing: A reason whose normalized value (U+000C and U+202E removed, then
    // trimmed) is empty or longer than 512 is silently dropped and the entry is recorded without it
    // (packages/schema/src/primitives/ChannelValidators.ts:119-132 and fluxer_api/src/api/middleware/
    // AuditLogMiddleware.ts:32-43 at 0098958f). The trimmed reason is sent, and the SDK refuses what Fluxer would drop.
    // U+202E is a format character rather than a control, so it passes the check above and only Fluxer's view counts it
    const normalized = normalizeText(reason)
    if (!normalized || normalized.length > 512)
        return inputValidationFailure(
            "options.auditReason",
            "length",
            "Audit reason must contain 1 through 512 UTF-16 code units after Fluxer's normalization",
        )
    return { auditReason: reason.trim() }
}

/** The X-Audit-Log-Reason header value for a validated reason: Its UTF-8 bytes, one character per byte, which Fluxer
 * decodes back to the reason. An ASCII reason is unchanged
 */
export function auditHeader(reason: string): string {
    return String.fromCharCode(...new TextEncoder().encode(reason))
}
