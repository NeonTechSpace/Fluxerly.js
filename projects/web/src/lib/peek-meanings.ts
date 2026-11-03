// Meanings of HTTP statuses, gateway close codes and log levels for the docs' hover peeks. Each source names the guide
// or reference section to review when the behavior changes, and its quote is a note of what that section said, not
// checked text. Codes the site does not explain, such as close code 4003, get no meaning and no peek

/** A guide section, a declaration or member of the JavaScript and TypeScript reference, or a reason on the codes page, with a note of the sentence that explains the code */
export type MeaningSource = { guide: string; anchor: string; quote: string } | { api: string; quote: string } | { codes: string; quote: string }

export interface Meaning {
    /** The peek's key, which is also the trigger's data-peek value */
    key: string
    /** The code as the peek names it, such as HTTP 401 */
    title: string
    /** What kind of code it is */
    kind: string
    meaning: string
    /** What to do about it */
    action?: string
    /** For a level, the records that appear at it */
    examples?: string
    /** The first source is where the peek links */
    sources: MeaningSource[]
}

const fiveHundreds = [500, 502, 503, 504]

export const httpStatuses: (Meaning & { status: number })[] = [
    {
        key: "http-204",
        status: 204,
        title: "HTTP 204",
        kind: "HTTP status",
        meaning: "A successful response without a value",
        sources: [{ guide: "glossary", anchor: "rest", quote: "HTTP 204 is a successful response without a value" }],
    },
    {
        key: "http-400",
        status: 400,
        title: "HTTP 400",
        kind: "HTTP status",
        meaning: "Fluxer refused the request as invalid or not allowed right now. The error's apiError, details.providerCode and hint say why, such as twoFactorRequired when a community requires two-factor authentication for moderation",
        action: "Read the error's apiError, details.providerCode and hint, then fix what they name",
        sources: [
            { guide: "reliability", anchor: "read-an-sdk-error", quote: "Every SDK error extends `FluxerlyError` with a stable `code`, an optional fix `hint`, safe `details` and a standard `cause`" },
            {
                guide: "troubleshooting",
                anchor: "a-moderation-action-fails-with-http-400",
                quote: "The community requires two-factor authentication for moderation, and the account that owns the bot's application does not have it enabled",
            },
        ],
    },
    {
        key: "http-401",
        status: 401,
        title: "HTTP 401",
        kind: "HTTP status",
        meaning: "Fluxer rejected a credential, usually the bot token, or a webhook or OAuth credential",
        action: "Check the credential that the error's hint names",
        sources: [
            { guide: "troubleshooting", anchor: "a-webhook-or-oauth-call-fails-with-http-401", quote: "can fail because Fluxer rejected a credential other than the bot token" },
            { guide: "logging", anchor: "look-up-a-record-code", quote: "Fluxer rejected a request with HTTP 401 or 403, usually a token or permission problem" },
        ],
    },
    {
        key: "http-403",
        status: 403,
        title: "HTTP 403",
        kind: "HTTP status",
        meaning: "Fluxer refused the request. HTTP 403 can indicate a missing permission or another restriction",
        action: "Check the error's apiError and hint for the reason. For a missing permission, grant the permissions named by the hint and requiredPermissions",
        sources: [
            { guide: "logging", anchor: "read-the-default-output", quote: "Fluxer reports that the bot lacks a required permission (MISSING_PERMISSIONS, HTTP 403)" },
            { guide: "logging", anchor: "read-the-default-output", quote: "For a missing permission, the hint and `requiredPermissions` name the permissions Fluxer checks for the operation" },
        ],
    },
    {
        key: "http-404",
        status: 404,
        title: "HTTP 404",
        kind: "HTTP status",
        meaning: "The resource does not exist or is not visible to this bot. Most operations report the reason notFound, while sends, replies and forwards report rejected. Use errors.isNotFound to recognize HTTP 404 across operations",
        sources: [{ codes: "reason-notfound", quote: "Fluxer answered HTTP 404. The resource does not exist or is not visible to this bot" }],
    },
    {
        key: "http-429",
        status: 429,
        title: "HTTP 429",
        kind: "HTTP status",
        meaning: "A rate limit was reached. The SDK waits for the delay Fluxer names and sends the request again when its body can be reused",
        action: "Nothing, unless waits repeat. A wait that would pass the request's deadline fails it at once",
        sources: [{ guide: "glossary", anchor: "rate-limit", quote: "Fluxer answers HTTP 429 when a limit is reached. The SDK then waits for the delay Fluxer names and sends the request again when its body can be reused" }],
    },
    // The guides say what the SDK does with these statuses, not what each one means
    ...fiveHundreds.map((status) => ({
        key: `http-${status}`,
        status,
        title: `HTTP ${status}`,
        kind: "HTTP status",
        meaning: "A GET request, or a call to threads.fetchPostData, that fails with it is retried at most twice within its deadline, except OAuth requests, which are never retried. Other requests are not sent again for this status",
        sources: [
            { guide: "reliability", anchor: "limits-and-retry-rules", quote: "A GET request, or a call to `threads.fetchPostData`, that fails with a network error or HTTP 500, 502, 503 or 504 is retried at most twice" },
            { guide: "reliability", anchor: "limits-and-retry-rules", quote: "so a write with an unknown outcome is never repeated automatically" },
        ],
    })),
]

export const closeCodes: (Meaning & { code: number })[] = [
    {
        key: "close-1000",
        code: 1000,
        title: "Close code 1000",
        kind: "WebSocket close code",
        meaning: "When the client sends this code to close intentionally, the session is destroyed. When the gateway sends it, the SDK reconnects and tries to resume",
        sources: [{ api: "SessionStore", quote: "uses 1000, which destroys the session" }],
    },
    {
        key: "close-4000",
        code: 4000,
        title: "Close code 4000",
        kind: "Gateway close code",
        meaning: "The gateway reported an unspecified error. The SDK reconnects and resumes the session",
        sources: [{ guide: "logging", anchor: "read-the-default-output", quote: "Close code 4000 (UNKNOWN_ERROR): The gateway reported an unspecified error. Reconnecting and resuming the session" }],
    },
    // The reference explains 4001 and 4002 together
    ...[4001, 4002].map((code) => ({
        key: `close-${code}`,
        code,
        title: `Close code ${code}`,
        kind: "Gateway close code",
        meaning: "Fluxer received an opcode it does not define, missing data or invalid command fields. The SDK treats it as permanent, so the client ends",
        action: "Send data that matches Fluxer's command schema exactly",
        sources: [
            { api: "GatewayCommands.send", quote: "Fluxer answers an opcode it does not define, missing data or invalid command fields with close code 4001 or 4002" },
        ],
    })),
    {
        key: "close-4004",
        code: 4004,
        title: "Close code 4004",
        kind: "Gateway close code",
        meaning: "Fluxer rejected the bot token. The SDK does not retry a rejected token",
        action: "Check that the configured value is the whole bot token, or regenerate the token",
        sources: [{ guide: "troubleshooting", anchor: "match-a-log-line-with-its-fix", quote: "`lifecycle.connectionEnded` with close 4004 | Fluxer rejected the bot token" }],
    },
    {
        key: "close-4010",
        code: 4010,
        title: "Close code 4010",
        kind: "Gateway close code",
        meaning: "The gateway rejected the shard assignment",
        action: "Configure sharding with the total shard count the gateway expects",
        sources: [
            {
                guide: "troubleshooting",
                anchor: "match-a-log-line-with-its-fix",
                quote: "`lifecycle.connectionEnded` with close 4011 or 4010 | The gateway requires more [shards](/docs/glossary/#shard), or rejected the shard assignment",
            },
        ],
    },
    {
        key: "close-4011",
        code: 4011,
        title: "Close code 4011",
        kind: "Gateway close code",
        meaning: "Sharding required. A shard may carry at most 2,500 communities",
        action: "Set sharding to \"auto\" for a bot in one process, which moves to more shards by itself",
        sources: [
            { guide: "sharding", anchor: "", quote: "Fluxer allows at most 2,500 communities per shard and refuses to start a new session" },
            { guide: "troubleshooting", anchor: "match-a-log-line-with-its-fix", quote: "Set `sharding: \"auto\"` for a bot in one process" },
        ],
    },
]

const levelsTable = { guide: "logging", anchor: "choose-levels-and-categories" }
const glossaryLevels = { guide: "glossary", anchor: "log-level" }

/** Log levels as the guides name them in prose, from least to most severe */
export const logLevels: (Meaning & { level: string })[] = [
    {
        key: "level-trace",
        level: "trace",
        title: "Trace",
        kind: "Log level",
        meaning: "Detail that is off by default",
        examples: "Heartbeats and every gateway opcode",
        sources: [
            { ...levelsTable, quote: "| `trace` | Heartbeats and every gateway opcode |" },
            { ...glossaryLevels, quote: "Trace and Debug for detail that is off by default" },
        ],
    },
    {
        key: "level-debug",
        level: "debug",
        title: "Debug",
        kind: "Log level",
        meaning: "Detail that is off by default",
        examples: "Each REST request and retry, gateway dispatches and rejected commands",
        sources: [
            { ...levelsTable, quote: "| `debug` | Every REST request with its route template, status and duration, retries, gateway dispatch summaries, rejected and unmatched commands |" },
            { ...glossaryLevels, quote: "Trace and Debug for detail that is off by default" },
        ],
    },
    {
        key: "level-info",
        level: "info",
        title: "Info",
        kind: "Log level",
        meaning: "Normal milestones, such as readiness. The default level",
        examples: "Startup, shard readiness and shutdown with its duration",
        sources: [
            { ...levelsTable, quote: "| `info` | Startup, shard readiness and shutdown with its duration |" },
            { ...levelsTable, quote: "The default level is `info`" },
            { ...glossaryLevels, quote: "Info for normal milestones such as readiness" },
        ],
    },
    {
        key: "level-warn",
        level: "warn",
        title: "Warn",
        kind: "Log level",
        meaning: "Problems the bot survives, such as a dropped event",
        examples: "Lost connections, session resets, long rate-limit waits and dropped events",
        sources: [
            {
                ...levelsTable,
                quote: "| `warn` | Lost connections, session resets, rate-limit waits of one second or more, rejected requests and responses, skipped malformed gateway events and dropped events |",
            },
            { ...glossaryLevels, quote: "Warn for problems the bot survives, such as a dropped event" },
        ],
    },
    {
        key: "level-error",
        level: "error",
        title: "Error",
        kind: "Log level",
        meaning: "Failures, such as a failed handler",
        examples: "Application errors, failed hooks, connections that cannot go on and failed cleanup",
        sources: [
            { ...levelsTable, quote: "| `error` | Application errors, failed hooks, connections that cannot continue and cleanup failures |" },
            { ...glossaryLevels, quote: "Error for failures, such as a failed handler" },
        ],
    },
    {
        key: "level-fatal",
        level: "fatal",
        title: "Fatal",
        kind: "Log level",
        meaning: "Only Fatal records",
        examples: "A failed handler, a failed hook and failed cleanup are Error records, so this level hides them",
        sources: [{ ...levelsTable, quote: "| `fatal` | Only Fatal records. Failed handlers, failed hooks and cleanup failures are Error records, so this level hides them |" }],
    },
]
