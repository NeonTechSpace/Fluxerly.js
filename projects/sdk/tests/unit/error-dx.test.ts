import { expect, test } from "vitest"
import { apiErrorDetail, apiErrorHint, apiErrorMappings, operationFailureHint } from "../../src/api-errors.js"
import { AssetUrlError } from "../../src/assets.js"
import { AttachmentDownloadError } from "../../src/attachments.js"
import {
    AuthenticationError,
    CancelledError,
    ClientClosedError,
    ConfigurationError,
    ConnectionError,
    RateLimitError,
    ShardConnectionError,
} from "../../src/errors.js"
import { describeError, errors } from "../../src/error-tools.js"
import { GatewaySendError } from "../../src/gateway.js"
import { HelperError } from "../../src/helpers.js"
import {
    commands,
    createClient,
    createWebhookClient,
    guards,
    oauth,
    supervisor,
    CountOperationError,
    MemberChunkError,
    MessageCleanupError,
    MessageError,
    MessageOperationError,
    OAuthOperationError,
    PaginationError,
    PresenceError,
} from "../../src/index.js"
import { inputValidationFailure } from "../../src/input-validation.js"
import { CloseCode } from "../../src/internal/protocol/gateway.js"
import { snapshotMessageFields } from "../../src/internal/message-fields.js"
import { restConfiguration, transportConfiguration } from "../../src/internal/rest/options.js"
import { gatewayConfiguration } from "../../src/internal/gateway/options.js"
import { errorInfo, loggingConfiguration, prettyLine } from "../../src/internal/logging.js"
import { parseSharding } from "../../src/internal/sharding.js"
import { snapshotBotEvents } from "../../src/internal/bot-runner.js"

test("every recognized ApiErrorCode has an actionable hint and never falls through to 403 permission advice", () => {
    const permissionHint = apiErrorHint(null, 403)
    const nonPermission403Codes = [
        "INVITES_DISABLED",
        "FEATURE_NOT_AVAILABLE_SELF_HOSTED",
        "GUILD_VERIFICATION_REQUIRED",
        "GUILD_EMAIL_VERIFICATION_REQUIRED",
        "BOT_IS_PRIVATE",
        "APPLICATION_NOT_OWNED",
        "CAPTCHA_REQUIRED",
        "INVALID_CAPTCHA",
        "BOT_ALREADY_IN_GUILD",
        "NOT_A_BOT_APPLICATION",
        "BAD_REQUEST",
        "CONFLICT",
        "GONE",
        "NOT_IMPLEMENTED",
    ] as const
    for (const providerCode of Object.keys(apiErrorMappings)) {
        const detail = apiErrorDetail({ code: providerCode })
        expect(detail, providerCode).not.toBeNull()
        const hint = apiErrorHint(detail, null)
        expect(hint, providerCode).toEqual(expect.stringMatching(/\S/))
    }
    for (const providerCode of nonPermission403Codes) {
        const detail = apiErrorDetail({ code: providerCode })
        expect(apiErrorHint(detail, 403), providerCode).not.toBe(permissionHint)
    }
})

test("statusHints cover common HTTP errors, empty INVALID_FORM_BODY differs from populated, and concrete retryAfterMs is interpolated", () => {
    for (const status of [400, 401, 403, 404, 405, 408, 409, 410, 413, 415, 422, 423, 500, 501, 502, 503, 504]) {
        expect(apiErrorHint(null, status), `HTTP ${status}`).toEqual(expect.stringMatching(/\S/))
    }
    expect(apiErrorHint(null, 503)).not.toContain("upload slots")

    const emptyForm = apiErrorDetail({ code: "INVALID_FORM_BODY", errors: [] })
    const populatedForm = apiErrorDetail({
        code: "INVALID_FORM_BODY",
        errors: [{ path: "content", code: "CONTENT_EXCEEDS_MAX_LENGTH" }],
    })
    expect(apiErrorHint(emptyForm, 400)).toContain("without naming individual fields")
    expect(apiErrorHint(populatedForm, 400)).toContain("apiError.validationErrors")

    expect(apiErrorHint(null, 423)).toContain("retryAfterMs")
    expect(apiErrorHint(null, 423, "bot", { retryAfterMs: 2000 })).toContain("2000 ms")
    expect(apiErrorHint(apiErrorDetail({ code: "RESOURCE_LOCKED" }), 423, "bot", { retryAfterMs: 2000 })).toContain(
        "2000 ms",
    )
    expect(
        operationFailureHint({
            reason: "rateLimit",
            outcome: "rejected",
            status: 429,
            retryAfterMs: 4500,
            apiError: apiErrorDetail({ code: "MESSAGE_CROSSPOST_RATE_LIMITED" }),
        }),
    ).toContain("4500 ms")
    expect(
        operationFailureHint({
            reason: "rateLimit",
            outcome: "rejected",
            status: 429,
            retryAfterMs: 4500,
            apiError: apiErrorDetail({ code: "MESSAGE_CROSSPOST_RATE_LIMITED" }),
        }),
    ).toContain("publishing")
    expect(
        operationFailureHint({
            reason: "rateLimit",
            outcome: "rejected",
            status: 429,
            retryAfterMs: 3200,
            apiError: apiErrorDetail({ code: "SLOWMODE_RATE_LIMITED" }),
        }),
    ).toContain("slowmode")
})

test("describeError shows Retry guidance, apiCode, inputConstraint, and Validation lines without breaking lines 0..2", () => {
    const rateLimited = new MessageOperationError({
        operation: "edit",
        reason: "rateLimit",
        outcome: "rejected",
        status: 429,
        retryAfterMs: 1500,
    })
    expect(describeError(rateLimited)).toContain("  Retry: Safe to retry after 1500 ms")

    const unknownWrite = new MessageError({ reason: "network", outcome: "unknown" })
    expect(describeError(unknownWrite)).toContain(
        "  Retry: Do not retry blindly (outcome is unknown and the change may have been applied)",
    )

    const streamed = new MessageError({
        reason: "rateLimit",
        outcome: "rejected",
        status: 429,
        retryAfterMs: 2500,
        streamUsed: true,
    })
    expect(describeError(streamed)).toContain("fresh stream")
    expect(describeError(streamed)).toContain("2500 ms")

    const limit = new MessageOperationError({
        operation: "edit",
        reason: "rejected",
        outcome: "rejected",
        status: 400,
        apiError: apiErrorDetail({ code: "MAX_EMOJIS" }),
    })
    expect(limit.details).toMatchObject({ apiError: "MAX_EMOJIS", apiCode: "resourceLimit" })
    const limitText = describeError(limit)
    expect(limitText).toContain("apiError=MAX_EMOJIS")
    expect(limitText).toContain("apiCode=resourceLimit")
    expect(limitText).toContain("  Retry: Do not retry unchanged")

    const form = new MessageError({
        reason: "rejected",
        outcome: "rejected",
        status: 400,
        apiError: apiErrorDetail({
            code: "INVALID_FORM_BODY",
            errors: [
                { path: "embeds.0.title", code: "CONTENT_EXCEEDS_MAX_LENGTH" },
                { path: "content", code: "CANNOT_SEND_EMPTY_MESSAGE" },
            ],
        }),
    })
    const formText = describeError(form)
    expect(formText).toContain("  Validation:")
    expect(formText).toContain("    embeds.0.title [CONTENT_EXCEEDS_MAX_LENGTH]: ")
    expect(formText).toContain("    content [CANNOT_SEND_EMPTY_MESSAGE]: ")

    const inputErr = new AttachmentDownloadError({
        reason: "input",
        inputValidation: inputValidationFailure("options.maxBytes", "range", "The maxBytes option must be positive")
            .detail,
    })
    expect(inputErr.details).toMatchObject({
        inputPath: "options.maxBytes",
        inputConstraint: "range",
        read: true,
    })
    expect(describeError(inputErr)).toContain("inputConstraint=range")

    const conn = new ConnectionError("gateway", "network")
    expect(describeError(conn)).toContain("  Retry: Safe to retry (create a new client if run ended)")
    expect(describeError(new ShardConnectionError(0, new RateLimitError("gateway", 3000)))).toContain(
        "  Retry: Safe to retry after 3000 ms (create a new client if run ended)",
    )
    expect(describeError(new AuthenticationError())).toContain("  Retry: Do not retry unchanged")
    expect(describeError(new ConfigurationError("token", "Bad token"), { stack: false })).not.toContain("  Retry:")
})

test("HelperError, AssetUrlError, ConnectionError and MessageCleanupError always carry actionable hints", () => {
    expect(new HelperError("format.parseMention", "markup").hint).toContain("tryParseMention")
    expect(new HelperError("errors.isNotFound", "resource").hint).toContain("channel")
    expect(new AssetUrlError("assets.avatar", "hash").hint).toContain("non-null")
    expect(new AssetUrlError("assets.displayMemberAvatar", "target").hint).toContain("matching User")
    expect(new AssetUrlError("assets.sticker", "options").hint).not.toContain("AssetFormats")

    for (const phase of ["discovery", "gateway"] as const) {
        for (const reason of ["network", "protocol", "closed"] as const) {
            for (const status of [
                null,
                404,
                503,
                CloseCode.unknownOpcode,
                CloseCode.invalidApiVersion,
                CloseCode.invalidPayload,
            ]) {
                expect(new ConnectionError(phase, reason, status).hint, `${phase}/${reason}/${status}`).toEqual(
                    expect.stringMatching(/\S/),
                )
            }
        }
    }
    expect(new ConnectionError("discovery", "network", 404).hint).toContain("instance.url")
    expect(new ConnectionError("gateway", "protocol", CloseCode.unknownOpcode).hint).toContain("4,096")

    const closedPreview = new MessageCleanupError({
        phase: "preview",
        reason: "closed",
        outcome: "notDispatched",
        status: null,
        retryAfterMs: null,
        scannedCount: 0,
        selectedMessageIds: [],
        submittedBatches: [],
        terminalBatchIds: null,
    })
    expect(closedPreview.hint).toContain("Nothing was deleted")

    const closedCleanup = new MessageCleanupError({
        phase: "cleanup",
        reason: "closed",
        outcome: "unknown",
        status: null,
        retryAfterMs: null,
        scannedCount: 5,
        selectedMessageIds: ["1", "2"],
        submittedBatches: [{ batchIndex: 0, messageIds: ["1"] }],
        terminalBatchIds: ["2"],
    })
    expect(closedCleanup.hint).toContain("submittedBatches")
    expect(closedCleanup.hint).toContain("new client")

    const partialRejected = new MessageCleanupError({
        phase: "cleanup",
        reason: "rejected",
        outcome: "rejected",
        status: 403,
        retryAfterMs: null,
        scannedCount: 5,
        selectedMessageIds: ["1", "2"],
        submittedBatches: [{ batchIndex: 0, messageIds: ["1"] }],
        terminalBatchIds: ["2"],
        apiError: apiErrorDetail({ code: "MISSING_PERMISSIONS" }),
    })
    expect(partialRejected.hint).toContain("Earlier batches in submittedBatches were already sent")
    expect(partialRejected.details).toMatchObject({ apiError: "MISSING_PERMISSIONS", apiCode: "missingPermissions" })
})

test("domain errors include consistent details and improved targeted hints", () => {
    const input = inputValidationFailure(
        "options.timeoutMs",
        "range",
        "The options.timeoutMs setting must be valid",
    ).detail
    expect(
        new CountOperationError({ operation: "guilds.fetchCounts", reason: "input", inputValidation: input }).details,
    ).toMatchObject({
        operation: "guilds.fetchCounts",
        inputPath: "options.timeoutMs",
        inputConstraint: "range",
        read: true,
    })
    expect(new MemberChunkError({ reason: "busy" }).details).toMatchObject({
        operation: "members.iterateChunks",
        read: true,
    })
    expect(new MemberChunkError({ reason: "busy" }).hint).toContain("active member chunk stream")
    expect(new MemberChunkError({ reason: "rateLimit", retryAfterMs: 4000 }).hint).toContain("12 per account")
    expect(new PresenceError({ reason: "input", inputValidation: input }).details).toMatchObject({
        inputPath: "options.timeoutMs",
        inputConstraint: "range",
    })
    expect(
        new PaginationError({ operation: "iterateHistory", reason: "input", inputValidation: input }).details,
    ).toMatchObject({
        inputPath: "options.timeoutMs",
        inputConstraint: "range",
    })
    const gwInput = new GatewaySendError({ reason: "input", inputValidation: input })
    expect(gwInput.details).toMatchObject({ inputPath: "options.timeoutMs", inputConstraint: "range" })
    expect(gwInput.hint).toContain("options.timeoutMs")
    expect(new GatewaySendError({ reason: "notOwned", shardId: 2 }).hint).toContain("snowflakes.shardFor")
    expect(new AttachmentDownloadError({ reason: "response", status: 403 }).hint).toContain("attachments.refreshUrls")
    expect(new AttachmentDownloadError({ reason: "response", status: 403 }).hint).toContain("channel access")
    expect(
        new OAuthOperationError({
            operation: "oauth.refresh",
            reason: "rejected",
            outcome: "rejected",
            status: 400,
            apiError: apiErrorDetail({ code: "BAD_REQUEST" }),
        }).details,
    ).toMatchObject({
        apiError: "BAD_REQUEST",
        apiCode: "badRequest",
    })
    expect(new ClientClosedError({ outcome: "unknown" }).message).toContain("The change may still have been applied")
    expect(new ClientClosedError({ outcome: "unknown", read: true }).message).not.toContain("applied")
    expect(new CancelledError("send").hint).toContain("Cancellation does not undo")
    expect(new RateLimitError("gateway", 2000).hint).toContain("create a new client")
    expect(errors.isRetryable(new RateLimitError("gateway", 2000))).toBe(true)
})

test("option validators report unsupported keys with closest-match typo suggestions and valid-shape hints", () => {
    const restErr = restConfiguration({ concurreny: 4 })
    expect(restErr).toBeInstanceOf(ConfigurationError)
    expect((restErr as ConfigurationError).hint).toContain('"concurrency"')

    const transportErr = transportConfiguration({ fetc: fetch })
    expect(transportErr).toBeInstanceOf(ConfigurationError)
    expect((transportErr as ConfigurationError).hint).toContain('"fetch"')

    expect(() => createWebhookClient({ id: "1", token: "x", loging: {} } as never)).toThrow(
        expect.objectContaining({ _tag: "ConfigurationError", hint: expect.stringContaining('"logging"') }),
    )
    expect(() => oauth.create({ clientId: "1", clientSecret: "x", instace: {} } as never)).toThrow(
        expect.objectContaining({ _tag: "ConfigurationError", hint: expect.stringContaining('"instance"') }),
    )
    expect(() => snapshotMessageFields(["conten"])).toThrow(
        expect.objectContaining({ _tag: "ConfigurationError", hint: expect.stringContaining('"content"') }),
    )
    const gwFlagsErr = gatewayConfiguration({ flags: { debounceMessageReaction: true } }, [])
    expect(gwFlagsErr).toBeInstanceOf(ConfigurationError)
    expect((gwFlagsErr as ConfigurationError).hint).toContain('"debounceMessageReactions"')

    const dedupeErr = loggingConfiguration({ dedupe: { window: 1000 } }, false)
    expect(dedupeErr).toBeInstanceOf(ConfigurationError)
    expect((dedupeErr as ConfigurationError).hint).toContain('"windowMs"')

    const unsafeErr = loggingConfiguration({ unsafe: { payload: true } }, false)
    expect(unsafeErr).toBeInstanceOf(ConfigurationError)
    expect((unsafeErr as ConfigurationError).hint).toContain('"payloads"')

    const client = createClient({ token: "fixture-only-not-a-credential" })
    expect(() => client.cache.clear("message" as never)).toThrow(
        expect.objectContaining({ _tag: "ConfigurationError", hint: expect.stringContaining('"messages"') }),
    )
    void client.shutdown()

    expect(() => guards.requirePermissions(["ManageMessage" as never])).toThrow(
        expect.objectContaining({ _tag: "ConfigurationError", hint: expect.stringContaining('"ManageMessages"') }),
    )

    expect(() =>
        commands.create({ prefix: "!" }).register({
            name: "say",
            arguments: [{ name: "text", rest: true }] as never,
            execute() {},
        }),
    ).toThrow(expect.objectContaining({ _tag: "ConfigurationError", hint: expect.stringContaining("rest: true") }))

    const shardErr = parseSharding({ totalShards: 2, shardIds: [2] })
    expect(shardErr).toBeInstanceOf(ConfigurationError)
    expect((shardErr as ConfigurationError).hint).toContain("0 through 1")

    expect(() => snapshotBotEvents([] as never)).toThrow(
        expect.objectContaining({ _tag: "ConfigurationError", hint: expect.stringContaining("messageCreate") }),
    )

    expect(() => supervisor.create({ entry: "relative.js", totalShards: 1 })).toThrow(
        expect.objectContaining({ _tag: "ConfigurationError", hint: expect.stringContaining("import.meta.url") }),
    )
})

test("prettyLine and describeError({ color: true }) format icons, gutter rails and highlights while preserving plain mode", () => {
    const token = "1456074443980800001.fixtureOnlyNotACredential0123456789abcdefgh"
    const formError = new MessageError({
        reason: "rejected",
        outcome: "rejected",
        status: 400,
        apiError: apiErrorDetail({
            code: "INVALID_FORM_BODY",
            errors: [{ path: "content", code: "CANNOT_SEND_EMPTY_MESSAGE" }],
        }),
    })
    const coloredError = describeError(formError, { color: true })
    const plainError = describeError(formError)
    // oxlint-disable-next-line no-control-regex -- Verifies plain mode emits zero ANSI escapes and color mode styles headings
    expect(plainError).not.toMatch(/\x1b\[/)
    // oxlint-disable-next-line no-control-regex -- Verifies color mode emits ANSI styling
    expect(coloredError).toMatch(/\x1b\[/)
    expect(coloredError).toContain("Hint:")
    expect(coloredError).toContain("Retry:")
    expect(coloredError).toContain("Validation:")
    expect(coloredError).toContain("CANNOT_SEND_EMPTY_MESSAGE")
    // Colored describeError still masks credentials identically to plain mode
    expect(describeError(new Error(`failed with ${token}`), { color: true })).not.toContain("fixtureOnlyNotACredential")

    const record = {
        time: "2026-11-24T22:00:00.000Z",
        level: "error" as const,
        category: "commands" as const,
        code: "commands.failed",
        message: "Command failed",
        command: "ping",
        error: errorInfo(formError, "sdk"),
    }
    const plainLog = prettyLine(record, false)
    const coloredLog = prettyLine(record, true)
    // oxlint-disable-next-line no-control-regex -- Verifies non-color prettyLine stays plain text
    expect(plainLog).not.toMatch(/\x1b\[/)
    // oxlint-disable-next-line no-control-regex -- Verifies colored prettyLine adds ANSI icons and gutter rails
    expect(coloredLog).toMatch(/\x1b\[/)
    expect(coloredLog).toContain("ERROR")
    expect(coloredLog).toContain("[commands.failed]")
    expect(coloredLog).toContain("Hint:")

    const connected = prettyLine(
        {
            time: "2026-11-24T22:00:00.000Z",
            level: "info",
            category: "lifecycle",
            code: "lifecycle.connected",
            message: "Bot connected",
        },
        true,
    )
    expect(connected).toContain("INFO ")
    expect(connected).toContain("[lifecycle.connected]")
})
