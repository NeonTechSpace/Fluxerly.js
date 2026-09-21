import type { RefreshedAttachmentUrl } from "#sdk/attachments"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import { record } from "./message.js"

/** Validated attachment URL refresh request; shared REST owns admission, deadlines and bounded response parsing */
export interface AttachmentRefreshRequest {
    readonly path: "/attachments/refresh-urls"
    readonly method: "POST"
    readonly status: 200
    readonly json: string
    readonly decode: (value: unknown) => readonly RefreshedAttachmentUrl[] | undefined
}

/** Build one explicit ordered refresh without parsing, normalizing or dereferencing any requested string */
export function attachmentRefresh(urls: readonly string[]): AttachmentRefreshRequest | InputValidationFailure {
    if (!Array.isArray(urls)) return inputValidationFailure("urls", "type", "Attachment URLs must be an array")
    const length = urls.length
    if (length < 1 || length > 50)
        return inputValidationFailure("urls", "length", "Attachment URL refresh requires 1 through 50 entries")
    const original = Array.from({ length }, (_, index) => urls[index])
    if (!original.every((url) => typeof url === "string"))
        return inputValidationFailure("urls[]", "type", "Each attachment URL must be a string")
    if (!original.every((url) => url.length <= 2_048))
        return inputValidationFailure(
            "urls[]",
            "length",
            "Each attachment URL must contain at most 2,048 UTF-16 code units",
        )
    return {
        path: "/attachments/refresh-urls",
        method: "POST",
        status: 200,
        json: JSON.stringify({ attachment_urls: original }),
        decode: (value) => {
            if (!record(value) || !Array.isArray(value.refreshed_urls)) return undefined
            if (value.refreshed_urls.length !== original.length) return undefined
            const refreshed: RefreshedAttachmentUrl[] = []
            for (let index = 0; index < original.length; index++) {
                const item = value.refreshed_urls[index]
                if (
                    !record(item) ||
                    typeof item.original !== "string" ||
                    item.original !== original[index] ||
                    typeof item.refreshed !== "string"
                )
                    return undefined
                refreshed.push(Object.freeze({ original: item.original, refreshed: item.refreshed }))
            }
            return Object.freeze(refreshed)
        },
    }
}
