/** @internal */
const apiErrorMappings = {
    MISSING_ACCESS: { code: "missingAccess", explanation: "The provider denied access to the requested resource" },
    MISSING_PERMISSIONS: {
        code: "missingPermissions",
        explanation: "The provider reports that the bot lacks a required permission",
    },
    COMMUNICATION_DISABLED: {
        code: "communicationDisabled",
        explanation: "The provider reports that communication is disabled for this operation",
    },
    CANNOT_SEND_MESSAGES_TO_USER: {
        code: "cannotSendMessagesToUser",
        explanation: "The provider rejected delivery of this message to the requested user",
    },
    CANNOT_SEND_EMPTY_MESSAGE: {
        code: "cannotSendEmptyMessage",
        explanation: "The provider requires message content, an embed, an attachment, or a sticker",
    },
    CANNOT_MODIFY_SYSTEM_WEBHOOK: {
        code: "cannotModifySystemWebhook",
        explanation: "The provider does not allow modifying a system webhook",
    },
    CAPTCHA_REQUIRED: { code: "captchaRequired", explanation: "The provider requires CAPTCHA verification" },
    INVALID_CAPTCHA: { code: "invalidCaptcha", explanation: "The provider rejected the CAPTCHA verification" },
    INVALID_FORM_BODY: { code: "invalidFormBody", explanation: "The provider rejected one or more request fields" },
    VALIDATION_ERROR: { code: "invalidFormBody", explanation: "The provider rejected one or more request fields" },
    UNKNOWN_APPLICATION: { code: "unknownResource", explanation: "The requested application was not found" },
    UNKNOWN_CHANNEL: { code: "unknownResource", explanation: "The requested channel was not found" },
    UNKNOWN_EMOJI: { code: "unknownResource", explanation: "The requested emoji was not found" },
    UNKNOWN_GUILD: { code: "unknownResource", explanation: "The requested guild was not found" },
    UNKNOWN_INVITE: { code: "unknownResource", explanation: "The requested invite was not found" },
    UNKNOWN_MEMBER: { code: "unknownResource", explanation: "The requested member was not found" },
    UNKNOWN_MESSAGE: { code: "unknownResource", explanation: "The requested message was not found" },
    UNKNOWN_ROLE: { code: "unknownResource", explanation: "The requested role was not found" },
    UNKNOWN_STICKER: { code: "unknownResource", explanation: "The requested sticker was not found" },
    UNKNOWN_USER: { code: "unknownResource", explanation: "The requested user was not found" },
    UNKNOWN_WEBHOOK: { code: "unknownResource", explanation: "The requested webhook was not found" },
    MISSING_OAUTH_SCOPE: { code: "missingOAuthScope", explanation: "The OAuth token lacks a required scope" },
    CANNOT_EDIT_OTHER_USER_MESSAGE: {
        code: "cannotEditOtherUserMessage",
        explanation: "The provider does not allow editing another user's message",
    },
    CANNOT_SEND_MESSAGES_IN_NON_TEXT_CHANNEL: {
        code: "cannotSendMessagesInNonTextChannel",
        explanation: "The provider does not allow messages in the requested channel type",
    },
    CONTENT_BLOCKED: { code: "contentBlocked", explanation: "The provider blocked the submitted content" },
    DIRECT_MESSAGES_DISABLED: {
        code: "directMessagesDisabled",
        explanation: "The provider has direct messages disabled",
    },
    EXPLICIT_CONTENT_CANNOT_BE_SENT: {
        code: "explicitContentCannotBeSent",
        explanation: "The provider blocked explicit content for this delivery",
    },
    FILE_SIZE_TOO_LARGE: { code: "fileSizeTooLarge", explanation: "A submitted file exceeds the provider limit" },
    FEATURE_TEMPORARILY_DISABLED: {
        code: "featureTemporarilyDisabled",
        explanation: "The provider has temporarily disabled this feature",
    },
    SLOWMODE_RATE_LIMITED: { code: "slowmodeRateLimited", explanation: "The provider's channel slowmode is active" },
    GUILD_VERIFICATION_REQUIRED: {
        code: "guildVerificationRequired",
        explanation: "The provider requires guild verification for this operation",
    },
    GUILD_PHONE_VERIFICATION_REQUIRED: {
        code: "guildVerificationRequired",
        explanation: "The provider requires guild phone verification for this operation",
    },
    GUILD_EMAIL_VERIFICATION_REQUIRED: {
        code: "guildVerificationRequired",
        explanation: "The provider requires guild email verification for this operation",
    },
    BOT_ALREADY_IN_GUILD: { code: "botAlreadyInGuild", explanation: "The bot is already in the requested guild" },
    BOT_IS_PRIVATE: { code: "botIsPrivate", explanation: "The provider does not allow adding this private bot" },
    NOT_A_BOT_APPLICATION: { code: "notBotApplication", explanation: "The requested application is not a bot" },
    APPLICATION_NOT_OWNED: {
        code: "applicationNotOwned",
        explanation: "The caller does not own the requested application",
    },
    RESOURCE_LOCKED: {
        code: "resourceLocked",
        explanation: "The provider has temporarily locked the requested resource",
    },
    ACCESS_DENIED: { code: "accessDenied", explanation: "The provider denied this request" },
    BAD_REQUEST: {
        code: "badRequest",
        explanation: "The request was malformed or failed a provider precondition",
    },
    CONFLICT: { code: "conflict", explanation: "The request conflicts with the provider's current resource state" },
    FORBIDDEN: { code: "forbidden", explanation: "The provider forbids this request" },
    NOT_FOUND: { code: "notFound", explanation: "The provider could not find the requested resource" },
    RATE_LIMITED: { code: "rateLimited", explanation: "The provider rate-limited this request" },
    SERVICE_UNAVAILABLE: { code: "serviceUnavailable", explanation: "The provider service is temporarily unavailable" },
    UNAUTHORIZED: { code: "unauthorized", explanation: "The provider rejected the request credentials" },
    INVALID_TOKEN: { code: "unauthorized", explanation: "The provider rejected the request token" },
    MISSING_AUTHORIZATION: { code: "unauthorized", explanation: "The provider requires request credentials" },
    GONE: { code: "gone", explanation: "The provider reports that this resource is no longer available" },
    BAD_GATEWAY: { code: "serviceFailure", explanation: "The provider gateway returned an invalid upstream response" },
    GATEWAY_TIMEOUT: { code: "serviceFailure", explanation: "The provider gateway timed out" },
    INTERNAL_SERVER_ERROR: { code: "serviceFailure", explanation: "The provider encountered an internal error" },
    NOT_IMPLEMENTED: { code: "notImplemented", explanation: "The provider does not implement this operation" },
    CANNOT_EXECUTE_ON_DM: {
        code: "cannotExecuteOnDirectMessage",
        explanation: "The provider does not allow this operation in a direct message",
    },
    INVITES_DISABLED: { code: "invitesDisabled", explanation: "The provider has disabled invites for this guild" },
    FEATURE_NOT_AVAILABLE_SELF_HOSTED: {
        code: "featureNotAvailableSelfHosted",
        explanation: "The provider does not offer this feature on this self-hosted instance",
    },
    MAX_CATEGORY_CHANNELS: { code: "resourceLimit", explanation: "The provider's category-channel limit was reached" },
    MAX_EMOJIS: { code: "resourceLimit", explanation: "The provider's emoji limit was reached" },
    MAX_GUILD_CHANNELS: { code: "resourceLimit", explanation: "The provider's guild-channel limit was reached" },
    MAX_GUILD_MEMBERS: { code: "resourceLimit", explanation: "The provider's guild-member limit was reached" },
    MAX_GUILD_ROLES: { code: "resourceLimit", explanation: "The provider's guild-role limit was reached" },
    MAX_INVITES: { code: "resourceLimit", explanation: "The provider's guild-invite limit was reached" },
    MAX_REACTIONS: { code: "resourceLimit", explanation: "The provider's reaction limit was reached" },
    MAX_STICKERS: { code: "resourceLimit", explanation: "The provider's sticker limit was reached" },
    MAX_WEBHOOKS_PER_CHANNEL: {
        code: "resourceLimit",
        explanation: "The provider's channel-webhook limit was reached",
    },
    MAX_WEBHOOKS_PER_GUILD: { code: "resourceLimit", explanation: "The provider's guild-webhook limit was reached" },
} as const

const validationErrorMappings = {
    ATTACHMENTS_NOT_ALLOWED_FOR_MESSAGE: "Attachments are not allowed for this message",
    CANNOT_DELETE_MORE_THAN_100_MESSAGES: "The provider allows at most 100 messages in one deletion request",
    CANNOT_SEND_EMPTY_MESSAGE: "The provider requires message content, an embed, an attachment, or a sticker",
    CANNOT_SPECIFY_BOTH_BEFORE_AND_AFTER: "The provider does not allow both before and after pagination bounds",
    CONTENT_EXCEEDS_MAX_LENGTH: "Submitted text exceeds the provider limit",
    DUPLICATE_ATTACHMENT_IDS_NOT_ALLOWED: "Attachment identifiers must be unique",
    DUPLICATE_FILE_INDEX: "Attachment file indexes must be unique",
    EMBEDS_EXCEED_MAX_CHARACTERS: "Submitted embeds exceed the provider's combined text limit",
    FILE_INDEX_EXCEEDS_MAXIMUM: "An attachment file index exceeds the provider limit",
    INVALID_AUDIT_LOG_REASON: "The audit-log reason is invalid",
    INVALID_FORMAT: "A submitted value has an invalid format",
    INVALID_MESSAGE_DATA: "The submitted message data is invalid",
    INVALID_SNOWFLAKE: "A submitted identifier is invalid",
    INVALID_SNOWFLAKE_FORMAT: "A submitted identifier has an invalid format",
    MESSAGE_IDS_CANNOT_BE_EMPTY: "At least one message identifier is required",
    STRING_LENGTH_INVALID: "A submitted string has an invalid length",
    TOO_MANY_EMBEDS: "Too many embeds were submitted",
    TOO_MANY_FILES: "Too many files were submitted",
    TOO_LARGE: "Submitted data exceeds the provider limit",
    ATTACHMENT_FIELDS_REQUIRED: "Required attachment fields are missing",
    INVALID_TIMEOUT_VALUE: "The requested timeout is invalid",
    TIMEOUT_CANNOT_EXCEED_365_DAYS: "The requested timeout exceeds the provider limit",
    RECIPIENT_IDS_CANNOT_BE_EMPTY: "At least one recipient identifier is required",
    DUPLICATE_RECIPIENTS_NOT_ALLOWED: "Recipient identifiers must be unique",
    VANITY_URL_CODE_ALREADY_TAKEN: "The vanity URL code is already taken",
    VANITY_URL_CODE_LENGTH_INVALID: "The vanity URL code has an invalid length",
    VANITY_URL_INVALID_CHARACTERS: "The vanity URL code has invalid characters",
} as const

/** Safe fixed explanation for one reviewed validation code, without the provider's path or localized message */
export type ApiValidationErrorDetail = {
    readonly [ProviderCode in keyof typeof validationErrorMappings]: {
        /** Exact reviewed provider validation code */
        readonly providerCode: ProviderCode
        /** Fixed SDK explanation of the reviewed validation code */
        readonly explanation: (typeof validationErrorMappings)[ProviderCode]
    }
}[keyof typeof validationErrorMappings]

/**
 * A finite allowlist of reviewed Fluxer error codes, with the SDK's fixed explanation for each code
 *
 * These details retain an exact providerCode but never a provider response body, localized message, field path, or
 * rejected value. Validation details retain at most eight reviewed codes, excluding their paths and messages because
 * either can contain private caller data. Unknown provider codes deliberately produce null apiError.
 * These classifications apply only to Fluxer API responses, not responses from presigned upload destinations
 *
 * @example
 * ```ts
 * import type { ApiErrorDetail } from "@neontechspace/fluxerly"
 *
 * function formatApiErrorDetail(detail: ApiErrorDetail): string {
 *     return `${detail.providerCode}: ${detail.explanation}`
 * }
 * ```
 */
export type ApiErrorDetail = {
    readonly [ProviderCode in keyof typeof apiErrorMappings]: {
        /** Stable SDK category for this reviewed provider rejection */
        readonly code: (typeof apiErrorMappings)[ProviderCode]["code"]
        /** Exact reviewed Fluxer server code */
        readonly providerCode: ProviderCode
        /** Fixed SDK explanation, never the provider's localized response text */
        readonly explanation: (typeof apiErrorMappings)[ProviderCode]["explanation"]
    } & (ProviderCode extends "INVALID_FORM_BODY" | "VALIDATION_ERROR"
        ? {
              /** At most eight reviewed validation codes, without provider paths or messages */
              readonly validationErrors: readonly ApiValidationErrorDetail[]
          }
        : {})
}[keyof typeof apiErrorMappings]

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validationDetails(value: unknown): readonly ApiValidationErrorDetail[] {
    if (!Array.isArray(value)) return Object.freeze([])
    const details: ApiValidationErrorDetail[] = []
    for (const item of value) {
        if (details.length === 8 || !record(item) || typeof item.code !== "string") continue
        if (!Object.hasOwn(validationErrorMappings, item.code)) continue
        const explanation = validationErrorMappings[item.code as keyof typeof validationErrorMappings]
        details.push(Object.freeze({ providerCode: item.code, explanation }) as ApiValidationErrorDetail)
    }
    return Object.freeze(details)
}

/** Maps only reviewed provider response shapes to immutable safe SDK-owned details. Unknown codes deliberately have no classification */
export function apiErrorDetail(body: unknown): ApiErrorDetail | null {
    if (!record(body) || typeof body.code !== "string") return null
    if (!Object.hasOwn(apiErrorMappings, body.code)) return null
    const mapped = apiErrorMappings[body.code as keyof typeof apiErrorMappings]
    const detail = {
        code: mapped.code,
        providerCode: body.code,
        explanation: mapped.explanation,
        ...(body.code === "INVALID_FORM_BODY" || body.code === "VALIDATION_ERROR"
            ? { validationErrors: validationDetails(body.errors) }
            : {}),
    }
    return Object.freeze(detail) as ApiErrorDetail
}

/** Creates a safe operation-error message from SDK-owned facts without forwarding provider text or unreviewed response data */
export function operationErrorMessage(
    subject: string,
    operation: string,
    reason: string,
    outcome: string,
    status: number | null,
    apiError: ApiErrorDetail | null,
    inputExplanation: string | null,
    retryAfterMs: number | null = null,
): string {
    const fallback =
        {
            input: "Local input validation failed",
            busy: "Local request admission is full",
            network: "The request could not complete",
            notFound: "The requested resource was not found",
            rateLimit: "The provider rate-limited the request",
            rejected: "The provider rejected the request without a reviewed detail",
            response: "The provider returned an invalid response",
            timeout: "The operation deadline expired",
            tooLarge: "The response exceeded the configured byte limit",
            untrustedUrl: "The attachment URL is not trusted for this instance",
        }[reason] ?? reason
    const detail =
        apiError === null ? (inputExplanation ?? fallback) : `${apiError.providerCode}: ${apiError.explanation}`
    const validation =
        apiError !== null && "validationErrors" in apiError
            ? apiError.validationErrors.map((error) => `${error.providerCode}: ${error.explanation}`).join("; ")
            : null
    const facts = [
        validation,
        status === null ? null : `HTTP ${status}`,
        retryAfterMs === null ? null : `retry after ${retryAfterMs} ms`,
        `outcome ${outcome}`,
    ].filter((part): part is string => part !== null)
    return `${subject} operation ${operation} failed (${detail === null ? reason : `${reason}: ${detail}`}; ${facts.join(
        "; ",
    )})`
}
