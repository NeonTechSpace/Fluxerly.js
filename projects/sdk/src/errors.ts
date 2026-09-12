/** Locally invalid client configuration or operation options, without the rejected input value */
export class ConfigurationError extends Error {
    readonly _tag = "ConfigurationError"

    constructor(
        /** The invalid option or containing object, including unsupported cache keys, without its rejected value */
        readonly field:
            | "configuration"
            | "instance"
            | "logging"
            | "development"
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
            | "commands"
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
        message: string,
    ) {
        super(message)
        this.name = "ConfigurationError"
    }
}

/** Public operation identified by a default SdkDefect, not proof that a dispatched mutation was rolled back */
export type Operation =
    | "attachments.download"
    | "attachments.stream"
    | "instance.resolve"
    | "presence.set"
    | "presence.setMembers"
    | "cache.entries"
    | "directMessages.send"
    | import("./application.js").BotApplicationOperation
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
    | "waitForClose"
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

/** Fluxer rejected the credential, so the connection owner does not retry it unchanged */
export class AuthenticationError extends Error {
    readonly _tag = "AuthenticationError"
    constructor() {
        super("Fluxer rejected the bot credential")
        this.name = this._tag
    }
}

// Reviewed against Fluxer's GatewayConstants and gateway handler call sites, not Discord close-code semantics
function gatewayExplanation(status: number | null): string {
    switch (status) {
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

/** Connection failure with safe phase and status metadata, without an upstream body or close-reason string.
 * message includes the observed status and a reviewed Fluxer close-code explanation when available.
 * Explanations do not change retry policy or establish whether a gateway session can resume
 */
export class ConnectionError extends Error {
    readonly _tag = "ConnectionError"
    constructor(
        /** The transport stage that failed */
        readonly phase: "discovery" | "gateway",
        /** Network failure, invalid protocol data, or a closed gateway connection */
        readonly reason: "network" | "protocol" | "closed",
        /** HTTP status during discovery or WebSocket close code at the gateway, or null when unavailable */
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

/** Gateway readiness or explicit instance discovery did not complete within its caller-owned budget, with cleanup still awaited */
export class ConnectionTimeoutError extends Error {
    readonly _tag = "ConnectionTimeoutError"
    constructor(
        /** Connection or discovery budget in milliseconds, not a guarantee of completion before cleanup finishes */
        readonly timeoutMs: number,
    ) {
        super(`Fluxer connection did not become ready within its ${timeoutMs} ms time budget`)
        this.name = this._tag
    }
}

/** A connection rate limit, distinct from authentication rejection or an SDK defect */
export class RateLimitError extends Error {
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

/** A configured shard could not start or permanently lost its gateway lifetime.
 * The client awaits sibling cleanup before returning this failure. This does not roll back delivered events or HTTP work
 */
export class ShardConnectionError extends Error {
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

/** The operation was not admitted because existing connection work already owns the client */
export class ClientBusyError extends Error {
    readonly _tag = "ClientBusyError"
    constructor() {
        super("The client already has an active connection or connection operation")
        this.name = this._tag
    }
}

/** The client is permanently closing or closed, so reconnecting requires a new client */
export class ClientClosedError extends Error {
    readonly _tag = "ClientClosedError"
    constructor() {
        super("The client is permanently closing or closed")
        this.name = this._tag
    }
}

/** Default operation cancellation, returned only after cleanup required by that operation finishes */
export class CancelledError extends Error {
    readonly _tag = "CancelledError"
    constructor() {
        super("The operation was cancelled")
        this.name = this._tag
    }
}

/** Expected startup or terminal connection failures, excluding cancellation and SDK defects */
export type ConnectionFailure =
    AuthenticationError | ConnectionError | ConnectionTimeoutError | RateLimitError | ShardConnectionError
/** Expected connect and run failures, with default methods adding CancelledError to their result union */
export type ConnectError = ConnectionFailure | ClientBusyError | ClientClosedError

/** Safe cause categories retain combined failure information without raw upstream defects */
export type DefectReason =
    | {
          readonly kind: "Failure"
          readonly failure:
              | ConnectError
              | ConfigurationError
              | import("./message-errors.js").EventReadError
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
              | import("./supervisor.js").SupervisorError
              | import("./supervisor.js").SupervisorChildError
              | CancelledError
      }
    | { readonly kind: "Defect" }
    | { readonly kind: "Interruption" }

/**
 * Unexpected default SDK failure, kept outside typed Result and ResultAsync errors.
 * Creation throws synchronously, while asynchronous operations reject.
 * Reasons retain safe failure categories without copying raw upstream defects or private payloads.
 * Native consumers receive Effect causes instead of this default-boundary exception
 */
export class SdkDefect extends Error {
    constructor(
        readonly operation: Operation = "createClient",
        readonly reasons: readonly DefectReason[] = [],
    ) {
        super(`Unexpected SDK failure during ${operation}`)
        this.name = "SdkDefect"
    }
}
