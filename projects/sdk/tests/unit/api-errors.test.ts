import { expect, onTestFinished, test, vi } from "vitest"
import { apiErrorDetail } from "../../src/api-errors.js"
import { errors } from "../../src/index.js"
import * as native from "../../src/effect.js"
import { MessageOperationError } from "../../src/message-errors.js"
import { OAuthOperationError } from "../../src/oauth.js"
import { modes, setup } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { expectErr } from "../support/settle.js"

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

// Fluxer 597116a: AnnouncementErrors, the channel/follow guards and CrosspostPropagation define these rejections
const announcementRejections = [
    { providerCode: "ANNOUNCEMENT_CHANNEL_REQUIRED", code: "announcementChannelRequired", status: 400 },
    { providerCode: "CHANNEL_ALREADY_FOLLOWED", code: "channelAlreadyFollowed", status: 400 },
    { providerCode: "CHANNEL_HAS_FOLLOWED_CHANNELS", code: "channelHasFollowedChannels", status: 400 },
    { providerCode: "CHANNEL_TYPE_CONVERSION_NOT_SUPPORTED", code: "channelTypeConversionNotSupported", status: 400 },
    { providerCode: "FOLLOW_TARGET_CONTENT_WARNING_REQUIRED", code: "followTargetContentWarningRequired", status: 400 },
    { providerCode: "FOLLOW_TARGET_NOT_AGE_RESTRICTED", code: "followTargetNotAgeRestricted", status: 400 },
    { providerCode: "INVALID_FOLLOW_TARGET_CHANNEL", code: "invalidFollowTargetChannel", status: 400 },
    { providerCode: "MESSAGE_ALREADY_CROSSPOSTED", code: "messageAlreadyCrossposted", status: 400 },
    { providerCode: "MESSAGE_NOT_CROSSPOSTABLE", code: "messageNotCrosspostable", status: 400 },
    { providerCode: "MESSAGE_CROSSPOST_RATE_LIMITED", code: "messageCrosspostRateLimited", status: 429 },
    { providerCode: "PUBLISHED_MESSAGE_EDIT_RATE_LIMITED", code: "publishedMessageEditRateLimited", status: 429 },
] as const

test.each(modes)(
    "%s classifies announcement rejections through public error helpers without provider text",
    async (mode) => {
        onTestFinished(() => void vi.unstubAllGlobals())
        let rejection: (typeof announcementRejections)[number] = announcementRejections[0]
        const marker = "private announcement response text"
        stubFetchWithHostedDiscovery(async () =>
            Response.json(
                { code: rejection.providerCode, message: marker, errors: [{ path: "private.path", message: marker }] },
                { status: rejection.status },
            ),
        )
        const client = await setup(mode)
        for (const reviewed of announcementRejections) {
            rejection = reviewed
            const error = await expectErr(
                client.rest.request({ method: "POST", path: "/channels/10/messages", body: {} }),
            )
            expect(error).toMatchObject({
                _tag: "RestRequestError",
                status: reviewed.status,
                reason: reviewed.status === 429 ? "rateLimit" : "rejected",
                outcome: "rejected",
                apiError: {
                    providerCode: reviewed.providerCode,
                    code: reviewed.code,
                    explanation: expect.stringMatching(/\S/),
                },
                details: { apiError: reviewed.providerCode },
                hint: expect.stringMatching(/\S/),
            })
            expect(errors.apiCode(error)).toBe(reviewed.code)
            expect(native.errors.apiCode(error)).toBe(reviewed.code)
            expect(errors.isRetryable(error)).toBe(reviewed.status === 429)
            expect(native.errors.isRetryable(error)).toBe(reviewed.status === 429)
            if (error._tag !== "RestRequestError") expect.fail("Expected a REST rejection")
            expect(Object.isFrozen(error.apiError)).toBe(true)
            expect(error.apiError).not.toHaveProperty("validationErrors")
            expect(error.details).not.toHaveProperty("providerCode")
            for (const text of [error.message, JSON.stringify(error)]) {
                expect(text).not.toContain(marker)
                expect(text).not.toContain("private.path")
            }
        }
    },
)

// Fluxer 4749eb7f: ThreadDenials, ThreadParentSettings, ForumTagRules, ThreadRepository and WebhookService define these
// rejections. SEARCH_INDEX_NOT_READY is left out because Fluxer answers it with HTTP 202, which the SDK returns as a
// search page, and WEBHOOK_FORUM_TARGET_CONFLICT because webhook sends refuse a post name together with a thread before
// any request
const threadRejections = [
    { providerCode: "THREAD_ARCHIVED", code: "threadArchived", status: 400 },
    { providerCode: "THREAD_LOCKED", code: "threadLocked", status: 400 },
    { providerCode: "THREAD_ALREADY_CREATED_FOR_MESSAGE", code: "threadAlreadyCreated", status: 400 },
    { providerCode: "CHANNEL_HAS_THREADS", code: "channelHasThreads", status: 400 },
    { providerCode: "INVALID_CHANNEL_TYPE", code: "invalidChannelType", status: 400 },
    { providerCode: "FORUM_TAG_NAMES_MUST_BE_UNIQUE", code: "forumTagNamesNotUnique", status: 400 },
    { providerCode: "FORUM_TAG_REQUIRED", code: "forumTagRequired", status: 400 },
    { providerCode: "NO_TAGS_AVAILABLE_TO_NON_MODERATORS", code: "noTagsAvailable", status: 400 },
    { providerCode: "HIDE_MEDIA_DOWNLOAD_OPTION_MEDIA_ONLY", code: "mediaChannelRequired", status: 400 },
    { providerCode: "WEBHOOK_FORUM_TARGET_REQUIRED", code: "webhookForumTargetRequired", status: 400 },
    { providerCode: "WEBHOOK_THREAD_NAME_REQUIRES_FORUM", code: "webhookThreadNameRequiresForum", status: 400 },
    { providerCode: "MAX_ACTIVE_THREADS", code: "resourceLimit", status: 400 },
    { providerCode: "MAX_FORUM_TAGS", code: "resourceLimit", status: 400 },
    { providerCode: "MAX_PINNED_THREADS_IN_FORUM", code: "resourceLimit", status: 400 },
    { providerCode: "MAX_THREAD_MEMBERS", code: "resourceLimit", status: 400 },
    { providerCode: "UNKNOWN_FORUM_TAG", code: "unknownResource", status: 404 },
    { providerCode: "UNKNOWN_THREAD_MEMBER", code: "unknownResource", status: 404 },
] as const

test.each(modes)(
    "%s classifies thread, forum tag and webhook post rejections with a category and a hint",
    async (mode) => {
        onTestFinished(() => void vi.unstubAllGlobals())
        let rejection: (typeof threadRejections)[number] = threadRejections[0]
        const marker = "private thread response text"
        stubFetchWithHostedDiscovery(async () =>
            Response.json({ code: rejection.providerCode, message: marker }, { status: rejection.status }),
        )
        const client = await setup(mode)
        for (const reviewed of threadRejections) {
            rejection = reviewed
            const error = await expectErr(
                client.rest.request({ method: "POST", path: "/channels/10/messages", body: {} }),
            )
            expect(error).toMatchObject({
                _tag: "RestRequestError",
                status: reviewed.status,
                outcome: "rejected",
                apiError: {
                    providerCode: reviewed.providerCode,
                    code: reviewed.code,
                    explanation: expect.stringMatching(/\S/),
                },
                details: { apiError: reviewed.providerCode },
                hint: expect.stringMatching(/\S/),
            })
            expect(errors.apiCode(error)).toBe(reviewed.code)
            expect(native.errors.apiCode(error)).toBe(reviewed.code)
            expect(errors.isRetryable(error)).toBe(false)
            expect(error.details).not.toHaveProperty("providerCode")
            for (const text of [error.message, JSON.stringify(error)]) expect(text).not.toContain(marker)
        }
    },
)

test.each(modes)("%s treats the retired phone-verification code as unrecognized", async (mode) => {
    onTestFinished(() => void vi.unstubAllGlobals())
    const providerCode = "GUILD_PHONE_VERIFICATION_REQUIRED"
    stubFetchWithHostedDiscovery(async () => Response.json({ code: providerCode }, { status: 400 }))
    const client = await setup(mode)
    const error = await expectErr(client.rest.request({ method: "POST", path: "/channels/10/messages", body: {} }))
    expect(error).toMatchObject({ apiError: null, details: { providerCode } })
    expect(errors.apiCode(error)).toBeUndefined()
    expect(native.errors.apiCode(error)).toBeUndefined()
    expect(errors.isRetryable(error)).toBe(false)
    for (const code of ["GUILD_VERIFICATION_REQUIRED", "GUILD_EMAIL_VERIFICATION_REQUIRED"])
        expect(apiErrorDetail({ code })).toMatchObject({ providerCode: code, code: "guildVerificationRequired" })
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
