import { expect, test } from "vitest"
import { apiErrorDetail } from "../../src/api-errors.js"
import { MessageOperationError } from "../../src/message-errors.js"
import { OAuthOperationError } from "../../src/oauth.js"

test("maps only reviewed provider codes and preserves the four established SDK codes", () => {
    for (const [providerCode, code] of [
        ["MISSING_ACCESS", "missingAccess"],
        ["MISSING_PERMISSIONS", "missingPermissions"],
        ["COMMUNICATION_DISABLED", "communicationDisabled"],
        ["CANNOT_SEND_MESSAGES_TO_USER", "cannotSendMessagesToUser"],
        ["CANNOT_SEND_EMPTY_MESSAGE", "cannotSendEmptyMessage"],
        ["CANNOT_MODIFY_SYSTEM_WEBHOOK", "cannotModifySystemWebhook"],
        ["CAPTCHA_REQUIRED", "captchaRequired"],
        ["TWO_FACTOR_REQUIRED", "twoFactorRequired"],
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

test("retains reviewed validation meanings with plain field paths, bounded to 32, without provider text", () => {
    const marker = "private provider validation message"
    const detail = apiErrorDetail({
        code: "INVALID_FORM_BODY",
        message: marker,
        errors: [
            { path: "embeds.0.title", code: "CONTENT_EXCEEDS_MAX_LENGTH", message: marker },
            { path: "nickname", code: "UNREVIEWED_NEW_CODE", message: marker },
            { path: "private.path", code: "not a code: private", message: marker },
            { path: "content: rejected value", code: "INVALID_FORMAT", message: marker },
            ...Array.from({ length: 40 }, (_, index) => ({
                path: `attachments.${index}`,
                code: "TOO_MANY_FILES",
                message: marker,
            })),
        ],
    })
    expect(detail).toMatchObject({ providerCode: "INVALID_FORM_BODY" })
    const errors = detail && "validationErrors" in detail ? detail.validationErrors : []
    expect(errors[0]).toEqual({
        providerCode: "CONTENT_EXCEEDS_MAX_LENGTH",
        explanation: expect.stringMatching(/\S/),
        path: "embeds.0.title",
    })
    // A code this SDK version does not describe keeps its field path when the code has a safe shape
    expect(errors[1]).toEqual({
        providerCode: "UNREVIEWED_NEW_CODE",
        explanation: expect.stringMatching(/\S/),
        path: "nickname",
    })
    // A path that is not a plain dotted field name is dropped rather than copied
    expect(errors[2]).toEqual({ providerCode: "INVALID_FORMAT", explanation: expect.stringMatching(/\S/) })
    expect(errors).toHaveLength(32)
    expect(errors[3]).toMatchObject({ path: "attachments.0" })
    const serialized = JSON.stringify(detail)
    for (const hidden of [marker, "private", "rejected value"]) expect(serialized).not.toContain(hidden)
    expect(Object.isFrozen(detail)).toBe(true)
    expect(Object.isFrozen(errors)).toBe(true)
})

test("operation errors use reviewed details, status, retry delay, and never raw provider text", () => {
    const detail = apiErrorDetail({
        code: "INVALID_FORM_BODY",
        errors: [{ path: "content", code: "CONTENT_EXCEEDS_MAX_LENGTH", message: "private" }],
    })
    if (!detail) throw new Error("Expected reviewed error detail")
    const message = new MessageOperationError({
        operation: "edit",
        reason: "rejected",
        outcome: "rejected",
        status: 400,
        retryAfterMs: 250,
        apiError: detail,
    })
    const oauth = new OAuthOperationError({
        operation: "oauth.refresh",
        reason: "rejected",
        outcome: "rejected",
        status: 400,
        apiError: detail,
    })
    expect(message).toMatchObject({
        status: 400,
        retryAfterMs: 250,
        details: { status: 400, retryAfterMs: 250, apiError: "INVALID_FORM_BODY" },
    })
    expect(oauth).toMatchObject({
        status: 400,
        retryAfterMs: null,
        details: { status: 400 },
    })
    expect(oauth.details).not.toHaveProperty("retryAfterMs")
    for (const error of [message, oauth]) {
        expect(error.apiError).toBe(detail)
        expect(error.apiError && "validationErrors" in error.apiError && error.apiError.validationErrors[0]).toEqual({
            providerCode: "CONTENT_EXCEEDS_MAX_LENGTH",
            explanation: expect.stringMatching(/\S/),
            path: "content",
        })
        expect(error.message).not.toContain("private")
        expect(JSON.stringify(error)).not.toContain("private")
    }

    const unknown = new MessageOperationError({
        operation: "edit",
        reason: "rejected",
        outcome: "rejected",
        status: 400,
    })
    expect(unknown.apiError).toBeNull()
    expect(unknown.message).toMatch(/\S/)
})
