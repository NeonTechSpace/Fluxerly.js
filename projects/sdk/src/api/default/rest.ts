import type { ResultAsync } from "neverthrow"
import type { CancelledError, ConfigurationError } from "#sdk/errors"
import type { OperationOptions } from "#sdk/client"
import type { AttachmentInput } from "#sdk/attachments"
import type { RestRequestFailure, RestResponse } from "#sdk/rest"

/**
 * Send requests to Fluxer API routes that the SDK does not wrap, with the client's bot credential and its REST scheduler.
 * Calls start immediately, need no gateway connection and default to the client's rest.defaultTimeoutMs deadline.
 * Abort waits for cleanup and returns CancelledError. Unexpected failures reject with SdkDefect
 *
 * @category Client and lifecycle
 */
export interface RestRequests {
    /**
     * Send one request to a route under /v1 and resolve with its status, lower-case headers and parsed JSON body.
     * The request waits in the client's queue and learned rate-limit windows like wrapped operations, and fails at once
     * with reason rateLimit and the remaining wait as retryAfterMs when a window outlasts the deadline. A 429 is waited
     * out and sent again while the deadline allows. A GET is also retried at most twice after a network error, including
     * a connection lost while the response body arrives, or HTTP 500, 502, 503 or 504. Another method is never sent
     * again after an uncertain outcome.
     * The body is sent as given, including a lone surrogate, which Fluxer answers with HTTP 503.
     * Invalid input fails with RestRequestError reason input before any request, a non-2xx status fails with its status
     * and sanitized apiError, and closure fails with ClientClosedError. Message and resource caches are not updated.
     * Percent-encoded unreserved letters cannot bypass the reserved /v1 prefix or token-webhook route checks, which remain case-sensitive.
     * Network causes retain sanitized transport facts, not raw errors. Unknown uppercase provider codes remain in details.providerCode,
     * including on HTTP 429 when its wait exceeds the deadline.
     * Logs, metrics and spans name only the route template, never the query, body or response
     */
    request<T = unknown>(
        input: RestRequest,
    ): ResultAsync<RestResponse<T>, RestRequestFailure | CancelledError | ConfigurationError>
}

/**
 * One request to a Fluxer API route that the SDK does not wrap, sent with the client's bot credential through the same
 * queue, rate-limit learning, 429 waits, deadline, logging and cancellation as wrapped operations.
 * Invalid input fails before dispatch with RestRequestError reason input. A GET that fails with a network error or
 * HTTP 500, 502, 503 or 504 is retried at most twice. Another method is sent again only after Fluxer confirms a rate
 * limit with HTTP 429, so a write with an unknown outcome is never repeated automatically.
 * Message and resource caches are neither read nor updated, and Fluxer's rate limits and permissions still apply
 *
 * Aborting the signal stops waiting and cancels the HTTP exchange, but cannot undo a request Fluxer already received
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
export interface RestRequest extends OperationOptions {
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
