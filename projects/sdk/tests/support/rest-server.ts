import { once } from "node:events"
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http"
import { onTestFinished } from "vitest"

/** One request received by a loopback REST fixture */
export interface RecordedRequest {
    readonly method: string
    /** Path without the query string, such as /v1/channels/20/messages */
    readonly path: string
    readonly query: URLSearchParams
    readonly headers: IncomingHttpHeaders
    /** Raw body text, empty when none was sent */
    readonly text: string
    /** Body parsed as JSON, or undefined when it is empty or not JSON */
    readonly body: unknown
    /** Whether the client aborted before sending the whole body. An aborted request reaches no route handler */
    readonly aborted: boolean
}

export type RouteHandler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>

export interface RestServer {
    readonly server: Server
    /** http://127.0.0.1:port */
    readonly origin: string
    /** Every received request in arrival order */
    readonly requests: RecordedRequest[]
    /** Requests received for one "METHOD /path" key */
    requestsTo(key: string): RecordedRequest[]
}

function parse(text: string): unknown {
    if (text === "") return undefined
    try {
        return JSON.parse(text)
    } catch {
        // Non-JSON bodies, such as multipart uploads, stay available through text
        return undefined
    }
}

/**
 * Start a loopback HTTP server with exact "METHOD /path" routes and a request log.
 * Unrouted requests without a fallback receive 404. The server closes when the current test finishes
 */
export async function startRestServer(
    options: { readonly routes?: Readonly<Record<string, RouteHandler>>; readonly fallback?: RouteHandler } = {},
): Promise<RestServer> {
    const routes = new Map(Object.entries(options.routes ?? {}))
    const requests: RecordedRequest[] = []
    const server = createServer(async (incoming, response) => {
        let text = ""
        let aborted = false
        try {
            for await (const chunk of incoming) text += chunk.toString()
        } catch {
            // An upload the client cut off, such as a cancelled attachment, is recorded rather than thrown
            aborted = true
        }
        const url = new URL(incoming.url ?? "/", "http://fixture")
        const request: RecordedRequest = {
            method: incoming.method ?? "GET",
            path: url.pathname,
            query: url.searchParams,
            headers: incoming.headers,
            text,
            body: aborted ? undefined : parse(text),
            aborted,
        }
        requests.push(request)
        if (aborted) return
        const handler = routes.get(`${request.method} ${request.path}`) ?? options.fallback
        if (handler) return handler(request, response)
        response.writeHead(404).end()
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing loopback fixture port")
    onTestFinished(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        server,
        origin: `http://127.0.0.1:${address.port}`,
        requests,
        requestsTo: (key) => requests.filter((request) => `${request.method} ${request.path}` === key),
    }
}

/** Reply with a JSON body */
export function sendJson(
    response: ServerResponse,
    body: unknown,
    status = 200,
    headers: Readonly<Record<string, string>> = {},
): void {
    response.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body))
}

export interface RateLimitOptions {
    /** Seconds the provider asks the client to wait, written to Retry-After and the body */
    readonly retryAfterSeconds?: number
}

export interface BucketHeaders {
    readonly bucket: string
    readonly remaining: number
    readonly resetAfterSeconds: number
    readonly limit?: number
}

/** X-RateLimit bucket headers as Fluxer sends them */
export function rateLimitHeaders(state: BucketHeaders): Record<string, string> {
    return {
        "x-ratelimit-bucket": state.bucket,
        "x-ratelimit-remaining": String(state.remaining),
        "x-ratelimit-reset-after": String(state.resetAfterSeconds),
        ...(state.limit === undefined ? {} : { "x-ratelimit-limit": String(state.limit) }),
    }
}

/** A 429 Response for fetch-stub fixtures */
export function rateLimitedResponse(options: RateLimitOptions = {}): Response {
    const retryAfter = options.retryAfterSeconds ?? 1
    return new Response(JSON.stringify({ retry_after: retryAfter, global: false }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(Math.ceil(retryAfter)) },
    })
}
