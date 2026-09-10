import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { createInstanceAssets } from "#sdk/assets"
import {
    ClientClosedError,
    ConfigurationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
} from "#sdk/errors"
import { withDeadline } from "#sdk/internal/effect-failures"
import { createInstanceLinks } from "#sdk/helpers"
import type { InstanceResolveError, InstanceResolveOptions, ResolvedInstance } from "#sdk/instance"

const hostedBootstrap = "https://fluxer.app"
const discoveryPath = "/.well-known/fluxer"
const maximumBootstrapRedirects = 3
const maximumDocumentBytes = 1_048_576
const defaultResolveTimeoutMs = 30_000

/** Validated local instance selection, with no network result retained at creation */
export interface InstanceConfiguration {
    /** Normalized selected discovery origin, without the well-known path */
    readonly bootstrap: string
    /** Explicit local/self-hosted HTTP and WS opt-in */
    readonly allowInsecure: boolean
}

/**
 * One immutable, caller-selected instance endpoint snapshot
 *
 * REST, gateway, upload and projection owners receive this value only after the
 * instance resolver has validated the advertised discovery document
 */
export interface InstanceEndpointContext {
    /** Public HTTP API base from discovery, without an SDK-added `/v1` suffix */
    readonly apiPublic: string
    /** Gateway WebSocket base from discovery */
    readonly gateway: string
    /** Public media base from discovery */
    readonly media: string
    /** Static CDN base from discovery */
    readonly staticCdn: string
    /** Web application base from discovery */
    readonly webapp: string
    /** Invite and vanity-code base from discovery */
    readonly invite: string
    /** Whether discovery permits presigned attachment-upload plans */
    readonly presignedAttachmentUploads: boolean
    /** Whether this explicitly selected instance may use HTTP and WS endpoints */
    readonly allowInsecure: boolean
}

interface ResolvedContext {
    readonly context: InstanceEndpointContext
    readonly value: ResolvedInstance
}

type InternalResolveError = ConnectionError | RateLimitError | ClientClosedError

interface ResolveTask {
    readonly result: Deferred.Deferred<ResolvedContext, InternalResolveError>
    readonly finished: Deferred.Deferred<void>
    waiters: number
    stopping: boolean
    done: boolean
    exit: Exit.Exit<ResolvedContext, InternalResolveError> | undefined
    fiber: Fiber.Fiber<void> | undefined
    readonly controller: AbortController
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function removeTrailingSlash(url: URL): string {
    return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href
}

function localUrl(value: unknown, allowInsecure: boolean): string | undefined {
    if (typeof value !== "string") return undefined
    try {
        const url = new URL(value)
        if (
            url.pathname !== "/" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:"))
        )
            return undefined
        return removeTrailingSlash(url)
    } catch {
        return undefined
    }
}

/** Validate and normalize selection locally without fetching its discovery document */
export function instanceConfiguration(value: unknown): InstanceConfiguration | ConfigurationError {
    if (value === undefined) return Object.freeze({ bootstrap: hostedBootstrap, allowInsecure: false })
    if (!record(value) || Object.keys(value).some((key) => key !== "url" && key !== "allowInsecure"))
        return new ConfigurationError("instance", "Instance settings must contain url and optional allowInsecure")
    const allowInsecure = value.allowInsecure === undefined ? false : value.allowInsecure
    if (typeof allowInsecure !== "boolean")
        return new ConfigurationError("instance", "allowInsecure must be a boolean when supplied")
    const bootstrap = localUrl(value.url, allowInsecure)
    return bootstrap
        ? Object.freeze({ bootstrap, allowInsecure })
        : new ConfigurationError(
              "instance",
              "Instance url must be an absolute root HTTPS URL, or HTTP when allowInsecure is true",
          )
}

function endpoint(value: unknown, protocol: "http" | "ws", allowInsecure: boolean): string | undefined {
    if (typeof value !== "string") return undefined
    try {
        const url = new URL(value)
        const secure = protocol === "http" ? "https:" : "wss:"
        const insecure = protocol === "http" ? "http:" : "ws:"
        if (
            (url.protocol !== secure && !(allowInsecure && url.protocol === insecure)) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        )
            return undefined
        return removeTrailingSlash(url)
    } catch {
        return undefined
    }
}

function discoveryUrl(value: string, allowInsecure: boolean): string | undefined {
    try {
        const url = new URL(value)
        if (
            url.pathname !== discoveryPath ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:"))
        )
            return undefined
        return url.href
    } catch {
        return undefined
    }
}

function redirectUrl(location: string, previous: string, allowInsecure: boolean): string | undefined {
    try {
        return discoveryUrl(new URL(location, previous).href, allowInsecure)
    } catch {
        return undefined
    }
}

function retryAfter(response: Response, body: unknown): number | null {
    const header = response.headers.get("retry-after")
    let delay = header === null ? NaN : Number(header) * 1_000
    if (header !== null && !Number.isFinite(delay)) delay = Date.parse(header) - Date.now()
    if (record(body) && typeof body.retry_after === "number") {
        const fromBody = body.retry_after * 1_000
        if (Number.isFinite(fromBody) && fromBody >= 0) delay = Math.max(Number.isFinite(delay) ? delay : 0, fromBody)
    }
    return Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : null
}

function parseDocument(value: unknown, allowInsecure: boolean): ResolvedContext | undefined {
    if (!record(value) || !record(value.endpoints)) return undefined
    const apiCodeVersion = value.api_code_version
    if (typeof apiCodeVersion !== "number" || !Number.isSafeInteger(apiCodeVersion) || apiCodeVersion < 0)
        return undefined
    const apiPublic = endpoint(value.endpoints.api_public, "http", allowInsecure)
    const gateway = endpoint(value.endpoints.gateway, "ws", allowInsecure)
    const media = endpoint(value.endpoints.media, "http", allowInsecure)
    const staticCdn = endpoint(value.endpoints.static_cdn, "http", allowInsecure)
    const webapp = endpoint(value.endpoints.webapp, "http", allowInsecure)
    const invite = endpoint(value.endpoints.invite, "http", allowInsecure)
    if (
        !apiPublic ||
        !gateway ||
        !media ||
        !staticCdn ||
        !webapp ||
        !invite ||
        !record(value.features) ||
        typeof value.features.presigned_attachment_uploads !== "boolean"
    )
        return undefined
    const context: InstanceEndpointContext = Object.freeze({
        apiPublic,
        gateway,
        media,
        staticCdn,
        webapp,
        invite,
        presignedAttachmentUploads: value.features.presigned_attachment_uploads,
        allowInsecure,
    })
    const endpoints = Object.freeze({ apiPublic, gateway, media, staticCdn, webapp, invite })
    return Object.freeze({
        context,
        value: Object.freeze({
            apiCodeVersion,
            endpoints,
            presignedAttachmentUploads: context.presignedAttachmentUploads,
            assets: createInstanceAssets(media, staticCdn),
            links: createInstanceLinks(webapp),
        }),
    })
}

function failure(error: unknown): InternalResolveError {
    return error instanceof ConnectionError || error instanceof RateLimitError || error instanceof ClientClosedError
        ? error
        : new ConnectionError("discovery", "network")
}

function cancel(response: Response | undefined): Promise<void> {
    return response && !response.bodyUsed ? (response.body?.cancel() ?? Promise.resolve()) : Promise.resolve()
}

/** Bound the document read and keep reader cleanup outside typed network/protocol failures */
function readDocumentBody(
    response: Response,
    configuration: InstanceConfiguration,
    signal: AbortSignal,
): Effect.Effect<ResolvedContext, InternalResolveError> {
    return Effect.acquireUseRelease(
        Effect.sync(() => ({ reader: response.body?.getReader(), done: false })),
        (state) =>
            Effect.tryPromise({
                try: async () => {
                    if (!state.reader) throw new ConnectionError("discovery", "protocol", response.status)
                    const chunks: Uint8Array[] = []
                    let length = 0
                    for (;;) {
                        const part = await state.reader.read()
                        if (part.done) {
                            state.done = true
                            break
                        }
                        length += part.value.byteLength
                        if (length > maximumDocumentBytes)
                            throw new ConnectionError("discovery", "protocol", response.status)
                        chunks.push(part.value)
                    }
                    const bytes = new Uint8Array(length)
                    let offset = 0
                    for (const chunk of chunks) {
                        bytes.set(chunk, offset)
                        offset += chunk.byteLength
                    }
                    let value: unknown
                    try {
                        value = JSON.parse(new TextDecoder().decode(bytes))
                    } catch {
                        value = undefined
                    }
                    if (response.status === 429) throw new RateLimitError("http", retryAfter(response, value))
                    const document = parseDocument(value, configuration.allowInsecure)
                    if (!document) throw new ConnectionError("discovery", "protocol")
                    return document
                },
                catch: (error) =>
                    response.status === 429 && !(error instanceof RateLimitError)
                        ? new RateLimitError("http", retryAfter(response, null))
                        : failure(error),
            }),
        (state) =>
            Effect.promise(async () => {
                if (!state.reader) return
                const failures: unknown[] = []
                if (!state.done)
                    try {
                        await state.reader.cancel()
                    } catch (error) {
                        if (!(signal.aborted && error === signal.reason)) failures.push(error)
                    }
                try {
                    state.reader.releaseLock()
                } catch (error) {
                    failures.push(error)
                }
                if (failures.length === 1) throw failures[0]
                if (failures.length > 1) throw new AggregateError(failures, "Discovery reader cleanup failed")
            }),
    )
}

interface DiscoveryState {
    readonly controller: AbortController
    settled: Promise<void>
}

function responseRequest(target: string, state: DiscoveryState): Effect.Effect<Response, InternalResolveError> {
    return Effect.tryPromise({
        try: () => {
            const request = fetch(target, { method: "GET", redirect: "manual", signal: state.controller.signal })
            state.settled = request.then(
                () => undefined,
                () => undefined,
            )
            return request
        },
        catch: failure,
    })
}

function releaseResponse(response: Response, signal: AbortSignal): Effect.Effect<void> {
    return Effect.uninterruptible(
        Effect.promise(async () => {
            try {
                await cancel(response)
            } catch (error) {
                if (!(signal.aborted && error === signal.reason)) throw error
            }
        }),
    )
}

function readDocument(
    target: string,
    redirects: number,
    configuration: InstanceConfiguration,
    state: DiscoveryState,
): Effect.Effect<ResolvedContext, InternalResolveError> {
    return Effect.acquireUseRelease(
        responseRequest(target, state),
        (response) => {
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                if (redirects >= maximumBootstrapRedirects)
                    return Effect.fail(new ConnectionError("discovery", "protocol", response.status))
                const location = response.headers.get("location")
                const next = location === null ? undefined : redirectUrl(location, target, configuration.allowInsecure)
                return next
                    ? readDocument(next, redirects + 1, configuration, state)
                    : Effect.fail(new ConnectionError("discovery", "protocol", response.status))
            }
            if (!response.ok && response.status !== 429)
                return Effect.fail(new ConnectionError("discovery", "network", response.status))
            return readDocumentBody(response, configuration, state.controller.signal)
        },
        (response) => releaseResponse(response, state.controller.signal),
    )
}

/** Read one unauthenticated discovery document, following only validated bootstrap redirects */
function discover(
    configuration: InstanceConfiguration,
    controller: AbortController,
): Effect.Effect<ResolvedContext, InternalResolveError> {
    return Effect.acquireUseRelease(
        Effect.sync((): DiscoveryState => ({
            controller,
            settled: Promise.resolve(),
        })),
        (state) => readDocument(`${configuration.bootstrap}${discoveryPath}`, 0, configuration, state),
        (state) =>
            Effect.uninterruptible(
                Effect.promise(async () => {
                    state.controller.abort()
                    await state.settled
                }),
            ),
    )
}

/**
 * One client-owned lifetime resolver
 *
 * Waiters share an in-flight document read, but each keeps its own interruption
 * context. The last departing waiter interrupts and awaits the scoped worker;
 * a later waiter waits for that cleanup before it can start a replacement read
 */
export class InstanceResolver {
    #cached: ResolvedContext | undefined
    #active: ResolveTask | undefined
    #closed = false

    constructor(
        private readonly configuration: InstanceConfiguration,
        private readonly scope: Scope.Scope,
    ) {}

    #start(): Effect.Effect<ResolveTask> {
        const owner = this
        return Effect.gen(function* () {
            const task: ResolveTask = {
                result: Deferred.makeUnsafe<ResolvedContext, InternalResolveError>(),
                finished: Deferred.makeUnsafe<void>(),
                waiters: 0,
                stopping: false,
                done: false,
                exit: undefined,
                fiber: undefined,
                controller: new AbortController(),
            }
            owner.#active = task
            task.fiber = yield* Effect.forkIn(
                discover(owner.configuration, task.controller).pipe(
                    Effect.tap((value) => Effect.sync(() => (owner.#cached = value))),
                    Effect.onExit((exit) =>
                        Effect.sync(() => {
                            task.done = true
                            task.exit = exit
                            // Completing the deferred can resume a zero-delay retry synchronously
                            if (owner.#active === task) owner.#active = undefined
                            Deferred.doneUnsafe(task.finished, Effect.void)
                            Deferred.doneUnsafe(task.result, exit)
                        }),
                    ),
                    // The deferred above retains the original exit for every waiter and cleanup observer
                    Effect.catchCause(() => Effect.void),
                    Effect.asVoid,
                ),
                owner.scope,
            )
            return task
        })
    }

    #stop(task: ResolveTask): Effect.Effect<ResolveTask["exit"]> {
        return Effect.uninterruptible(
            Effect.sync(() => task.controller.abort()).pipe(
                Effect.andThen(Fiber.interrupt(task.fiber!)),
                Effect.andThen(Fiber.await(task.fiber!)),
                Effect.map(() => task.exit),
            ),
        )
    }

    #release(task: ResolveTask): Effect.Effect<void, InternalResolveError> {
        return Effect.uninterruptible(
            Effect.suspend(() => {
                task.waiters -= 1
                if (task.waiters !== 0 || task.done || this.#active !== task) return Effect.void
                task.stopping = true
                return this.#stop(task).pipe(
                    Effect.flatMap((exit) =>
                        exit && Exit.isFailure(exit) && Cause.hasDies(exit.cause)
                            ? Effect.failCause(exit.cause)
                            : Effect.void,
                    ),
                )
            }),
        )
    }

    /** Resolve the internal endpoint snapshot once for one owner lifetime */
    resolve(): Effect.Effect<InstanceEndpointContext, InternalResolveError> {
        const owner = this
        return Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
                if (owner.#closed) return yield* Effect.fail(new ClientClosedError())
                if (owner.#cached) return owner.#cached.context
                const active = owner.#active
                if (active?.stopping) {
                    yield* restore(Deferred.await(active.finished))
                    return yield* owner.resolve()
                }
                const task = active ?? (yield* owner.#start())
                task.waiters += 1
                return yield* restore(
                    Deferred.await(task.result).pipe(
                        Effect.map((value) => value.context),
                        Effect.onExit(() => owner.#release(task)),
                    ),
                )
            }),
        )
    }

    /** Resolve the public immutable result without a second request, with one caller-local deadline */
    resolveInfo(options?: InstanceResolveOptions): Effect.Effect<ResolvedInstance, InstanceResolveError> {
        return Effect.suspend<ResolvedInstance, InstanceResolveError, never>(() => {
            if (
                options !== undefined &&
                (!record(options) || Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal"))
            )
                return Effect.fail(
                    new ConfigurationError(
                        "timeoutMs",
                        "Instance discovery options accept only timeoutMs and the default cancellation signal",
                    ),
                )
            const timeout = options?.timeoutMs === undefined ? defaultResolveTimeoutMs : options.timeoutMs
            if (
                typeof timeout !== "number" ||
                !Number.isSafeInteger(timeout) ||
                timeout <= 0 ||
                timeout > 2_147_483_647
            )
                return Effect.fail(
                    new ConfigurationError(
                        "timeoutMs",
                        "Instance discovery timeout must be a positive timer-safe integer in milliseconds",
                    ),
                )
            return this.resolve().pipe(
                Effect.andThen(
                    Effect.sync(() => {
                        if (!this.#cached) throw new Error("Instance resolver completed without a cached result")
                        return this.#cached.value
                    }),
                ),
                withDeadline(timeout, () => new ConnectionTimeoutError(timeout)),
            )
        })
    }

    /** Stop shared discovery and await its cleanup before the owning client releases credentials and schedulers */
    shutdown(): Effect.Effect<void> {
        return Effect.uninterruptible(
            Effect.suspend(() => {
                if (this.#closed) return Effect.void
                this.#closed = true
                const task = this.#active
                if (!task || task.done) return Effect.void
                task.stopping = true
                Deferred.doneUnsafe(task.result, Effect.fail(new ClientClosedError()))
                return this.#stop(task).pipe(
                    Effect.flatMap((exit) =>
                        exit && Exit.isFailure(exit) && Cause.hasDies(exit.cause)
                            ? Effect.failCause(
                                  Cause.fromReasons<never>(
                                      exit.cause.reasons.filter((reason) => reason._tag === "Die"),
                                  ),
                              )
                            : Effect.void,
                    ),
                )
            }),
        )
    }
}

/** Add Fluxer's required protocol parameters to a validated advertised gateway base */
export function gatewayUrl(endpoint: string): string {
    const url = new URL(endpoint)
    url.search = "?v=1&encoding=json"
    return url.href
}
