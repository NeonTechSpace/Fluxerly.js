/**
 * Public types of the testing entry points, shared by the default and native test clients.
 * Invariant: This module declares types only and imports nothing that needs Node.js or Effect declarations, so both
 * testing entry points compile in consumers that lack those type packages, as their main entry points do.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { WireUser } from "./fixtures.js"

/**
 * Settings that only test clients accept, alongside the usual client options
 *
 * @category Testing
 */
export interface TestSettings {
    /** Token passed to the client, default the fixture token. The fake transport never sends it anywhere */
    readonly token?: string
    /** Bot account the test gateway reports in READY, default the test client's fixtures.botUser() */
    readonly user?: WireUser
    /**
     * Heartbeat interval in milliseconds sent in HELLO, default 41,250 as on hosted Fluxer.
     * The client heartbeats on its own timer, which shutdown stops
     */
    readonly heartbeatIntervalMs?: number
}

/**
 * Choose the shard that receives an emitted dispatch
 *
 * @category Testing
 */
export interface TestEmitOptions {
    /**
     * Local shard ID that receives the dispatch.
     * By default a payload with a guild_id goes to the shard Fluxer routes that community to, (guild_id >> 22) % totalShards,
     * and any other payload goes to shard 0, which receives direct-message traffic
     */
    readonly shardId?: number
}

/**
 * Choose how the test gateway ends one shard's connection
 *
 * @category Testing
 */
export interface TestDisconnectOptions {
    /** Local shard ID whose connection closes, default 0 */
    readonly shardId?: number
    /**
     * WebSocket or gateway close code the client receives, default 4000 (unknown error), after which the SDK reconnects
     * and resumes. A fatal code such as 4004 ends the client's connection lifetime instead
     */
    readonly code?: number
}

/**
 * One gateway command a client sent to the test gateway, in send order.
 * Identify and Resume carry "[redacted]" in place of the token
 *
 * @category Testing
 */
export interface TestGatewayCommand {
    /** Shard that sent the command, or null when it came before the socket identified or resumed */
    readonly shardId: number | null
    /** Gateway opcode, such as 2 for Identify, 3 for Presence Update or 8 for Request Guild Members */
    readonly op: number
    /** Command data as sent, parsed from JSON */
    readonly d: unknown
}

/**
 * One attachment part of a recorded multipart request
 *
 * @category Testing
 */
export interface TestRequestFile {
    /** Form field name, such as files[0] */
    readonly field: string
    /** Uploaded file name */
    readonly filename: string
    /** Declared content type */
    readonly contentType: string
    /** Size in bytes */
    readonly size: number
}

/**
 * One HTTP request a test client sent, as recorded by the test transport and passed to response handlers.
 * The record never contains the Authorization header, and a webhook token in the path reads "[redacted]"
 *
 * @category Testing
 */
export interface TestRequest {
    /** Upper-case HTTP method */
    readonly method: string
    /** Absolute request URL, including the query string */
    readonly url: string
    /**
     * Fluxer API path after the /v1 prefix and without the query string, such as /channels/1/messages.
     * Requests to other origins, such as media downloads, use the absolute URL without its query string
     */
    readonly path: string
    /** Query parameters. A repeated parameter keeps its last value */
    readonly query: Readonly<Record<string, string>>
    /** Request headers with lower-case names, without authorization */
    readonly headers: Readonly<Record<string, string>>
    /**
     * Request body: Parsed JSON for JSON requests, the parsed payload_json part of a multipart upload, the text of any
     * other body, or undefined when the request has none
     */
    readonly body: unknown
    /** Attachment parts of a multipart upload, empty for other requests */
    readonly files: readonly TestRequestFile[]
    /** Whether a registered response answered the request. False means it received the default 404 */
    readonly matched: boolean
}

/**
 * Select the requests a registered response answers.
 * A string is "METHOD /path" or "/path" for any method, where a :name segment matches any single path segment, such as
 * "POST /channels/:id/messages". A string starting with http matches an absolute URL on another origin.
 * A RegExp is tested against the path. An object combines an optional method with a string or RegExp path,
 * and a function decides from the whole request
 *
 * @category Testing
 */
export type TestRequestMatcher =
    | string
    | RegExp
    | {
          /** HTTP method to match, case-insensitive. Omit it to match every method */
          readonly method?: string
          /** Path pattern with the string or RegExp rules above */
          readonly path: string | RegExp
      }
    | ((request: TestRequest) => boolean)

/**
 * A response description. Omitted fields default to status 200 with a JSON body, or status 204 when body is omitted.
 * A Response object is used unchanged for bodies that are not JSON
 *
 * @category Testing
 */
export type TestResponse =
    | {
          /** HTTP status from 200 through 599 */
          readonly status?: number
          /** Response headers, such as Retry-After or X-RateLimit-Bucket */
          readonly headers?: Readonly<Record<string, string>>
          /** Value sent as the JSON response body, usually a wire fixture. Omit it for an empty body */
          readonly body?: unknown
      }
    | Response

/**
 * Compute a response from the recorded request. A returned promise may settle later, and a handler that throws or
 * rejects makes the request fail as a network error, which the client reports like any transport failure
 *
 * @category Testing
 */
export type TestResponder = (request: TestRequest) => TestResponse | Promise<TestResponse>

/**
 * One registered response. Registrations are searched newest first, so a later registration overrides an earlier one
 * for the requests both match
 *
 * @category Testing
 */
export interface TestRoute {
    /** Requests this registration answered so far, in order */
    requests(): readonly TestRequest[]
    /**
     * Resolve with the next request this registration answers. Each call returns a different request, in order, so
     * a request that arrived before the call is returned at once.
     * The promise rejects with TestTimeoutError when no request arrives within the timeout, default 2,000 ms, and
     * with ClientClosedError when the test client shuts down first. Invalid options throw ConfigurationError
     */
    next(options?: TestWaitOptions): Promise<TestRequest>
    /** Stop answering requests. Earlier matching registrations and the default 404 apply again */
    remove(): void
}

/**
 * Limit how long a test wait, such as TestRoute.next or idle, may take
 *
 * @category Testing
 */
export interface TestWaitOptions {
    /** Milliseconds before the wait fails with TestTimeoutError, an integer from 1 through 2,147,483,647, default 2,000.
     * The timeout uses real timers, so it still fires when a test fakes timers
     */
    readonly timeoutMs?: number
}

/**
 * Register fake Fluxer HTTP API responses for a test client
 *
 * @category Testing
 */
export interface TestRest {
    /**
     * Answer matching requests with a fixed response or a handler's response until the registration is removed.
     * The newest matching registration wins. Invalid matchers or responses throw ConfigurationError
     *
     * @example
     * ```ts
     * import { createTestClient } from "@neontechspace/fluxerly/testing"
     * export function respondExample() {
     *     const test = createTestClient()
     *     test.rest.respond("GET /users/@me", { body: test.fixtures.botUser() })
     *     return test.rest.respond("POST /channels/:id/messages", (request) => ({
     *         body: test.fixtures.message({ content: String((request.body as { content?: unknown }).content) }),
     *     }))
     * }
     * ```
     */
    respond(matcher: TestRequestMatcher, response: TestResponse | TestResponder): TestRoute
}
