/**
 * Instance resolver: Selection validation, unauthenticated discovery and one immutable endpoint map per owner, including
 * webhook-only clients. Invariant: Discovery runs when first needed and shares one request among concurrent REST, gateway and
 * explicit callers, each with its own deadline and cancellation, and the last departing caller waits for the shared request to
 * clean up. An explicitly selected instance is trusted to advertise service origins that receive its credential: HTTPS and WSS
 * are required unless it permits plaintext, bootstrap redirects are validated and credentialed service redirects are rejected.
 * Instance-bound URLs use the advertised bases without refreshing discovery. Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import { createInstanceAssets } from "#sdk/assets"
import {
    ClientClosedError,
    ConfigurationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
} from "#sdk/errors"
import { TransportError, withDeadline } from "#sdk/internal/effect-failures"
import { record } from "#sdk/internal/decode/primitives"
import { suspendInput } from "#sdk/internal/defects"
import { unsupportedKeyHint } from "#sdk/internal/suggest"
import { defaultHttpTransport, type HttpTransport } from "#sdk/internal/transport/index"
import { createInstanceLinks } from "#sdk/helpers"
import type {
    InstanceDomainMigration,
    InstanceResolveError,
    InstanceResolveOptions,
    ResolvedInstance,
} from "#sdk/instance"

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
        // allow-silent: An unparsable endpoint makes the discovery document invalid
        return undefined
    }
}

/** Validate and normalize selection locally without fetching its discovery document */
export function instanceConfiguration(value: unknown): InstanceConfiguration | ConfigurationError {
    if (value === undefined) return Object.freeze({ bootstrap: hostedBootstrap, allowInsecure: false })
    if (!record(value)) return new ConfigurationError("instance", "Instance settings must be an object with url")
    const unsupported = Object.keys(value).find((key) => key !== "url" && key !== "allowInsecure")
    if (unsupported !== undefined)
        return new ConfigurationError("instance", `Unsupported instance setting ${JSON.stringify(unsupported)}`, {
            hint: unsupportedKeyHint(unsupported, ["url", "allowInsecure"], "settings"),
        })
    const allowInsecureInput = value.allowInsecure
    const allowInsecure = allowInsecureInput === undefined ? false : allowInsecureInput
    if (typeof allowInsecure !== "boolean")
        return new ConfigurationError("instance", 'The option "instance.allowInsecure" must be true or false')
    const bootstrap = localUrl(value.url, allowInsecure)
    return bootstrap
        ? Object.freeze({ bootstrap, allowInsecure })
        : new ConfigurationError(
              "instance",
              'The option "instance.url" must be an absolute HTTPS URL without a path, or HTTP when instance.allowInsecure is true',
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
        // allow-silent: An unparsable endpoint makes the discovery document invalid
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
        // allow-silent: An unparsable URL is rejected by the caller
        return undefined
    }
}

function redirectUrl(location: string, previous: string, allowInsecure: boolean): string | undefined {
    try {
        return discoveryUrl(new URL(location, previous).href, allowInsecure)
    } catch {
        // allow-silent: An unparsable redirect is rejected as a protocol failure
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

/** Read the optional web domain migration switch. Malformed or absent data is treated as no announced migration */
function domainMigration(value: unknown): InstanceDomainMigration | null {
    if (!record(value) || typeof value.enabled !== "boolean") return null
    const rollout = value.anonymous_rollout_basis_points
    return Object.freeze({
        enabled: value.enabled,
        anonymousRolloutBasisPoints:
            typeof rollout === "number" && Number.isSafeInteger(rollout) && rollout >= 0 && rollout <= 10_000
                ? rollout
                : null,
        standaloneForwarding: typeof value.standalone_forwarding === "boolean" ? value.standalone_forwarding : null,
    })
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
            domainMigration: domainMigration(value.domain_migration),
        }),
    })
}

function failure(error: unknown): InternalResolveError {
    if (error instanceof ConnectionError || error instanceof RateLimitError || error instanceof ClientClosedError)
        return error
    // Keep the transport error code, never the raw runtime message, which can carry request details
    const cause = new TransportError(error, "request for Fluxer's instance information")
    return new ConnectionError("discovery", "network", null, {
        cause,
        details: cause.code === undefined ? {} : { transportCode: cause.code },
    })
}

/** An invalid discovery response, with a safe explanation of what was wrong */
function invalidDocument(status: number | null, detail: string): ConnectionError {
    return new ConnectionError("discovery", "protocol", status, { details: { detail } })
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
                    if (!state.reader) throw invalidDocument(response.status, "the response had no body")
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
                            throw invalidDocument(
                                response.status,
                                `the instance document is larger than ${maximumDocumentBytes} bytes`,
                            )
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
                        // allow-silent: A non-JSON discovery body is rejected as a protocol failure below
                        value = undefined
                    }
                    if (response.status === 429) throw new RateLimitError("http", retryAfter(response, value))
                    const document = parseDocument(value, configuration.allowInsecure)
                    if (!document)
                        throw invalidDocument(null, "the instance document is not JSON or lacks valid endpoints")
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
    readonly http: HttpTransport
    settled: Promise<void>
}

function responseRequest(target: string, state: DiscoveryState): Effect.Effect<Response, InternalResolveError> {
    return Effect.tryPromise({
        try: () => {
            const request = state.http(target, { method: "GET", redirect: "manual", signal: state.controller.signal })
            // allow-silent: The request itself is returned and its rejection observed by the caller, so this only records settlement
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
                    return Effect.fail(
                        invalidDocument(response.status, `more than ${maximumBootstrapRedirects} redirects`),
                    )
                const location = response.headers.get("location")
                const next = location === null ? undefined : redirectUrl(location, target, configuration.allowInsecure)
                return next
                    ? readDocument(next, redirects + 1, configuration, state)
                    : Effect.fail(invalidDocument(response.status, "the redirect location is missing or not allowed"))
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
    http: HttpTransport,
): Effect.Effect<ResolvedContext, InternalResolveError> {
    return Effect.acquireUseRelease(
        Effect.sync((): DiscoveryState => ({
            controller,
            http,
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
 * context. The last departing waiter interrupts and awaits the scoped worker.
 * A later waiter waits for that cleanup before it can start a replacement read
 */
export class InstanceResolver {
    #cached: ResolvedContext | undefined
    #active: ResolveTask | undefined
    #closed = false

    private readonly onDiscovered: ((value: ResolvedInstance) => void) | undefined
    private readonly http: HttpTransport

    constructor(
        private readonly configuration: InstanceConfiguration,
        private readonly scope: Scope.Scope,
        options: {
            /** Called once with each newly discovered instance, for example to record a web domain migration */
            readonly onDiscovered?: (value: ResolvedInstance) => void
            /** HTTP transport for discovery, defaulting to the platform fetch */
            readonly http?: HttpTransport
        } = {},
    ) {
        this.onDiscovered = options.onDiscovered
        this.http = options.http ?? defaultHttpTransport
    }

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
                discover(owner.configuration, task.controller, owner.http).pipe(
                    Effect.tap((value) =>
                        Effect.sync(() => {
                            owner.#cached = value
                            try {
                                owner.onDiscovered?.(value.value)
                            } catch {
                                // allow-silent: Discovery observers only log, and a failed observer must not fail resolution
                            }
                        }),
                    ),
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
                    // allow-silent: The deferred above retains the original exit for every waiter
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
        // Reading the caller options is marked as application input, and discovery runs outside that region
        return suspendInput<number, InstanceResolveError, never>(() => {
            if (options !== undefined && !record(options))
                return Effect.fail(
                    new ConfigurationError(
                        "timeoutMs",
                        "Instance discovery options must be an object with only timeoutMs and, in the default API, signal",
                    ),
                )
            const optionKeys = ["timeoutMs", "signal"]
            const unsupported = options && Object.keys(options).find((key) => !optionKeys.includes(key))
            if (unsupported !== undefined)
                return Effect.fail(
                    new ConfigurationError(
                        "timeoutMs",
                        `Unsupported option ${JSON.stringify(unsupported)} in the instance discovery options`,
                        { hint: unsupportedKeyHint(unsupported, optionKeys) },
                    ),
                )
            const timeoutInput = options?.timeoutMs
            const timeout = timeoutInput === undefined ? defaultResolveTimeoutMs : timeoutInput
            if (
                typeof timeout !== "number" ||
                !Number.isSafeInteger(timeout) ||
                timeout <= 0 ||
                timeout > 2_147_483_647
            )
                return Effect.fail(
                    new ConfigurationError(
                        "timeoutMs",
                        "The option timeoutMs must be an integer from 1 through 2,147,483,647 milliseconds",
                    ),
                )
            return Effect.succeed(timeout)
        }).pipe(
            Effect.flatMap((timeout) =>
                this.resolve().pipe(
                    Effect.andThen(
                        Effect.sync(() => {
                            if (!this.#cached) throw new Error("Instance resolver completed without a cached result")
                            return this.#cached.value
                        }),
                    ),
                    withDeadline(timeout, () => new ConnectionTimeoutError(timeout)),
                ),
            ),
        )
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
