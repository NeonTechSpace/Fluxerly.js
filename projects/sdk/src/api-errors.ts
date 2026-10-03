import {
    operationDetails,
    operationHint,
    type FluxerlyErrorOptions,
    type OperationErrorOptions,
    type OperationOutcome,
} from "./errors.js"
import type { InputValidationDetail } from "./input-validation.js"
import { record } from "#sdk/internal/decode/primitives"
/**
 * @internal Reviewed Fluxer codes behind ApiErrorDetail. Not part of the supported API
 *
 * @category Errors
 */
export const apiErrorMappings = {
    MISSING_ACCESS: { code: "missingAccess", explanation: "Fluxer denied access to the requested resource" },
    MISSING_PERMISSIONS: {
        code: "missingPermissions",
        explanation: "Fluxer reports that the bot lacks a required permission",
    },
    COMMUNICATION_DISABLED: {
        code: "communicationDisabled",
        explanation: "Fluxer reports that communication is disabled for this operation",
    },
    CANNOT_SEND_MESSAGES_TO_USER: {
        code: "cannotSendMessagesToUser",
        explanation: "Fluxer rejected delivery of this message to the requested user",
    },
    CANNOT_SEND_EMPTY_MESSAGE: {
        code: "cannotSendEmptyMessage",
        explanation: "Fluxer requires message content, an embed, an attachment, or a sticker",
    },
    CANNOT_MODIFY_SYSTEM_WEBHOOK: {
        code: "cannotModifySystemWebhook",
        explanation: "Fluxer does not allow modifying a system webhook",
    },
    ANNOUNCEMENT_CHANNEL_REQUIRED: {
        code: "announcementChannelRequired",
        explanation: "Fluxer requires an announcement channel for this operation",
    },
    CHANNEL_ALREADY_FOLLOWED: {
        code: "channelAlreadyFollowed",
        explanation: "The destination channel already receives updates from this announcement channel",
    },
    CHANNEL_HAS_FOLLOWED_CHANNELS: {
        code: "channelHasFollowedChannels",
        explanation: "The channel receives followed-channel updates and cannot become an announcement channel",
    },
    CHANNEL_TYPE_CONVERSION_NOT_SUPPORTED: {
        code: "channelTypeConversionNotSupported",
        explanation: "Fluxer rejected the requested channel type conversion",
    },
    FOLLOW_TARGET_CONTENT_WARNING_REQUIRED: {
        code: "followTargetContentWarningRequired",
        explanation:
            "The announcement source has a content warning but the destination has no warning or age restriction",
    },
    FOLLOW_TARGET_NOT_AGE_RESTRICTED: {
        code: "followTargetNotAgeRestricted",
        explanation: "The announcement source is age-restricted but the destination is not",
    },
    INVALID_FOLLOW_TARGET_CHANNEL: {
        code: "invalidFollowTargetChannel",
        explanation: "Fluxer requires a community text channel as the follow destination",
    },
    MESSAGE_ALREADY_CROSSPOSTED: {
        code: "messageAlreadyCrossposted",
        explanation: "The message has already been published",
    },
    MESSAGE_NOT_CROSSPOSTABLE: {
        code: "messageNotCrosspostable",
        explanation: "Fluxer cannot publish replies, system messages, forwarded messages or received crosspost copies",
    },
    MESSAGE_CROSSPOST_RATE_LIMITED: {
        code: "messageCrosspostRateLimited",
        explanation: "The announcement channel has reached its publishing rate limit",
    },
    PUBLISHED_MESSAGE_EDIT_RATE_LIMITED: {
        code: "publishedMessageEditRateLimited",
        explanation: "The published message has reached its editing rate limit",
    },
    CAPTCHA_REQUIRED: { code: "captchaRequired", explanation: "Fluxer requires CAPTCHA verification" },
    INVALID_CAPTCHA: { code: "invalidCaptcha", explanation: "Fluxer rejected the CAPTCHA verification" },
    INVALID_FORM_BODY: { code: "invalidFormBody", explanation: "Fluxer rejected one or more request fields" },
    VALIDATION_ERROR: { code: "invalidFormBody", explanation: "Fluxer rejected one or more request fields" },
    UNKNOWN_APPLICATION: { code: "unknownResource", explanation: "The requested application was not found" },
    UNKNOWN_CHANNEL: { code: "unknownResource", explanation: "The requested channel was not found" },
    UNKNOWN_EMOJI: { code: "unknownResource", explanation: "The requested emoji was not found" },
    UNKNOWN_GUILD: { code: "unknownResource", explanation: "The requested community was not found" },
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
        explanation: "Fluxer does not allow editing another user's message",
    },
    CANNOT_SEND_MESSAGES_IN_NON_TEXT_CHANNEL: {
        code: "cannotSendMessagesInNonTextChannel",
        explanation: "Fluxer does not allow messages in the requested channel type",
    },
    CONTENT_BLOCKED: { code: "contentBlocked", explanation: "Fluxer blocked the submitted content" },
    DIRECT_MESSAGES_DISABLED: {
        code: "directMessagesDisabled",
        explanation: "The recipient does not accept direct messages",
    },
    EXPLICIT_CONTENT_CANNOT_BE_SENT: {
        code: "explicitContentCannotBeSent",
        explanation: "Fluxer blocked explicit content for this delivery",
    },
    FILE_SIZE_TOO_LARGE: { code: "fileSizeTooLarge", explanation: "A submitted file exceeds Fluxer's limit" },
    FEATURE_TEMPORARILY_DISABLED: {
        code: "featureTemporarilyDisabled",
        explanation: "Fluxer has temporarily disabled this feature",
    },
    SLOWMODE_RATE_LIMITED: { code: "slowmodeRateLimited", explanation: "Fluxer's channel slowmode is active" },
    GUILD_VERIFICATION_REQUIRED: {
        code: "guildVerificationRequired",
        explanation: "Fluxer requires community verification for this operation",
    },
    GUILD_EMAIL_VERIFICATION_REQUIRED: {
        code: "guildVerificationRequired",
        explanation: "Fluxer requires community email verification for this operation",
    },
    TWO_FACTOR_REQUIRED: {
        code: "twoFactorRequired",
        explanation: "Fluxer requires two-factor authentication on the calling account for this operation",
    },
    BOT_ALREADY_IN_GUILD: { code: "botAlreadyInGuild", explanation: "The bot is already in the requested community" },
    BOT_IS_PRIVATE: { code: "botIsPrivate", explanation: "Fluxer does not allow adding this private bot" },
    NOT_A_BOT_APPLICATION: { code: "notBotApplication", explanation: "The requested application is not a bot" },
    APPLICATION_NOT_OWNED: {
        code: "applicationNotOwned",
        explanation: "The caller does not own the requested application",
    },
    RESOURCE_LOCKED: {
        code: "resourceLocked",
        explanation: "Fluxer has temporarily locked the requested resource",
    },
    ACCESS_DENIED: { code: "accessDenied", explanation: "Fluxer denied this request" },
    BAD_REQUEST: {
        code: "badRequest",
        explanation: "The request was malformed or failed a Fluxer precondition",
    },
    CONFLICT: { code: "conflict", explanation: "The request conflicts with Fluxer's current resource state" },
    FORBIDDEN: { code: "forbidden", explanation: "Fluxer forbids this request" },
    NOT_FOUND: { code: "notFound", explanation: "Fluxer could not find the requested resource" },
    RATE_LIMITED: { code: "rateLimited", explanation: "Fluxer rate-limited this request" },
    SERVICE_UNAVAILABLE: { code: "serviceUnavailable", explanation: "Fluxer service is temporarily unavailable" },
    UNAUTHORIZED: { code: "unauthorized", explanation: "Fluxer rejected the request credentials" },
    INVALID_TOKEN: { code: "unauthorized", explanation: "Fluxer rejected the request token" },
    MISSING_AUTHORIZATION: { code: "unauthorized", explanation: "Fluxer requires request credentials" },
    GONE: { code: "gone", explanation: "Fluxer reports that this resource is no longer available" },
    BAD_GATEWAY: { code: "serviceFailure", explanation: "Fluxer's gateway returned an invalid upstream response" },
    GATEWAY_TIMEOUT: { code: "serviceFailure", explanation: "Fluxer's gateway timed out" },
    INTERNAL_SERVER_ERROR: { code: "serviceFailure", explanation: "Fluxer encountered an internal error" },
    NOT_IMPLEMENTED: { code: "notImplemented", explanation: "Fluxer does not implement this operation" },
    CANNOT_EXECUTE_ON_DM: {
        code: "cannotExecuteOnDirectMessage",
        explanation: "Fluxer does not allow this operation in a direct message",
    },
    INVITES_DISABLED: { code: "invitesDisabled", explanation: "Fluxer has disabled invites for this community" },
    FEATURE_NOT_AVAILABLE_SELF_HOSTED: {
        code: "featureNotAvailableSelfHosted",
        explanation: "Fluxer does not offer this feature on this self-hosted instance",
    },
    MAX_CATEGORY_CHANNELS: { code: "resourceLimit", explanation: "Fluxer's category-channel limit was reached" },
    MAX_EMOJIS: { code: "resourceLimit", explanation: "Fluxer's emoji limit was reached" },
    MAX_GUILD_CHANNELS: { code: "resourceLimit", explanation: "Fluxer's community channel limit was reached" },
    MAX_GUILD_MEMBERS: { code: "resourceLimit", explanation: "Fluxer's community member limit was reached" },
    MAX_GUILD_ROLES: { code: "resourceLimit", explanation: "Fluxer's community role limit was reached" },
    MAX_INVITES: { code: "resourceLimit", explanation: "Fluxer's community invite limit was reached" },
    MAX_REACTIONS: { code: "resourceLimit", explanation: "Fluxer's reaction limit was reached" },
    MAX_STICKERS: { code: "resourceLimit", explanation: "Fluxer's sticker limit was reached" },
    MAX_WEBHOOKS_PER_CHANNEL: {
        code: "resourceLimit",
        explanation: "Fluxer's channel-webhook limit was reached",
    },
    MAX_WEBHOOKS_PER_GUILD: { code: "resourceLimit", explanation: "Fluxer's community webhook limit was reached" },
} as const satisfies Readonly<Record<ApiProviderCode, { readonly code: ApiErrorCode; readonly explanation: string }>>

/**
 * @internal Reviewed validation codes behind ApiValidationErrorDetail. Not part of the supported API
 *
 * @category Errors
 */
export const validationErrorMappings = {
    ATTACHMENTS_NOT_ALLOWED_FOR_MESSAGE: "Attachments are not allowed for this message",
    CANNOT_DELETE_MORE_THAN_100_MESSAGES: "Fluxer allows at most 100 messages in one deletion request",
    CANNOT_SEND_EMPTY_MESSAGE: "Fluxer requires message content, an embed, an attachment, or a sticker",
    CANNOT_SPECIFY_BOTH_BEFORE_AND_AFTER: "Fluxer does not allow both before and after pagination bounds",
    CONTENT_EXCEEDS_MAX_LENGTH: "Submitted text exceeds Fluxer's limit",
    DUPLICATE_ATTACHMENT_IDS_NOT_ALLOWED: "Attachment identifiers must be unique",
    DUPLICATE_FILE_INDEX: "Attachment file indexes must be unique",
    EMBEDS_EXCEED_MAX_CHARACTERS: "Submitted embeds exceed Fluxer's combined text limit",
    FILE_INDEX_EXCEEDS_MAXIMUM: "An attachment file index exceeds Fluxer's limit",
    INVALID_AUDIT_LOG_REASON: "The audit-log reason is invalid",
    INVALID_FORMAT: "A submitted value has an invalid format",
    INVALID_MESSAGE_DATA: "The submitted message data is invalid",
    INVALID_SNOWFLAKE: "A submitted identifier is invalid",
    INVALID_SNOWFLAKE_FORMAT: "A submitted identifier has an invalid format",
    MESSAGE_IDS_CANNOT_BE_EMPTY: "At least one message identifier is required",
    STRING_LENGTH_INVALID: "A submitted string has an invalid length",
    TOO_MANY_EMBEDS: "Too many embeds were submitted",
    TOO_MANY_FILES: "Too many files were submitted",
    TOO_LARGE: "Submitted data exceeds Fluxer's limit",
    ATTACHMENT_FIELDS_REQUIRED: "Required attachment fields are missing",
    INVALID_TIMEOUT_VALUE: "The requested timeout is invalid",
    TIMEOUT_CANNOT_EXCEED_365_DAYS: "The requested timeout exceeds Fluxer's limit",
    RECIPIENT_IDS_CANNOT_BE_EMPTY: "At least one recipient identifier is required",
    DUPLICATE_RECIPIENTS_NOT_ALLOWED: "Recipient identifiers must be unique",
    VANITY_URL_CODE_ALREADY_TAKEN: "The vanity URL code is already taken",
    VANITY_URL_CODE_LENGTH_INVALID: "The vanity URL code has an invalid length",
    VANITY_URL_INVALID_CHARACTERS: "The vanity URL code has invalid characters",
} as const satisfies Readonly<Record<ApiValidationCode, string>>

/**
 * Stable SDK category of a recognized Fluxer API rejection, read from ApiErrorDetail.code.
 * Branch on this rather than on providerCode when several server codes mean the same thing, such as every resource limit.
 * Announcement, follow, channel conversion and publishing preconditions have distinct categories. Publishing and
 * published-message editing limits are separate from the general rateLimited category
 *
 * @category Errors
 */
export type ApiErrorCode =
    | "missingAccess"
    | "missingPermissions"
    | "communicationDisabled"
    | "cannotSendMessagesToUser"
    | "cannotSendEmptyMessage"
    | "cannotModifySystemWebhook"
    | "announcementChannelRequired"
    | "channelAlreadyFollowed"
    | "channelHasFollowedChannels"
    | "channelTypeConversionNotSupported"
    | "followTargetContentWarningRequired"
    | "followTargetNotAgeRestricted"
    | "invalidFollowTargetChannel"
    | "messageAlreadyCrossposted"
    | "messageNotCrosspostable"
    | "messageCrosspostRateLimited"
    | "publishedMessageEditRateLimited"
    | "captchaRequired"
    | "invalidCaptcha"
    | "invalidFormBody"
    | "unknownResource"
    | "missingOAuthScope"
    | "cannotEditOtherUserMessage"
    | "cannotSendMessagesInNonTextChannel"
    | "contentBlocked"
    | "directMessagesDisabled"
    | "explicitContentCannotBeSent"
    | "fileSizeTooLarge"
    | "featureTemporarilyDisabled"
    | "slowmodeRateLimited"
    | "guildVerificationRequired"
    | "twoFactorRequired"
    | "botAlreadyInGuild"
    | "botIsPrivate"
    | "notBotApplication"
    | "applicationNotOwned"
    | "resourceLocked"
    | "accessDenied"
    | "badRequest"
    | "conflict"
    | "forbidden"
    | "notFound"
    | "rateLimited"
    | "serviceUnavailable"
    | "unauthorized"
    | "gone"
    | "serviceFailure"
    | "notImplemented"
    | "cannotExecuteOnDirectMessage"
    | "invitesDisabled"
    | "featureNotAvailableSelfHosted"
    | "resourceLimit"

/**
 * Exact Fluxer server code that the SDK recognizes, read from ApiErrorDetail.providerCode.
 * An unrecognized server code produces no ApiErrorDetail
 *
 * @category Errors
 */
export type ApiProviderCode =
    | "MISSING_ACCESS"
    | "MISSING_PERMISSIONS"
    | "COMMUNICATION_DISABLED"
    | "CANNOT_SEND_MESSAGES_TO_USER"
    | "CANNOT_SEND_EMPTY_MESSAGE"
    | "CANNOT_MODIFY_SYSTEM_WEBHOOK"
    | "ANNOUNCEMENT_CHANNEL_REQUIRED"
    | "CHANNEL_ALREADY_FOLLOWED"
    | "CHANNEL_HAS_FOLLOWED_CHANNELS"
    | "CHANNEL_TYPE_CONVERSION_NOT_SUPPORTED"
    | "FOLLOW_TARGET_CONTENT_WARNING_REQUIRED"
    | "FOLLOW_TARGET_NOT_AGE_RESTRICTED"
    | "INVALID_FOLLOW_TARGET_CHANNEL"
    | "MESSAGE_ALREADY_CROSSPOSTED"
    | "MESSAGE_NOT_CROSSPOSTABLE"
    | "MESSAGE_CROSSPOST_RATE_LIMITED"
    | "PUBLISHED_MESSAGE_EDIT_RATE_LIMITED"
    | "CAPTCHA_REQUIRED"
    | "INVALID_CAPTCHA"
    | "INVALID_FORM_BODY"
    | "VALIDATION_ERROR"
    | "UNKNOWN_APPLICATION"
    | "UNKNOWN_CHANNEL"
    | "UNKNOWN_EMOJI"
    | "UNKNOWN_GUILD"
    | "UNKNOWN_INVITE"
    | "UNKNOWN_MEMBER"
    | "UNKNOWN_MESSAGE"
    | "UNKNOWN_ROLE"
    | "UNKNOWN_STICKER"
    | "UNKNOWN_USER"
    | "UNKNOWN_WEBHOOK"
    | "MISSING_OAUTH_SCOPE"
    | "CANNOT_EDIT_OTHER_USER_MESSAGE"
    | "CANNOT_SEND_MESSAGES_IN_NON_TEXT_CHANNEL"
    | "CONTENT_BLOCKED"
    | "DIRECT_MESSAGES_DISABLED"
    | "EXPLICIT_CONTENT_CANNOT_BE_SENT"
    | "FILE_SIZE_TOO_LARGE"
    | "FEATURE_TEMPORARILY_DISABLED"
    | "SLOWMODE_RATE_LIMITED"
    | "GUILD_VERIFICATION_REQUIRED"
    | "GUILD_EMAIL_VERIFICATION_REQUIRED"
    | "TWO_FACTOR_REQUIRED"
    | "BOT_ALREADY_IN_GUILD"
    | "BOT_IS_PRIVATE"
    | "NOT_A_BOT_APPLICATION"
    | "APPLICATION_NOT_OWNED"
    | "RESOURCE_LOCKED"
    | "ACCESS_DENIED"
    | "BAD_REQUEST"
    | "CONFLICT"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "SERVICE_UNAVAILABLE"
    | "UNAUTHORIZED"
    | "INVALID_TOKEN"
    | "MISSING_AUTHORIZATION"
    | "GONE"
    | "BAD_GATEWAY"
    | "GATEWAY_TIMEOUT"
    | "INTERNAL_SERVER_ERROR"
    | "NOT_IMPLEMENTED"
    | "CANNOT_EXECUTE_ON_DM"
    | "INVITES_DISABLED"
    | "FEATURE_NOT_AVAILABLE_SELF_HOSTED"
    | "MAX_CATEGORY_CHANNELS"
    | "MAX_EMOJIS"
    | "MAX_GUILD_CHANNELS"
    | "MAX_GUILD_MEMBERS"
    | "MAX_GUILD_ROLES"
    | "MAX_INVITES"
    | "MAX_REACTIONS"
    | "MAX_STICKERS"
    | "MAX_WEBHOOKS_PER_CHANNEL"
    | "MAX_WEBHOOKS_PER_GUILD"

/**
 * Exact Fluxer validation code that the SDK recognizes, read from ApiValidationErrorDetail.providerCode.
 * An unrecognized validation code stays in validationErrors with a generic explanation when it has a safe code shape
 *
 * @category Errors
 */
export type ApiValidationCode =
    | "ATTACHMENTS_NOT_ALLOWED_FOR_MESSAGE"
    | "CANNOT_DELETE_MORE_THAN_100_MESSAGES"
    | "CANNOT_SEND_EMPTY_MESSAGE"
    | "CANNOT_SPECIFY_BOTH_BEFORE_AND_AFTER"
    | "CONTENT_EXCEEDS_MAX_LENGTH"
    | "DUPLICATE_ATTACHMENT_IDS_NOT_ALLOWED"
    | "DUPLICATE_FILE_INDEX"
    | "EMBEDS_EXCEED_MAX_CHARACTERS"
    | "FILE_INDEX_EXCEEDS_MAXIMUM"
    | "INVALID_AUDIT_LOG_REASON"
    | "INVALID_FORMAT"
    | "INVALID_MESSAGE_DATA"
    | "INVALID_SNOWFLAKE"
    | "INVALID_SNOWFLAKE_FORMAT"
    | "MESSAGE_IDS_CANNOT_BE_EMPTY"
    | "STRING_LENGTH_INVALID"
    | "TOO_MANY_EMBEDS"
    | "TOO_MANY_FILES"
    | "TOO_LARGE"
    | "ATTACHMENT_FIELDS_REQUIRED"
    | "INVALID_TIMEOUT_VALUE"
    | "TIMEOUT_CANNOT_EXCEED_365_DAYS"
    | "RECIPIENT_IDS_CANNOT_BE_EMPTY"
    | "DUPLICATE_RECIPIENTS_NOT_ALLOWED"
    | "VANITY_URL_CODE_ALREADY_TAKEN"
    | "VANITY_URL_CODE_LENGTH_INVALID"
    | "VANITY_URL_INVALID_CHARACTERS"

/** A validation error reported by Fluxer, with a fixed SDK explanation.
 * This is a server rejection, not a problem found by local input checks.
 * It includes the rejected field path when Fluxer supplied one, but never the rejected value or localized server message
 *
 * @category Errors
 */
export interface ApiValidationErrorDetail {
    /**
     * Fluxer validation code. A code this SDK version does not recognize is kept when it is an uppercase code of at most
     * 64 characters, with a generic explanation, so its field path is not lost
     */
    readonly providerCode: ApiValidationCode | (string & {})
    /** Fixed SDK explanation of the validation code */
    readonly explanation: string
    /** Request field path that Fluxer rejected, such as embeds.0.title, when supplied in a plain dotted form */
    readonly path?: string
}

/**
 * Safe details about a Fluxer API rejection, available in an operation error's apiError field.
 * The code is the SDK's category. The providerCode is the exact server code that the SDK recognizes.
 * The explanation is fixed SDK text, not the server's message or text to show directly to users.
 * If the SDK does not recognize the server code, apiError is null rather than containing unreviewed text, and the
 * error's details.providerCode names the unrecognized code when it is an uppercase code of at most 64 characters.
 * For form errors, validationErrors contains at most 32 validation codes with their field paths, without messages or rejected values.
 * These details never contain the response body, localized message, rejected value or private caller data.
 * Responses from presigned upload destinations do not receive this classification
 *
 * @example
 * ```ts
 * import type { ApiErrorDetail } from "@neontechspace/fluxerly"
 *
 * export function formatApiErrorDetail(detail: ApiErrorDetail): string {
 *     // Branch on the category, which groups related server codes such as every resource limit
 *     if (detail.code === "resourceLimit") return `Limit reached: ${detail.explanation}`
 *     const fields = detail.validationErrors?.map((error) => error.path ?? error.providerCode) ?? []
 *     return `${detail.providerCode}: ${detail.explanation}${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`
 * }
 * ```
 *
 * @category Errors
 */
export interface ApiErrorDetail {
    /** Stable SDK category for this recognized rejection. Several Fluxer codes can share one category */
    readonly code: ApiErrorCode
    /** Exact recognized Fluxer server code */
    readonly providerCode: ApiProviderCode
    /** Fixed SDK explanation, never Fluxer's localized response text */
    readonly explanation: string
    /**
     * Present only when code is invalidFormBody. Holds at most 32 validation codes with field paths, without Fluxer
     * messages or rejected values
     */
    readonly validationErrors?: readonly ApiValidationErrorDetail[]
}

/** Shape of a Fluxer error code that is safe to keep even when this SDK version does not describe it */
const providerCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/

function validationDetails(value: unknown): readonly ApiValidationErrorDetail[] {
    if (!Array.isArray(value)) return Object.freeze([])
    const details: ApiValidationErrorDetail[] = []
    for (const item of value) {
        if (details.length === 32 || !record(item) || typeof item.code !== "string") continue
        const known = Object.hasOwn(validationErrorMappings, item.code)
        if (!known && !providerCodePattern.test(item.code)) continue
        const explanation = known
            ? validationErrorMappings[item.code as keyof typeof validationErrorMappings]
            : "Fluxer rejected this field with a code that this SDK version does not describe"
        const path =
            typeof item.path === "string" &&
            /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d{1,4})){0,8}$/.test(item.path)
                ? item.path
                : undefined
        details.push(
            Object.freeze({
                providerCode: item.code,
                explanation,
                ...(path === undefined ? {} : { path }),
            }),
        )
    }
    return Object.freeze(details)
}

/** Return frozen, SDK-written details only for recognized Fluxer response codes. Return null for unknown codes */
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

/** @internal A Fluxer error code that apiErrorDetail does not recognize but that is safe to show, or null */
export function unrecognizedProviderCode(body: unknown): string | null {
    if (!record(body) || typeof body.code !== "string" || Object.hasOwn(apiErrorMappings, body.code)) return null
    return providerCodePattern.test(body.code) ? body.code : null
}

/**
 * @internal Suggested fixes by API error category. The rejection's explanation says what Fluxer refused, and this text
 * says what to change. Categories without an actionable fix have no entry
 */
const apiErrorHints: Readonly<Partial<Record<ApiErrorCode, string>>> = {
    missingPermissions:
        "Grant the bot's role the permission this operation needs in the community settings or the channel's permission overrides",
    missingAccess:
        "Give the bot's role View Channel for this channel or its category, and check that the bot is still in the community",
    unknownResource: "Check the ID. The resource may be deleted or not visible to this bot",
    notFound: "Check the ID. The resource may be deleted or not visible to this bot",
    unauthorized:
        "Check the configured credential. A valid bot token can also be rejected when the application owner's account is closed or disabled. For OAuth, check whether the authorizing user's account is closed or temporarily banned. A new token does not fix an account-standing rejection. The rejection alone does not identify the cause",
    invalidFormBody:
        "Correct the fields named in the message. The error's apiError.validationErrors lists them as data",
    cannotSendMessagesToUser: "The user does not accept direct messages from this bot, so retrying does not help",
    directMessagesDisabled: "The user does not accept direct messages from this bot, so retrying does not help",
    cannotSendEmptyMessage: "Include content, an embed, an attachment or a sticker",
    announcementChannelRequired: "Use an announcement channel as the source of this operation",
    channelAlreadyFollowed: "Keep the existing follow or choose a destination that does not already follow this source",
    channelHasFollowedChannels: "Remove the channel-follower webhooks from this channel before converting it",
    channelTypeConversionNotSupported:
        "Convert only between community text and announcement channels, using the channel's current type as the source",
    followTargetContentWarningRequired:
        "Use a destination with a content warning or an age restriction, including inherited category or community settings",
    followTargetNotAgeRestricted:
        "Use an age-restricted destination, including inherited category or community settings",
    invalidFollowTargetChannel: "Use a community text channel as the follow destination",
    messageAlreadyCrossposted: "Edit the source message to update its published copies instead of publishing it again",
    messageNotCrosspostable:
        "Publish an ordinary source message rather than a reply, forwarded message or received crosspost copy",
    messageCrosspostRateLimited: "Wait at least retryAfterMs before publishing another message in this channel",
    publishedMessageEditRateLimited: "Wait at least retryAfterMs before editing this published message again",
    cannotSendMessagesInNonTextChannel: "Send the message to a text channel",
    cannotEditOtherUserMessage: "Only messages that the bot sent can be edited",
    twoFactorRequired: "The application owner's account needs two-factor authentication enabled for this operation",
    slowmodeRateLimited: "Wait for the channel's slowmode interval before sending again",
    resourceLimit: "Remove unused items before creating more. Fluxer sets this limit",
    missingOAuthScope: "Request the missing scope when the user authorizes the application",
    fileSizeTooLarge: "Send a smaller file",
    serviceUnavailable: "Fluxer had a temporary problem. Retry later",
    serviceFailure: "Fluxer had a temporary problem. Retry later",
    featureTemporarilyDisabled: "Retry later",
    resourceLocked: "Retry later",
    cannotExecuteOnDirectMessage: "Use this operation in a community channel",
}

/** Suggested fixes for the standard OAuth error codes that the SDK keeps in oauthError */
const oauthErrorHints: Readonly<Record<string, string>> = {
    invalid_grant:
        "Check the authorization code or refresh token for expiry, prior use and the correct redirect URI. Also check whether the authorizing user's account is closed or temporarily banned. A new token or repeated authorization does not fix an account-standing rejection. The rejection alone does not identify the cause",
    invalid_client: "Check the configured OAuth client ID and client secret",
    invalid_request: "Check the request parameters, such as the code and redirectUri",
    invalid_scope: "Request only scopes that the application may use",
    unauthorized_client: "This application may not use this grant type. Check its OAuth settings",
    unsupported_grant_type: "Use a grant type that Fluxer supports",
}

/** The suggested fix for a standard OAuth error code, when the SDK has one */
function oauthErrorHint(oauthError: string | null): string | undefined {
    return oauthError !== null && Object.hasOwn(oauthErrorHints, oauthError) ? oauthErrorHints[oauthError] : undefined
}

/** Suggested fixes for rejections without a recognized code, by HTTP status */
const statusHints: Readonly<Record<number, string | undefined>> = {
    401: apiErrorHints.unauthorized,
    403: "Check the bot's permissions and role position for this resource",
    404: apiErrorHints.unknownResource,
}

/**
 * @internal The credential a request sent: The bot token, a webhook token, the OAuth client ID and secret, or an OAuth
 * user access token. A rejected credential needs a different fix for each
 */
export type RequestCredential = "bot" | "webhook" | "oauthClient" | "oauthUser"

/** Suggested fixes for a rejected credential other than the bot token */
const credentialHints: Readonly<Record<Exclude<RequestCredential, "bot">, string>> = {
    webhook: "Check the webhook ID and token, or recreate the webhook and use its new token",
    oauthClient: "Check the configured OAuth client ID and client secret",
    oauthUser: "Refresh the user's access token, or ask the user to authorize the application again",
}

/** @internal What a rejected request tried to do, so a missing-permission hint names what that action needs */
export type RequestAction = "message" | "moderation" | "other"

/** Missing-permission fixes for actions whose needs are known */
const missingPermissionHints: Readonly<Record<Exclude<RequestAction, "other">, string>> = {
    message:
        "Grant the bot's role View Channel and Send Messages in this channel, plus Embed Links or Attach Files when the message has them, in the community settings or the channel's permission overrides",
    moderation:
        "Grant the bot's role the permission this operation needs in the community settings, and move the bot's highest role above the highest role of the member it acts on",
}

/** @internal The action of a REST route template, such as /channels/:id/messages or /guilds/:id/bans/:id */
export function routeAction(template: string): RequestAction {
    if (/\/(members|bans|roles)(\/|$)/.test(template)) return "moderation"
    if (/\/messages(\/|$)/.test(template)) return "message"
    return "other"
}

/** The action of a failed operation, from its error code prefix such as message.send and its operation name */
function operationAction(prefix: string, operation: string): RequestAction {
    if (prefix === "message" || prefix.startsWith("message.") || operation === "directMessages.send") return "message"
    if (/^(members|roles)\./.test(operation)) return "moderation"
    return "other"
}

/**
 * @internal The suggested fix for a Fluxer rejection, from its recognized category or else its HTTP status.
 * A rejected credential is described for the credential the request sent, which defaults to the bot token, and a
 * missing permission for the action the request tried
 */
export function apiErrorHint(
    apiError: ApiErrorDetail | null,
    status: number | null,
    credential: RequestCredential = "bot",
    action: RequestAction = "other",
): string | undefined {
    if (credential !== "bot" && (apiError === null ? status === 401 : apiError.code === "unauthorized"))
        return credentialHints[credential]
    if (apiError?.code === "missingPermissions" && action !== "other") return missingPermissionHints[action]
    const categoryHint = apiError === null ? undefined : apiErrorHints[apiError.code]
    return categoryHint ?? (status === null ? undefined : statusHints[status])
}

/** @internal Safe response facts that extend an operation-error message */
export interface OperationMessageFacts {
    /** Unrecognized Fluxer error code that matched the safe code shape */
    readonly providerCode?: string | null | undefined
    /** Response field path or named check that failed, for reason response */
    readonly responseField?: string | null | undefined
    /** Whether the request only read data, so an unknown outcome needs no mention */
    readonly read?: boolean | undefined
}

/** What each failure reason means when neither Fluxer nor local validation supplied a more specific explanation */
const reasonExplanations: Readonly<Record<string, string>> = {
    input: "The input is invalid",
    busy: "Too many requests of this kind are already pending in this client",
    network: "A network error interrupted the request",
    notFound: "Fluxer could not find the requested resource",
    rateLimit: "Fluxer rate-limited the request, and the SDK could not wait and retry it",
    rejected: "Fluxer rejected the request",
    response: "Fluxer's answer did not have the expected format",
    timeout: "The operation did not finish within its timeout",
    tooLarge: "The response is larger than the maxBytes limit",
    untrustedUrl: "The attachment URL is not on this Fluxer instance's media host",
    notConnected: "The client is not connected to the gateway for this community",
    connectionLost: "The gateway connection was lost before Fluxer answered",
    overflow: "Unread member batches exceeded the maxPendingBytes limit",
    filter: "The selection filter threw or returned a value that is not a boolean",
    closed: "The client shut down",
}

/** Readable text for the named response checks, which are not field paths */
const responseChecks: Readonly<Record<string, string>> = {
    body: "The response body has the wrong type",
    tooMany: "It returned more items than requested",
    order: "Its items are out of order",
    channelMismatch: "The returned message belongs to a different channel",
    idMismatch: "The returned message has a different ID",
}

/** @internal Describe the response field path or named check that failed, for messages and log records */
export function responseFieldText(responseField: string): string {
    return Object.hasOwn(responseChecks, responseField)
        ? (responseChecks[responseField] as string)
        : `Field ${responseField} is missing or has the wrong type`
}

/**
 * Build an operation-error message from SDK-written facts, without copying server text or unreviewed response data.
 * The message leads with the failed operation and what happened, puts Fluxer's code, the HTTP status and the retry wait
 * in parentheses, then lists rejected fields and says when a write may have been applied
 */
export function operationErrorMessage(input: {
    /** Resource or workflow named first, such as "Message cleanup" */
    readonly subject: string
    readonly operation: string
    readonly reason: string
    readonly outcome: string
    readonly status?: number | null
    readonly apiError?: ApiErrorDetail | null
    /** Explanation of a local input rejection, used when Fluxer supplied no detail */
    readonly inputExplanation?: string | null
    readonly retryAfterMs?: number | null
    readonly facts?: OperationMessageFacts
}): string {
    const { subject, operation, reason, outcome, facts = {} } = input
    const status = input.status ?? null
    const apiError = input.apiError ?? null
    const inputExplanation = input.inputExplanation ?? null
    const retryAfterMs = input.retryAfterMs ?? null
    const fallback = reasonExplanations[reason] ?? `The operation failed with reason ${reason}`
    const providerCode = facts.providerCode ?? null
    const responseField = facts.responseField ?? null
    const detail =
        apiError !== null && reason !== "rateLimit"
            ? apiError.explanation
            : providerCode !== null
              ? `Fluxer returned ${providerCode}, a code this SDK version does not describe yet`
              : reason === "response" && responseField !== null
                ? `${fallback}. ${responseFieldText(responseField)}`
                : (inputExplanation ?? fallback)
    const validation = (apiError?.validationErrors ?? []).map((error) => {
        const text = Object.hasOwn(validationErrorMappings, error.providerCode)
            ? `${error.explanation} (${error.providerCode})`
            : `Fluxer returned ${error.providerCode}, a code this SDK version does not describe yet`
        return error.path === undefined ? text : `Field ${error.path}: ${text}`
    })
    const parts = [
        apiError?.providerCode ?? null,
        status === null ? null : `HTTP ${status}`,
        retryAfterMs === null ? null : `retry after ${retryAfterMs} ms`,
    ].filter((part): part is string => part !== null && part !== "")
    const label = operation.includes(".") ? `${subject} operation ${operation}` : `${subject} ${operation}`
    return [
        `${label} failed: ${detail}${parts.length ? ` (${parts.join(", ")})` : ""}`,
        ...validation,
        ...(outcome === "unknown" && facts.read !== true ? ["The change may still have been applied"] : []),
    ].join(". ")
}

/**
 * @internal The suggested next step for an operation failure: A possibly applied write first, then Fluxer's rejection
 * category or HTTP status, then the failure reason. An input failure names the rejected path when known
 */
export function operationFailureHint(input: {
    readonly reason: string
    readonly outcome: string
    readonly status?: number | null
    readonly retryAfterMs?: number | null
    readonly apiError?: ApiErrorDetail | null
    readonly read?: boolean
    readonly inputPath?: string | null | undefined
    readonly oauthError?: string | null
    readonly credential?: RequestCredential
    readonly action?: RequestAction
}): string | undefined {
    const { reason, outcome } = input
    const read = input.read === true
    const general = operationHint(reason, outcome, input.retryAfterMs ?? null, read)
    if (reason === "rateLimit" || (outcome === "unknown" && !read)) return general
    if (reason === "rejected" || reason === "notFound")
        return (
            oauthErrorHint(input.oauthError ?? null) ??
            apiErrorHint(input.apiError ?? null, input.status ?? null, input.credential, input.action) ??
            (reason === "notFound" ? apiErrorHints.unknownResource : undefined)
        )
    if (reason === "input" && input.inputPath) return `Correct ${input.inputPath}. Nothing was sent to Fluxer`
    return general
}

/** @internal Normalized operation-error fields with null defaults */
export interface OperationErrorFields<
    Operation extends string,
    Reason extends string,
    Outcome extends string = OperationOutcome,
> {
    readonly operation: Operation
    readonly reason: Reason
    readonly outcome: Outcome
    readonly status: number | null
    readonly retryAfterMs: number | null
    readonly apiError: ApiErrorDetail | null
    readonly inputValidation: InputValidationDetail | null
    readonly read: boolean
    readonly providerCode: string | null
    readonly responseField: string | null
}

/**
 * @internal Facts a composed operation keeps when it reports a failed step under its own operation name: The
 * unrecognized Fluxer code, the failing response field, the read marker and the step's error as the cause
 */
export function composedStepFacts(error: {
    readonly details: Readonly<Record<string, unknown>>
}): Pick<OperationErrorOptions<string>, "providerCode" | "responseField" | "read" | "cause"> {
    const { providerCode, responseField, read } = error.details
    return {
        providerCode: typeof providerCode === "string" ? providerCode : null,
        responseField: typeof responseField === "string" ? responseField : null,
        read: read === true,
        cause: error,
    }
}

/** @internal An unrecognized Fluxer code with the safe shape, or null. A recognized apiError wins over it */
export function safeProviderCode(apiError: ApiErrorDetail | null, providerCode: string | null): string | null {
    return apiError === null && providerCode !== null && providerCodePattern.test(providerCode) ? providerCode : null
}

/** @internal A response field path or check name with the safe shape, or null */
export function safeResponseField(responseField: string | null): string | null {
    return responseField !== null && /^[A-Za-z0-9_.]{1,128}$/.test(responseField) ? responseField : null
}

/** @internal Apply null defaults to operation-error options, keeping only safe code and field shapes */
export function operationErrorFields<Operation extends string, Reason extends string>(
    options: OperationErrorOptions<Operation, Reason>,
): OperationErrorFields<Operation, Reason> {
    const apiError = options.apiError ?? null
    const providerCode = options.providerCode ?? null
    const responseField = options.responseField ?? null
    return {
        operation: options.operation,
        reason: options.reason,
        outcome: options.outcome,
        status: options.status ?? null,
        retryAfterMs: options.retryAfterMs ?? null,
        apiError,
        inputValidation: options.inputValidation ?? null,
        read: options.read === true,
        providerCode: safeProviderCode(apiError, providerCode),
        responseField: safeResponseField(responseField),
    }
}

/** @internal The readable message for a resource operation error */
export function operationErrorText(subject: string, fields: OperationErrorFields<string, string, string>): string {
    return operationErrorMessage({
        subject,
        operation: fields.operation,
        reason: fields.reason,
        outcome: fields.outcome,
        status: fields.status,
        apiError: fields.apiError,
        inputExplanation: fields.inputValidation?.explanation ?? null,
        retryAfterMs: fields.retryAfterMs,
        facts: fields,
    })
}

/** @internal Code, hint, cause and safe details for a resource operation error */
export function operationErrorSettings(
    prefix: string,
    fields: OperationErrorFields<string, string, string>,
    cause: unknown,
    credential: RequestCredential = "bot",
): FluxerlyErrorOptions {
    return {
        code: `${prefix}.${fields.reason}`,
        hint: operationFailureHint({
            ...fields,
            inputPath: fields.inputValidation?.path ?? null,
            credential,
            action: operationAction(prefix, fields.operation),
        }),
        cause,
        details: operationDetails({
            operation: fields.operation,
            reason: fields.reason,
            outcome: fields.outcome,
            status: fields.status,
            retryAfterMs: fields.retryAfterMs,
            apiError: fields.apiError?.providerCode,
            providerCode: fields.providerCode,
            responseField: fields.responseField,
            inputPath: fields.inputValidation?.path,
            read: fields.read || undefined,
        }),
    }
}
