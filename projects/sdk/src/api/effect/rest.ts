import type * as Effect from "effect/Effect"
import type {
    RestCallArguments,
    RestCallInput,
    RestRequest,
    RestRequestFailure,
    RestResponse,
    RestRoute,
    RestRouteResponse,
} from "#sdk/rest"

/**
 * Send requests to Fluxer API routes that the SDK does not wrap, with the client's bot credential and its REST scheduler.
 * Effects start when run, need no gateway connection and default to the client's rest.defaultTimeoutMs deadline.
 * Interruption and unexpected faults remain in Cause rather than becoming RestRequestError
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
    request<T = unknown>(input: RestRequest): Effect.Effect<RestResponse<T>, RestRequestFailure>

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
     * import * as Effect from "effect/Effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const recentContents = (client: Client, channelId: string) =>
     *     client.rest
     *         .call("GET /channels/{channel_id}/messages", { params: { channel_id: channelId }, query: { limit: 10 } })
     *         .pipe(Effect.map((response) => response.body.map((message) => message.content)))
     * ```
     */
    call<R extends RestRoute>(
        route: R,
        ...input: RestCallArguments<R, RestCallInput<R>>
    ): Effect.Effect<RestResponse<RestRouteResponse<R>>, RestRequestFailure>
}
