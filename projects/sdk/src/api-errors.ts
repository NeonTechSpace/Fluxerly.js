/**
 * Safe, SDK-owned classifications for selected Fluxer API rejections. They never retain a provider response body, message or field data
 *
 * @example
 * ```ts
 * import type { ApiErrorDetail } from "@neontechspace/fluxerly"
 *
 * function formatApiErrorDetail(detail: ApiErrorDetail): string {
 *     return `${detail.code}: ${detail.explanation}`
 * }
 * ```
 */
export type ApiErrorDetail =
    | { readonly code: "missingAccess"; readonly explanation: "The provider denied access to the requested resource" }
    | {
          readonly code: "missingPermissions"
          readonly explanation: "The provider reports that the bot lacks a required permission"
      }
    | {
          readonly code: "communicationDisabled"
          readonly explanation: "The provider reports that communication is disabled for this operation"
      }
    | {
          readonly code: "cannotSendMessagesToUser"
          readonly explanation: "The provider rejected delivery of this message to the requested user"
      }

/** Maps only reviewed provider codes to safe SDK-owned details. Unknown codes deliberately have no classification */
export function apiErrorDetail(code: unknown): ApiErrorDetail | null {
    switch (code) {
        case "MISSING_ACCESS":
            return Object.freeze({
                code: "missingAccess",
                explanation: "The provider denied access to the requested resource",
            })
        case "MISSING_PERMISSIONS":
            return Object.freeze({
                code: "missingPermissions",
                explanation: "The provider reports that the bot lacks a required permission",
            })
        case "COMMUNICATION_DISABLED":
            return Object.freeze({
                code: "communicationDisabled",
                explanation: "The provider reports that communication is disabled for this operation",
            })
        case "CANNOT_SEND_MESSAGES_TO_USER":
            return Object.freeze({
                code: "cannotSendMessagesToUser",
                explanation: "The provider rejected delivery of this message to the requested user",
            })
        default:
            return null
    }
}
