import type { AttachmentInput } from "./attachments.js"
import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorFields, operationErrorSettings, operationErrorText, type ApiErrorDetail } from "./api-errors.js"
import { FluxerlyError, type OperationErrorOptions, type OperationOutcome, type OperationReason } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/**
 * Tune how many REST requests one client runs and queues, and the deadline an operation gets when it omits timeoutMs.
 * Every limit is local to the client: Clients, processes and webhook or OAuth clients sharing a credential do not
 * share these slots. Invalid values throw ConfigurationError from default createClient, naming the field, and are
 * defects in the Effect createClient. Diagnostics report the configured capacities under rest
 *
 * @example
 * ```ts
 * import { createClient } from "@neontechspace/fluxerly"
 * export const client = createClient({
 *     token: "fixture-only-not-a-credential",
 *     rest: { concurrency: 8, maxQueued: 512, defaultTimeoutMs: 15_000 },
 * })
 * ```
 *
 * @category Options
 */
export interface RestOptions {
    /** Fluxer API requests, including signed attachment upload parts, that may run at once.
     * An integer from 1 through 64. The default is 4 for each shard this client runs, up to 64, and follows the plan
     * when automatic sharding sizes or enlarges it. A set value is used as given, whatever the shard count.
     * Raising it does not raise Fluxer's rate limits, which still apply per route
     * @defaultValue 4 per local shard, at most 64
     */
    readonly concurrency?: number
    /** Attachment downloads that may run at once, in slots separate from API requests so a lazy upload source can still
     * read its own attachment. An integer from 1 through 64, default 4
     */
    readonly mediaConcurrency?: number
    /** Requests of both kinds that may wait for a slot or a rate-limit window. A request that finds the queue full fails
     * immediately with reason busy and outcome notDispatched, and the first such failure in a minute logs rest.busy at
     * Warn. An integer from 1 through 65,536, default 256
     */
    readonly maxQueued?: number
    /** JSON request-body bytes that waiting requests may hold together, excluding attachment transfers.
     * A request whose JSON does not fit fails immediately with reason busy, so this also caps the largest single JSON body.
     * An integer from 65,536 (64 KiB) through 268,435,456 (256 MiB), default 4,194,304 (4 MiB)
     */
    readonly queuedJsonMaxBytes?: number
    /** Deadline in milliseconds for a REST operation or attachment download that omits timeoutMs. It covers local
     * queueing, rate-limit waits, retries and HTTP. An integer from 1 through 2,147,483,647, default 30,000
     */
    readonly defaultTimeoutMs?: number
}

/**
 * Options the gateway passes to a custom WebSocket factory for each connection it opens.
 * A factory that uses the ws library can pass them to its constructor unchanged
 *
 * @category Options
 */
export interface WebSocketOptions {
    /** Always false: Compression is never negotiated, so received sizes are wire sizes */
    readonly perMessageDeflate: false
    /** Always false: The gateway URL is used as given and a redirect fails the connection attempt */
    readonly followRedirects: false
    /** Largest accepted message in bytes. The socket must reject a larger message, including fragments, before decoding it */
    readonly maxPayload: number
    /** Handshake headers to send. Contains the client's User-Agent */
    readonly headers: Readonly<Record<string, string>>
}

/**
 * The subset of a ws WebSocket that the gateway uses. A custom WebSocket factory returns this shape.
 * Connection failures must arrive as error or close events, never as synchronous throws from send or the factory
 *
 * @category Options
 */
export interface WebSocketLike {
    /** Ready state in the ws and WHATWG numbering: 0 connecting, 1 open, 2 closing, 3 closed */
    readonly readyState: number
    /** Send one text frame, then call callback once, with an error when the frame could not be written */
    send(data: string, callback: (error?: Error) => void): void
    /** Start a close handshake with the given WebSocket close code. The close event follows */
    close(code: number): void
    /** Drop the connection immediately without a close handshake. The close event follows */
    terminate(): void
    /** Receive each message with binary true for binary frames. Text arrives as bytes, as ws delivers it (a Buffer is a Uint8Array), or as a string */
    on(
        event: "message",
        listener: (data: Uint8Array | ArrayBuffer | readonly Uint8Array[] | string, binary: boolean) => void,
    ): unknown
    /** Receive transport failures. An optional code identifies local receive rejections such as oversized messages */
    on(event: "error", listener: (error: Error & { code?: string }) => void): unknown
    /** Receive the close code once the connection has closed */
    on(event: "close", listener: (code: number) => void): unknown
    /** Receive the next close once, used while waiting for a close handshake to finish */
    once(event: "close", listener: () => void): unknown
    /** Remove a message listener added with on */
    off(
        event: "message",
        listener: (data: Uint8Array | ArrayBuffer | readonly Uint8Array[] | string, binary: boolean) => void,
    ): unknown
    /** Remove an error listener added with on */
    off(event: "error", listener: (error: Error & { code?: string }) => void): unknown
    /** Remove a close listener added with on or once */
    off(event: "close", listener: (() => void) | ((code: number) => void)): unknown
}

/**
 * Replace the HTTP and WebSocket implementations one client uses, or the User-Agent it sends.
 * This is an advanced option for proxies, instrumentation and tests, and most bots omit it.
 * Replacements receive every request the client makes, including instance discovery, REST, signed attachment upload
 * parts, attachment downloads and gateway connections, so they see the bot token in Authorization headers and must
 * protect it. The SDK keeps its own redirect, deadline, cancellation, size and rate-limit policies around them.
 * Invalid values throw ConfigurationError from default createClient, naming the field, and are defects in the
 * Effect createClient
 *
 * @example
 * ```ts
 * import { createClient } from "@neontechspace/fluxerly"
 * export const client = createClient({
 *     token: "fixture-only-not-a-credential",
 *     transport: { userAgent: "ExampleBot/1.0 (+https://example.test/bot)" },
 * })
 * ```
 *
 * @category Options
 */
export interface TransportOptions {
    /** Fetch-compatible function for every HTTP request, called without a this value. It must honour init.signal and
     * init.redirect as the platform fetch does, and settle with a Response or reject. A rejection or synchronous throw
     * is a network failure of that request. Defaults to the platform fetch
     */
    readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
    /** Open one gateway WebSocket for the URL, applying every WebSocketOptions setting. It must return a WebSocketLike
     * synchronously and report connection failures as error or close events. A synchronous throw or an unusable return
     * value is an SDK defect. Defaults to the ws library
     */
    readonly webSocket?: (url: string, options: WebSocketOptions) => WebSocketLike
    /** User-Agent header sent with every HTTP request and gateway handshake, replacing the default
     * `Fluxerly.js/<version> (+<SDK homepage>)`. From 1 through 512 printable ASCII characters without leading or
     * trailing spaces
     */
    readonly userAgent?: string
}

/**
 * One request to a Fluxer API route that the SDK does not wrap, sent with the client's bot credential through the same
 * queue, rate-limit learning, 429 waits, deadline, logging and cancellation as wrapped operations.
 * Invalid input fails before dispatch with RestRequestError reason input. A GET that fails with a network error or
 * HTTP 500, 502, 503 or 504 is retried at most twice. Another method is sent again only after Fluxer confirms a rate
 * limit with HTTP 429, so a write with an unknown outcome is never repeated automatically.
 * Message and resource caches are neither read nor updated, and Fluxer's rate limits and permissions still apply
 *
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export async function currentUserName(client: Client): Promise<string | undefined> {
 *     const result = await client.rest.request<{ username: string }>({ method: "GET", path: "/users/@me" })
 *     return result.isOk() ? result.value.body.username : undefined
 * }
 * ```
 *
 * @category Client and lifecycle
 */
export interface RestRequest {
    /** HTTP method. Only POST, PUT, PATCH and DELETE may carry a body or files */
    readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
    /** API path after /v1, such as /users/@me, of at most 2,048 characters. It must start with one slash and contain
     * only URL path characters with valid percent escapes, without empty, dot or dot-dot segments, a query or a fragment.
     * The /v1 prefix and token-authenticated webhook routes (/webhooks/{id}/{token}) are rejected, including percent-encoded
     * unreserved characters in those route names. These checks are case-sensitive and do not decode reserved characters.
     * Logs, metrics and spans name the route with numeric IDs and other non-word segments replaced by placeholders
     */
    readonly path: string
    /** Query parameters appended to the path in insertion order. Undefined values are omitted, numbers must be finite,
     * and booleans are sent as true or false. The encoded query may contain at most 8,192 characters
     */
    readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
    /** JSON body, serialized when the request starts. A value JSON cannot represent fails with reason input.
     * Its size counts against the client's queued JSON budget while the request waits. Not allowed with GET
     */
    readonly body?: unknown
    /** Files sent inline as multipart/form-data, with the JSON body as payload_json and each file as files[n] in order.
     * Accepts the same byte, file and stream inputs as message attachments, with the same size, filename and upload-budget
     * rules. The body must then be omitted or a JSON object without attachments, because the SDK sets attachments to
     * the files' metadata as Fluxer's message routes expect. A request whose file source cannot be read again fails
     * with reason rateLimit instead of waiting out a 429. Not allowed with GET
     */
    readonly files?: readonly AttachmentInput[]
    /** Audit-log reason sent as the X-Audit-Log-Reason header, 1 through 512 printable ASCII characters after trimming.
     * Omission sends no header. Never included in errors, logs or diagnostics
     */
    readonly auditReason?: string
    /** Total milliseconds across local queueing, rate-limit waits, retries and HTTP. An integer from 1 through
     * 2,147,483,647, defaulting to the client's rest.defaultTimeoutMs (30,000 unless configured).
     * Owned cleanup is awaited afterward, so completion can take longer
     */
    readonly timeoutMs?: number
}

/**
 * A default-API REST request with optional cancellation.
 * Aborting stops waiting and cancels the HTTP exchange, but cannot undo a request Fluxer already received
 *
 * @category Client and lifecycle
 */
export interface DefaultRestRequest extends RestRequest, OperationOptions {}

/**
 * A successful response from client.rest.request, for any 2xx status
 *
 * @category Client and lifecycle
 */
export interface RestResponse<T = unknown> {
    /** HTTP status from 200 through 299 */
    readonly status: number
    /** Response headers with lower-case names. Repeated headers are joined with a comma and space as fetch does */
    readonly headers: Readonly<Record<string, string>>
    /** The parsed JSON body, or undefined when the response has no body. The type parameter is not checked at runtime,
     * so decode the value before trusting its shape. A body over 16 MiB or one that is not valid JSON fails the request
     * with reason response
     */
    readonly body: T
}

/**
 * Operation name included in REST request failures
 *
 * @category Errors
 */
export type RestOperation = "rest.request"

/**
 * Expected failure of client.rest.request.
 * Reason input means the request object was invalid and nothing was sent, and reason busy means the client's local queue
 * was full. Reason notFound means HTTP 404, and reason rejected means another non-2xx status, with the sanitized Fluxer
 * error in apiError. Reason rateLimit means a required wait would pass the deadline or could not be completed.
 * Reasons network, timeout and response describe transport failures, the deadline and unusable success bodies. Check outcome before repeating a write.
 * Default API calls return it in an Err and Effect calls fail with it. Errors never include the path, query,
 * body, headers or response body
 *
 * @category Errors
 */
export class RestRequestError extends FluxerlyError {
    /** Stable expected-failure discriminator */
    readonly _tag = "RestRequestError"
    /** Requested operation, always rest.request */
    readonly operation: RestOperation
    /** Failure category, described by {@link OperationReason} */
    readonly reason: OperationReason
    /** Whether the request may have reached Fluxer, described by {@link OperationOutcome} */
    readonly outcome: OperationOutcome
    /** HTTP status when a response was received, otherwise null */
    readonly status: number | null
    /** Usable server-required retry wait in milliseconds, otherwise null */
    readonly retryAfterMs: number | null
    /** Safe classification of why Fluxer rejected the request, or null when the response could not be classified */
    readonly apiError: ApiErrorDetail | null
    /** Safe explanation of the locally invalid request field, or null when the failure was not an input failure */
    readonly inputValidation: InputValidationDetail | null

    /** Create the failure from its operation, reason and outcome, with optional status, retry wait, API detail, input detail and cause */
    constructor(options: OperationErrorOptions<RestOperation>) {
        const fields = operationErrorFields(options)
        super(operationErrorText("REST request", fields), operationErrorSettings("rest", fields, options.cause))
        this.operation = fields.operation
        this.reason = fields.reason
        this.outcome = fields.outcome
        this.status = fields.status
        this.retryAfterMs = fields.retryAfterMs
        this.apiError = fields.apiError
        this.inputValidation = freezeInputValidationDetail(fields.inputValidation)
        this.name = this._tag
    }
}

/**
 * Expected REST request failures in both APIs. Native interruption is outside this union, and default API calls
 * additionally return CancelledError and ConfigurationError for a malformed signal
 *
 * @category Errors
 */
export type RestRequestFailure = RestRequestError | ClientClosedError
