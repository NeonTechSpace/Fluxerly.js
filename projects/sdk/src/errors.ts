/** A client setting or operation option is invalid before the requested work starts.
 * Use field to identify the setting without exposing its rejected value
 */
export class ConfigurationError extends Error {
    /** Discriminator for narrowing a local configuration failure */
    readonly _tag = "ConfigurationError"

    constructor(
        /** The invalid option or containing object, including unsupported cache keys, without its rejected value */
        readonly field:
            | "configuration"
            | "instance"
            | "logging"
            | "development"
            | "measurements"
            | "minimumLevel"
            | "logger"
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
            | "maxPendingMessages"
            | "maxPendingBytes"
            | "onError"
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
            | "shutdownTimeoutMs"
            | "childEnvironment"
            | "args"
            | "execArgv",
        /** Explanation of the accepted setting, without its rejected value */
        message: string,
    ) {
        super(message)
        this.name = "ConfigurationError"
    }
}

/** Identifies the default API call during which an SdkDefect was observed.
 * This attribution does not establish whether a dispatched server mutation took effect or was rolled back
 */
export type Operation =
    | "attachments.download"
    | "attachments.stream"
    | import("./attachments.js").AttachmentRefreshOperation
    | "instance.resolve"
    | "presence.set"
    | "presence.setMembers"
    | "cache.entries"
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
    | "events"
    | "next"
    | "send"
    | "forward"
    | "reply"
    | "typing"
    | "keepTyping"
    | "fetch"
    | "get"
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
    | "deleteMine"
    | "cleanup"
    | "subscription.waitForClose"
    | "collect"
    | "collector.waitForClose"
    | "collectReactions"
    | "reactionCollector.waitForClose"

/** Fluxer rejected the bot token during connection startup or recovery.
 * Check the token before connecting again, since the SDK does not retry this rejection unchanged
 */
export class AuthenticationError extends Error {
    /** Discriminator for identifying a rejected bot credential */
    readonly _tag = "AuthenticationError"
    constructor() {
        super("Fluxer rejected the bot credential")
        this.name = this._tag
    }
}

// Reviewed against Fluxer's GatewayConstants and gateway handler call sites, not Discord close-code semantics
function gatewayExplanation(status: number | null): string {
    switch (status) {
        case 1007:
            return "The WebSocket connection rejected invalid payload encoding"
        case 1009:
            return "The WebSocket connection rejected a message exceeding its receive limit"
        case 4000:
            return "The gateway reported an unspecified error"
        case 4001:
            return "The gateway rejected an unsupported command or missing command data"
        case 4002:
            return "The gateway rejected invalid payload encoding, size, compression or command fields"
        case 4003:
            return "The gateway received a command before authentication established a session"
        case 4004:
            return "The gateway rejected the bot credential"
        case 4005:
            return "The gateway rejected Identify or Resume because a session was already attached or command data was missing"
        case 4007:
            return "The gateway rejected the heartbeat or resume sequence"
        case 4008:
            return "The gateway rejected work because a connection, payload or session budget was exceeded"
        case 4009:
            return "The gateway closed after a heartbeat acknowledgement timeout"
        case 4010:
            return "The gateway rejected the shard assignment"
        case 4011:
            return "The gateway requires additional shards for this bot"
        case 4012:
            return "The gateway rejected an absent or unsupported API version"
        default:
            return "No reviewed provider explanation is available"
    }
}

/** Instance discovery or the gateway connection failed.
 * Inspect phase, reason and status to distinguish network failure, invalid protocol data and gateway closure.
 * The message includes a reviewed Fluxer close-code explanation when available, but no provider body or close-reason text.
 * An explanation does not establish whether the session can resume or whether the SDK will retry
 * Local gateway receive-limit and UTF-8 failures use reason protocol and status 1009 and 1007 respectively.
 * These failures do not retry automatically. No rejected payload or transport error text is retained
 */
export class ConnectionError extends Error {
    /** Discriminator for identifying an expected discovery or gateway connection failure */
    readonly _tag = "ConnectionError"
    constructor(
        /** The transport stage that failed */
        readonly phase: "discovery" | "gateway",
        /** Network failure, invalid protocol data, or a closed gateway connection */
        readonly reason: "network" | "protocol" | "closed",
        /** HTTP status during discovery or WebSocket close code at the gateway, including local receive rejection, or null when unavailable */
        readonly status: number | null = null,
    ) {
        super(
            `Fluxer ${phase} connection failed (${reason}${status === null ? "" : `; status ${status}`}): ${
                phase === "gateway" && status !== null
                    ? gatewayExplanation(status)
                    : reason === "network"
                      ? "The connection request could not complete"
                      : reason === "protocol"
                        ? "The connection returned invalid or disallowed protocol data"
                        : "The gateway connection closed"
            }`,
        )
        this.name = this._tag
    }
}

/** Gateway startup or explicit instance discovery exceeded its time budget.
 * Required cleanup is still awaited, so completion can occur after timeoutMs has elapsed
 */
export class ConnectionTimeoutError extends Error {
    /** Discriminator for identifying an expired connection or discovery deadline */
    readonly _tag = "ConnectionTimeoutError"
    constructor(
        /** Connection or discovery budget in milliseconds, not a guarantee of completion before cleanup finishes */
        readonly timeoutMs: number,
    ) {
        super(`Fluxer connection did not become ready within its ${timeoutMs} ms time budget`)
        this.name = this._tag
    }
}

/** Discovery HTTP or the gateway imposed a connection rate limit.
 * When retryAfterMs is available, wait at least that duration before another manual attempt
 */
export class RateLimitError extends Error {
    /** Discriminator for identifying a connection rate limit */
    readonly _tag = "RateLimitError"
    constructor(
        /** Whether discovery HTTP or the gateway imposed the limit */
        readonly source: "http" | "gateway",
        /** Server-required wait in milliseconds, or null when no usable duration was supplied */
        readonly retryAfterMs: number | null,
    ) {
        super(
            `Fluxer rate limited the ${source} connection: ${retryAfterMs === null ? "No usable retry delay was supplied" : `Wait at least ${retryAfterMs} ms before retrying`}`,
        )
        this.name = this._tag
    }
}

/** A configured gateway shard failed startup or permanently lost its established connection.
 * Use shardId to identify the local connection and failure to inspect its expected cause.
 * The client waits for its other shards to clean up before returning this failure.
 * This does not undo delivered events or dispatched HTTP work
 */
export class ShardConnectionError extends Error {
    /** Discriminator for narrowing a failure attributed to one local shard */
    readonly _tag = "ShardConnectionError"
    constructor(
        /** The locally assigned shard whose connection failed */
        readonly shardId: number,
        /** Original SDK-owned expected failure, without private upstream payloads */
        readonly failure: AuthenticationError | ConnectionError | ConnectionTimeoutError | RateLimitError,
    ) {
        super(`Fluxer shard ${shardId} connection failed (${failure._tag}): ${failure.message}`)
        this.name = this._tag
    }
}

/** A competing connection operation already owns the client, so this call did not take ownership.
 * The rejected call does not cancel or close the existing connection work
 */
export class ClientBusyError extends Error {
    /** Discriminator for identifying competing connection ownership */
    readonly _tag = "ClientBusyError"
    constructor() {
        super("The client already has an active connection or connection operation")
        this.name = this._tag
    }
}

/** The client is permanently closing or closed, so reconnecting requires a new client */
export class ClientClosedError extends Error {
    /** Discriminator for identifying permanent client closure */
    readonly _tag = "ClientClosedError"
    constructor() {
        super("The client is permanently closing or closed")
        this.name = this._tag
    }
}

/** A default API operation was cancelled through its signal.
 * The SDK returns this expected failure after required cleanup, not as proof that remote work was undone.
 * Cancellation combined with an unexpected cleanup failure rejects with SdkDefect instead
 */
export class CancelledError extends Error {
    /** Error tag for identifying cancellation in the default API */
    readonly _tag = "CancelledError"
    constructor() {
        super("The operation was cancelled")
        this.name = this._tag
    }
}

/** Expected startup or terminal connection failures, excluding cancellation and SDK defects */
export type ConnectionFailure =
    AuthenticationError | ConnectionError | ConnectionTimeoutError | RateLimitError | ShardConnectionError
/** Expected connect and run failures, with default API methods adding CancelledError to their result union */
export type ConnectError = ConnectionFailure | ClientBusyError | ClientClosedError

/** Safe details of what caused an SdkDefect in the default API.
 * Failure holds an expected SDK error, Defect marks an unexpected fault, and Interruption marks cancellation.
 * More than one entry can describe both the original failure and a cleanup fault. Raw faults are not exposed
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
          /** An unexpected fault occurred, with its raw value deliberately omitted */
          readonly kind: "Defect"
      }
    | {
          /** Cancellation interrupted work, possibly alongside another failure */
          readonly kind: "Interruption"
      }

/**
 * An unexpected fault thrown or rejected by the default API instead of returned as a typed error result.
 * Client creation throws synchronously, while asynchronous operations reject.
 * This includes expected failures or cancellation combined with an unexpected cleanup fault.
 * Reasons retain safe failure categories without the original fault or private data.
 * The native entry point uses Effect causes rather than wrapping them in this exception
 */
export class SdkDefect extends Error {
    constructor(
        /** Public call during which the fault was observed, not proof that a server mutation was rolled back */
        readonly operation: Operation = "createClient",
        /** Safe cause entries, which can include both the primary failure and cleanup failure categories */
        readonly reasons: readonly DefectReason[] = [],
    ) {
        super(`Unexpected SDK failure during ${operation}`)
        this.name = "SdkDefect"
    }
}
