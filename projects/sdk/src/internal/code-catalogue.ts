/**
 * Catalogue of every SDK error code and log record code, the source text of the website's error and log codes page.
 * Invariant: Every emitted log code is a key of logCodes, which the compiler enforces through LogCode, and the website
 * generator fails when an error code or error code family in the source has no entry here or an entry names a code
 * that no longer exists. Entries describe the code in plain words and never quote runtime values
 */
import type { LogLevel } from "#sdk/logging"

/** One catalogue entry: What the code means and, when there is one, what to do about it */
export interface CodeEntry {
    /** What happened, in one or two short sentences without a final period */
    readonly meaning: string
    /** The usual fix or next step, without a final period. Absent when the code needs no action */
    readonly action?: string
}

/** One error code or error code family. A family key such as guild.<reason> lists its values */
export interface ErrorCodeEntry extends CodeEntry {
    /** The error class that carries this code */
    readonly error: string
    /** For a family with one placeholder, the values that replace it */
    readonly values?: readonly string[]
}

/** One log record code with the levels it is emitted at */
export interface LogCodeEntry extends CodeEntry {
    readonly levels: readonly LogLevel[]
}

const operationReasons = [
    "input",
    "busy",
    "notFound",
    "rejected",
    "network",
    "response",
    "timeout",
    "rateLimit",
] as const
/**
 * What each operation reason means, shown once on the page for every family that uses them.
 * Read by the website generator
 *
 * @public
 */
export const operationReasonMeanings = {
    input: "An input value is invalid, so nothing was sent to Fluxer. The error's inputValidation.path names it",
    busy: "Too many requests of this kind were already pending in the client, so nothing was sent",
    notFound: "Fluxer answered HTTP 404. The resource does not exist or is not visible to this bot",
    rejected: "Fluxer refused the request. The error's apiError, or details.providerCode for a newer code, says why",
    network: "A network error interrupted the request",
    response:
        "Fluxer's answer did not have the expected format. The failing field or check is in details.responseField",
    timeout: "The operation did not finish within its timeoutMs",
    rateLimit:
        "Fluxer rate-limited the request, and the SDK could not wait and retry it, for example because the wait would pass the timeout",
} as const satisfies Readonly<Record<(typeof operationReasons)[number], string>>
const operationMeaning = (subject: string) =>
    `A ${subject} request failed. The reason says why, as listed under operation reasons`
const operationAction =
    "Read the hint, and apiError or details.providerCode for a Fluxer rejection. Repeat the call only when errors.isRetryable returns true"

/**
 * Error codes and families, keyed by code. Family keys use a placeholder such as <reason>. Read by the website generator
 *
 * @public
 */
export const errorCodes = {
    "configuration.invalid": {
        error: "ConfigurationError",
        meaning:
            "An option or setting is invalid, so the requested work did not start. The error's field names the setting",
        action: "Fix the named setting. The hint suggests the closest supported option for a misspelled key",
    },
    "auth.rejected": {
        error: "AuthenticationError",
        meaning:
            "Fluxer rejected the bot token when the client connected, reconnected or counted communities for automatic sharding",
        action: "Check the whole bot token and the application owner's account standing. A valid token can be rejected if that account is closed or disabled, which a new token cannot fix. The rejection alone does not identify the cause. The SDK does not retry it",
    },
    "connection.<phase>.<reason>": {
        error: "ConnectionError",
        meaning:
            "Instance discovery or the gateway connection failed. The phase is discovery or gateway, and the reason is network, protocol or closed. The message explains a known close code and names it",
        action: "Check network access to the Fluxer instance. Follow the hint for rejected tokens and shard close codes",
    },
    "connection.timeout": {
        error: "ConnectionTimeoutError",
        meaning: "The connection to Fluxer, or instance discovery, was not ready within its timeout",
        action: "Check network access, or raise the timeout that expired, usually connection.startupTimeoutMs",
    },
    "connection.shard": {
        error: "ShardConnectionError",
        meaning:
            "One shard failed to start or lost its connection for good, so it stopped. The cause is the shard's own failure",
        action: "Read the cause and its hint",
    },
    "ratelimit.connection": {
        error: "RateLimitError",
        meaning: "Fluxer rate-limited the gateway connection or a request made while connecting",
        action: "Wait at least retryAfterMs before connecting again",
    },
    "client.busy": {
        error: "ClientBusyError",
        meaning: "The client is already connecting or connected, because connect or run was called before",
        action: "Call connect or run once per client and await that call",
    },
    "client.closed": {
        error: "ClientClosedError",
        meaning: "The client is shutting down or has shut down, so it cannot do more work",
        action: "Create a new client to connect again",
    },
    "operation.cancelled": {
        error: "CancelledError",
        meaning:
            "A default API operation stopped because its AbortSignal was aborted, for example during shutdown. The details.operation field names the call",
        action: "No action is needed during shutdown. Otherwise check what aborted the signal",
    },
    "application.callbackFailed": {
        error: "ApplicationError",
        meaning:
            "An application callback that the SDK ran, such as runBot setup, threw or rejected. The cause is the original value",
        action: "Fix the callback named by details.source",
    },
    "application.defect": {
        error: "SdkDefect",
        meaning: "An application callback or an option getter threw where the SDK could not return a typed failure",
        action: "Fix the callback or getter that raised the cause",
    },
    "sdk.defect": {
        error: "SdkDefect",
        meaning: "An unexpected fault inside the SDK or its cleanup",
        action: "Report it with the output of describeError",
    },
    "bot.workerStopped": {
        error: "CriticalWorkerStoppedError",
        meaning:
            "One of the bot's event or command subscriptions ended while the bot was still running, so the bot stopped. The details.workerIndex field numbers it from 0",
        action: "Keep the bot's subscriptions open while it runs. The hint explains how subscriptions are numbered",
    },
    "events.overflow": {
        error: "EventOverflowError",
        meaning: "A subscription's queue exceeded its limit and the overflow policy stopped it",
        action: "Handle events faster, raise the pending limits or choose a dropping overflow policy",
    },
    "events.readBusy": {
        error: "EventReadBusyError",
        meaning: "An event read was started while another read on the same subscription was pending",
        action: "Await the pending next call before calling next again",
    },
    "events.wait.<reason>": {
        error: "EventWaitError",
        values: ["timeout", "filter"],
        meaning:
            "An event wait ended without a match before its deadline, or its filter threw or returned a non-boolean",
        action: "Raise timeoutMs, or make the filter return true or false synchronously",
    },
    "message.send.<reason>": {
        error: "MessageError",
        values: ["input", "busy", "rejected", "network", "response", "timeout", "rateLimit"],
        meaning:
            "A message send failed. The reason says why, as listed under operation reasons, and a send reports HTTP 404 as rejected",
        action: `${operationAction}. A send whose outcome is unknown may already have created the message`,
    },
    "message.<reason>": {
        error: "MessageOperationError",
        values: operationReasons,
        meaning: `${operationMeaning("message")}. Publishing requires an unpublished source message in an announcement channel, excluding replies, system messages, forwarded messages and received crosspost copies. Publishing and editing a published message have separate rate limits`,
        action: `${operationAction}. For publishing preconditions, check the source channel and message. For rate limits, wait at least retryAfterMs before repeating the call`,
    },
    "guild.<reason>": {
        error: "GuildOperationError",
        values: operationReasons,
        meaning: operationMeaning("guild"),
        action: operationAction,
    },
    "channel.<reason>": {
        error: "ChannelOperationError",
        values: operationReasons,
        meaning: `${operationMeaning("channel")}. Announcement operations require an announcement source. Following requires a community text destination that does not already follow that source and has compatible content warnings or age restrictions. Only text and announcement channels can convert into each other`,
        action: `${operationAction}. Choose a compatible follow destination. Before converting a text channel to an announcement channel, remove its channel-follower webhooks`,
    },
    "user.<reason>": {
        error: "UserOperationError",
        values: operationReasons,
        meaning: operationMeaning("user"),
        action: operationAction,
    },
    "webhook.<reason>": {
        error: "WebhookOperationError",
        values: operationReasons,
        meaning: `${operationMeaning("webhook")}. Moving a channel-follower webhook requires a community text destination that does not already follow its source and has compatible content warnings or age restrictions. Editing a published webhook message can reach the published-message edit rate limit`,
        action: `${operationAction}. Choose a compatible destination for a follower webhook. For a published-message edit rate limit, wait at least retryAfterMs before editing again`,
    },
    "application.<reason>": {
        error: "BotApplicationOperationError",
        values: operationReasons,
        meaning: operationMeaning("bot application"),
        action: operationAction,
    },
    "rest.<reason>": {
        error: "RestRequestError",
        values: operationReasons,
        meaning: operationMeaning("raw REST"),
        action: operationAction,
    },
    "attachment.<reason>": {
        error: "AttachmentRefreshError",
        values: operationReasons,
        meaning: operationMeaning("attachment URL refresh"),
        action: operationAction,
    },
    "attachment.download.<reason>": {
        error: "AttachmentDownloadError",
        values: ["input", "untrustedUrl", "busy", "network", "response", "tooLarge", "timeout"],
        meaning:
            "An attachment download failed. The reason untrustedUrl means the URL is not on this instance's media host, and tooLarge means the attachment is larger than maxBytes",
        action: "Pass attachments received from this client, and raise maxBytes for tooLarge",
    },
    "oauth.<reason>": {
        error: "OAuthOperationError",
        values: ["input", "busy", "rejected", "network", "response", "timeout", "rateLimit"],
        meaning: `${operationMeaning("OAuth")}. The oauthError field names a standard OAuth error code, such as invalid_grant`,
        action: operationAction,
    },
    "cleanup.<reason>": {
        error: "MessageCleanupError",
        values: ["filter", "closed", ...operationReasons],
        meaning: "A message cleanup stopped. The phase says whether history scanning or deletion failed",
        action: "Check selectedMessageIds and terminalBatchIds before running the cleanup again",
    },
    "count.<reason>": {
        error: "CountOperationError",
        values: ["input", "notConnected", "busy", "timeout", "connectionLost", "response"],
        meaning:
            "A fresh member or presence count over the gateway failed. The reason notConnected means the community's shard is not ready, and connectionLost means it disconnected before the answer",
        action: "Connect the client first, and retry after a timeout or lost connection",
    },
    "memberChunks.<reason>": {
        error: "MemberChunkError",
        values: ["input", "notConnected", "busy", "response", "overflow", "timeout", "connectionLost", "rateLimit"],
        meaning:
            "A gateway member request failed before its last chunk arrived. The reason overflow means unread batches passed maxPendingBytes",
        action: "Connect the client first, read batches promptly, and wait retryAfterMs after rateLimit",
    },
    "presence.<reason>": {
        error: "PresenceError",
        values: ["input", "limit"],
        meaning:
            "A presence update or presence member selection was invalid, or the selection was larger than the SDK's limits (reason limit)",
        action: "Correct the input named by inputValidation.path, or select fewer members",
    },
    "pagination.<reason>": {
        error: "PaginationError",
        values: ["input", "cursorStalled", "pageLimit", "indexing"],
        meaning:
            "An iterator stopped. The reason cursorStalled means Fluxer repeated a page, and indexing means search results are not ready yet",
        action: "Retry indexing later, and raise maxPages for pageLimit",
    },
    "collector.<reason>": {
        error: "CollectorError",
        values: ["notConnected", "connectionLost", "filter", "handler", "overflow"],
        meaning: "A message or reaction collector failed instead of ending normally",
        action: "Start collectors after the client is ready, start a new one after a lost connection, fix a failing filter or callback, or raise the limit named in the message",
    },
    "gateway.send.<reason>": {
        error: "GatewaySendError",
        values: ["input", "reserved", "notOwned", "notReady", "busy"],
        meaning: "A raw gateway send was invalid, used an opcode the SDK manages, or had no ready shard to use",
        action: "Send only application opcodes to a shard this client owns after it is ready",
    },
    "helper.<reason>": {
        error: "HelperError",
        values: ["id", "markup", "time", "permissionBits", "link", "color", "text", "limit", "shardCount"],
        meaning: "A formatting or parsing helper received a value it cannot use",
        action: "Pass a value of the documented form",
    },
    "asset.<reason>": {
        error: "AssetUrlError",
        values: ["target", "id", "hash", "options"],
        meaning: "An asset URL could not be built from the given object or options",
        action: "Pass the object received from Fluxer and supported size and format options",
    },
    "supervisor.<reason>": {
        error: "SupervisorError",
        values: ["closed", "spawn", "protocol", "restartLimit", "startupTimeout", "shardCount"],
        meaning: "The shard supervisor failed to start or keep its child processes",
        action: "Read the supervisor log records for the child that failed",
    },
    "supervisor.child.<reason>": {
        error: "SupervisorChildError",
        values: ["disconnected", "protocol"],
        meaning: "A supervised child lost its connection to the parent process or received an invalid message",
        action: "Start the child only through the supervisor",
    },
    "testing.unhandledFailures": {
        error: "UnhandledTestFailuresError",
        meaning: "A test client logged failures that the test neither handled nor asserted",
        action: "Fix the failing code, assert the failures before shutdown, or handle them with onError",
    },
    "testing.timeout": {
        error: "TestTimeoutError",
        meaning: "A test wait did not finish within its timeout",
        action: "Check that the code under test sends the request, or raise timeoutMs",
    },
} as const satisfies Readonly<Record<string, ErrorCodeEntry>>

/** Log record codes, keyed by code */
export const logCodes = {
    "lifecycle.starting": {
        levels: ["info"],
        meaning: "The client started connecting, with its SDK version and shard plan",
    },
    "lifecycle.startupDeadline": {
        levels: ["info"],
        meaning:
            "Starting several shards may take longer than connection.startupTimeoutMs, because the SDK starts shard sessions one second apart",
    },
    "lifecycle.automaticSharding": {
        levels: ["info"],
        meaning: "Automatic sharding counted the bot's communities and chose the shard count from that number",
    },
    "lifecycle.resharded": {
        levels: ["warn"],
        meaning:
            "Fluxer closed a shard of an automatically sized client with 4011 (sharding required), so the SDK counted the communities again and moved every shard to a larger plan. Every shard started a new session, so events sent during the move were missed",
        action: "No action is needed. If it repeats, the bot may be growing fast, and each move is logged with the new total",
    },
    "lifecycle.cacheRefill": {
        levels: ["info", "warn"],
        meaning:
            "Shards resumed sessions from the session store, which carry no community data, so the SDK refilled the enabled community, role and channel caches through REST. Warn means some communities failed or the refill stopped early",
        action: "At Warn, read the error. The affected cache entries fill as events and requests arrive",
    },
    "lifecycle.attempt": { levels: ["debug"], meaning: "A shard started a connection attempt" },
    "lifecycle.ready": { levels: ["info"], meaning: "A shard is ready and receives events" },
    "lifecycle.connected": {
        levels: ["info", "warn"],
        meaning:
            "Every shard of the client is connected, with the bot's name and the number of communities it is in. Warn means the bot is in no community yet",
        action: "At Warn, invite the bot to a community with the installation link in the message",
    },
    "lifecycle.retry": {
        levels: ["warn"],
        meaning: "A shard's connection attempt failed and will be retried after the delay",
        action: "Check network access if it repeats",
    },
    "lifecycle.connectionLost": {
        levels: ["warn"],
        meaning: "An established shard connection was lost and the SDK is reconnecting",
        action: "No action is needed unless it repeats",
    },
    "lifecycle.connectionEnded": {
        levels: ["error"],
        meaning:
            "A shard stopped for good, for example after a rejected token, an invalid shard setting or an exhausted recovery schedule",
        action: "Read the error's hint",
    },
    "lifecycle.sessionReset": {
        levels: ["warn"],
        meaning:
            "A shard's session can no longer resume, so the next connection starts a new session and missed events are lost",
    },
    "lifecycle.sessionRestored": {
        levels: ["info"],
        meaning: "A shard is resuming a session saved by the session store",
    },
    "lifecycle.sessionSaved": { levels: ["debug"], meaning: "A shard's session was saved for a later Resume" },
    "lifecycle.sessionSaveFailed": {
        levels: ["error"],
        meaning:
            "The session store's save function threw, rejected or timed out during shutdown, so the next start begins a new session",
        action: "Fix the session store's save function",
    },
    "lifecycle.sessionLoadFailed": {
        levels: ["error"],
        meaning: "The session store's load function threw, rejected or timed out, so the shard starts a new session",
        action: "Fix the session store's load function",
    },
    "lifecycle.sessionSnapshotIgnored": {
        levels: ["warn"],
        meaning:
            "A saved session was malformed, older than Fluxer's 60-second resume window, or saved for another gateway or shard count, so the shard starts a new session",
    },
    "lifecycle.identifyPermitFailed": {
        levels: ["error"],
        meaning:
            "The sharding.identify coordinator failed to let a shard start a new session, so the SDK retries the connection",
        action: "Fix the coordinator's permit function",
    },
    "lifecycle.domainMigration": {
        levels: ["debug", "info"],
        meaning:
            "The Fluxer instance announced a web domain migration. When it is switched on, links and OAuth URLs use the announced web app host (Info). A switched-off migration is Debug",
    },
    "lifecycle.observerCoalesced": {
        levels: ["debug"],
        meaning: "A connection-state observer was still busy, so an intermediate state was replaced by a newer one",
    },
    "lifecycle.observerFailed": {
        levels: ["debug", "error"],
        meaning: "A connection-state observer threw or rejected",
        action: "Fix the observer callback",
    },
    "lifecycle.stopRequested": { levels: ["info"], meaning: "A stop signal or process signal asked the bot to stop" },
    "lifecycle.botFailed": {
        levels: ["error"],
        meaning:
            "The runBot runner stopped because of a failure that no earlier record reported, and set the process exit code to 1. Setting reportFailure to false turns both off",
        action: "Read the error's hint",
    },
    "lifecycle.shutdown": { levels: ["info"], meaning: "The client began shutting down" },
    "lifecycle.draining": {
        levels: ["info"],
        meaning:
            "A shutdown with drainMs stopped accepting new events and waits for running handlers, waiting handler events and REST requests to finish",
    },
    "lifecycle.drained": {
        levels: ["info"],
        meaning: "All work running when the drain began finished in time, so shutdown continues without cancelling any",
    },
    "lifecycle.drainTimedOut": {
        levels: ["warn"],
        meaning:
            "The drain time ran out, so shutdown cancels the handlers, waiting events and REST requests that had not finished. The fields name how many",
        action: "Make handlers finish sooner, or raise drainMs if the process may take longer to stop",
    },
    "lifecycle.shutdownComplete": {
        levels: ["info"],
        meaning: "The client finished shutting down and released its resources",
    },
    "lifecycle.cleanupFailed": {
        levels: ["error"],
        meaning: "A cleanup step failed during shutdown. Shutdown still ran the remaining steps",
        action: "Report it with the record's error if the SDK owns the failing step",
    },
    "gateway.receive": { levels: ["trace"], meaning: "A gateway frame was received" },
    "gateway.send": { levels: ["trace"], meaning: "A gateway frame was sent" },
    "gateway.payloadReceived": {
        levels: ["trace"],
        meaning: "The masked body of a received gateway frame, printed only in unsafe payload mode",
    },
    "gateway.payloadSent": {
        levels: ["trace"],
        meaning: "The masked body of a sent gateway frame, printed only in unsafe payload mode",
    },
    "gateway.heartbeatAck": { levels: ["trace"], meaning: "Fluxer acknowledged a heartbeat" },
    "gateway.dispatch": { levels: ["debug"], meaning: "A dispatch event was received" },
    "gateway.commandSent": { levels: ["debug"], meaning: "A command passed to gateway.send was sent to the gateway" },
    "gateway.dispatchRejected": {
        levels: ["warn"],
        meaning: "A dispatch failed validation and was skipped. The failing field is in fields.field",
        action: "Report it if Fluxer's payloads changed, and include the field",
    },
    "gateway.unknownDispatch": {
        levels: ["debug"],
        meaning: "A dispatch type that this SDK version does not handle was ignored",
    },
    "gateway.unknownOpcode": {
        levels: ["debug"],
        meaning: "An opcode that this SDK version does not handle was ignored",
    },
    "gateway.identifyFilter": {
        levels: ["debug"],
        meaning: "A shard asked Fluxer not to send dispatch types that nothing uses",
    },
    "gateway.ignoredEventRegistered": {
        levels: ["warn"],
        meaning: "A handler was registered for an event type that the running shards asked Fluxer to suppress",
        action: "Register the handler before connecting, or remove the type from gateway.ignoredEvents",
    },
    "rest.request": {
        levels: ["debug"],
        meaning: "One REST attempt finished, with its route, status, duration and Fluxer error code",
    },
    "rest.retry": { levels: ["debug"], meaning: "A read is retried after a transient failure" },
    "rest.busy": {
        levels: ["warn"],
        meaning:
            "A REST request failed with reason busy because the REST queue or the upload byte budget was full. It is logged at most once a minute, and every busy failure is counted in diagnostics().counters.restBusy",
        action: "Send fewer requests at once, or raise the limit the message names",
    },
    "rest.rejected": {
        levels: ["warn"],
        meaning:
            "Fluxer rejected a request with HTTP 401 or 403, usually a token or permission problem that persists. The message names the target channel or community when the route has one. It is logged even when the application handles the Result. When a handler or command fails with this rejection within one second and no onError hook receives the failure, the handler's failure record reports it instead. A later handler failure also logs its own record, because the Warn has already been emitted. Webhook and OAuth clients log rejected webhook tokens and OAuth client credentials the same way",
        action: "Follow fields.hint. A bot that expects these rejections can lower the rest category level",
    },
    "rest.responseRejected": {
        levels: ["warn"],
        meaning:
            "A successful response to an SDK operation did not match the expected shape. The failing field or check is in fields.field",
        action: "Check test fixtures, or report it if Fluxer's responses changed",
    },
    "rest.payloadSent": {
        levels: ["trace"],
        meaning: "The masked body of a REST request, printed only in unsafe payload mode",
    },
    "rest.payloadReceived": {
        levels: ["trace"],
        meaning: "The masked body of a REST response, printed only in unsafe payload mode",
    },
    "ratelimit.wait": {
        levels: ["debug", "warn"],
        meaning: "A request was rate-limited and waits delayMs before retrying. Waits of a second or more are Warn",
        action: "Send fewer requests on that route if long waits repeat",
    },
    "ratelimit.deadline": {
        levels: ["debug", "warn"],
        meaning: "A rate-limit wait would pass the operation's timeout, so the request fails without waiting",
        action: "Raise timeoutMs, or send fewer requests on that route",
    },
    "events.handlerFailed": {
        levels: ["debug", "error"],
        meaning: "An event handler threw or failed. Other events keep running",
        action: "Fix the handler, or handle the failure with onError",
    },
    "events.hookFailed": {
        levels: ["error"],
        meaning: "An onError hook failed while it handled another failure",
        action: "Fix the onError hook",
    },
    "events.overflow": {
        levels: ["debug", "warn", "error"],
        meaning: "A subscription's queue exceeded its limit, so the subscription stopped",
        action: "Handle events faster, raise the pending limits or choose a dropping overflow policy",
    },
    "events.dropped": {
        levels: ["warn"],
        meaning: "A full subscription queue dropped an event under its overflow policy",
        action: "Handle events faster or raise the pending limits",
    },
    "events.raw": { levels: ["trace"], meaning: "A raw dispatch is being delivered to raw subscribers" },
    "events.registeredAfterShutdown": {
        levels: ["warn"],
        meaning: "A subscription was registered after shutdown began, so it starts closed",
        action: "Register handlers before shutting down",
    },
    "commands.executed": { levels: ["debug"], meaning: "A command finished" },
    "commands.rejected": {
        levels: ["debug"],
        meaning: "A command did not run because a guard denied it, its cooldown was active or an argument was invalid",
    },
    "commands.unmatched": {
        levels: ["debug"],
        meaning: "A message with the command prefix matched no command. The closest command is in fields.suggestion",
    },
    "commands.middlewareStopped": {
        levels: ["debug"],
        meaning: "A command did not run because middleware did not continue",
    },
    "commands.failed": {
        levels: ["debug", "error"],
        meaning: "A command threw or failed",
        action: "Fix the command, or handle the failure with the router's onError",
    },
    "commands.mentionPrefixUnavailable": {
        levels: ["warn"],
        meaning:
            "The bot user ID needed for mention prefixes could not be read, so mention commands are skipped for a while",
    },
    "collectors.callbackFailed": {
        levels: ["debug", "error"],
        meaning: "A collector callback threw or failed",
        action: "Fix the callback",
    },
    "collectors.filterFailed": {
        levels: ["debug", "error"],
        meaning: "A collector filter threw or returned a non-boolean",
        action: "Make the filter return true or false without throwing",
    },
    "collectors.failed": {
        levels: ["warn"],
        meaning: "A collector stopped because of a failure",
        action: "Read the collector's result for the error",
    },
    "collectors.dropped": {
        levels: ["debug"],
        meaning: "A full collector ignored an event while its last callback finished",
    },
    "cache.policyFailed": {
        levels: ["debug", "error"],
        meaning: "A message cache maxAgeMs function or a cache.onChange listener threw or returned an invalid value",
        action: "Fix that function or listener",
    },
    "cleanup.progressFailed": {
        levels: ["debug", "error"],
        meaning: "A message cleanup progress callback threw",
        action: "Fix the onProgress callback",
    },
    "supervisor.spawn": { levels: ["info"], meaning: "The supervisor started a child process" },
    "supervisor.spawnFailed": {
        levels: ["error"],
        meaning: "The supervisor could not start a child process",
        action: "Check the entry path and execArgv",
    },
    "supervisor.exit": {
        levels: ["info", "warn"],
        meaning: "A child process exited. Warn means it exited unexpectedly",
    },
    "supervisor.crash": {
        levels: ["error"],
        meaning:
            "A child process stopped unexpectedly and cannot be restarted, because restart is false or its restarts are used up, so the supervisor shuts down",
        action: "Read the child's output records before this one, and raise restart.maxAttempts or remove restart: false if restarts should continue",
    },
    "supervisor.restart": {
        levels: ["warn"],
        meaning: "The supervisor restarts a child after a crash, within the restart budget",
    },
    "supervisor.automaticSharding": {
        levels: ["info"],
        meaning:
            "The supervisor counted the bot's communities for totalShards auto and chose the shard count and child processes",
    },
    "supervisor.resharded": {
        levels: ["warn", "error"],
        meaning:
            "Fluxer closed a shard of a child with 4011 (sharding required) under totalShards auto. Warn means the supervisor stopped every child, counted the communities again and started a larger plan, so events sent during the move were missed. Error means it had already moved 3 times within an hour or reached 16,384 shards, so it shut down",
        action: "For Error, check why the community count keeps growing, or choose a larger numeric totalShards",
    },
    "supervisor.identifyPermitFailed": {
        levels: ["error"],
        meaning:
            "The supervisor's identify coordinator rejected or threw instead of granting a child permission to start a new session, so the child retries as after a network failure",
        action: "Fix the permit function of the identify.coordinator supervisor option",
    },
    "supervisor.childOutput": {
        levels: ["info", "warn"],
        meaning: "A child printed a line that is not a log record. Standard error lines are Warn",
    },
    "sdk.unknownDebugCategory": {
        levels: ["warn"],
        meaning: "FLUXERLY_DEBUG names categories that do not exist",
        action: "Use the category names listed in fields.known",
    },
    "sdk.unknownEnvironmentValue": {
        levels: ["warn"],
        meaning: "FLUXERLY_LOG_FORMAT or FLUXERLY_LOG_COLOR has a value that is not recognized, so it is ignored",
        action: "Use one of the values in fields.accepted",
    },
    "sdk.unsafePayloads": {
        levels: ["warn"],
        meaning:
            "Unsafe payload logging is on, so Trace records include gateway and REST payloads that can contain private content. Bot tokens and other secrets stay masked",
        action: "Turn it off outside local debugging",
    },
    "sdk.timerFailed": {
        levels: ["error"],
        meaning: "An internal timer callback failed",
        action: "Report it with the record's error",
    },
    "sdk.effectLog": {
        levels: ["trace", "debug", "info", "warn", "error", "fatal"],
        meaning: "An Effect log call inside the SDK",
    },
    "testing.unmatchedRequest": {
        levels: ["warn"],
        meaning: "A test client request matched no test route, so it received 404",
        action: "Add a route for the request",
    },
    "testing.responderFailed": {
        levels: ["error"],
        meaning: "A test route's responder threw, so the request failed as a network error",
        action: "Fix the responder",
    },
    "testing.socketsLeftOpen": {
        levels: ["warn"],
        meaning: "A test client left gateway sockets open after shutdown, and the test transport closed them",
    },
} as const satisfies Readonly<Record<string, LogCodeEntry>>

/** Every log record code the SDK emits */
export type LogCode = keyof typeof logCodes
