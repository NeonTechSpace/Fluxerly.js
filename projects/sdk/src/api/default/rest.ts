import type { ResultAsync } from "neverthrow"
import type { CancelledError, ConfigurationError } from "#sdk/errors"
import type { OperationOptions } from "#sdk/client"
import type { AttachmentInput } from "#sdk/attachments"
import type {
    RestCallArguments,
    RestRequestFailure,
    RestResponse,
    RestRoute,
    RestRouteInput,
    RestRouteOptions,
    RestRouteResponse,
} from "#sdk/rest"

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
     * Logs, metrics and spans name only the route template, never the query. They leave out the body and response too,
     * unless logging.unsafe prints payloads for the rest category, which logs masked request and response bodies
     */
    request<T = unknown>(
        input: RestRequest,
    ): ResultAsync<RestResponse<T>, RestRequestFailure | CancelledError | ConfigurationError>

    /**
     * Send one request to a route of Fluxer's API description, checked at compile time: The route is its method and
     * path template, such as `POST /channels/{channel_id}/messages`, and params, query and body take Fluxer's official
     * field names. The response body has the route's type. These types come from Fluxer's API description at the
     * commit this release pins, with reviewed corrections where Fluxer's server sends or accepts something else, such
     * as public routes the description lists without a bot token that Fluxer answers for a bot too. They do not cover
     * later routes or fields, and the response is not checked at runtime.
     * Each path parameter is percent-encoded as one segment, and a missing, extra or empty one fails with
     * RestRequestError reason input before any request. Only the compiler checks that a route is listed, and at runtime
     * any route is sent whose filled path request accepts. The request then follows every rule of request, through the
     * same queue, rate limits, retries, deadline, logging and RestRequestError failures, with operation rest.request
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function recentContents(client: Client, channelId: string) {
     *     const result = await client.rest.call("GET /channels/{channel_id}/messages", {
     *         params: { channel_id: channelId },
     *         query: { limit: 10 },
     *     })
     *     return result.map((response) => response.body.map((message) => message.content))
     * }
     * ```
     */
    call<R extends RestRoute>(
        route: R,
        ...input: RestCallArguments<R, RestCallInput<R>>
    ): ResultAsync<RestResponse<RestRouteResponse<R>>, RestRequestFailure | CancelledError | ConfigurationError>
}

/**
 * The second argument of client.rest.call: The route's fields, the shared options and an optional abort signal
 *
 * @category Client and lifecycle
 */
export type RestCallInput<R extends RestRoute> = RestRouteInput<R> & RestRouteOptions & OperationOptions

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
     * and booleans are sent as true or false. An array sends its name once per item in order, such as
     * `{ tag: ["1", "2"] }` for `tag=1&tag=2`, and an empty array sends nothing. The encoded query may contain at most
     * 8,192 characters
     */
    readonly query?: Readonly<
        Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>
    >
    /** JSON body, serialized when the request starts. A value JSON cannot represent fails with reason input.
     * Its size counts against the client's queued JSON budget while the request waits. Not allowed with GET
     */
    readonly body?: unknown
    /** Files sent inline as multipart/form-data, with the JSON body as payload_json and each file as files[n] in order.
     * Accepts the same byte, file and stream inputs as message attachments, with the same size, filename and upload-budget
     * rules. The body must then be omitted or a JSON object. The SDK sends body.attachments as Fluxer's message routes
     * expect: The body's entries for existing attachments first, which an edit must list to keep them, then each file's
     * metadata with id n. A body entry whose id is a file's index may add that file's title or description and repeat
     * its filename or flags. A value that differs from the file's own, two entries for one file or another key there
     * fail with reason input.
     * A request whose file source cannot be read again fails with reason rateLimit instead of waiting out a 429.
     * Not allowed with GET
     */
    readonly files?: readonly AttachmentInput[]
    /** Audit-log reason sent as the X-Audit-Log-Reason header, 1 through 512 UTF-16 code units after
     * U+000C and U+202E removal and trimming, which Fluxer otherwise drops silently. Any language works, because the header carries its UTF-8 bytes. Control characters, line separators and lone
     * surrogates fail before dispatch. Omission sends no header. Never included in errors, logs or diagnostics
     */
    readonly auditReason?: string
    /** Total milliseconds across local queueing, rate-limit waits, retries and HTTP. An integer from 1 through
     * 2,147,483,647, defaulting to the client's rest.defaultTimeoutMs (30,000 unless configured).
     * Owned cleanup is awaited afterward, so completion can take longer
     */
    readonly timeoutMs?: number
}
