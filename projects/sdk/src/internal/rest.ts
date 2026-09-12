import { randomUUID } from "node:crypto"
import { Cause, Deferred, Effect, Exit, Random, Redacted } from "effect"
import { mapFailureCause, withDeadline } from "./effect-failures.js"
import { ClientClosedError, ConnectionError, RateLimitError } from "#sdk/errors"
import { MessageError, MessageOperationError, type MessageOperationFailure, type SendError } from "#sdk/message-errors"
import { apiErrorDetail, type ApiErrorDetail } from "#sdk/api-errors"
import {
    InputValidationFailure,
    inputValidationFailure,
    type InputValidationConstraint,
    type InputValidationDetail,
} from "#sdk/input-validation"
import type {
    EditMessageInput,
    ForwardMessageInput,
    Message,
    MessageInput,
    MessageHistoryQuery,
    MessageOperationOptions,
    MessageReference,
    SendOptions,
} from "#sdk/messages"
import type { Attachment, AttachmentDownloadFailure, AttachmentDownloadOptions } from "#sdk/attachments"
import { AttachmentDownloadError } from "#sdk/attachments"
import {
    decodeMessage,
    encodeEdit,
    encodeForward,
    encodeHistory,
    encodeMessage,
    identifier,
    record,
    reference,
} from "./message.js"
import type { MessageCache } from "./cache.js"
import type { EncodedBody } from "./attachments.js"
import { decodeUploadPlans, readUploadJson, type UploadPlan, UploadResponseCleanupError } from "./uploads.js"
import {
    AttachmentTransferCleanupError,
    AttachmentTransferSource,
    AttachmentTransferVerificationCleanupError,
} from "./transfer-source.js"
import type { InstanceEndpointContext } from "./instance.js"
import type { ReactionEmojiInput, ReactionUsersQuery, ReactionUsersPage } from "#sdk/reactions"
import { encodeReactionEmoji, encodeReactionUsersQuery, decodeReactionUsersPage } from "./reactions.js"
import type { MessagePinsPage, MessagePinsQuery } from "#sdk/pins"
import { decodePinsPage, encodePinsQuery } from "./pins.js"
import type { MessageSearchContext, MessageSearchPage, MessageSearchQuery } from "#sdk/message-search"
import { decodeMessageSearchPage, encodeMessageSearch } from "./message-search.js"
import { GuildOperationError, type GuildOperation, type GuildOperationOptions } from "#sdk/guilds"
import type { GuildRequest } from "./guilds.js"
import type { GuildCache, ResourceGuard, ResourceRequest } from "./guild-cache.js"
import { ChannelOperationError, type ChannelOperation, type ChannelOperationOptions } from "#sdk/channels"
import type { ChannelRequest } from "./channels.js"
import type { ChannelCache, ChannelCacheGuard, ChannelCacheRequest } from "./channel-cache.js"
import { WebhookOperationError, type WebhookOperation, type WebhookOperationOptions } from "#sdk/webhooks"
import type { WebhookRequest } from "./webhooks.js"
import { multipart } from "./multipart.js"
import { UserOperationError, type UserOperation, type UserOperationOptions } from "#sdk/users"
import type { UserRequest } from "./users.js"
import { directMessageOpen } from "./users.js"
import type { UserCache } from "./user-cache.js"
import {
    BotApplicationOperationError,
    type BotApplicationOperation,
    type BotApplicationOperationOptions,
} from "#sdk/application"
import type { BotApplicationRequest } from "./application.js"

type Pending = {
    route: string
    bytes: number
    until: number
    rateLimited: boolean
    resume: (effect: Effect.Effect<() => void, RestFailure | ClientClosedError>) => void
}
type Bucket = { remaining: number; until: number }
const activeRequestCapacity = 4
const queuedRequestCapacity = 256
const queuedJsonMaxBytes = 4_194_304
type Outcome = MessageOperationError["outcome"]
type Request<A> = {
    directMessageUser?: string
    method: "POST" | "GET" | "PATCH" | "DELETE" | "PUT"
    channel: string
    webhookId?: string
    bucket?: string
    cache?: false
    deleteIds?: readonly string[]
    moderation?: true
    auditReason?: string
    deleteAuthorId?: string
    invalidateMessages?: true
    resourceCache?: ResourceRequest
    resourceGuard?: ResourceGuard
    channelCache?: ChannelCacheRequest
    channelGuard?: ChannelCacheGuard
    path: string
    body: EncodedBody | undefined
    status?: number
    decode: (response: Response, instance: InstanceEndpointContext) => Promise<A>
    target?: string
    preparation?: boolean
    instance?: InstanceEndpointContext
    sources?: readonly AttachmentTransferSource[]
    inlineAttachments?: true
    featureDisabled?: () => A
    put?: {
        url: string
        source: AttachmentTransferSource
        offset: number
        size: number
        contentType?: string
    }
}
async function completeCleanup(actions: readonly (() => void | PromiseLike<void>)[]) {
    const failures: unknown[] = []
    for (const action of actions) {
        try {
            await action()
        } catch (error) {
            failures.push(error)
        }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "REST cleanup failed")
}

/** One one-shot media response reader. It retains one client HTTP slot until EOF, cancellation, or release */
export class AttachmentDownloadSource {
    #reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    #response: Response | undefined
    #opening: Promise<Response> | undefined
    #ended = false
    #closed = false
    #reading = false
    #total = 0
    #failure: AttachmentDownloadFailure | undefined
    #interrupted = false
    #close: Promise<void> | undefined
    #defectRecorded = false
    #defectObserved = false
    #timer: ReturnType<typeof setTimeout> | undefined
    #removeSignal: (() => void) | undefined

    constructor(
        private readonly controller: AbortController,
        private readonly maxBytes: number,
        deadline: number,
        private readonly release: () => void,
        private readonly onClose: () => void,
        private readonly onDefect: () => void,
        private readonly onDefectObserved: () => void,
    ) {
        const remaining = deadline - Date.now()
        this.#timer = setTimeout(() => this.fail(new AttachmentDownloadError("timeout")), Math.max(1, remaining))
    }

    open(url: string): Promise<Response> {
        this.#opening = fetch(url, { method: "GET", redirect: "error", signal: this.controller.signal }).then(
            (response) => {
                this.#response = response
                return response
            },
        )
        return this.#opening.catch((error) => {
            throw this.#failure ?? error
        })
    }

    accept(response: Response, verifyLength = true) {
        if (this.#closed) throw this.#failure ?? new ClientClosedError()
        this.#response = response
        const declared = response.headers.get("content-length")
        if (verifyLength && declared !== null) {
            if (!/^\d+$/.test(declared)) throw new AttachmentDownloadError("response", response.status)
            if (Number(declared) > this.maxBytes) throw new AttachmentDownloadError("tooLarge", response.status)
        }
        this.#reader = response.body?.getReader()
    }

    /** Bind default cancellation through the source so it also releases an idle stream */
    bindSignal(
        signal: {
            readonly aborted: boolean
            addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void
            removeEventListener(type: "abort", listener: () => void): void
        },
        onClose: () => void,
    ) {
        const abort = () => this.interrupt()
        signal.addEventListener("abort", abort, { once: true })
        this.#removeSignal = () => {
            signal.removeEventListener("abort", abort)
            onClose()
        }
        if (signal.aborted) abort()
    }

    interrupt() {
        if (this.#closed) return
        this.#interrupted = true
        this.#closeInBackground()
    }

    fail(error: AttachmentDownloadFailure) {
        if (this.#closed) return
        this.#failure = error
        this.#closeInBackground()
    }

    #closeInBackground() {
        void this.close().catch(() => {
            // A later source finalizer or operation boundary retains this cleanup defect
        })
    }

    #recordDefect() {
        if (this.#defectRecorded) return
        this.#defectRecorded = true
        this.onDefect()
    }

    async #finish() {
        if (this.#closed) return
        this.#closed = true
        clearTimeout(this.#timer)
        this.#timer = undefined
        this.controller.abort()
        // Await a late response before releasing its body or declaring the operation closed
        await this.#opening?.catch(() => undefined)
        this.#opening = undefined
        const reader = this.#reader
        this.#reader = undefined
        const response = this.#response
        this.#response = undefined
        const removeSignal = this.#removeSignal
        this.#removeSignal = undefined
        const cancel = async (body: Pick<ReadableStream<Uint8Array>, "cancel">) => {
            try {
                await body.cancel()
            } catch (error) {
                if (error !== this.controller.signal.reason) throw error
            }
        }
        try {
            await completeCleanup([
                () => this.controller.abort(),
                ...(!this.#ended && reader ? [() => cancel(reader)] : []),
                ...(reader ? [() => reader.releaseLock()] : []),
                ...(!reader && response && !response.bodyUsed && response.body ? [() => cancel(response.body!)] : []),
                () => removeSignal?.(),
                () => this.release(),
            ])
        } catch {
            const defect = new AttachmentStreamCleanupError()
            this.#recordDefect()
            throw defect
        } finally {
            this.onClose()
        }
    }

    close(): Promise<void> {
        this.#close ??= this.#finish().catch((error) => {
            this.#recordDefect()
            throw error
        })
        return this.#close
    }

    readonly closeEffect: Effect.Effect<void> = Effect.promise(() =>
        this.close().catch((error) => {
            if (!this.#defectObserved) {
                this.#defectObserved = true
                this.onDefectObserved()
            }
            throw error
        }),
    )

    readonly next: Effect.Effect<Uint8Array | undefined, AttachmentDownloadFailure> = Effect.suspend(() => {
        if (this.#interrupted) return Effect.interrupt.pipe(Effect.ensuring(this.closeEffect))
        if (this.#failure) return Effect.fail(this.#failure).pipe(Effect.ensuring(this.closeEffect))
        if (this.#closed || this.#ended) return Effect.succeed(undefined)
        if (this.#reading) return Effect.fail(new AttachmentDownloadError("busy"))
        const reader = this.#reader
        if (!reader) {
            this.#ended = true
            return this.closeEffect.pipe(Effect.as(undefined))
        }
        this.#reading = true
        return Effect.tryPromise({
            try: async () => {
                const value = await reader.read()
                if (this.#interrupted) throw new AttachmentDownloadError("network", this.#response?.status ?? null)
                if (this.#failure) throw this.#failure
                if (value.done) {
                    this.#ended = true
                    return undefined
                }
                if (!(value.value instanceof Uint8Array) || !(value.value.buffer instanceof ArrayBuffer))
                    throw new AttachmentDownloadError("response", this.#response?.status ?? null)
                this.#total += value.value.byteLength
                if (!Number.isSafeInteger(this.#total) || this.#total > this.maxBytes)
                    throw new AttachmentDownloadError("tooLarge", this.#response?.status ?? null)
                return value.value
            },
            catch: (error) =>
                this.#failure ??
                (error instanceof AttachmentDownloadError
                    ? error
                    : new AttachmentDownloadError("network", this.#response?.status ?? null)),
        }).pipe(
            Effect.catchIf(
                () => this.#interrupted,
                () => Effect.interrupt,
            ),
            Effect.catchIf(
                () => this.#failure !== undefined,
                () => Effect.fail(this.#failure!),
            ),
            Effect.ensuring(
                Effect.sync(() => {
                    this.#reading = false
                }),
            ),
            Effect.flatMap((value) =>
                value === undefined ? this.closeEffect.pipe(Effect.as(undefined)) : Effect.succeed(value),
            ),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? this.closeEffect : Effect.void)),
        )
    })
}

function completeSourceCleanup(sources: readonly AttachmentTransferSource[]) {
    return completeCleanup(sources.map((source) => () => source.close()))
}

class RestFailure extends Error {
    constructor(
        readonly reason: MessageOperationError["reason"],
        readonly outcome: Outcome,
        readonly status: number | null = null,
        readonly retryAfterMs: number | null = null,
        readonly retryableRead = false,
        readonly apiError: ApiErrorDetail | null = null,
        readonly inputValidation: InputValidationDetail | null = null,
    ) {
        super("REST operation failed")
    }
}

// Keep the named REST metadata at one constructor boundary; domain tags and operation types stay distinct
function operationFailure<Operation extends string, Failure>(
    error: RestFailure | ClientClosedError,
    ErrorType: new (
        operation: Operation,
        reason: RestFailure["reason"],
        outcome: Outcome,
        status: number | null,
        retryAfterMs: number | null,
        apiError: ApiErrorDetail | null,
        inputValidation: InputValidationDetail | null,
    ) => Failure,
    operation: NoInfer<Operation>,
): Failure | ClientClosedError {
    if (!(error instanceof RestFailure)) return error
    return new ErrorType(
        operation,
        error.reason,
        error.outcome,
        error.status,
        error.retryAfterMs,
        error.apiError,
        error.inputValidation,
    )
}

/** Internal-only cleanup defect. Never retain an untrusted reader's thrown value */
class AttachmentStreamCleanupError extends Error {
    constructor() {
        super("Attachment stream cleanup failed")
        this.name = "AttachmentStreamCleanupError"
    }
}

function localInputFailure(path: string, constraint: InputValidationConstraint, explanation: string): RestFailure {
    return new RestFailure(
        "input",
        "notDispatched",
        null,
        null,
        false,
        null,
        inputValidationFailure(path, constraint, explanation).detail,
    )
}

function instanceFailure(error: unknown): RestFailure | ClientClosedError {
    if (error instanceof ClientClosedError) return error
    if (error instanceof RestFailure) return error
    if (error instanceof RateLimitError) return new RestFailure("rateLimit", "notDispatched", null, error.retryAfterMs)
    if (error instanceof ConnectionError) return new RestFailure("network", "notDispatched", error.status)
    return new RestFailure("network", "notDispatched")
}

function retryAfter(response: Response): number | null {
    const value = response.headers.get("retry-after")?.trim()
    if (!value) return null
    const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
    return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : null
}

const errorBodyMaxBytes = 8_192
const errorBodyReadTimeoutMs = 100

type ApiErrorRead = {
    readonly detail: ApiErrorDetail | null
    readonly retryAfterMs: number | null
    readonly global: boolean
    readonly cleanupDefect: unknown | null
}

class ApiErrorBodyCleanupError extends Error {
    constructor() {
        super("Failed to release an API error response body")
        this.name = "ApiErrorBodyCleanupError"
    }
}

async function readApiError(
    response: Response,
    signal: AbortSignal,
    source: "fluxer" | "upload" = "fluxer",
    requireJsonContentType = true,
): Promise<ApiErrorRead> {
    const body = response.body
    if (
        !body ||
        (requireJsonContentType && !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? ""))
    )
        return { detail: null, retryAfterMs: null, global: false, cleanupDefect: null }
    const declared = response.headers.get("content-length")
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > errorBodyMaxBytes))
        return { detail: null, retryAfterMs: null, global: false, cleanupDefect: null }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let cancel: (() => void) | undefined
    const cancelled = new Promise<"cancelled">((resolve) => {
        cancel = () => resolve("cancelled")
        signal.addEventListener("abort", cancel, { once: true })
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<"timedOut">((resolve) => {
        timer = setTimeout(() => resolve("timedOut"), errorBodyReadTimeoutMs)
    })
    let cancelBody = signal.aborted
    let result: ApiErrorDetail | null = null
    let retryAfterMs: number | null = null
    let global = false
    try {
        while (!cancelBody) {
            const next = await Promise.race([reader.read(), cancelled, timedOut])
            if (next === "cancelled" || next === "timedOut") {
                cancelBody = true
                break
            }
            if (next.done) break
            size += next.value.byteLength
            if (size > errorBodyMaxBytes) {
                cancelBody = true
                break
            }
            chunks.push(next.value)
        }
        if (!cancelBody) {
            const data: unknown = JSON.parse(
                new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
            )
            // Signed upload destinations can be external storage, not a Fluxer API error source
            result = source === "fluxer" ? apiErrorDetail(data) : null
            if (record(data)) {
                if (typeof data.retry_after === "number" && data.retry_after >= 0) {
                    const milliseconds = data.retry_after * 1000
                    if (Number.isFinite(milliseconds)) retryAfterMs = milliseconds
                }
                global = data.global === true
            }
        }
    } catch {
        result = null
    } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (cancel !== undefined) signal.removeEventListener("abort", cancel)
        reader.releaseLock()
    }
    let cleanupDefect: unknown | null = null
    if (cancelBody) {
        try {
            await body.cancel()
        } catch {
            cleanupDefect = new ApiErrorBodyCleanupError()
        }
    }
    return { detail: result, retryAfterMs, global, cleanupDefect }
}

function attachmentDownloadUrl(value: unknown, instance: InstanceEndpointContext): string | undefined {
    if (typeof value !== "string" || value.length < 1 || value.length > 8192) return undefined
    try {
        const base = new URL(instance.media)
        const url = new URL(value)
        const path = `${base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "")}/attachments/`
        return (base.protocol === "https:" || (instance.allowInsecure && base.protocol === "http:")) &&
            base.username === "" &&
            base.password === "" &&
            url.protocol === base.protocol &&
            url.origin === base.origin &&
            url.username === "" &&
            url.password === "" &&
            url.hash === "" &&
            url.pathname.startsWith(path)
            ? url.toString()
            : undefined
    } catch {
        return undefined
    }
}

async function readMessage(response: Response, channel: string, id?: string): Promise<Message> {
    const decoded = decodeMessage(await response.json().catch(() => null))
    if (!decoded || decoded.channelId !== channel || (id !== undefined && decoded.id !== id))
        throw new RestFailure("response", "unknown", response.status)
    return decoded
}

async function readHistory(
    response: Response,
    channel: string,
    query: { readonly limit: number; readonly params: URLSearchParams },
) {
    const body: unknown = await response.json().catch(() => null)
    const invalid = () => new RestFailure("response", "unknown", response.status)
    if (!Array.isArray(body) || body.length > query.limit) throw invalid()
    const messages: Message[] = []
    const before = query.params.get("before")
    const after = query.params.get("after")
    let previous: bigint | undefined
    for (const item of body) {
        const message = decodeMessage(item)
        if (!message || message.channelId !== channel) throw invalid()
        const id = BigInt(message.id)
        if (
            (previous !== undefined && id >= previous) ||
            (before !== null && id >= BigInt(before)) ||
            (after !== null && id <= BigInt(after))
        )
            throw invalid()
        previous = id
        messages.push(message)
    }
    return Object.freeze(messages)
}

/** One client's transient REST scheduler, without shared-token coordination or durable delivery */
export class RestOwner {
    constructor(
        private readonly cache: MessageCache | undefined,
        private readonly uploadMaxBytes: number,
        private readonly resources: GuildCache | undefined,
        private readonly channels: ChannelCache | undefined,
        private readonly users: UserCache | undefined,
        private readonly resolveInstance: () => Effect.Effect<InstanceEndpointContext, unknown>,
    ) {}
    #uploadBytes = 0
    #closed = false
    #active = 0
    #pending: Pending[] = []
    #bytes = 0
    #buckets = new Map<string, Bucket>()
    #globalUntil = 0
    #timer: ReturnType<typeof setTimeout> | undefined
    #controllers = new Set<AbortController>()
    #downloads = new Set<AttachmentDownloadSource>()
    #unobservedDownloadDefects = 0
    #operations = new Set<Deferred.Deferred<void>>()
    #instance: InstanceEndpointContext | undefined

    diagnostics() {
        return {
            activeRequests: this.#active,
            activeCapacity: activeRequestCapacity,
            queuedRequests: this.#pending.length,
            queuedCapacity: queuedRequestCapacity,
            queuedJsonBytes: this.#bytes,
            queuedJsonByteCapacity: queuedJsonMaxBytes,
            reservedUploadBytes: this.#uploadBytes,
            uploadByteCapacity: this.uploadMaxBytes,
        }
    }

    #pump() {
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        const now = performance.now()
        for (const [key, bucket] of this.#buckets) if (bucket.until <= now) this.#buckets.delete(key)
        if (this.#closed) return
        let earliest = Infinity
        for (let index = 0; index < this.#pending.length && this.#active < activeRequestCapacity;) {
            const item = this.#pending[index]!
            const bucket = item.rateLimited ? this.#buckets.get(item.route) : undefined
            const until = item.rateLimited
                ? Math.max(item.until, this.#globalUntil, bucket && bucket.remaining <= 0 ? bucket.until : 0)
                : item.until
            if (until > now) {
                earliest = Math.min(earliest, until)
                index++
                continue
            }
            this.#pending.splice(index, 1)
            this.#bytes -= item.bytes
            this.#active++
            if (bucket) bucket.remaining--
            let released = false
            item.resume(
                Effect.succeed(() => {
                    if (released) return
                    released = true
                    this.#active--
                    this.#pump()
                }),
            )
        }
        if (earliest !== Infinity && this.#active < activeRequestCapacity)
            this.#timer = setTimeout(() => this.#pump(), Math.min(2_147_483_647, Math.max(1, earliest - now)))
    }

    #acquire(
        route: string,
        bytes: number,
        until = 0,
        rateLimited = true,
    ): Effect.Effect<() => void, RestFailure | ClientClosedError> {
        return Effect.callback((resume) => {
            if (this.#closed) {
                resume(Effect.fail(new ClientClosedError()))
                return
            }
            // A new request may enter directly when there is no backlog and a slot is available
            if (this.#pending.length >= queuedRequestCapacity || bytes > queuedJsonMaxBytes - this.#bytes) {
                resume(Effect.fail(new RestFailure("busy", "notDispatched")))
                return
            }
            const item = { route, bytes, until, rateLimited, resume }
            this.#pending.push(item)
            this.#bytes += bytes
            this.#pump()
            return Effect.sync(() => {
                const index = this.#pending.indexOf(item)
                if (index !== -1) {
                    this.#pending.splice(index, 1)
                    this.#bytes -= bytes
                    this.#pump()
                }
            })
        })
    }

    #headers(route: string, response: Response) {
        const remainingText = response.headers.get("x-ratelimit-remaining")
        const resetText = response.headers.get("x-ratelimit-reset-after")
        if (remainingText === null || resetText === null) return
        const remaining = Number(remainingText)
        const delay = Number(resetText) * 1000
        if (Number.isSafeInteger(remaining) && remaining >= 0 && Number.isFinite(delay) && delay > 0) {
            const previous = this.#buckets.get(route)
            this.#buckets.set(route, {
                remaining: Math.min(previous?.remaining ?? remaining, remaining),
                until: Math.max(previous?.until ?? 0, performance.now() + delay),
            })
        }
    }

    #request<A>(
        token: Redacted.Redacted<string>,
        request: Request<A>,
        route: string,
        progress: { outcome: Outcome },
        generation: number,
    ): Effect.Effect<
        | { kind: "success"; value: A }
        | { kind: "retry"; retry: number; global: boolean; apiError: ApiErrorDetail | null },
        RestFailure | ClientClosedError
    > {
        const owner = this
        const failure = (error: unknown, state?: { cleanupDefects: unknown[] }): RestFailure | ClientClosedError => {
            if (error instanceof AttachmentTransferCleanupError) throw error
            if (error instanceof AttachmentTransferVerificationCleanupError) {
                state?.cleanupDefects.push(error.cleanup)
                return new RestFailure("network", progress.outcome)
            }
            if (error instanceof UploadResponseCleanupError) {
                state?.cleanupDefects.push(error.cause)
                const rejected = error.status >= 400
                if (rejected && !request.preparation) progress.outcome = "rejected"
                return new RestFailure(rejected ? "rejected" : "response", progress.outcome, error.status)
            }
            return owner.#closed
                ? new ClientClosedError()
                : error instanceof RestFailure || error instanceof ClientClosedError
                  ? error
                  : new RestFailure("network", progress.outcome)
        }
        return Effect.acquireUseRelease(
            Effect.sync(() => {
                // Opening a caller-owned source can throw before it is consumed. Do that
                // before registering client-owned controller or cache state, whose release
                // only runs after successful acquisition
                const putUpload = request.put
                    ? request.put.source.open(request.put.offset, request.put.size)
                    : undefined
                const upload =
                    putUpload ??
                    ((request.webhookId || request.inlineAttachments) && request.body?.files.length
                        ? multipart(request.body, request.sources ?? [])
                        : undefined)
                const multipartHeaders =
                    upload && "contentType" in upload && "size" in upload
                        ? { "Content-Type": String(upload.contentType), "Content-Length": String(upload.size) }
                        : undefined
                const controller = new AbortController()
                owner.#controllers.add(controller)
                const guard =
                    request.cache === false ||
                    request.preparation ||
                    request.bucket === "reaction" ||
                    (request.bucket === "pins" && request.method === "GET")
                        ? undefined
                        : owner.cache?.begin(
                              request.channel,
                              request.target,
                              request.method === "PATCH" || request.method === "DELETE" || request.bucket === "pins",
                              generation,
                          )
                return {
                    controller,
                    settled: Promise.resolve(),
                    response: undefined as Response | undefined,
                    guard,
                    success: false,
                    upload,
                    putUpload,
                    multipartHeaders,
                    cleanupDefects: [] as unknown[],
                }
            }),
            (state) =>
                Effect.tryPromise({
                    try: () => {
                        if (owner.#closed) throw new ClientClosedError()
                        if (!request.preparation) progress.outcome = "unknown"
                        const work = fetch(
                            request.put?.url ??
                                `${request.instance!.apiPublic}/v1${request.webhookId ? `/webhooks/${request.webhookId}/${encodeURIComponent(Redacted.value(token))}` : ""}${request.path}`,
                            {
                                method: request.method,
                                redirect: "error",
                                signal: state.controller.signal,
                                headers: request.put
                                    ? {
                                          "Content-Length": String(request.put.size),
                                          ...(request.put.contentType
                                              ? { "Content-Type": request.put.contentType }
                                              : {}),
                                      }
                                    : {
                                          ...(request.webhookId
                                              ? {}
                                              : { Authorization: `Bot ${Redacted.value(token)}` }),
                                          ...(request.auditReason === undefined
                                              ? {}
                                              : { "X-Audit-Log-Reason": request.auditReason }),
                                          ...(state.multipartHeaders
                                              ? state.multipartHeaders
                                              : request.body === undefined
                                                ? {}
                                                : { "Content-Type": "application/json" }),
                                      },
                                ...(state.upload
                                    ? { body: state.upload.body }
                                    : request.body
                                      ? { body: request.body.json }
                                      : {}),
                                ...(state.upload === undefined ? {} : { duplex: "half" }),
                            },
                        )
                            .then((response) => {
                                state.response = response
                                return response
                            })
                            .catch((error) => {
                                if (
                                    error instanceof AttachmentTransferCleanupError ||
                                    error instanceof AttachmentTransferVerificationCleanupError
                                )
                                    throw error
                                throw new RestFailure("network", progress.outcome, null, null, true)
                            })
                        state.settled = work.then(
                            () => undefined,
                            () => undefined,
                        )
                        return work
                    },
                    catch: (error) => failure(error, state),
                }).pipe(
                    Effect.flatMap((response) => {
                        if (!request.put) owner.#headers(route, response)
                        return Effect.tryPromise({
                            try: () => {
                                const work = (async () => {
                                    if (response.status === 429) {
                                        if (request.put) {
                                            const apiRead = await readApiError(
                                                response,
                                                state.controller.signal,
                                                "upload",
                                                false,
                                            )
                                            if (apiRead.cleanupDefect !== null)
                                                state.cleanupDefects.push(apiRead.cleanupDefect)
                                            throw new RestFailure(
                                                "rateLimit",
                                                progress.outcome,
                                                429,
                                                apiRead.retryAfterMs,
                                                false,
                                                apiRead.detail,
                                            )
                                        }
                                        const header = response.headers.get("retry-after")
                                        let delay = header === null ? NaN : Number(header) * 1000
                                        if (header !== null && !Number.isFinite(delay))
                                            delay = Date.parse(header) - Date.now()
                                        const apiRead = await readApiError(
                                            response,
                                            state.controller.signal,
                                            "fluxer",
                                            false,
                                        )
                                        if (apiRead.cleanupDefect !== null)
                                            state.cleanupDefects.push(apiRead.cleanupDefect)
                                        if (apiRead.retryAfterMs !== null)
                                            delay = Math.max(Number.isFinite(delay) ? delay : 0, apiRead.retryAfterMs)
                                        // Mutation resends require a received rate-limit rejection
                                        if (!request.preparation) progress.outcome = "rejected"
                                        if (!Number.isFinite(delay) || delay <= 0)
                                            throw new RestFailure(
                                                "rateLimit",
                                                progress.outcome,
                                                429,
                                                null,
                                                false,
                                                apiRead.detail,
                                            )
                                        const retry = Math.ceil(delay)
                                        const global = apiRead.global
                                        const until = performance.now() + retry
                                        if (global) owner.#globalUntil = Math.max(owner.#globalUntil, until)
                                        else owner.#buckets.set(route, { remaining: 0, until })
                                        return { kind: "retry" as const, retry, global, apiError: apiRead.detail }
                                    }
                                    if (!response.ok) {
                                        let apiRead: ApiErrorRead | undefined
                                        if (response.status === 403 && request.featureDisabled) {
                                            apiRead = await readApiError(response, state.controller.signal)
                                            if (apiRead.cleanupDefect !== null)
                                                state.cleanupDefects.push(apiRead.cleanupDefect)
                                            if (apiRead.detail?.providerCode === "FEATURE_TEMPORARILY_DISABLED")
                                                return { kind: "success" as const, value: request.featureDisabled() }
                                        }
                                        if (
                                            response.status === 404 &&
                                            request.method === "GET" &&
                                            request.resourceGuard
                                        )
                                            owner.resources!.missing(request.resourceGuard)
                                        if (response.status === 404 && request.method === "GET" && request.channelGuard)
                                            owner.channels!.missing(request.channelGuard)
                                        const rejected = response.status >= 400 && response.status < 500
                                        if (rejected && !request.preparation) progress.outcome = "rejected"
                                        const retryableRead =
                                            request.method === "GET" && [500, 502, 503, 504].includes(response.status)
                                        apiRead ??= await readApiError(
                                            response,
                                            state.controller.signal,
                                            request.put ? "upload" : "fluxer",
                                        )
                                        if (
                                            apiRead.cleanupDefect !== null &&
                                            !state.cleanupDefects.includes(apiRead.cleanupDefect)
                                        )
                                            state.cleanupDefects.push(apiRead.cleanupDefect)
                                        const headerRetryAfterMs = retryAfter(response)
                                        const retryAfterMs =
                                            headerRetryAfterMs === null
                                                ? apiRead.retryAfterMs
                                                : apiRead.retryAfterMs === null
                                                  ? headerRetryAfterMs
                                                  : Math.max(headerRetryAfterMs, apiRead.retryAfterMs)
                                        throw new RestFailure(
                                            response.status === 404 && !request.preparation ? "notFound" : "rejected",
                                            progress.outcome,
                                            response.status,
                                            retryAfterMs,
                                            retryableRead,
                                            apiRead.detail,
                                        )
                                    }
                                    if (request.status !== undefined && response.status !== request.status)
                                        throw new RestFailure("response", progress.outcome, response.status)
                                    const value = await request.decode(response, request.instance!)
                                    return { kind: "success" as const, value }
                                })()
                                state.settled = work.then(
                                    () => undefined,
                                    () => undefined,
                                )
                                return work
                            },
                            catch: (error) => failure(error, state),
                        })
                    }),
                    Effect.flatMap((result) =>
                        result.kind === "success" && state.putUpload
                            ? Effect.tryPromise({
                                  try: () => state.putUpload!.verify(),
                                  catch: (error) => failure(error, state),
                              }).pipe(
                                  Effect.flatMap(() => Effect.promise(() => state.putUpload!.finish())),
                                  Effect.as(result),
                              )
                            : Effect.succeed(result),
                    ),
                    Effect.map((result) => {
                        if (result.kind === "success") {
                            state.success = true
                            if (request.resourceGuard) owner.resources!.complete(request.resourceGuard, result.value)
                            if (request.channelGuard) owner.channels!.complete(request.channelGuard, result.value)
                            if (state.guard) {
                                if (request.method === "DELETE" || request.bucket === "pins")
                                    owner.cache!.delete(
                                        { id: request.target!, channelId: request.channel },
                                        state.guard,
                                    )
                                else
                                    owner.cache!.complete(
                                        state.guard,
                                        Array.isArray(result.value) ? result.value : [result.value as Message],
                                    )
                            }
                        }
                        return result
                    }),
                ),
            (state) =>
                Effect.uninterruptible(
                    Effect.promise(async () => {
                        let cancelled = false
                        await completeCleanup([
                            async () => {
                                if (state.response && !state.response.bodyUsed) {
                                    await state.response.body?.cancel()
                                    cancelled = true
                                }
                            },
                            () => state.controller.abort(),
                            () => state.upload?.stop(),
                            () => state.settled,
                            async () => {
                                const response = state.response
                                if (!cancelled && response && !response.bodyUsed) {
                                    try {
                                        await response.body?.cancel()
                                    } catch (error) {
                                        if (
                                            !state.controller.signal.aborted ||
                                            error !== state.controller.signal.reason
                                        )
                                            throw error
                                    }
                                }
                            },
                            () => {
                                if (state.cleanupDefects.length === 1) throw state.cleanupDefects[0]
                                if (state.cleanupDefects.length > 1)
                                    throw new AggregateError(state.cleanupDefects, "REST response cleanup failed")
                            },
                        ])
                    }).pipe(
                        Effect.ensuring(
                            Effect.sync(() => {
                                owner.#controllers.delete(state.controller)
                                if (state.guard) {
                                    if (!state.success && progress.outcome === "unknown" && state.guard.mutation)
                                        owner.cache!.delete(
                                            { id: request.target!, channelId: request.channel },
                                            state.guard,
                                        )
                                    owner.cache!.end(state.guard)
                                }
                            }),
                        ),
                    ),
                ),
        )
    }

    openDownload(
        attachment: Attachment,
        options?: AttachmentDownloadOptions,
    ): Effect.Effect<AttachmentDownloadSource, AttachmentDownloadFailure> {
        const owner = this
        return Effect.suspend((): Effect.Effect<AttachmentDownloadSource, AttachmentDownloadFailure> => {
            if (owner.#closed) return Effect.fail(new ClientClosedError())
            if (!record(options))
                return Effect.fail(
                    new AttachmentDownloadError(
                        "input",
                        null,
                        inputValidationFailure("options", "type", "Attachment download options must be an object")
                            .detail,
                    ),
                )
            const maxBytes = options.maxBytes
            const attachmentUrl = attachment?.url
            if (Object.keys(options).some((key) => key !== "maxBytes" && key !== "timeoutMs" && key !== "signal"))
                return Effect.fail(
                    new AttachmentDownloadError(
                        "input",
                        null,
                        inputValidationFailure(
                            "options",
                            "allowedFields",
                            "Attachment download options may contain only maxBytes, timeoutMs, and signal",
                        ).detail,
                    ),
                )
            const signal = (options as Record<string, unknown>).signal
            if (
                signal !== undefined &&
                (!record(signal) ||
                    typeof signal.aborted !== "boolean" ||
                    typeof signal.addEventListener !== "function" ||
                    typeof signal.removeEventListener !== "function")
            )
                return Effect.fail(
                    new AttachmentDownloadError(
                        "input",
                        null,
                        inputValidationFailure(
                            "options.signal",
                            "type",
                            "Attachment signal must be AbortSignal-compatible",
                        ).detail,
                    ),
                )
            if (
                typeof maxBytes !== "number" ||
                !Number.isSafeInteger(maxBytes) ||
                maxBytes <= 0 ||
                maxBytes > 52_428_800
            )
                return Effect.fail(
                    new AttachmentDownloadError(
                        "input",
                        null,
                        inputValidationFailure(
                            "options.maxBytes",
                            "range",
                            "Attachment maxBytes must be an integer from 1 through 52,428,800",
                        ).detail,
                    ),
                )
            const timeout = options.timeoutMs === undefined ? 30_000 : options.timeoutMs
            if (
                typeof timeout !== "number" ||
                !Number.isSafeInteger(timeout) ||
                timeout <= 0 ||
                timeout > 2_147_483_647
            )
                return Effect.fail(
                    new AttachmentDownloadError(
                        "input",
                        null,
                        inputValidationFailure(
                            "options.timeoutMs",
                            "range",
                            "Attachment timeoutMs must be an integer from 1 through 2,147,483,647 milliseconds",
                        ).detail,
                    ),
                )
            const operation = Deferred.makeUnsafe<void>()
            owner.#operations.add(operation)
            const complete = () => {
                owner.#operations.delete(operation)
                Deferred.doneUnsafe(operation, Effect.void)
            }
            let source: AttachmentDownloadSource | undefined
            const deadline = Date.now() + timeout
            return Effect.gen(function* () {
                const resolved = owner.#instance
                const instance =
                    resolved ??
                    (yield* Effect.acquireUseRelease(
                        Effect.interruptible(owner.#acquire("media:discovery", 0, 0, false)),
                        () => owner.resolveInstance(),
                        (release) => Effect.sync(release),
                    ).pipe(
                        mapFailureCause((error) =>
                            error instanceof ClientClosedError
                                ? error
                                : error instanceof RestFailure
                                  ? new AttachmentDownloadError(
                                        error.reason === "busy" ? "busy" : "network",
                                        error.status,
                                    )
                                  : new AttachmentDownloadError(
                                        "network",
                                        error instanceof ConnectionError ? error.status : null,
                                    ),
                        ),
                    ))
                if (!resolved) owner.#instance = instance
                const url = attachmentDownloadUrl(attachmentUrl, instance)
                if (!url) return yield* Effect.fail(new AttachmentDownloadError("untrustedUrl"))
                const release = yield* owner
                    .#acquire("media:download", 0, 0, false)
                    .pipe(Effect.interruptible)
                    .pipe(
                        mapFailureCause((error) =>
                            error instanceof ClientClosedError
                                ? error
                                : error instanceof RestFailure
                                  ? new AttachmentDownloadError(
                                        error.reason === "busy" ? "busy" : "network",
                                        error.status,
                                    )
                                  : new AttachmentDownloadError("network"),
                        ),
                    )
                const controller = new AbortController()
                owner.#controllers.add(controller)
                source = new AttachmentDownloadSource(
                    controller,
                    maxBytes,
                    deadline,
                    release,
                    () => {
                        owner.#controllers.delete(controller)
                        owner.#downloads.delete(source!)
                        complete()
                    },
                    () => {
                        owner.#unobservedDownloadDefects = Math.min(
                            Number.MAX_SAFE_INTEGER,
                            owner.#unobservedDownloadDefects + 1,
                        )
                    },
                    () => {
                        if (owner.#unobservedDownloadDefects < Number.MAX_SAFE_INTEGER)
                            owner.#unobservedDownloadDefects = Math.max(0, owner.#unobservedDownloadDefects - 1)
                    },
                )
                owner.#downloads.add(source)
                const response = yield* Effect.tryPromise({
                    try: () => source!.open(url),
                    catch: (error) =>
                        error instanceof AttachmentDownloadError ? error : new AttachmentDownloadError("network", null),
                })
                try {
                    source.accept(response, response.ok)
                } catch (error) {
                    return yield* Effect.fail(
                        error instanceof AttachmentDownloadError || error instanceof ClientClosedError
                            ? error
                            : new AttachmentDownloadError("network", response.status),
                    )
                }
                if (controller.signal.aborted) return yield* Effect.fail(new ClientClosedError())
                if (!response.ok) return yield* Effect.fail(new AttachmentDownloadError("response", response.status))
                return source
            }).pipe(
                withDeadline(timeout, () => new AttachmentDownloadError("timeout")),
                Effect.onExit((exit) =>
                    Exit.isFailure(exit) ? (source ? source.closeEffect : Effect.sync(complete)) : Effect.void,
                ),
            )
        })
    }

    download(
        attachment: Attachment,
        options?: AttachmentDownloadOptions,
    ): Effect.Effect<Uint8Array, AttachmentDownloadFailure> {
        const owner = this
        return Effect.suspend((): Effect.Effect<Uint8Array, AttachmentDownloadFailure> => {
            if (owner.#closed) return Effect.fail(new ClientClosedError())
            if (!record(options))
                return Effect.fail(
                    new AttachmentDownloadError(
                        "input",
                        null,
                        inputValidationFailure("options", "type", "Attachment download options must be an object")
                            .detail,
                    ),
                )
            const maxBytes = options.maxBytes
            const attachmentUrl = attachment?.url
            if (Object.keys(options).some((key) => key !== "maxBytes" && key !== "timeoutMs" && key !== "signal"))
                return Effect.fail(
                    new AttachmentDownloadError(
                        "input",
                        null,
                        inputValidationFailure(
                            "options",
                            "allowedFields",
                            "Attachment download options may contain only maxBytes, timeoutMs, and signal",
                        ).detail,
                    ),
                )
            if (
                typeof maxBytes !== "number" ||
                !Number.isSafeInteger(maxBytes) ||
                maxBytes <= 0 ||
                maxBytes > 52_428_800
            )
                return Effect.fail(
                    new AttachmentDownloadError(
                        "input",
                        null,
                        inputValidationFailure(
                            "options.maxBytes",
                            "range",
                            "Attachment maxBytes must be an integer from 1 through 52,428,800",
                        ).detail,
                    ),
                )
            const timeout = options.timeoutMs === undefined ? 30_000 : options.timeoutMs
            if (
                typeof timeout !== "number" ||
                !Number.isSafeInteger(timeout) ||
                timeout <= 0 ||
                timeout > 2_147_483_647
            )
                return Effect.fail(
                    new AttachmentDownloadError(
                        "input",
                        null,
                        inputValidationFailure(
                            "options.timeoutMs",
                            "range",
                            "Attachment timeoutMs must be an integer from 1 through 2,147,483,647 milliseconds",
                        ).detail,
                    ),
                )
            const operation = Deferred.makeUnsafe<void>()
            owner.#operations.add(operation)
            let controller: AbortController | undefined
            let response: Response | undefined
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
            let ended = false
            let settled = Promise.resolve()
            let release: (() => void) | undefined
            const cancel = async (action: () => void | PromiseLike<void>) => {
                try {
                    await action()
                } catch (error) {
                    // Fetch can return this controller's exact abort reason while closing its own body
                    if (!(controller?.signal.aborted && error === controller.signal.reason)) throw error
                }
            }
            const closeBody = async () => {
                if (reader) {
                    const current = reader
                    reader = undefined
                    await completeCleanup([
                        ...(!ended ? [() => cancel(() => current.cancel())] : []),
                        () => current.releaseLock(),
                    ])
                } else if (response && !response.bodyUsed) {
                    const body = response.body
                    if (body) await cancel(() => body.cancel())
                }
            }
            return Effect.gen(function* () {
                const resolved = owner.#instance
                const instance =
                    resolved ??
                    (yield* Effect.acquireUseRelease(
                        Effect.interruptible(owner.#acquire("media:discovery", 0, 0, false)),
                        () => owner.resolveInstance(),
                        (release) => Effect.sync(release),
                    ).pipe(
                        mapFailureCause((error) =>
                            error instanceof ClientClosedError
                                ? error
                                : error instanceof RestFailure
                                  ? new AttachmentDownloadError(
                                        error.reason === "busy" ? "busy" : "network",
                                        error.status,
                                    )
                                  : new AttachmentDownloadError(
                                        "network",
                                        error instanceof ConnectionError ? error.status : null,
                                    ),
                        ),
                    ))
                if (!resolved) owner.#instance = instance
                const url = attachmentDownloadUrl(attachmentUrl, instance)
                if (!url) return yield* Effect.fail(new AttachmentDownloadError("untrustedUrl"))
                // Media transfers share the client's four HTTP slots but not API rate-limit buckets
                release = yield* owner
                    .#acquire("media:download", 0, 0, false)
                    .pipe(Effect.interruptible)
                    .pipe(
                        mapFailureCause((error) =>
                            error instanceof ClientClosedError
                                ? error
                                : error instanceof RestFailure
                                  ? new AttachmentDownloadError(
                                        error.reason === "busy" ? "busy" : "network",
                                        error.status,
                                    )
                                  : new AttachmentDownloadError("network"),
                        ),
                    )
                controller = new AbortController()
                owner.#controllers.add(controller)
                return yield* Effect.tryPromise({
                    try: () => {
                        const work = (async () => {
                            response = await fetch(url, {
                                method: "GET",
                                redirect: "error",
                                signal: controller!.signal,
                            })
                            if (controller!.signal.aborted) {
                                throw controller!.signal.reason ?? new Error("Attachment download aborted")
                            }
                            if (!response.ok) throw new AttachmentDownloadError("response", response.status)
                            const declared = response.headers.get("content-length")
                            if (declared !== null) {
                                if (!/^\d+$/.test(declared))
                                    throw new AttachmentDownloadError("response", response.status)
                                if (Number(declared) > maxBytes)
                                    throw new AttachmentDownloadError("tooLarge", response.status)
                            }
                            reader = response.body?.getReader()
                            if (!reader) {
                                ended = true
                                return new Uint8Array()
                            }
                            const chunks: Uint8Array[] = []
                            let total = 0
                            while (true) {
                                const next = await reader.read()
                                if (next.done) {
                                    ended = true
                                    break
                                }
                                if (!(next.value instanceof Uint8Array) || !(next.value.buffer instanceof ArrayBuffer))
                                    throw new AttachmentDownloadError("response", response.status)
                                total += next.value.byteLength
                                if (!Number.isSafeInteger(total) || total > maxBytes)
                                    throw new AttachmentDownloadError("tooLarge", response.status)
                                chunks.push(next.value)
                            }
                            const output = new Uint8Array(total)
                            let offset = 0
                            for (const chunk of chunks) {
                                output.set(chunk, offset)
                                offset += chunk.byteLength
                            }
                            return output
                        })()
                        settled = work.then(
                            () => undefined,
                            () => undefined,
                        )
                        return work
                    },
                    catch: (error) =>
                        error instanceof AttachmentDownloadError
                            ? error
                            : new AttachmentDownloadError("network", response?.status ?? null),
                })
            }).pipe(
                withDeadline(timeout, () => new AttachmentDownloadError("timeout")),
                Effect.ensuring(
                    Effect.uninterruptible(
                        Effect.promise(async () => {
                            await completeCleanup([
                                () => controller?.abort(),
                                () => closeBody(),
                                () => settled,
                                () => closeBody(),
                                () => release?.(),
                                () => {
                                    if (controller) owner.#controllers.delete(controller)
                                },
                            ])
                        }).pipe(
                            Effect.ensuring(
                                Effect.sync(() => {
                                    owner.#operations.delete(operation)
                                    Deferred.doneUnsafe(operation, Effect.void)
                                }),
                            ),
                        ),
                    ),
                ),
            )
        })
    }

    send(
        token: Redacted.Redacted<string>,
        channel: string,
        input: MessageInput,
        options?: SendOptions,
        directMessageUser?: string,
    ): Effect.Effect<Message, SendError> {
        return this.#send(
            token,
            channel,
            () => encodeMessage(channel, input, randomUUID().replaceAll("-", "")),
            options,
            directMessageUser,
        )
    }

    forward(token: Redacted.Redacted<string>, channel: string, input: ForwardMessageInput, options?: SendOptions) {
        return this.#send(
            token,
            channel,
            () => encodeForward(channel, input, randomUUID().replaceAll("-", "")),
            options,
        )
    }

    #send(
        token: Redacted.Redacted<string>,
        channel: string,
        encode: () => EncodedBody | MessageError,
        options?: SendOptions,
        directMessageUser?: string,
    ): Effect.Effect<Message, SendError> {
        return Effect.suspend((): Effect.Effect<Message, SendError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const body = encode()
            if (body instanceof MessageError) return Effect.fail(body)
            return this.#execute(
                token,
                {
                    method: "POST",
                    channel,
                    body,
                    path: `/channels/${channel}/messages`,
                    ...(directMessageUser === undefined ? {} : { directMessageUser }),
                    decode: (response) => readMessage(response, channel),
                },
                options,
            ).pipe(
                mapFailureCause((error) =>
                    error instanceof RestFailure
                        ? new MessageError(
                              error.reason === "notFound" ? "rejected" : error.reason,
                              error.outcome === "unknown" ? "unknown" : "notSent",
                              error.status,
                              error.retryAfterMs,
                              error.apiError,
                              error.inputValidation,
                          )
                        : error,
                ),
            )
        })
    }

    fetch(token: Redacted.Redacted<string>, target: MessageReference, options?: MessageOperationOptions) {
        return this.#manage(token, "fetch", target, undefined, options, (response, ref) =>
            readMessage(response, ref.channelId, ref.id),
        )
    }

    typing(
        token: Redacted.Redacted<string>,
        channel: string,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            if (!identifier(channel))
                return Effect.fail(localInputFailure("channelId", "format", "Channel IDs must be decimal strings"))
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            if (record(options) && Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal"))
                return Effect.fail(
                    localInputFailure(
                        "options",
                        "allowedFields",
                        "Operation options may contain only timeoutMs and signal",
                    ),
                )
            return this.#execute(
                token,
                {
                    method: "POST",
                    channel,
                    bucket: "typing",
                    cache: false,
                    path: `/channels/${channel}/typing`,
                    body: undefined,
                    status: 204,
                    decode: async () => {},
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, "typing")))
    }

    fetchHistory(
        token: Redacted.Redacted<string>,
        channel: string,
        query?: MessageHistoryQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<readonly Message[], MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<readonly Message[], RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const encoded = encodeHistory(channel, query)
            if (encoded instanceof InputValidationFailure)
                return Effect.fail(new RestFailure("input", "notDispatched", null, null, false, null, encoded.detail))
            return this.#execute(
                token,
                {
                    method: "GET",
                    channel,
                    bucket: "history",
                    path: `/channels/${channel}/messages?${encoded.params}`,
                    body: undefined,
                    status: 200,
                    decode: (response) => readHistory(response, channel, encoded),
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, "fetchHistory")))
    }

    search(
        token: Redacted.Redacted<string>,
        context: MessageSearchContext,
        query?: MessageSearchQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<MessageSearchPage, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<MessageSearchPage, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const encoded = encodeMessageSearch(context, query)
            if (encoded instanceof InputValidationFailure)
                return Effect.fail(new RestFailure("input", "notDispatched", null, null, false, null, encoded.detail))
            return this.#execute(
                token,
                {
                    method: "POST",
                    channel: context.channelId ?? context.guildId!,
                    bucket: "search",
                    cache: false,
                    path: "/search/messages",
                    body: { json: encoded.json, files: [] },
                    status: 200,
                    decode: async (response) => {
                        const decoded = decodeMessageSearchPage(await response.json().catch(() => null))
                        if (!decoded) throw new RestFailure("response", "unknown", response.status)
                        return decoded
                    },
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, "search")))
    }

    edit(
        token: Redacted.Redacted<string>,
        target: MessageReference,
        input: EditMessageInput,
        options?: MessageOperationOptions,
    ) {
        return this.#manage(token, "edit", target, input, options, (response, ref) =>
            readMessage(response, ref.channelId, ref.id),
        )
    }

    delete(token: Redacted.Redacted<string>, target: MessageReference, options?: MessageOperationOptions) {
        return this.#manage(token, "delete", target, undefined, options, async () => {})
    }

    deleteAttachment(
        token: Redacted.Redacted<string>,
        target: MessageReference,
        attachmentId: string,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            if (!reference(target))
                return Effect.fail(
                    localInputFailure("target", "format", "Message targets require decimal id and channelId strings"),
                )
            if (!identifier(attachmentId))
                return Effect.fail(
                    localInputFailure("attachmentId", "format", "Attachment IDs must be decimal strings"),
                )
            const ref = { channelId: target.channelId, id: target.id }
            return this.#execute(
                token,
                {
                    method: "DELETE",
                    channel: ref.channelId,
                    target: ref.id,
                    path: `/channels/${ref.channelId}/messages/${ref.id}/attachments/${attachmentId}`,
                    body: undefined,
                    status: 204,
                    decode: async () => {},
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, "deleteAttachment")))
    }

    deleteMany(
        token: Redacted.Redacted<string>,
        channelId: string,
        ids: readonly string[],
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            if (!identifier(channelId))
                return Effect.fail(localInputFailure("channelId", "format", "Channel IDs must be decimal strings"))
            if (!Array.isArray(ids))
                return Effect.fail(localInputFailure("messageIds", "type", "Message IDs must be an array"))
            if (ids.length < 1 || ids.length > 100)
                return Effect.fail(
                    localInputFailure("messageIds", "length", "Bulk deletion requires 1 through 100 message IDs"),
                )
            if (!Array.from(ids).every(identifier))
                return Effect.fail(localInputFailure("messageIds[]", "format", "Message IDs must be decimal strings"))
            if (new Set(ids).size !== ids.length)
                return Effect.fail(localInputFailure("messageIds", "unique", "Message IDs must be unique"))
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            if (record(options) && Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal"))
                return Effect.fail(
                    localInputFailure(
                        "options",
                        "allowedFields",
                        "Operation options may contain only timeoutMs and signal",
                    ),
                )
            const snapshot = [...ids]
            return this.#execute(
                token,
                {
                    method: "POST",
                    channel: channelId,
                    bucket: "bulk-delete",
                    cache: false,
                    deleteIds: snapshot,
                    path: `/channels/${channelId}/messages/bulk-delete`,
                    body: { json: JSON.stringify({ message_ids: snapshot }), files: [] },
                    status: 204,
                    decode: async () => {},
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, "deleteMany")))
    }

    fetchReactionUsers(
        token: Redacted.Redacted<string>,
        target: MessageReference,
        emoji: ReactionEmojiInput,
        query?: ReactionUsersQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<ReactionUsersPage, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<ReactionUsersPage, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const encoded = encodeReactionEmoji(emoji)
            const page = encodeReactionUsersQuery(query)
            if (!reference(target))
                return Effect.fail(
                    localInputFailure("target", "format", "Message targets require decimal id and channelId strings"),
                )
            if (encoded === undefined)
                return Effect.fail(
                    localInputFailure(
                        "emoji",
                        "format",
                        "Reaction emoji must be Unicode text or a custom emoji with a decimal ID",
                    ),
                )
            if (page instanceof InputValidationFailure)
                return Effect.fail(new RestFailure("input", "notDispatched", null, null, false, null, page.detail))
            return this.#execute(
                token,
                {
                    method: "GET",
                    channel: target.channelId,
                    bucket: "reaction",
                    path: `/channels/${target.channelId}/messages/${target.id}/reactions/${encoded}/users?${page.params}`,
                    body: undefined,
                    status: 200,
                    decode: async (response) => {
                        const decoded = decodeReactionUsersPage(await response.json().catch(() => null), page)
                        if (!decoded) throw new RestFailure("response", "unknown", response.status)
                        return decoded
                    },
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, "fetchReactionUsers")))
    }

    fetchPins(
        token: Redacted.Redacted<string>,
        channel: string,
        query?: MessagePinsQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<MessagePinsPage, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<MessagePinsPage, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const page = encodePinsQuery(channel, query)
            if (page instanceof InputValidationFailure)
                return Effect.fail(new RestFailure("input", "notDispatched", null, null, false, null, page.detail))
            return this.#execute(
                token,
                {
                    method: "GET",
                    channel,
                    bucket: "pins",
                    path: `/channels/${channel}/messages/pins?${page.params}`,
                    body: undefined,
                    status: 200,
                    decode: async (response) => {
                        const decoded = decodePinsPage(await response.json().catch(() => null), channel, page)
                        if (!decoded) throw new RestFailure("response", "unknown", response.status)
                        return decoded
                    },
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, "fetchPins")))
    }

    pin(
        token: Redacted.Redacted<string>,
        operation: "pin" | "unpin",
        target: MessageReference,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            if (!reference(target))
                return Effect.fail(
                    localInputFailure("target", "format", "Message targets require decimal id and channelId strings"),
                )
            return this.#execute(
                token,
                {
                    method: operation === "pin" ? "PUT" : "DELETE",
                    channel: target.channelId,
                    target: target.id,
                    bucket: "pins",
                    path: `/channels/${target.channelId}/pins/${target.id}`,
                    body: undefined,
                    status: 204,
                    decode: async () => {},
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, operation)))
    }

    reaction(
        token: Redacted.Redacted<string>,
        operation: "addReaction" | "removeReaction" | "removeUserReaction" | "clearReaction" | "clearReactions",
        target: MessageReference,
        emoji: ReactionEmojiInput | undefined,
        options?: MessageOperationOptions,
        userId?: string,
    ): Effect.Effect<void, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const encoded = operation === "clearReactions" ? "" : encodeReactionEmoji(emoji as ReactionEmojiInput)
            if (!reference(target))
                return Effect.fail(
                    localInputFailure("target", "format", "Message targets require decimal id and channelId strings"),
                )
            if (encoded === undefined)
                return Effect.fail(
                    localInputFailure(
                        "emoji",
                        "format",
                        "Reaction emoji must be Unicode text or a custom emoji with a decimal ID",
                    ),
                )
            if (operation === "removeUserReaction" && !identifier(userId))
                return Effect.fail(localInputFailure("userId", "format", "User IDs must be decimal strings"))
            const suffix =
                operation === "clearReactions"
                    ? ""
                    : operation === "clearReaction"
                      ? `/${encoded}`
                      : `/${encoded}/${operation === "removeUserReaction" ? userId : "@me"}`
            return this.#execute(
                token,
                {
                    method: operation === "addReaction" ? "PUT" : "DELETE",
                    channel: target.channelId,
                    bucket: "reaction",
                    path: `/channels/${target.channelId}/messages/${target.id}/reactions${suffix}`,
                    body: undefined,
                    status: 204,
                    decode: async () => {},
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, operation)))
    }

    #manage<A>(
        token: Redacted.Redacted<string>,
        operation: "fetch" | "edit" | "delete",
        target: MessageReference,
        input: EditMessageInput | undefined,
        options: MessageOperationOptions | undefined,
        decode: (response: Response, ref: MessageReference) => Promise<A>,
    ): Effect.Effect<A, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            if (!reference(target))
                return Effect.fail(
                    localInputFailure("target", "format", "Message targets require decimal id and channelId strings"),
                )
            const ref = { channelId: target.channelId, id: target.id }
            const body = operation === "edit" ? encodeEdit(input) : undefined
            if (body instanceof InputValidationFailure)
                return Effect.fail(new RestFailure("input", "notDispatched", null, null, false, null, body.detail))
            return this.#execute(
                token,
                {
                    method: operation === "fetch" ? "GET" : operation === "edit" ? "PATCH" : "DELETE",
                    channel: ref.channelId,
                    target: ref.id,
                    path: `/channels/${ref.channelId}/messages/${ref.id}`,
                    body,
                    status: operation === "delete" ? 204 : 200,
                    decode: (response) => decode(response, ref),
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, operation)))
    }

    #exchange<A>(
        token: Redacted.Redacted<string>,
        request: Request<A>,
        progress: { outcome: Outcome },
        generation: number,
        deadline: number,
        retainedBytes = 0,
    ): Effect.Effect<A, RestFailure | ClientClosedError> {
        const owner = this
        const route = `${request.bucket ?? request.method}:${request.channel}`
        const bytes = retainedBytes + Buffer.byteLength(request.body?.json ?? "")
        return Effect.gen(function* () {
            let retries = 0
            let until = 0
            while (true) {
                const attempt = yield* Effect.uninterruptibleMask((restore) =>
                    Effect.exit(
                        restore(
                            Effect.acquireUseRelease(
                                Effect.interruptible(owner.#acquire(route, bytes, until)).pipe(
                                    mapFailureCause((error) =>
                                        error instanceof RestFailure
                                            ? new RestFailure(
                                                  error.reason,
                                                  progress.outcome,
                                                  error.status,
                                                  error.retryAfterMs,
                                                  error.retryableRead,
                                                  error.apiError,
                                                  error.inputValidation,
                                              )
                                            : error,
                                    ),
                                ),
                                () =>
                                    performance.now() >= deadline
                                        ? Effect.fail(new RestFailure("timeout", progress.outcome))
                                        : owner.#request(token, request, route, progress, generation),
                                (release) => Effect.sync(release),
                            ),
                        ),
                    ).pipe(
                        Effect.flatMap((exit) =>
                            Exit.isFailure(exit) && (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
                                ? Effect.failCause(exit.cause)
                                : Effect.succeed(exit),
                        ),
                    ),
                )
                if (Exit.isFailure(attempt)) {
                    const reason = attempt.cause.reasons.find((reason) => reason._tag === "Fail")
                    if (reason?._tag !== "Fail")
                        return yield* Effect.die(new Error("REST request failed without a cause"))
                    const error = reason.error
                    if (
                        request.method !== "GET" ||
                        !(error instanceof RestFailure) ||
                        !error.retryableRead ||
                        retries === 2
                    )
                        return yield* Effect.fail(error)
                    const minimum = retries++ === 0 ? 125 : 250
                    const delay = Math.max(minimum * (1 + (yield* Random.next)), error.retryAfterMs ?? 0)
                    until = performance.now() + Math.ceil(delay)
                    continue
                }
                const response = attempt.value
                if (response.kind === "success") return response.value
                if (
                    (request.inlineAttachments || request.webhookId) &&
                    request.sources?.some((source) => !source.replayable)
                )
                    return yield* Effect.fail(
                        new RestFailure("rateLimit", progress.outcome, 429, response.retry, false, response.apiError),
                    )
                until = performance.now() + response.retry
                if (response.global) owner.#globalUntil = Math.max(owner.#globalUntil, until)
                else owner.#buckets.set(route, { remaining: 0, until })
                if (until >= deadline)
                    return yield* Effect.fail(
                        new RestFailure("rateLimit", progress.outcome, 429, response.retry, false, response.apiError),
                    )
            }
        })
    }

    #prepareUploads(
        token: Redacted.Redacted<string>,
        channel: string,
        body: EncodedBody,
        sources: readonly AttachmentTransferSource[],
        instance: InstanceEndpointContext,
        progress: { outcome: Outcome },
        generation: number,
        deadline: number,
    ): Effect.Effect<"preuploaded" | "inline", RestFailure | ClientClosedError> {
        const owner = this
        return Effect.gen(function* () {
            const inline = (): "inline" => {
                const payload = JSON.parse(body.json) as { attachments: Record<string, unknown>[] }
                payload.attachments = payload.attachments.map((item) => {
                    const file = body.files.find((file) => file.id === item.id)
                    if (!file) throw new Error("Inline attachment source is missing")
                    return { ...item, filename: file.filename, content_type: file.contentType }
                })
                body.json = JSON.stringify(payload)
                return "inline"
            }
            if (!instance.presignedAttachmentUploads) return inline()
            const retainedBytes = Buffer.byteLength(body.json)
            const attachments = body.files.map((file) => ({
                id: file.id,
                filename: file.filename,
                file_size: file.size,
                content_type: file.contentType,
            }))
            const planned = yield* owner.#exchange<{ kind: "plans"; plans: UploadPlan[] } | { kind: "disabled" }>(
                token,
                {
                    method: "POST",
                    channel,
                    bucket: "upload",
                    preparation: true,
                    instance,
                    path: `/channels/${channel}/attachments`,
                    body: { json: JSON.stringify({ attachments }), files: [] },
                    decode: async (response): Promise<{ kind: "plans"; plans: UploadPlan[] }> => {
                        const plans = decodeUploadPlans(
                            await readUploadJson(response),
                            body.files,
                            instance.allowInsecure,
                        )
                        if (!plans) throw new RestFailure("response", "notDispatched", response.status)
                        return { kind: "plans" as const, plans }
                    },
                    featureDisabled: () => ({ kind: "disabled" as const }),
                },
                progress,
                generation,
                deadline,
                retainedBytes,
            )
            if (planned.kind === "disabled") return inline()
            const plans = planned.plans
            // Charge retained plan capabilities too while queued; they are never exposed as diagnostics
            const queuedBytes = retainedBytes + Buffer.byteLength(JSON.stringify(plans))
            for (const plan of plans) {
                const file = body.files.find((file) => file.id === plan.id)!
                const source = sources[body.files.indexOf(file)]
                if (!source) return yield* Effect.fail(new RestFailure("response", "notDispatched"))
                for (const part of plan.parts) {
                    yield* owner.#exchange(
                        token,
                        {
                            method: "PUT",
                            channel,
                            preparation: true,
                            instance,
                            path: "",
                            body: undefined,
                            put: {
                                ...part,
                                source,
                                ...(plan.uploadId ? {} : { contentType: plan.contentType }),
                            },
                            decode: async () => {},
                        },
                        progress,
                        generation,
                        deadline,
                        queuedBytes,
                    )
                }
            }
            const uploads = plans
                .filter((plan) => plan.uploadId !== undefined)
                .map((plan) => ({ upload_filename: plan.key, upload_id: plan.uploadId! }))
            if (uploads.length)
                yield* owner.#exchange(
                    token,
                    {
                        method: "POST",
                        channel,
                        bucket: "upload",
                        preparation: true,
                        instance,
                        path: `/channels/${channel}/attachments/complete`,
                        body: { json: JSON.stringify({ uploads }), files: [] },
                        decode: async (response) => {
                            const value = await readUploadJson(response)
                            if (
                                !record(value) ||
                                !Array.isArray(value.uploads) ||
                                value.uploads.length !== uploads.length ||
                                uploads.some(
                                    (upload) =>
                                        !Array.isArray(value.uploads) ||
                                        value.uploads.filter(
                                            (item) => record(item) && item.upload_filename === upload.upload_filename,
                                        ).length !== 1,
                                )
                            )
                                throw new RestFailure("response", "notDispatched", response.status)
                        },
                    },
                    progress,
                    generation,
                    deadline,
                    queuedBytes,
                )
            const payload = JSON.parse(body.json) as { attachments: Record<string, unknown>[] }
            payload.attachments = payload.attachments.map((item) => {
                const plan = plans.find((plan) => plan.id === item.id)
                if (!plan) return item
                const file = body.files.find((file) => file.id === plan.id)!
                return {
                    ...item,
                    filename: plan.filename,
                    content_type: plan.contentType,
                    file_size: file.size,
                    upload_filename: plan.key,
                }
            })
            body.json = JSON.stringify(payload)
            return "preuploaded" as const
        })
    }

    guild<A>(
        token: Redacted.Redacted<string>,
        operation: GuildOperation,
        build: () => GuildRequest<A> | InputValidationFailure,
        options?: GuildOperationOptions,
    ) {
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (input instanceof InputValidationFailure)
                return Effect.fail(new RestFailure("input", "notDispatched", null, null, false, null, input.detail))
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            if (
                record(options) &&
                Object.keys(options).some(
                    (key) =>
                        key !== "timeoutMs" &&
                        key !== "signal" &&
                        !(input.moderation && key === "auditReason") &&
                        !(
                            key === "purge" &&
                            input.method === "DELETE" &&
                            ["guild:emojis", "guild:stickers"].includes(input.bucket)
                        ),
                )
            )
                return Effect.fail(
                    localInputFailure("options", "allowedFields", "Operation options contain an unsupported field"),
                )
            return this.#execute(
                token,
                {
                    // The scheduler's major-resource key is the guild here, never a message-cache channel
                    channel: input.guildId,
                    bucket: input.bucket,
                    cache: false,
                    ...(input.cache === undefined ? {} : { resourceCache: input.cache }),
                    ...(input.channelCache === undefined ? {} : { channelCache: input.channelCache }),
                    ...(input.moderation === undefined ? {} : { moderation: input.moderation }),
                    ...(input.auditReason === undefined ? {} : { auditReason: input.auditReason }),
                    ...(input.deleteAuthorId === undefined ? {} : { deleteAuthorId: input.deleteAuthorId }),
                    ...(input.invalidateMessages === undefined ? {} : { invalidateMessages: input.invalidateMessages }),
                    path: input.path,
                    method: input.method,
                    status: input.status,
                    body: input.json === undefined ? undefined : { json: input.json, files: [] },
                    decode: async (response, instance) => {
                        if (input.status === 204) return undefined as A
                        const value = input.decode(await response.json().catch(() => null), instance)
                        if (value === undefined) throw new RestFailure("response", "unknown", response.status)
                        return value
                    },
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, GuildOperationError, operation)))
    }

    channel<A>(
        token: Redacted.Redacted<string>,
        operation: ChannelOperation,
        build: () => ChannelRequest<A> | InputValidationFailure,
        options?: ChannelOperationOptions,
    ) {
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (input instanceof InputValidationFailure)
                return Effect.fail(new RestFailure("input", "notDispatched", null, null, false, null, input.detail))
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            if (record(options) && Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal"))
                return Effect.fail(
                    localInputFailure(
                        "options",
                        "allowedFields",
                        "Operation options may contain only timeoutMs and signal",
                    ),
                )
            return this.#execute(
                token,
                {
                    channel: input.majorId,
                    bucket: input.bucket,
                    cache: false,
                    channelCache: input.cache,
                    path: input.path,
                    method: input.method,
                    status: input.status,
                    body: input.json === undefined ? undefined : { json: input.json, files: [] },
                    decode: async (response) => {
                        if (input.status === 204) return undefined as A
                        const value = input.decode(await response.json().catch(() => null))
                        if (value === undefined) throw new RestFailure("response", "unknown", response.status)
                        return value
                    },
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, ChannelOperationError, operation)))
    }

    user<A>(
        token: Redacted.Redacted<string>,
        operation: UserOperation,
        build: () => UserRequest<A> | InputValidationFailure,
        options?: UserOperationOptions,
    ) {
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (input instanceof InputValidationFailure)
                return Effect.fail(new RestFailure("input", "notDispatched", null, null, false, null, input.detail))
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            if (record(options) && Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal"))
                return Effect.fail(
                    localInputFailure(
                        "options",
                        "allowedFields",
                        "Operation options may contain only timeoutMs and signal",
                    ),
                )
            return this.#execute(
                token,
                {
                    channel: input.majorId,
                    bucket: `user:${operation}`,
                    cache: false,
                    path: input.path,
                    method: input.method,
                    status: input.status,
                    body: input.json === undefined ? undefined : { json: input.json, files: [] },
                    decode: async (response) => {
                        if (input.status === 204) return undefined as A
                        const value = input.decode(await readUploadJson(response))
                        if (value === undefined) throw new RestFailure("response", "unknown", response.status)
                        return value
                    },
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, UserOperationError, operation)))
    }

    application<A>(
        token: Redacted.Redacted<string>,
        operation: BotApplicationOperation,
        build: () => BotApplicationRequest<A>,
        options?: BotApplicationOperationOptions,
    ) {
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            if (record(options) && Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal"))
                return Effect.fail(
                    localInputFailure(
                        "options",
                        "allowedFields",
                        "Operation options may contain only timeoutMs and signal",
                    ),
                )
            return this.#execute(
                token,
                {
                    channel: "application",
                    bucket: "application:current",
                    cache: false,
                    path: input.path,
                    method: input.method,
                    status: input.status,
                    body: undefined,
                    decode: async (response) => {
                        const value = input.decode(await readUploadJson(response))
                        if (value === undefined) throw new RestFailure("response", "unknown", response.status)
                        return value
                    },
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, BotApplicationOperationError, operation)))
    }

    webhook<A>(
        token: Redacted.Redacted<string>,
        operation: WebhookOperation,
        build: () => WebhookRequest<A> | InputValidationFailure,
        options?: WebhookOperationOptions,
    ) {
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (input instanceof InputValidationFailure)
                return Effect.fail(new RestFailure("input", "notDispatched", null, null, false, null, input.detail))
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            if (
                record(options) &&
                Object.keys(options).some(
                    (key) =>
                        key !== "timeoutMs" &&
                        key !== "signal" &&
                        !(input.method !== "GET" && !input.tokenAuth && key === "auditReason"),
                )
            )
                return Effect.fail(
                    localInputFailure("options", "allowedFields", "Operation options contain an unsupported field"),
                )
            return this.#execute(
                token,
                {
                    channel: input.majorId,
                    bucket: `webhook:${input.tokenAuth ? "token" : operation}`,
                    cache: false,
                    ...(input.tokenAuth ? { webhookId: input.majorId } : {}),
                    ...(input.auditReason === undefined ? {} : { auditReason: input.auditReason }),
                    path: input.path,
                    method: input.method,
                    status: input.status,
                    body: input.body,
                    decode: async (response) => {
                        if (input.status === 204) return undefined as A
                        const value = input.decode(await readUploadJson(response))
                        if (value === undefined) throw new RestFailure("response", "unknown", response.status)
                        return value
                    },
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, WebhookOperationError, operation)))
    }

    #execute<A>(
        token: Redacted.Redacted<string>,
        request: Request<A>,
        options?: MessageOperationOptions,
    ): Effect.Effect<A, RestFailure | ClientClosedError> {
        const owner = this
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (owner.#closed) return Effect.fail(new ClientClosedError())
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            const timeout = options?.timeoutMs === undefined ? 30_000 : options.timeoutMs
            if (
                typeof timeout !== "number" ||
                !Number.isSafeInteger(timeout) ||
                timeout <= 0 ||
                timeout > 2_147_483_647
            )
                return Effect.fail(
                    localInputFailure(
                        "options.timeoutMs",
                        "range",
                        "Operation timeoutMs must be an integer from 1 through 2,147,483,647 milliseconds",
                    ),
                )
            const bytes = Buffer.byteLength(request.body?.json ?? "")
            const uploadBytes = request.body?.files.reduce((sum, file) => sum + file.size, 0) ?? 0
            if (!Number.isSafeInteger(uploadBytes) || uploadBytes > owner.uploadMaxBytes - owner.#uploadBytes)
                return Effect.fail(new RestFailure("busy", "notDispatched"))
            // Check JSON/count admission before allocating binary snapshots, then reserve before any wait
            if (owner.#pending.length >= queuedRequestCapacity || bytes > queuedJsonMaxBytes - owner.#bytes)
                return Effect.fail(new RestFailure("busy", "notDispatched"))
            owner.#uploadBytes += uploadBytes
            try {
                if (request.body) {
                    request.body.files = request.body.files.map((file) => ({
                        ...file,
                        source:
                            file.source.kind === "bytes"
                                ? { kind: "bytes" as const, data: new Uint8Array(file.source.data) }
                                : file.source,
                    }))
                    request.sources = request.body.files.map((file) => new AttachmentTransferSource(file))
                }
            } catch {
                owner.#uploadBytes -= uploadBytes
                return Effect.fail(
                    localInputFailure(
                        "attachments[].data",
                        "type",
                        "Attachment byte data must remain readable while the operation snapshots it",
                    ),
                )
            }
            const deadline = performance.now() + timeout
            const generation = owner.cache?.generation ?? 0
            const progress: { outcome: Outcome } = { outcome: "notDispatched" }
            const deletionGuard = request.deleteIds && owner.cache?.begin(request.channel, undefined, true, generation)
            // Register before discovery and queue/rate waits so events, writes and gaps invalidate the whole operation
            const resourceGuard = request.resourceCache && owner.resources?.begin(request.resourceCache)
            if (resourceGuard) request = { ...request, resourceGuard }
            const channelGuard = request.channelCache && owner.channels?.begin(request.channelCache)
            if (channelGuard) request = { ...request, channelGuard }
            const operation = Deferred.makeUnsafe<void>()
            owner.#operations.add(operation)
            return Effect.gen(function* () {
                const resolved = owner.#instance
                const instance =
                    resolved ??
                    (yield* Effect.acquireUseRelease(
                        Effect.interruptible(owner.#acquire("discovery", bytes)),
                        () => owner.resolveInstance(),
                        (release) => Effect.sync(release),
                    ).pipe(mapFailureCause(instanceFailure)))
                if (!resolved) owner.#instance = instance
                request = { ...request, instance }
                if (request.directMessageUser !== undefined) {
                    const open = directMessageOpen(request.directMessageUser)!
                    if (open instanceof InputValidationFailure)
                        return yield* Effect.fail(
                            new RestFailure("input", "notDispatched", null, null, false, null, open.detail),
                        )
                    const userGeneration = owner.users?.begin("directMessages", true)
                    const channel = yield* owner
                        .#exchange(
                            token,
                            {
                                method: "POST",
                                channel: "@me",
                                bucket: "user:directMessages.open",
                                cache: false,
                                instance,
                                path: open.path,
                                body: { json: open.json!, files: [] },
                                status: 200,
                                preparation: true,
                                decode: async (response) => {
                                    const channel = open.decode(await readUploadJson(response))
                                    if (!channel) throw new RestFailure("response", "notDispatched", response.status)
                                    return channel
                                },
                            },
                            { outcome: "notDispatched" },
                            generation,
                            deadline,
                            bytes,
                        )
                        .pipe(
                            mapFailureCause((error) =>
                                error instanceof RestFailure
                                    ? new RestFailure(
                                          error.reason,
                                          "notDispatched",
                                          error.status,
                                          error.retryAfterMs,
                                          error.retryableRead,
                                          error.apiError,
                                          error.inputValidation,
                                      )
                                    : error,
                            ),
                        )
                    if (userGeneration !== undefined) owner.users!.complete("directMessages", userGeneration, [channel])
                    request = {
                        ...request,
                        channel: channel.id,
                        path: `/channels/${channel.id}/messages`,
                        decode: (response) => readMessage(response, channel.id) as Promise<A>,
                    }
                }
                if (request.body?.files.length && !request.webhookId) {
                    const uploadMode = yield* owner.#prepareUploads(
                        token,
                        request.channel,
                        request.body,
                        request.sources ?? [],
                        instance,
                        progress,
                        generation,
                        deadline,
                    )
                    if (uploadMode === "inline") request = { ...request, inlineAttachments: true }
                }
                return yield* owner.#exchange(token, request, progress, generation, deadline)
            }).pipe(
                withDeadline(timeout, () => new RestFailure("timeout", progress.outcome)),
                Effect.ensuring(
                    Effect.promise(() => completeSourceCleanup(request.sources ?? [])).pipe(
                        Effect.ensuring(
                            Effect.sync(() => {
                                if (request.deleteIds && progress.outcome !== "notDispatched")
                                    owner.cache?.deleteMany(request.channel, request.deleteIds)
                                if (deletionGuard) owner.cache!.end(deletionGuard)
                                if (resourceGuard)
                                    owner.resources!.end(
                                        resourceGuard,
                                        request.moderation
                                            ? progress.outcome !== "notDispatched"
                                            : progress.outcome === "unknown",
                                    )
                                if (request.deleteAuthorId && progress.outcome !== "notDispatched")
                                    owner.cache?.deleteAuthor(request.deleteAuthorId)
                                // Message observations need not carry guild IDs, so leaving conservatively clears this cache
                                if (request.invalidateMessages && progress.outcome !== "notDispatched")
                                    owner.cache?.gap()
                                // A rejected multi-entry reorder can have applied earlier entries before its failure
                                if (channelGuard)
                                    owner.channels!.end(channelGuard, progress.outcome !== "notDispatched")
                                if (
                                    request.channelCache?.mutation &&
                                    request.method === "DELETE" &&
                                    request.bucket === "channel:delete" &&
                                    progress.outcome === "unknown"
                                )
                                    owner.cache?.deleteChannel(request.channel)
                                if (request.body) request.body.files.length = 0
                                owner.#uploadBytes -= uploadBytes
                                owner.#operations.delete(operation)
                                Deferred.doneUnsafe(operation, Effect.void)
                            }),
                        ),
                    ),
                ),
            )
        })
    }

    stop() {
        this.#closed = true
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        const pending = this.#pending
        this.#pending = []
        this.#bytes = 0
        this.#buckets.clear()
        this.#instance = undefined
        for (const item of pending) item.resume(Effect.fail(new ClientClosedError()))
        for (const source of this.#downloads) source.fail(new ClientClosedError())
        for (const controller of this.#controllers) controller.abort()
    }
    shutdown(): Effect.Effect<void> {
        return Effect.suspend(() => {
            this.stop()
            return Effect.forEach([...this.#operations], (operation) => Deferred.await(operation), {
                discard: true,
                concurrency: "unbounded",
            }).pipe(
                Effect.andThen(
                    Effect.suspend(() => {
                        const defects = this.#unobservedDownloadDefects
                        this.#unobservedDownloadDefects = 0
                        return defects > 0 ? Effect.die(new AttachmentStreamCleanupError()) : Effect.void
                    }),
                ),
            )
        })
    }
}
