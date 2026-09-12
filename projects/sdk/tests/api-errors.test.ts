import { expect, test } from "vitest"
import { apiErrorDetail } from "../src/api-errors.js"
import { MessageOperationError } from "../src/message-errors.js"
import { OAuthOperationError } from "../src/oauth.js"

test("maps only reviewed provider codes and preserves the four established SDK codes", () => {
    for (const [providerCode, code] of [
        ["MISSING_ACCESS", "missingAccess"],
        ["MISSING_PERMISSIONS", "missingPermissions"],
        ["COMMUNICATION_DISABLED", "communicationDisabled"],
        ["CANNOT_SEND_MESSAGES_TO_USER", "cannotSendMessagesToUser"],
        ["CANNOT_SEND_EMPTY_MESSAGE", "cannotSendEmptyMessage"],
        ["CANNOT_MODIFY_SYSTEM_WEBHOOK", "cannotModifySystemWebhook"],
        ["CAPTCHA_REQUIRED", "captchaRequired"],
        ["MAX_WEBHOOKS_PER_GUILD", "resourceLimit"],
    ] as const) {
        expect(apiErrorDetail({ code: providerCode })).toMatchObject({ providerCode, code })
    }
})

test("excludes unknown and inherited provider values with every raw response field", () => {
    for (const code of ["UNKNOWN", "__proto__", "constructor", "toString"]) {
        const detail = apiErrorDetail({ code, message: "private provider message", errors: [{ path: "private.path" }] })
        expect(detail).toBeNull()
        expect(JSON.stringify(detail)).not.toContain("private")
    }
})

test("retains at most eight reviewed validation meanings without paths or provider text", () => {
    const marker = "private provider validation message"
    const detail = apiErrorDetail({
        code: "INVALID_FORM_BODY",
        message: marker,
        errors: [
            { path: "embeds.0.title", code: "CONTENT_EXCEEDS_MAX_LENGTH", message: marker },
            { path: "secret", code: "UNREVIEWED", message: marker },
            ...Array.from({ length: 10 }, (_, index) => ({
                path: `attachments.${index}`,
                code: "TOO_MANY_FILES",
                message: marker,
            })),
        ],
    })
    expect(detail).toMatchObject({ providerCode: "INVALID_FORM_BODY" })
    expect(detail && "validationErrors" in detail && detail.validationErrors).toContainEqual({
        providerCode: "CONTENT_EXCEEDS_MAX_LENGTH",
        explanation: expect.stringMatching(/\S/),
    })
    expect(detail && "validationErrors" in detail && detail.validationErrors).toHaveLength(8)
    expect(JSON.stringify(detail)).not.toContain(marker)
    expect(JSON.stringify(detail)).not.toContain("embeds.0.title")
    expect(Object.isFrozen(detail)).toBe(true)
    expect(detail && "validationErrors" in detail && Object.isFrozen(detail.validationErrors)).toBe(true)
})

test("operation errors use reviewed details, status, retry delay, and never raw provider text", () => {
    const detail = apiErrorDetail({
        code: "INVALID_FORM_BODY",
        errors: [{ path: "content", code: "CONTENT_EXCEEDS_MAX_LENGTH", message: "private" }],
    })
    if (!detail) throw new Error("Expected reviewed error detail")
    const message = new MessageOperationError("edit", "rejected", "rejected", 400, 250, detail).message
    expect(message).toContain(detail.explanation)
    if (!("validationErrors" in detail)) throw new Error("Expected reviewed validation details")
    const validation = detail.validationErrors[0]!
    expect(message).toContain(validation.providerCode)
    expect(message).toContain(validation.explanation)
    expect(message).toContain("HTTP 400")
    expect(message).toContain("retry after 250 ms")
    expect(message).not.toContain("private")

    const unknown = new MessageOperationError("edit", "rejected", "rejected", 400)
    expect(unknown.apiError).toBeNull()
    expect(unknown.message).toMatch(/\S/)

    const oauth = new OAuthOperationError("oauth.refresh", "rejected", "rejected", 400, null, null, null, detail)
    expect(oauth.apiError).toBe(detail)
    expect(oauth.message).toContain("HTTP 400")
})
