import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import { record } from "./message.js"

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
            "Audit reason must contain printable ASCII characters",
        )
    const trimmed = reason.trim()
    if (!trimmed || trimmed.length > 512)
        return inputValidationFailure(
            "options.auditReason",
            "length",
            "Audit reason must contain 1 through 512 characters",
        )
    return { auditReason: trimmed }
}
