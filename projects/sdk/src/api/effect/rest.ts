import type * as Effect from "effect/Effect"
import type { RestRequest, RestRequestFailure, RestResponse } from "#sdk/rest"

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
     * Invalid input fails with RestRequestError reason input before any request, a non-2xx status fails with its status
     * and sanitized apiError, and closure fails with ClientClosedError. Message and resource caches are not updated.
     * Percent-encoded unreserved letters cannot bypass the reserved /v1 prefix or token-webhook route checks, which remain case-sensitive.
     * Network causes retain sanitized transport facts, not raw errors. Unknown uppercase provider codes remain in details.providerCode,
     * including on HTTP 429 when its wait exceeds the deadline.
     * Logs, metrics and spans name only the route template, never the query, body or response
     */
    request<T = unknown>(input: RestRequest): Effect.Effect<RestResponse<T>, RestRequestFailure>
}
