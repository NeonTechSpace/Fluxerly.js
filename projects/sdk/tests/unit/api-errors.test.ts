import { expect, onTestFinished, test, vi } from "vitest"
import { apiErrorDetail, apiErrorHint, routeAction, type RequestCredential } from "../../src/api-errors.js"
import { ChannelOperationError, CountOperationError, errors } from "../../src/index.js"
import * as native from "../../src/effect.js"
import { MessageError, MessageOperationError } from "../../src/message-errors.js"
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

// Fluxer 5f3fc0b1: GuildMemberOperationsService, GuildDiscoveryService and its controller, MessageSendService (a
// forward of age-restricted content) and GuildBaseController (leaving a single-community instance) send these to bots
const botReachableRejections = [
    { providerCode: "USER_NOT_IN_VOICE", code: "userNotInVoice", status: 400, topic: /voice/ },
    { providerCode: "DISCOVERY_DISABLED", code: "discoveryDisabled", status: 400, topic: /discoveryEnabled/ },
    {
        providerCode: "DISCOVERY_INSUFFICIENT_MEMBERS",
        code: "discoveryInsufficientMembers",
        status: 400,
        topic: /members/,
    },
    {
        providerCode: "DISCOVERY_ALREADY_APPLIED",
        code: "discoveryAlreadyApplied",
        status: 409,
        topic: /discovery\.edit/,
    },
    {
        providerCode: "DISCOVERY_APPLICATION_NOT_FOUND",
        code: "discoveryApplicationNotFound",
        status: 404,
        topic: /discovery\.apply/,
    },
    {
        providerCode: "DISCOVERY_APPLICATION_ALREADY_REVIEWED",
        code: "discoveryApplicationAlreadyReviewed",
        status: 409,
        topic: /discovery\.apply/,
    },
    {
        providerCode: "NSFW_CONTENT_AGE_RESTRICTED",
        code: "nsfwContentAgeRestricted",
        status: 403,
        topic: /age-restricted/,
    },
    {
        providerCode: "SINGLE_COMMUNITY_CANNOT_LEAVE",
        code: "singleCommunityCannotLeave",
        status: 400,
        topic: /administrator/,
    },
] as const

test.each(modes)("%s describes the Fluxer codes a bot can reach instead of calling them unknown", async (mode) => {
    onTestFinished(() => void vi.unstubAllGlobals())
    let rejection: (typeof botReachableRejections)[number] = botReachableRejections[0]
    stubFetchWithHostedDiscovery(async () =>
        Response.json({ code: rejection.providerCode, message: "private text" }, { status: rejection.status }),
    )
    const client = await setup(mode)
    for (const reviewed of botReachableRejections) {
        rejection = reviewed
        const error = await expectErr(client.rest.request({ method: "POST", path: "/channels/10/messages", body: {} }))
        expect(error, reviewed.providerCode).toMatchObject({
            apiError: { providerCode: reviewed.providerCode, code: reviewed.code },
            details: { apiError: reviewed.providerCode },
            hint: expect.stringMatching(reviewed.topic),
        })
        expect(error.message).not.toContain("does not describe")
        expect(errors.apiCode(error)).toBe(reviewed.code)
        expect(native.errors.apiCode(error)).toBe(reviewed.code)
    }
})

// FEATURE_TEMPORARILY_DISABLED marks an operation instance staff turned off, through a community's disabled operations
// or an instance setting, so waiting does not bring it back (MessageSendService.ts:235, InviteService.ts:209 at 5f3fc0b1)
test("an operation staff turned off and blocked explicit media get hints that do not promise a retry", () => {
    const disabled = hintOf("FEATURE_TEMPORARILY_DISABLED", 403)
    expect(disabled).toMatch(/does not help/)
    expect(disabled).not.toMatch(/^Retry later$/)
    expect(apiErrorDetail({ code: "FEATURE_TEMPORARILY_DISABLED" })?.explanation).not.toMatch(/temporarily/)
    expect(hintOf("EXPLICIT_CONTENT_CANNOT_BE_SENT", 400)).toMatch(/explicit content filter/)
})

// Fluxer answers a held role, channel-order or community-settings lock with GENERAL_ERROR, HTTP 423 and Retry-After 2
test("a rejection Fluxer sends while another change holds the resource says to wait and send again", () => {
    expect(apiErrorHint(null, 423)).toMatch(/retryAfterMs/)
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

test("describes Fluxer's invalid URL validation code instead of treating it as unreviewed", () => {
    const detail = apiErrorDetail({
        code: "INVALID_FORM_BODY",
        errors: [{ path: "url", code: "INVALID_URL_FORMAT", message: "Invalid URL format." }],
    })
    const [url] = detail && "validationErrors" in detail ? detail.validationErrors : []
    expect(url).toEqual({ providerCode: "INVALID_URL_FORMAT", explanation: expect.stringMatching(/\S/), path: "url" })
    // A code that the SDK does not describe gets the generic explanation, which this one differs from
    const unreviewed = apiErrorDetail({
        code: "INVALID_FORM_BODY",
        errors: [{ path: "url", code: "UNREVIEWED_NEW_CODE" }],
    })
    const [other] = unreviewed && "validationErrors" in unreviewed ? unreviewed.validationErrors : []
    expect(url!.explanation).not.toBe(other!.explanation)
    const failure = new MessageOperationError({
        operation: "edit",
        reason: "rejected",
        outcome: "rejected",
        status: 400,
        apiError: detail,
    })
    expect(failure.message).not.toContain("does not describe")
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

const hintOf = (providerCode: string, status: number, credential?: RequestCredential) =>
    apiErrorHint(apiErrorDetail({ code: providerCode }), status, credential)

// Fluxer sends these as 403, so without their own hint they would get the permission-and-role advice
test("timeout and content-filter rejections get their own hints instead of the permission hint", () => {
    const permissionHint = apiErrorHint(null, 403)
    for (const [providerCode, topic] of [
        ["COMMUNICATION_DISABLED", /timed out/],
        ["CONTENT_BLOCKED", /content filter.*\bfile\b/],
    ] as const) {
        expect(hintOf(providerCode, 403), providerCode).not.toBe(permissionHint)
        expect(hintOf(providerCode, 403), providerCode).toMatch(topic)
    }
})

// Fluxer sends DIRECT_MESSAGES_DISABLED only for the instance's policy, and CANNOT_MODIFY_SYSTEM_WEBHOOK only for
// system messages
test("instance-wide DM refusals and system-message refusals name what Fluxer checked", () => {
    const dms = apiErrorDetail({ code: "DIRECT_MESSAGES_DISABLED" })
    for (const text of [dms?.explanation, hintOf("DIRECT_MESSAGES_DISABLED", 403)]) {
        expect(text).toMatch(/instance/)
        expect(text).not.toMatch(/recipient|user/)
    }
    expect(apiErrorDetail({ code: "CANNOT_MODIFY_SYSTEM_WEBHOOK" })?.explanation).not.toMatch(/webhook/)
    expect(hintOf("CANNOT_MODIFY_SYSTEM_WEBHOOK", 400)).toEqual(expect.any(String))
})

test("the missing-access hint covers private threads the bot was not added to", () => {
    expect(hintOf("MISSING_ACCESS", 403)).toMatch(/private thread/)
    expect(hintOf("MISSING_ACCESS", 403)).toContain("Manage threads")
})

// Fluxer answers a wrong or deleted webhook token with UNKNOWN_WEBHOOK and HTTP 404
test("an unknown webhook is a rejected token only for a token-authenticated request", () => {
    expect(hintOf("UNKNOWN_WEBHOOK", 404, "webhook")).toMatch(/webhook ID and token/)
    expect(hintOf("UNKNOWN_WEBHOOK", 404)).not.toMatch(/webhook ID and token/)
    expect(hintOf("UNKNOWN_MESSAGE", 404, "webhook")).not.toMatch(/webhook ID and token/)
})

// Only routes whose needs are certain get a specific missing-permission fix in the rest.rejected record
test("logged missing-permission hints name Send messages or role order only for routes that need them", () => {
    const missing = apiErrorDetail({ code: "MISSING_PERMISSIONS" })
    for (const [method, template] of [
        ["DELETE", "/channels/:id/messages/:id/reactions"],
        ["GET", "/guilds/:id/bans"],
        ["GET", "/channels/:id/messages"],
        ["POST", "/channels/:id/messages/bulk-delete"],
        ["PUT", "/channels/:id/pins/:id"],
        ["POST", "/guilds/:id/roles"],
        ["PATCH", "/guilds/:id/roles/:id"],
    ] as const) {
        const action = routeAction(template, method)
        expect(action, `${method} ${template}`).toBe("other")
        expect(apiErrorHint(missing, 403, "bot", action)).not.toMatch(/Send messages|highest role/)
    }
    expect(routeAction("/channels/:id/messages", "POST")).toBe("message")
    for (const [method, template] of [
        ["PATCH", "/guilds/:id/members/:id"],
        ["DELETE", "/guilds/:id/members/:id"],
        ["PUT", "/guilds/:id/bans/:id"],
    ] as const)
        expect(routeAction(template, method), `${method} ${template}`).toBe("moderation")
    // Fluxer checks Manage roles and the bot's highest role against the role, not against the member
    for (const method of ["PUT", "DELETE"] as const) {
        const action = routeAction("/guilds/:id/members/:id/roles/:id", method)
        expect(action, `${method} member role`).toBe("memberRole")
        const hint = apiErrorHint(missing, 403, "bot", action)
        expect(hint).toContain("above the role")
        expect(hint).not.toContain("of the member it acts on")
    }
    // Fluxer checks only Ban Members for an unban, without the role order
    expect(routeAction("/guilds/:id/bans/:id", "DELETE")).toBe("unban")
    expect(apiErrorHint(missing, 403, "bot", "unban")).not.toMatch(/highest role/)
})

test("the malformed-answer hint does not name a details field that the error lacks", () => {
    const error = new CountOperationError({ operation: "guilds.fetchCounts", reason: "response" })
    expect(error.details).not.toHaveProperty("responseField")
    expect(error.hint).not.toMatch(/report the field named/)
})

// Threads replace Send messages and Manage channels with thread permissions of the parent channel
test("a refused send or typing request names the thread permission too", () => {
    const refused = { reason: "rejected", outcome: "rejected", status: 403 } as const
    const apiError = apiErrorDetail({ code: "MISSING_PERMISSIONS" })
    for (const error of [
        new MessageError({ ...refused, apiError }),
        new MessageOperationError({ ...refused, operation: "typing", apiError }),
    ])
        expect(error.hint).toContain("Send messages in threads")
})

// Fluxer sends a thread PATCH through channels.edit to its thread rules, where Manage channels does not help
test("a refused channel edit names the thread permission too", () => {
    const error = new ChannelOperationError({
        operation: "channels.edit",
        reason: "rejected",
        outcome: "rejected",
        status: 403,
        apiError: apiErrorDetail({ code: "MISSING_PERMISSIONS" }),
    })
    expect(error.hint).toContain("Manage threads")
    expect(error.hint).toContain("threads.edit")
    expect(error.details.requiredPermissions).toEqual(["ViewChannel", "ManageChannels"])
})

test("a refused channel deletion names the thread permission too", () => {
    const error = new ChannelOperationError({
        operation: "channels.delete",
        reason: "rejected",
        outcome: "rejected",
        status: 403,
        apiError: apiErrorDetail({ code: "MISSING_PERMISSIONS" }),
    })
    expect(error.hint).toContain("Manage threads")
    // The listed permissions stay those of an ordinary channel
    expect(error.details.requiredPermissions).toEqual(["ViewChannel", "ManageChannels"])
})
