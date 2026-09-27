/**
 * Audit-reason option shared by audited operations.
 * Invariant: A reason is printable ASCII, trimmed to 1 through 512 characters and sent only as the X-Audit-Log-Reason header.
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
    if (typeof reason !== "string" || !/^[\x20-\x7E]+$/.test(reason))
        return inputValidationFailure(
            "options.auditReason",
            "format",
            "Audit reason must contain only printable ASCII characters",
        )
    const trimmed = reason.trim()
    if (!trimmed || trimmed.length > 512)
        return inputValidationFailure(
            "options.auditReason",
            "length",
            "Audit reason must contain 1 through 512 characters after trimming",
        )
    return { auditReason: trimmed }
}
