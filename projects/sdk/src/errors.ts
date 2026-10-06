import type { ApiErrorDetail } from "./api-errors.js"
import type { InputValidationDetail } from "./input-validation.js"
import { CloseCode, closeCodeInfo } from "#sdk/internal/protocol/gateway"
import { describeValue, errorSummary, maskText } from "#sdk/internal/masking"

/**
 * Settings shared by SDK error constructors
 *
 * @category Errors
 */
export interface FluxerlyErrorOptions {
    /** Stable dotted identifier for this failure, such as configuration.invalid or guild.rateLimit */
    readonly code: string
    /** Actionable next step for a person reading the error, when the SDK can suggest one */
    readonly hint?: string | undefined
    /** Underlying failure, exposed as the standard ES2022 cause property */
    readonly cause?: unknown
    /** Safe structured facts about the failure, without credentials or private payloads */
    readonly details?: Readonly<Record<string, unknown>> | undefined
}

/**
 * The JSON form of an SDK error, produced by toJSON. Credential patterns are masked in error names and messages,
 * including summarized causes. SDK codes remain fixed identifiers
 *
 * @category Errors
 */
export interface FluxerlyErrorJson {
    /** Error class discriminator, such as GuildOperationError */
    readonly _tag: string
    /** Error name, normally equal to _tag */
    readonly name: string
    /** Stable dotted failure code */
    readonly code: string
    /** Human-readable message */
    readonly message: string
    /** Actionable next step, when available */
    readonly hint?: string
    /** Safe structured facts about the failure */
    readonly details: Readonly<Record<string, unknown>>
    /** Summary of the underlying cause, when one was retained */
    readonly cause?:
        | FluxerlyErrorJson
        | {
              /** Name of a non-SDK cause, or Non-Error value (string) and similar for a cause that is not an Error */
              readonly name: string
              /** Message of a non-SDK cause, or its text form when it is not an Error */
              readonly message: string
          }
}

function causeJson(cause: unknown, depth: number): NonNullable<FluxerlyErrorJson["cause"]> {
    try {
        if (cause instanceof FluxerlyError && depth < 5) return errorJson(cause, depth + 1)
        if (cause instanceof Error)
            return { name: maskText(String(cause.name)), message: maskText(String(cause.message)) }
    } catch {
        // allow-silent: an Error whose name or message getters throw is summarized by the guarded fallback below
    }
    return {
        name: `Non-Error value (${cause === null ? "null" : typeof cause})`,
        message: maskText(describeValue(cause)),
    }
}

function errorJson(error: FluxerlyError, depth: number): FluxerlyErrorJson {
    return {
        _tag: error._tag,
        name: maskText(error.name),
        code: error.code,
        message: maskText(error.message),
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        details: error.details,
        ...(error.cause === undefined ? {} : { cause: causeJson(error.cause, depth) }),
    }
}

/**
 * Base class for every error the SDK returns, throws or reports, in both entry points.
 * Narrow a specific failure with its readonly _tag, read code for a stable identifier and hint for a suggested fix.
 * The standard cause property keeps the underlying failure when the SDK retained one, and details holds safe structured facts.
 * Messages the SDK writes and details never include tokens or other credentials.
 * ApplicationError and SdkDefect messages quote application-supplied error text with credential patterns masked, while
 * the cause property keeps the original value unchanged.
 * Use describeError for a readable multi-line summary, and toJSON for a structured summary whose names and messages,
 * including those in the cause chain, have credential patterns masked. Built-in JSON log output uses the LogRecord shape instead
 *
 * @category Errors
 */
export abstract class FluxerlyError extends Error {
    /** Discriminator that identifies the concrete error class */
    abstract readonly _tag: string
    /** Stable dotted identifier for this failure, suitable for alerts and metrics */
    readonly code: string
    /** Actionable next step for a person reading the error, or undefined when the SDK has no suggestion */
    readonly hint: string | undefined
    /** Frozen safe structured facts about the failure, without credentials or private payloads */
    readonly details: Readonly<Record<string, unknown>>

    constructor(message: string, options: FluxerlyErrorOptions) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause })
        this.code = options.code
        this.hint = options.hint
        this.details = Object.freeze({ ...options.details })
    }

    /** Return a plain JSON-safe summary with tag, code, message, hint, details and a summarized cause chain.
     * Credential patterns in names and messages are masked, while the original cause remains unchanged
     */
    toJSON(): FluxerlyErrorJson {
        return errorJson(this, 0)
    }
}

/**
 * Whether a request may have reached Fluxer.
 * The outcome notDispatched means it was not sent, rejected means Fluxer refused it, and unknown means the result is uncertain.
 * A write with an unknown outcome may already have applied, so reconcile remote state before repeating it.
 * A read with an unknown outcome cannot have changed remote state and is safe to repeat.
 * A rejection does not prove rollback
 *
 * @category Errors
 */
export type OperationOutcome = "notDispatched" | "rejected" | "unknown"

/**
 * Why a remote operation failed.
 * The reason input means local validation failed, busy means local request capacity was full, and notFound means HTTP 404.
 * A 404 does not prove that an earlier deletion succeeded.
 * The reason rejected is another API rejection, network is a transport failure, response means unusable success data,
 * timeout means the deadline expired, and rateLimit means the wait Fluxer required could not be completed.
 * HTTP failures keep their status, never their response bodies
 *
 * @category Errors
 */
export type OperationReason =
    "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit"

/**
 * Constructor settings shared by resource operation errors, such as GuildOperationError and MessageOperationError
 *
 * @category Errors
 */
export interface OperationErrorOptions<Operation extends string, Reason extends string = OperationReason> {
    /** The failed step */
    readonly operation: Operation
    /** Failure category */
    readonly reason: Reason
    /** Whether the request may have reached Fluxer */
    readonly outcome: OperationOutcome
    /** HTTP status when available. Defaults to null */
    readonly status?: number | null | undefined
    /** Usable server-required retry wait in milliseconds. Defaults to null */
    readonly retryAfterMs?: number | null | undefined
    /** Safe classification of a Fluxer rejection. Defaults to null */
    readonly apiError?: ApiErrorDetail | null | undefined
    /** Safe explanation of locally invalid input. Defaults to null */
    readonly inputValidation?: InputValidationDetail | null | undefined
    /**
     * Fluxer error code that this SDK version does not recognize, recorded as details.providerCode and named in the
     * message. Kept only when apiError is null and the code is an uppercase code of at most 64 characters. Defaults to null
     */
    readonly providerCode?: string | null | undefined
    /**
     * For reason response, the response field path or named check that failed, such as type or channelMismatch.
     * Recorded as details.responseField and named in the message. Defaults to null
     */
    readonly responseField?: string | null | undefined
    /** Whether the failed request only read data, so even an unknown outcome cannot have changed remote state.
     * A read is recorded as details.read and keeps network and timeout failures retryable. Defaults to false
     */
    readonly read?: boolean | undefined
    /** Underlying failure retained as the error's cause */
    readonly cause?: unknown
}

/**
 * @internal Suggest the next step for an operation failure from its reason, outcome and retry wait.
 * Rejections are left to apiErrorHint, which knows Fluxer's code and the HTTP status
 */
export function operationHint(
    reason: string,
    outcome: string,
    retryAfterMs: number | null,
    read = false,
): string | undefined {
    if (reason === "rateLimit")
        return retryAfterMs === null
            ? "Fluxer rate-limited this request. Wait before retrying"
            : `Fluxer rate-limited this request. Wait at least ${retryAfterMs} ms before retrying`
    if (outcome === "unknown" && !read) return "Check whether Fluxer applied the change before repeating it"
    return reasonHints[reason]
}

/** Next steps for failure reasons that need no knowledge of Fluxer's answer */
const reasonHints: Readonly<Record<string, string | undefined>> = {
    busy: "Wait for pending requests to finish, then retry",
    input: "Correct the input named by inputValidation.path. Nothing was sent to Fluxer",
    network: "Check network access to Fluxer, then retry",
    timeout: "Retry, or pass a larger timeoutMs",
    notConnected: "Connect the client and wait until it is ready before calling this",
    connectionLost: "Retry after the shard reconnects",
    response:
        "Fluxer's answer changed shape, or a test fixture is wrong. Check the fixture, or report the field named in details.responseField",
    tooLarge: "Raise maxBytes if the attachment is expected to be this large",
    untrustedUrl: "Pass an attachment URL received from this client's Fluxer instance",
    overflow: "Read the batches faster, or raise maxPendingBytes",
    filter: "Make the filter return true or false without throwing",
}

/** @internal Build the frozen details shared by resource operation errors */
export function operationDetails(fields: Record<string, unknown>): Record<string, unknown> {
    const details: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) if (value !== null && value !== undefined) details[key] = value
    return details
}

/** A client setting or operation option is invalid before the requested work starts.
 * Use field to identify the setting without exposing its rejected value
 *
 * @category Errors
 */
export class ConfigurationError extends FluxerlyError {
    /** Discriminator for narrowing a local configuration failure */
    readonly _tag = "ConfigurationError"

    constructor(
        /** The invalid option or containing object, including unsupported cache keys, without its rejected value */
        readonly field:
            | "configuration"
            | "instance"
            | "logging"
            | "level"
            | "categories"
            | "debug"
            | "format"
            | "sink"
            | "dedupe"
            | "unsafe"
            | "gateway"
            | "onMalformedDispatch"
            | "overflow"
            | "childOutput"
            | "token"
            | "connection"
            | "sharding"
            | "totalShards"
            | "shardIds"
            | "startupTimeoutMs"
            | "maxStartupAttempts"
            | "event"
            | "handler"
            | "eventOptions"
            | "concurrency"
            | "partition"
            | "maxPendingMessages"
            | "maxPendingBytes"
            | "onError"
            | "observe"
            | "cache"
            | "uploads"
            | "messages"
            | "guilds"
            | "members"
            | "roles"
            | "emojis"
            | "stickers"
            | "channels"
            | "users"
            | "directMessages"
            | "maxEntries"
            | "maxBytes"
            | "maxAgeMs"
            | "kind"
            | "limit"
            | "collectorOptions"
            | "channelId"
            | "guildId"
            | "filter"
            | "onReaction"
            | "onMessage"
            | "emoji"
            | "signal"
            | "maxMessages"
            | "maxReactions"
            | "message"
            | "timeoutMs"
            | "idleMs"
            | "messageFields"
            | "commands"
            | "help"
            | "prefix"
            | "parser"
            | "command"
            | "aliases"
            | "cooldown"
            | "supervisor"
            | "assignments"
            | "childId"
            | "entry"
            | "restart"
            | "maxAttempts"
            | "minDelayMs"
            | "maxDelayMs"
            | "identify"
            | "minimumSpacingMs"
            | "processes"
            | "shardsPerProcess"
            | "diagnosticsIntervalMs"
            | "shutdownTimeoutMs"
            | "drainMs"
            | "childEnvironment"
            | "args"
            | "execArgv"
            | "ignoredEvents"
            | "flags"
            | "presence"
            | "sessions"
            | "recovery"
            | "attemptTimeoutMs"
            | "healthyResetMs"
            | "schedule"
            | "rest"
            | "transport"
            | "mediaConcurrency"
            | "maxQueued"
            | "queuedJsonMaxBytes"
            | "defaultTimeoutMs"
            | "fetch"
            | "webSocket"
            | "userAgent"
            | "middleware"
            | "listener"
            | "next"
            | "embedField",
        /** Explanation of the accepted setting, without its rejected value */
        message: string,
        /** Optional suggested fix and underlying cause */
        options?: { readonly hint?: string | undefined; readonly cause?: unknown },
    ) {
        super(message, {
            code: "configuration.invalid",
            hint: options?.hint,
            cause: options?.cause,
            details: { field },
        })
        this.name = "ConfigurationError"
    }
}

/** Identifies the default API call during which an SdkDefect was observed.
 * This attribution does not establish whether a dispatched server mutation took effect or was rolled back
 *
 * @category Errors
 */
export type Operation =
    | "attachments.download"
    | "attachments.stream"
    | import("./attachments.js").AttachmentRefreshOperation
    | "instance.resolve"
    | "presence.set"
    | "presence.setMembers"
    | "cache.entries"
    | "users.getSelf"
    | "directMessages.send"
    | import("./application.js").BotApplicationOperation
    | "oauth.create"
    | import("./oauth.js").OAuthOperation
    | import("./counts.js").CountOperation
    | "members.iterateChunks"
    | import("./users.js").UserOperation
    | import("./webhooks.js").WebhookOperation
    | "createWebhookClient"
    | import("./channels.js").ChannelOperation
    | import("./guilds.js").GuildOperation
    | import("./rest.js").RestOperation
    | "gateway.send"
    | "cache.onChange"
    | import("./pagination.js").PaginationOperation
    | "createClient"
    | "supervisor.create"
    | "supervisor.start"
    | "supervisor.waitForClose"
    | "supervisor.waitForReady"
    | "supervisor.shutdown"
    | "supervisor.child.run"
    | "commands"
    | "connect"
    | "run"
    | "runBot"
    | "waitForClose"
    | "waitFor"
    | "shutdown"
    | "on"
    | "subscribe"
    | "next"
    | "send"
    | "forward"
    | "reply"
    | "typing"
    | "keepTyping"
    | "fetch"
    | "publish"
    | "fetchCrosspostSource"
    | "messages.get"
    | "fetchHistory"
    | "previewCleanup"
    | "search"
    | "fetchReactionUsers"
    | "pin"
    | "unpin"
    | "fetchPins"
    | "addReaction"
    | "removeReaction"
    | "removeUserReaction"
    | "clearReaction"
    | "clearReactions"
    | "edit"
    | "delete"
    | "deleteAttachment"
    | "deleteMany"
    | "deleteOwnMessages"
    | "cleanup"
    | "subscription.waitForClose"
    | "collect"
    | "collector.result"
    | "collectReactions"
    | "reactionCollector.result"

/** Fluxer rejected the bot token during connection startup or recovery.
 * Check the token and the application owner's account standing before connecting again.
 * A closed or disabled owner account can cause rejection of a valid token, and a new token does not fix that account standing.
 * The rejection alone does not identify the cause. The SDK does not retry this rejection unchanged
 *
 * @category Errors
 */
export class AuthenticationError extends FluxerlyError {
    /** Discriminator for identifying a rejected bot credential */
    readonly _tag = "AuthenticationError"
    constructor() {
        super("Fluxer rejected the bot token", {
            code: "auth.rejected",
            hint: "Check the whole bot token and the application owner's account standing. A valid token can be rejected if that account is closed or disabled, which a new token cannot fix. The rejection alone does not identify the cause. The SDK does not retry it",
        })
        this.name = this._tag
    }
}

/** Instance discovery or the gateway connection failed.
 * Inspect phase, reason and status to distinguish network failure, invalid protocol data and gateway closure.
 * The message includes a reviewed Fluxer close-code explanation when available, but no Fluxer response body or close-reason text.
 * An explanation does not establish whether the session can resume or whether the SDK will retry.
 * Local gateway receive-limit and UTF-8 failures use reason protocol and status 1009 and 1007 respectively.
 * These failures and binary frames do not retry automatically. No rejected payload is retained.
 * Other invalid gateway data, such as a frame that is not JSON or a sequence that goes backwards, is retried with a new
 * session. Three such failures in a row without a healthy connection between them end the shard with reason protocol.
 * Protocol failures name the violated opcode, dispatch type or field path in details when the SDK identified one
 *
 * @category Errors
 */
export class ConnectionError extends FluxerlyError {
    /** Discriminator for identifying an expected discovery or gateway connection failure */
    readonly _tag = "ConnectionError"
    constructor(
        /** The transport stage that failed */
        readonly phase: "discovery" | "gateway",
        /** Network failure, invalid protocol data, or a closed gateway connection */
        readonly reason: "network" | "protocol" | "closed",
        /** HTTP status during discovery or WebSocket close code at the gateway, including local receive rejection, or null when unavailable */
        readonly status: number | null = null,
        /** Optional protocol facts and underlying transport cause */
        options?: {
            /** Safe protocol facts such as opcode, dispatch type, field path or transport error code */
            readonly details?: Readonly<Record<string, string | number | boolean>> | undefined
            readonly cause?: unknown
            readonly hint?: string | undefined
        },
    ) {
        super(connectionErrorMessage(phase, reason, status, options?.details?.detail), {
            code: `connection.${phase}.${reason}`,
            hint:
                options?.hint ??
                (status === CloseCode.authenticationFailed
                    ? "Check the whole bot token and the application owner's account standing. A valid token can be rejected if that account is closed or disabled, which a new token cannot fix. The rejection alone does not identify the cause. The SDK does not retry it"
                    : status === CloseCode.shardingRequired
                      ? 'Set sharding to "auto", or configure sharding with a larger totalShards'
                      : status === CloseCode.invalidShard
                        ? "Check the configured shard IDs and total shard count"
                        : reason === "network"
                          ? "Check network access to the Fluxer instance"
                          : undefined),
            cause: options?.cause,
            details: { phase, reason, ...(status === null ? {} : { status }), ...options?.details },
        })
        this.name = this._tag
    }
}

/** What went wrong, then the close code or HTTP status in parentheses */
function connectionErrorMessage(
    phase: "discovery" | "gateway",
    reason: "network" | "protocol" | "closed",
    status: number | null,
    detail: string | number | boolean | undefined,
): string {
    const known = phase === "gateway" && status !== null ? closeCodeInfo(status) : undefined
    const specific = detail === undefined ? undefined : String(detail)
    const general =
        phase === "discovery"
            ? {
                  network:
                      status === null
                          ? "The instance could not be reached"
                          : "The instance answered with an error status",
                  protocol:
                      status !== null && status >= 300 && status < 400
                          ? "The instance redirected too often or to an unusable location"
                          : "The instance returned an unusable discovery document",
                  closed: "The client shut down before discovery finished",
              }[reason]
            : {
                  network: "A network error interrupted the gateway connection",
                  protocol: "The gateway sent data that the SDK cannot use",
                  closed: "The gateway closed the connection",
              }[reason]
    const sentence = specific === undefined ? undefined : `${specific.charAt(0).toUpperCase()}${specific.slice(1)}`
    const what = known ? `${known.meaning}${sentence === undefined ? "" : `. ${sentence}`}` : (sentence ?? general)
    const code =
        status === null
            ? ""
            : phase === "gateway"
              ? ` (close code ${status}${known && known.name !== "UNKNOWN" ? ` ${known.name}` : ""})`
              : ` (HTTP ${status})`
    return `Fluxer ${phase === "gateway" ? "gateway connection" : "instance discovery"} failed: ${what}${code}`
}

/** Gateway startup or explicit instance discovery exceeded its time budget.
 * Required cleanup is still awaited, so completion can occur after timeoutMs has elapsed
 *
 * @category Errors
 */
export class ConnectionTimeoutError extends FluxerlyError {
    /** Discriminator for identifying an expired connection or discovery deadline */
    readonly _tag = "ConnectionTimeoutError"
    constructor(
        /** Connection or discovery budget in milliseconds, not a guarantee of completion before cleanup finishes */
        readonly timeoutMs: number,
    ) {
        super(`The connection to Fluxer was not ready within ${timeoutMs} ms`, {
            code: "connection.timeout",
            hint: "Check network access to the Fluxer instance, or raise the timeout that expired, usually connection.startupTimeoutMs",
            details: { timeoutMs },
        })
        this.name = this._tag
    }
}

/** Discovery HTTP or the gateway imposed a connection rate limit.
 * When retryAfterMs is available, wait at least that duration before another manual attempt
 *
 * @category Errors
 */
export class RateLimitError extends FluxerlyError {
    /** Discriminator for identifying a connection rate limit */
    readonly _tag = "RateLimitError"
    constructor(
        /** Whether discovery HTTP or the gateway imposed the limit */
        readonly source: "http" | "gateway",
        /** Server-required wait in milliseconds, or null when no usable duration was supplied */
        readonly retryAfterMs: number | null,
    ) {
        super(
            `Fluxer rate-limited the ${source === "gateway" ? "gateway connection" : "connection setup request"}${retryAfterMs === null ? " without saying how long to wait" : ` (retry after ${retryAfterMs} ms)`}`,
            {
                code: "ratelimit.connection",
                hint: operationHint("rateLimit", "notDispatched", retryAfterMs),
                details: { source, ...(retryAfterMs === null ? {} : { retryAfterMs }) },
            },
        )
        this.name = this._tag
    }
}

/** A configured gateway shard failed startup or permanently lost its established connection.
 * Use shardId to identify the local connection and failure to inspect its expected cause, which is also the error's cause.
 * The client waits for its other shards to clean up before returning this failure.
 * This does not undo delivered events or dispatched HTTP work
 *
 * @category Errors
 */
export class ShardConnectionError extends FluxerlyError {
    /** Discriminator for narrowing a failure attributed to one local shard */
    readonly _tag = "ShardConnectionError"
    constructor(
        /** The locally assigned shard whose connection failed */
        readonly shardId: number,
        /** Original SDK-owned expected failure, without private upstream payloads */
        readonly failure: AuthenticationError | ConnectionError | ConnectionTimeoutError | RateLimitError,
    ) {
        super(`Shard ${shardId} stopped: ${failure.message}`, {
            code: "connection.shard",
            hint: failure.hint,
            cause: failure,
            details: { shardId },
        })
        this.name = this._tag
    }
}

/** A competing connection operation already owns the client, so this call did not take ownership.
 * The rejected call does not cancel or close the existing connection work
 *
 * @category Errors
 */
export class ClientBusyError extends FluxerlyError {
    /** Discriminator for identifying competing connection ownership */
    readonly _tag = "ClientBusyError"
    constructor() {
        super("The client is already connecting or connected", {
            code: "client.busy",
            hint: "Call connect or run once per client, and await that call instead of starting another",
        })
        this.name = this._tag
    }
}

/**
 * The client is permanently closing or closed, so reconnecting requires a new client
 *
 * @category Errors
 */
export class ClientClosedError extends FluxerlyError {
    /** Discriminator for identifying permanent client closure */
    readonly _tag = "ClientClosedError"
    constructor() {
        super("The client is shutting down or has shut down, so it cannot do more work", {
            code: "client.closed",
            hint: "Create a new client to connect again",
        })
        this.name = this._tag
    }
}

/** A default API operation was cancelled through its signal.
 * The SDK returns this expected failure after required cleanup, not as proof that remote work was undone.
 * Cancellation combined with an unexpected cleanup failure rejects with SdkDefect instead
 *
 * @category Errors
 */
export class CancelledError extends FluxerlyError {
    /** Error tag for identifying cancellation in the default API */
    readonly _tag = "CancelledError"
    constructor(
        /** The cancelled default API call, recorded as details.operation and named in the message. Defaults to undefined */
        operation?: Operation,
    ) {
        super(
            `${operation === undefined ? "The operation" : `The operation ${operation}`} was cancelled before it finished`,
            {
                code: "operation.cancelled",
                hint: "Its AbortSignal was aborted. Signals that the SDK passes to handlers abort when the client shuts down, so this is expected during shutdown",
                details: operation === undefined ? undefined : { operation },
            },
        )
        this.name = this._tag
    }
}

/** Short masked text for an application-thrown value. Never throws, including for null, symbols and hostile proxies */
function thrownText(value: unknown): string {
    if (typeof value === "string")
        return maskText(JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value))
    let error = false
    try {
        error = value instanceof Error
    } catch {
        // allow-silent: a proxy that rejects prototype inspection is described as a non-Error object below
    }
    if (error) return maskText(errorSummary(value))
    return typeof value === "object" && value !== null ? "a non-Error object" : describeValue(value)
}

/** The masked message of an application fault, usually an ApplicationError, or a guarded description of another value */
function defectMessage(value: unknown): string {
    try {
        if (value instanceof Error) return maskText(String(value.message))
    } catch {
        // allow-silent: an Error whose message getter throws is described by the guarded fallback below
    }
    return thrownText(value)
}

/** An application callback invoked by the SDK failed, threw or rejected.
 * The runBot function returns it as an expected failure, with source "runBot setup", when its setup callback fails,
 * and with source "runBot commands" when its commands register callback throws.
 * Where the SDK cannot return a typed failure, such as a default keepTyping task, it appears as a fault inside SdkDefect.
 * The original failure or thrown value is the cause. Handler, filter and collector callback failures are reported with
 * their original value through FailureReport or their own error types instead
 *
 * @category Errors
 */
export class ApplicationError extends FluxerlyError {
    /** Discriminator for a failure thrown by application code rather than the SDK */
    readonly _tag = "ApplicationError"
    constructor(
        /** Names the application callback that failed, such as runBot setup or keepTyping task */
        readonly source: string,
        /** The original thrown or rejected value */
        cause: unknown,
    ) {
        super(`Application callback ${source} failed: ${thrownText(cause)}`, {
            code: "application.callbackFailed",
            hint: `Fix the ${source} callback. The error's cause is the value it threw`,
            cause,
            details: { source },
        })
        this.name = this._tag
    }
}

/**
 * Expected startup or terminal connection failures, excluding cancellation and SDK defects
 *
 * @category Errors
 */
export type ConnectionFailure =
    AuthenticationError | ConnectionError | ConnectionTimeoutError | RateLimitError | ShardConnectionError
/**
 * Expected connect and run failures, with default API methods adding CancelledError to their result union
 *
 * @category Errors
 */
export type ConnectError = ConnectionFailure | ClientBusyError | ClientClosedError

/** Details of what caused an SdkDefect in the default API.
 * Failure holds an expected SDK error, Defect holds an unexpected fault with its original value, and Interruption marks cancellation.
 * More than one entry can describe both the original failure and a cleanup fault
 *
 * @category Errors
 */
export type DefectReason =
    | {
          /** This cause entry retains an expected SDK failure */
          readonly kind: "Failure"
          /** Typed expected failure preserved alongside the unexpected fault */
          readonly failure:
              | ConnectError
              | ConfigurationError
              | import("./message-errors.js").EventReadError
              | import("./message-errors.js").EventWaitError
              | import("./message-errors.js").MessageError
              | import("./message-errors.js").MessageOperationError
              | import("./message-cleanup.js").MessageCleanupError
              | import("./guilds.js").GuildOperationError
              | import("./channels.js").ChannelOperationError
              | import("./webhooks.js").WebhookOperationError
              | import("./users.js").UserOperationError
              | import("./application.js").BotApplicationOperationError
              | import("./oauth.js").OAuthOperationError
              | import("./counts.js").CountOperationError
              | import("./member-chunks.js").MemberChunkError
              | import("./presence.js").PresenceError
              | import("./pagination.js").PaginationError
              | import("./collectors.js").CollectorError
              | import("./attachments.js").AttachmentDownloadFailure
              | import("./attachments.js").AttachmentRefreshFailure
              | import("./supervisor.js").SupervisorError
              | import("./supervisor.js").SupervisorChildError
              | CancelledError
              | import("./bot-runner.js").CriticalWorkerStoppedError
      }
    | {
          /** An unexpected fault occurred */
          readonly kind: "Defect"
          /**
           * The original fault value. An application callback failure is an ApplicationError naming the callback, and a
           * throw while the SDK read caller-supplied input, such as from a property getter or a caller AbortSignal
           * listener method, is the thrown value itself
           */
          readonly defect: unknown
          /**
           * Where the fault came from. The value application means an application callback failed or reading caller-supplied
           * options or input threw, and sdk means any other fault, including one in SDK work that runs between those reads
           */
          readonly origin: "application" | "sdk"
      }
    | {
          /** Cancellation interrupted work, possibly alongside another failure */
          readonly kind: "Interruption"
      }

/**
 * An unexpected fault thrown or rejected by the default API instead of returned as a typed error result.
 * Client creation throws synchronously, while asynchronous operations reject.
 * This includes expected failures or cancellation combined with an unexpected cleanup fault.
 * The first fault is the standard cause property, and reasons list every failure, fault and interruption entry.
 * A fault from an application callback, such as a default keepTyping task, is an ApplicationError with origin application.
 * A throw while the SDK reads caller-supplied options or input, such as from a property getter or a caller AbortSignal
 * listener method, keeps the thrown value as the cause with origin application. Either application origin sets code
 * application.defect instead of sdk.defect. A fault in SDK work around those reads, such as building a command registry
 * or a client logger, keeps origin sdk.
 * The native entry point uses Effect causes rather than wrapping them in this exception
 *
 * @category Errors
 */
export class SdkDefect extends FluxerlyError {
    /** Discriminator for an unexpected fault in the default API */
    readonly _tag = "SdkDefect"
    constructor(
        /** Public call during which the fault was observed, not proof that a server mutation was rolled back */
        readonly operation: Operation = "createClient",
        /** Cause entries, which can include both the primary failure and cleanup faults */
        readonly reasons: readonly DefectReason[] = [],
    ) {
        const fault = reasons.find((reason) => reason.kind === "Defect")
        const application = fault?.kind === "Defect" && fault.origin === "application"
        super(
            application
                ? `Application failure during ${operation}: ${defectMessage(fault.defect)}`
                : `Unexpected SDK failure during ${operation}${fault?.kind === "Defect" ? `: ${thrownText(fault.defect)}` : ""}`,
            {
                code: application ? "application.defect" : "sdk.defect",
                hint: application
                    ? "Fix the application callback or the input property getter that raised the cause"
                    : "This is an SDK or cleanup fault. Report it with the output of describeError",
                cause:
                    fault?.kind === "Defect"
                        ? fault.defect
                        : reasons.find((reason) => reason.kind === "Failure")?.failure,
                details: { operation, reasons: reasons.map((reason) => reason.kind) },
            },
        )
        this.reasons = Object.freeze([...reasons])
        this.name = "SdkDefect"
    }
}
