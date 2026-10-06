/**
 * In-memory HTTP transport for test clients: Instance discovery, registered REST responses and the request record.
 * Invariant: No request leaves the process. The hosted discovery bootstrap is answered directly, every other request is
 * recorded without its Authorization header or webhook token and answered by the newest matching registration. An
 * unmatched message send or edit receives an echoed bot message, and any other unmatched request receives a
 * Fluxer-shaped 404 together with a Warn record. Cancellation settles a pending handler's request at once with the
 * signal's reason.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import type { LogRecord } from "#sdk/logging"
import { hostedDiscoveryDocument, hostedDiscoveryUrl } from "./discovery.js"
import { fixtureTimestamp, type Fixtures, type WireMessage, type WireUser } from "./fixtures.js"
import type {
    TestRequest,
    TestRequestFile,
    TestRequestMatcher,
    TestResponder,
    TestResponse,
    TestRest,
    TestRoute,
    TestWaitOptions,
} from "./types.js"
import { timedWait, waitTimeout } from "./wait.js"

interface Route {
    readonly matches: (request: TestRequest) => boolean
    readonly response: TestResponse | TestResponder
    readonly answered: TestRequest[]
    /** How many answered requests next already returned */
    taken: number
    /** Pending next calls, oldest first */
    readonly waiters: Set<(request: TestRequest) => void>
    active: boolean
}

/** A registered route with the abort signal the native entry point passes to next for interruption */
export interface InternalTestRoute extends TestRoute {
    next(options?: TestWaitOptions, signal?: AbortSignal): Promise<TestRequest>
}

const apiBase = `${hostedDiscoveryDocument.endpoints.api_public}/v1`
/** Hosted discovery with presigned uploads off, so an attachment upload arrives as one recorded multipart request */
const testDiscoveryDocument = Object.freeze({
    ...hostedDiscoveryDocument,
    features: Object.freeze({ presigned_attachment_uploads: false }),
})
const nullBodyStatuses = new Set([204, 205, 304])

function redactWebhookToken(text: string): string {
    return text.replace(/(\/webhooks\/\d+\/)[^/?#]+/g, "$1[redacted]")
}

/** The fixtures and bot account that automatic message replies are built from */
export interface TestReplies {
    readonly fixtures: Fixtures
    readonly author: WireUser
}

const isMessageSend = (request: Pick<TestRequest, "method" | "path">) =>
    request.method === "POST" && pathPattern("/channels/:channel/messages")(request.path)
const isMessageEdit = (request: Pick<TestRequest, "method" | "path">) =>
    request.method === "PATCH" && pathPattern("/channels/:channel/messages/:message")(request.path)

/** Turn a request embed into the response shape, which adds the rich type, media flags and field inline defaults */
function echoedEmbed(embed: unknown): unknown {
    if (typeof embed !== "object" || embed === null) return embed
    const object = (value: unknown, defaults: object) =>
        typeof value === "object" && value !== null ? { ...defaults, ...value } : value
    const { image, thumbnail, fields, ...rest } = embed as Record<string, unknown>
    return {
        type: "rich",
        ...rest,
        ...(image === undefined ? {} : { image: object(image, { flags: 0 }) }),
        ...(thumbnail === undefined ? {} : { thumbnail: object(thumbnail, { flags: 0 }) }),
        ...(Array.isArray(fields) ? { fields: fields.map((field) => object(field, { inline: false })) } : {}),
    }
}

/** Build the message a send or edit request describes, echoing the fields a bot usually sets */
function echoedMessage(replies: TestReplies, request: TestRequest, edit: boolean): WireMessage {
    const [, , channelId, , messageId] = request.path.split("/")
    const body =
        typeof request.body === "object" && request.body !== null ? (request.body as Record<string, unknown>) : {}
    const { guild_id: _, ...message } = replies.fixtures.message({
        id: edit ? messageId! : replies.fixtures.nextId(),
        channel_id: channelId!,
        author: replies.author,
        content: typeof body.content === "string" ? body.content : "",
        embeds: Array.isArray(body.embeds) ? body.embeds.map(echoedEmbed) : [],
        flags: typeof body.flags === "number" ? body.flags : 0,
        tts: body.tts === true,
        edited_timestamp: edit ? fixtureTimestamp : null,
    })
    return Object.freeze(message)
}

/** Compile a string path pattern, where :name matches one segment */
function pathPattern(pattern: string): (path: string) => boolean {
    if (/^https?:\/\//.test(pattern)) return (path) => path === pattern
    if (!pattern.startsWith("/"))
        throw new ConfigurationError("configuration", "Test request paths must start with / or be absolute http URLs")
    const expected = pattern.split("/")
    return (path) => {
        const actual = path.split("/")
        return (
            actual.length === expected.length &&
            expected.every((segment, index) =>
                segment.startsWith(":") && segment.length > 1 ? actual[index] !== "" : segment === actual[index],
            )
        )
    }
}

function methodPattern(method: unknown): ((request: TestRequest) => boolean) | undefined {
    if (method === undefined) return undefined
    if (typeof method !== "string" || !/^[A-Za-z]+$/.test(method))
        throw new ConfigurationError("configuration", "Test request methods must be HTTP method names such as GET")
    const expected = method.toUpperCase()
    return (request) => request.method === expected
}

function compileMatcher(matcher: TestRequestMatcher): (request: TestRequest) => boolean {
    if (typeof matcher === "function") return (request) => matcher(request) === true
    if (matcher instanceof RegExp) return (request) => new RegExp(matcher.source, matcher.flags).test(request.path)
    let method: unknown
    let path: unknown
    if (typeof matcher === "string") {
        const parts = matcher.trim().split(/\s+/)
        if (parts.length > 2 || parts[0] === "")
            throw new ConfigurationError("configuration", 'Test request matchers must read "METHOD /path" or "/path"')
        ;[method, path] = parts.length === 2 ? parts : [undefined, parts[0]]
    } else if (typeof matcher === "object" && matcher !== null) {
        method = matcher.method
        path = matcher.path
    } else
        throw new ConfigurationError(
            "configuration",
            "Test request matchers must be a string, RegExp, { method, path } object or function",
        )
    const methodMatches = methodPattern(method)
    const pathMatches =
        path instanceof RegExp
            ? (value: string) => new RegExp(path.source, path.flags).test(value)
            : typeof path === "string"
              ? pathPattern(path)
              : undefined
    if (!pathMatches)
        throw new ConfigurationError("configuration", "Test request matcher paths must be strings or RegExps")
    return (request) => (methodMatches?.(request) ?? true) && pathMatches(request.path)
}

function validateResponse(response: unknown): void {
    if (typeof response === "function") return
    if (response instanceof Response) {
        if (response.bodyUsed)
            throw new ConfigurationError("configuration", "A registered test Response must not have a consumed body")
        return
    }
    if (typeof response !== "object" || response === null)
        throw new ConfigurationError(
            "configuration",
            "Test responses must be an object, a Response or a handler function",
        )
    checkDescription(response as Exclude<TestResponse, Response>)
}

function checkDescription(response: Exclude<TestResponse, Response>): void {
    const { status, headers, body } = response
    if (status !== undefined && (!Number.isSafeInteger(status) || status < 200 || status > 599))
        throw new ConfigurationError("configuration", "Test response status must be an integer from 200 through 599")
    if (status !== undefined && nullBodyStatuses.has(status) && body !== undefined)
        throw new ConfigurationError("configuration", `Test response status ${status} cannot have a body`)
    if (
        headers !== undefined &&
        (typeof headers !== "object" ||
            headers === null ||
            Object.values(headers).some((value) => typeof value !== "string"))
    )
        throw new ConfigurationError("configuration", "Test response headers must be an object of strings")
}

function toResponse(response: TestResponse): Response {
    if (response instanceof Response) return response
    if (typeof response !== "object" || response === null)
        throw new TypeError("A test response handler must return a response object or a Response")
    checkDescription(response)
    const { body, headers } = response
    const status = response.status ?? (body === undefined ? 204 : 200)
    return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: body === undefined ? { ...headers } : { "content-type": "application/json", ...headers },
    })
}

/** Read the recorded body and attachment parts of one request, consuming any streamed body */
async function readBody(request: Request): Promise<{ body: unknown; files: TestRequestFile[] }> {
    if (request.body === null) return { body: undefined, files: [] }
    const type = request.headers.get("content-type") ?? ""
    if (type.startsWith("multipart/form-data")) {
        const form = await request.formData()
        let body: unknown
        const files: TestRequestFile[] = []
        for (const [field, value] of form) {
            if (typeof value === "string") {
                if (field === "payload_json") body = parseJson(value)
            } else files.push({ field, filename: value.name, contentType: value.type, size: value.size })
        }
        return { body, files }
    }
    const text = await request.text()
    if (text === "") return { body: undefined, files: [] }
    return { body: type.includes("json") ? parseJson(text) : text, files: [] }
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown
    } catch {
        // allow-silent: A body that is not valid JSON stays visible to the test as its text
        return text
    }
}

function aborted(signal: AbortSignal | null | undefined): Promise<never> | undefined {
    if (!signal) return undefined
    return new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
}

/** The fake HTTP side of one test client */
export class TestHttp implements TestRest {
    readonly #routes: Route[] = []
    readonly #requests: TestRequest[] = []
    /** Pending next calls of every route, failed with ClientClosedError when the transport closes */
    readonly #waits = new Set<(error: unknown) => void>()
    /** Messages described by recorded sends, built once when the automatic reply or sentMessages first needs them */
    readonly #sent = new WeakMap<TestRequest, WireMessage>()
    #inFlight = 0
    #closed = false

    constructor(
        private readonly record: (record: Omit<LogRecord, "time">) => void,
        private readonly replies: TestReplies,
    ) {}

    /** Requests received but not yet answered, including ones whose response handler is still running */
    get inFlight() {
        return this.#inFlight
    }

    respond(matcher: TestRequestMatcher, response: TestResponse | TestResponder): InternalTestRoute {
        const matches = compileMatcher(matcher)
        validateResponse(response)
        const route: Route = { matches, response, answered: [], taken: 0, waiters: new Set(), active: true }
        this.#routes.push(route)
        return Object.freeze({
            requests: () => Object.freeze([...route.answered]),
            next: (options?: TestWaitOptions, signal?: AbortSignal) => {
                const timeoutMs = waitTimeout(options)
                if (route.taken < route.answered.length) return Promise.resolve(route.answered[route.taken++]!)
                if (this.#closed) return Promise.reject(new ClientClosedError())
                return timedWait<TestRequest>("next", timeoutMs, signal, (settle) => {
                    const deliver = (request: TestRequest) => settle({ value: request })
                    const fail = (error: unknown) => settle({ error })
                    route.waiters.add(deliver)
                    this.#waits.add(fail)
                    return () => {
                        route.waiters.delete(deliver)
                        this.#waits.delete(fail)
                    }
                })
            },
            remove: () => {
                route.active = false
            },
        })
    }

    /** Requests received so far, in order, excluding the discovery bootstrap */
    requests(): readonly TestRequest[] {
        return Object.freeze([...this.#requests])
    }

    /** The messages described by the message sends among these requests, in order */
    sentMessages(requests: readonly TestRequest[]): readonly WireMessage[] {
        return Object.freeze(requests.filter(isMessageSend).map((request) => this.#sentMessage(request)))
    }

    #sentMessage(request: TestRequest): WireMessage {
        let message = this.#sent.get(request)
        if (!message) this.#sent.set(request, (message = echoedMessage(this.replies, request, false)))
        return message
    }

    /** The fetch-compatible function passed to the client's transport option */
    readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
        this.#inFlight++
        try {
            return await this.#answer(url, init)
        } finally {
            this.#inFlight--
        }
    }

    readonly #answer = async (url: string, init: RequestInit): Promise<Response> => {
        if (this.#closed) throw new Error("The test client has shut down, so its transport accepts no requests")
        const cancelled = aborted(init.signal)
        // A cancelled request must settle even while a handler or body read is still pending
        const settle = <A>(work: Promise<A>) => (cancelled ? Promise.race([work, cancelled]) : work)
        cancelled?.catch(() => {
            // allow-silent: The same rejection is observed through the race below when cancellation wins
        })
        if (url === hostedDiscoveryUrl) return Response.json(testDiscoveryDocument)
        const request = new Request(url, init)
        const { body, files } = await settle(readBody(request))
        const target = new URL(url)
        const headers: Record<string, string> = {}
        request.headers.forEach((value, name) => {
            if (name !== "authorization") headers[name] = value
        })
        const withoutQuery = `${target.origin}${target.pathname}`
        const recordedUrl = redactWebhookToken(url)
        const path = redactWebhookToken(
            withoutQuery.startsWith(`${apiBase}/`) ? withoutQuery.slice(apiBase.length) : withoutQuery,
        )
        const base = {
            method: request.method.toUpperCase(),
            url: recordedUrl,
            path,
            query: Object.freeze(Object.fromEntries(target.searchParams)),
            headers: Object.freeze(headers),
            body,
            files: Object.freeze(files),
        }
        const route = this.#routes.findLast(
            (candidate) => candidate.active && candidate.matches({ ...base, matched: true }),
        )
        const recorded: TestRequest = Object.freeze({ ...base, matched: route !== undefined })
        this.#requests.push(recorded)
        if (!route && isMessageSend(recorded)) return Response.json(this.#sentMessage(recorded))
        if (!route && isMessageEdit(recorded)) return Response.json(echoedMessage(this.replies, recorded, true))
        if (!route) {
            this.record({
                level: "warn",
                category: "rest",
                code: "testing.unmatchedRequest",
                message: `No test response matches ${recorded.method} ${recorded.path}, so the request received HTTP 404. Register a matching response with rest.respond`,
                status: 404,
                fields: { method: recorded.method, path: recorded.path },
            })
            return Response.json(
                { code: "NOT_FOUND", message: `No test response matches ${recorded.method} ${recorded.path}` },
                { status: 404 },
            )
        }
        route.answered.push(recorded)
        const waiter = route.waiters.values().next().value
        if (waiter) {
            route.taken++
            waiter(recorded)
        }
        const { response } = route
        // A registered Response answers every match, so each request receives its own unread copy
        if (typeof response !== "function")
            return response instanceof Response ? response.clone() : toResponse(response)
        try {
            return toResponse(await settle(Promise.resolve(response(recorded))))
        } catch (error) {
            if (init.signal?.aborted && error === init.signal.reason) throw error
            this.record({
                level: "error",
                category: "rest",
                code: "testing.responderFailed",
                message: `The test response handler for ${recorded.method} ${recorded.path} failed, so the request failed as a network error`,
                fields: { method: recorded.method, path: recorded.path },
                error: {
                    origin: "application",
                    name: error instanceof Error ? error.name : "Error",
                    message: error instanceof Error ? error.message : String(error),
                    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
                },
            })
            throw error
        }
    }

    /** Refuse later requests and fail pending next calls with ClientClosedError */
    close() {
        this.#closed = true
        for (const fail of this.#waits) fail(new ClientClosedError())
    }
}
