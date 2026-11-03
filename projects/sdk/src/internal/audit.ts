/**
 * Audit-reason option shared by audited operations.
 * Invariant: A reason is well-formed Unicode text without control characters or line separators, trimmed to 1 through 512
 * UTF-16 code units and sent only as the X-Audit-Log-Reason header, whose value carries its UTF-8 bytes.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import { record } from "./decode/primitives.js"

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
    const trimmed = reason.trim()
    if (!trimmed || trimmed.length > 512)
        return inputValidationFailure(
            "options.auditReason",
            "length",
            "Audit reason must contain 1 through 512 UTF-16 code units after trimming",
        )
    return { auditReason: trimmed }
}

/** The X-Audit-Log-Reason header value for a validated reason: Its UTF-8 bytes, one character per byte, which Fluxer
 * decodes back to the reason. An ASCII reason is unchanged
 */
export function auditHeader(reason: string): string {
    return String.fromCharCode(...new TextEncoder().encode(reason))
}
