import { randomUUID } from "node:crypto"
import { Deferred, Effect, Random, Redacted } from "effect"
import { ClientClosedError } from "#sdk/errors"
import { MessageError, MessageOperationError, type MessageOperationFailure, type SendError } from "#sdk/message-errors"
import type {
    EditMessageInput,
    Message,
    MessageInput,
    MessageHistoryQuery,
    MessageOperationOptions,
    MessageReference,
    SendOptions,
} from "#sdk/messages"
import { decodeMessage, encodeEdit, encodeHistory, encodeMessage, identifier, record, reference } from "./message.js"
import type { MessageCache } from "./cache.js"
import type { EncodedBody } from "./attachments.js"
import { decodeUploadPlans, readUploadJson, uploadBody } from "./uploads.js"
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

type Pending = {
    route: string
    bytes: number
    until: number
    resume: (effect: Effect.Effect<() => void, RestFailure | ClientClosedError>) => void
}
type Bucket = { remaining: number; until: number }
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
    resourceCache?: ResourceRequest
    resourceGuard?: ResourceGuard
    channelCache?: ChannelCacheRequest
    channelGuard?: ChannelCacheGuard
    path: string
    body: EncodedBody | undefined
    status?: number
    decode: (response: Response) => Promise<A>
    target?: string
    preparation?: boolean
    put?: { url: string; data: Uint8Array; offset: number; size: number; contentType?: string }
}

class RestFailure extends Error {
    constructor(
        readonly reason: MessageOperationError["reason"],
        readonly outcome: Outcome,
        readonly status: number | null = null,
        readonly retryAfterMs: number | null = null,
        readonly retryableRead = false,
    ) {
        super("REST operation failed")
    }
}

function retryAfter(response: Response): number | null {
    const value = response.headers.get("retry-after")?.trim()
    if (!value) return null
    const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
    return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : null
}

async function readMessage(response: Response, channel: string, id?: string): Promise<Message> {
    const decoded = decodeMessage(await response.json().catch(() => null))
    if (!decoded || decoded.channelId !== channel || (id !== undefined && decoded.id !== id))
        throw new RestFailure("response", "unknown", response.status)
    return decoded
}

async function readHistory(response: Response, channel: string, query: NonNullable<ReturnType<typeof encodeHistory>>) {
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
        private readonly cache?: MessageCache,
        private readonly uploadMaxBytes = 104_857_600,
        private readonly resources?: GuildCache,
        private readonly channels?: ChannelCache,
        private readonly users?: UserCache,
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
    #operations = new Set<Deferred.Deferred<void>>()

    #pump() {
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        const now = performance.now()
        for (const [key, bucket] of this.#buckets) if (bucket.until <= now) this.#buckets.delete(key)
        if (this.#closed) return
        let earliest = Infinity
        for (let index = 0; index < this.#pending.length && this.#active < 4;) {
            const item = this.#pending[index]!
            const bucket = this.#buckets.get(item.route)
            const until = Math.max(item.until, this.#globalUntil, bucket && bucket.remaining <= 0 ? bucket.until : 0)
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
        if (earliest !== Infinity && this.#active < 4)
            this.#timer = setTimeout(() => this.#pump(), Math.min(2_147_483_647, Math.max(1, earliest - now)))
    }

    #acquire(route: string, bytes: number, until = 0): Effect.Effect<() => void, RestFailure | ClientClosedError> {
        return Effect.callback((resume) => {
            if (this.#closed) {
                resume(Effect.fail(new ClientClosedError()))
                return
            }
            // A new request may enter directly when there is no backlog and a slot is available
            if (this.#pending.length >= 256 || bytes > queuedJsonMaxBytes - this.#bytes) {
                resume(Effect.fail(new RestFailure("busy", "notDispatched")))
                return
            }
            const item = { route, bytes, until, resume }
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
        { kind: "success"; value: A } | { kind: "retry"; retry: number; global: boolean },
        RestFailure | ClientClosedError
    > {
        const owner = this
        return Effect.acquireUseRelease(
            Effect.sync(() => {
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
                const upload = request.put
                    ? uploadBody(request.put.data, request.put.offset, request.put.size)
                    : request.webhookId && request.body?.files.length
                      ? multipart(request.body)
                      : undefined
                const multipartHeaders =
                    upload && "contentType" in upload && "size" in upload
                        ? { "Content-Type": String(upload.contentType), "Content-Length": String(upload.size) }
                        : undefined
                return { controller, settled: Promise.resolve(), guard, success: false, upload, multipartHeaders }
            }),
            (state) =>
                Effect.tryPromise({
                    try: () => {
                        const work = (async () => {
                            if (owner.#closed) throw new ClientClosedError()
                            if (!request.preparation) progress.outcome = "unknown"
                            const response = await fetch(
                                request.put?.url ??
                                    `https://api.fluxer.app/v1${request.webhookId ? `/webhooks/${request.webhookId}/${encodeURIComponent(Redacted.value(token))}` : ""}${request.path}`,
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
                            ).catch(() => {
                                throw new RestFailure("network", progress.outcome, null, null, true)
                            })
                            if (!request.put) owner.#headers(route, response)
                            try {
                                if (response.status === 429) {
                                    if (request.put) throw new RestFailure("rateLimit", progress.outcome, 429)
                                    const header = response.headers.get("retry-after")
                                    let delay = header === null ? NaN : Number(header) * 1000
                                    if (header !== null && !Number.isFinite(delay))
                                        delay = Date.parse(header) - Date.now()
                                    const data: unknown = await response.json().catch(() => null)
                                    if (
                                        record(data) &&
                                        typeof data.retry_after === "number" &&
                                        Number.isFinite(data.retry_after) &&
                                        data.retry_after >= 0
                                    )
                                        delay = Math.max(Number.isFinite(delay) ? delay : 0, data.retry_after * 1000)
                                    // Mutation resends require a received rate-limit rejection
                                    if (!request.preparation) progress.outcome = "rejected"
                                    if (!Number.isFinite(delay) || delay <= 0)
                                        throw new RestFailure("rateLimit", progress.outcome, 429)
                                    const retry = Math.ceil(delay)
                                    const global = record(data) && data.global === true
                                    const until = performance.now() + retry
                                    if (global) owner.#globalUntil = Math.max(owner.#globalUntil, until)
                                    else owner.#buckets.set(route, { remaining: 0, until })
                                    return { kind: "retry" as const, retry, global }
                                }
                                if (!response.ok) {
                                    if (response.status === 404 && request.method === "GET" && request.resourceGuard)
                                        owner.resources!.missing(request.resourceGuard)
                                    if (response.status === 404 && request.method === "GET" && request.channelGuard)
                                        owner.channels!.missing(request.channelGuard)
                                    const rejected = response.status >= 400 && response.status < 500
                                    if (rejected && !request.preparation) progress.outcome = "rejected"
                                    const retryableRead =
                                        request.method === "GET" && [500, 502, 503, 504].includes(response.status)
                                    throw new RestFailure(
                                        response.status === 404 && !request.preparation ? "notFound" : "rejected",
                                        progress.outcome,
                                        response.status,
                                        retryableRead ? retryAfter(response) : null,
                                        retryableRead,
                                    )
                                }
                                if (request.status !== undefined && response.status !== request.status)
                                    throw new RestFailure("response", progress.outcome, response.status)
                                const value = await request.decode(response)
                                return { kind: "success" as const, value }
                            } finally {
                                if (!response.bodyUsed) await response.body?.cancel()
                            }
                        })()
                        // Interruption waits for fetch/body cleanup instead of abandoning its promise
                        state.settled = work.then(
                            () => {},
                            () => {},
                        )
                        return work
                    },
                    catch: (error): RestFailure | ClientClosedError =>
                        owner.#closed
                            ? new ClientClosedError()
                            : error instanceof RestFailure || error instanceof ClientClosedError
                              ? error
                              : new RestFailure("network", progress.outcome),
                }).pipe(
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
                Effect.promise(async () => {
                    state.controller.abort()
                    state.upload?.stop()
                    await state.settled
                    owner.#controllers.delete(state.controller)
                    if (state.guard) {
                        if (!state.success && progress.outcome === "unknown" && state.guard.mutation)
                            owner.cache!.delete({ id: request.target!, channelId: request.channel }, state.guard)
                        owner.cache!.end(state.guard)
                    }
                }),
        )
    }

    send(
        token: Redacted.Redacted<string>,
        channel: string,
        input: MessageInput,
        options?: SendOptions,
        directMessageUser?: string,
    ): Effect.Effect<Message, SendError> {
        return Effect.suspend((): Effect.Effect<Message, SendError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const body = encodeMessage(channel, input, randomUUID().replaceAll("-", ""))
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
                Effect.mapError((error) =>
                    error instanceof RestFailure
                        ? new MessageError(
                              error.reason === "notFound" ? "rejected" : error.reason,
                              error.outcome === "unknown" ? "unknown" : "notSent",
                              error.status,
                              error.retryAfterMs,
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
            if (
                !identifier(channel) ||
                (options !== undefined &&
                    (!record(options) || Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal")))
            )
                return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new MessageOperationError("typing", error.reason, error.outcome, error.status, error.retryAfterMs)
                    : error,
            ),
        )
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
            if (!encoded) return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new MessageOperationError(
                          "fetchHistory",
                          error.reason,
                          error.outcome,
                          error.status,
                          error.retryAfterMs,
                      )
                    : error,
            ),
        )
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
            if (!encoded) return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new MessageOperationError("search", error.reason, error.outcome, error.status, error.retryAfterMs)
                    : error,
            ),
        )
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

    deleteMany(
        token: Redacted.Redacted<string>,
        channelId: string,
        ids: readonly string[],
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            if (
                !identifier(channelId) ||
                !Array.isArray(ids) ||
                ids.length < 1 ||
                ids.length > 100 ||
                !Array.from(ids).every(identifier) ||
                new Set(ids).size !== ids.length ||
                (options !== undefined &&
                    (!record(options) || Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal")))
            )
                return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new MessageOperationError(
                          "deleteMany",
                          error.reason,
                          error.outcome,
                          error.status,
                          error.retryAfterMs,
                      )
                    : error,
            ),
        )
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
            if (!reference(target) || encoded === undefined || !page)
                return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new MessageOperationError(
                          "fetchReactionUsers",
                          error.reason,
                          error.outcome,
                          error.status,
                          error.retryAfterMs,
                      )
                    : error,
            ),
        )
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
            if (!page) return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new MessageOperationError(
                          "fetchPins",
                          error.reason,
                          error.outcome,
                          error.status,
                          error.retryAfterMs,
                      )
                    : error,
            ),
        )
    }

    pin(
        token: Redacted.Redacted<string>,
        operation: "pin" | "unpin",
        target: MessageReference,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return Effect.suspend((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            if (!reference(target)) return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new MessageOperationError(
                          operation,
                          error.reason,
                          error.outcome,
                          error.status,
                          error.retryAfterMs,
                      )
                    : error,
            ),
        )
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
            if (
                !reference(target) ||
                encoded === undefined ||
                (operation === "removeUserReaction" && !identifier(userId))
            )
                return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new MessageOperationError(
                          operation,
                          error.reason,
                          error.outcome,
                          error.status,
                          error.retryAfterMs,
                      )
                    : error,
            ),
        )
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
            if (!reference(target)) return Effect.fail(new RestFailure("input", "notDispatched"))
            const ref = { channelId: target.channelId, id: target.id }
            const body = operation === "edit" ? encodeEdit(input) : undefined
            if (operation === "edit" && body === undefined)
                return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new MessageOperationError(
                          operation,
                          error.reason,
                          error.outcome,
                          error.status,
                          error.retryAfterMs,
                      )
                    : error,
            ),
        )
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
                const attempt = yield* Effect.result(
                    Effect.acquireUseRelease(
                        Effect.interruptible(owner.#acquire(route, bytes, until)).pipe(
                            Effect.mapError((error) =>
                                error instanceof RestFailure
                                    ? new RestFailure(error.reason, progress.outcome, error.status, error.retryAfterMs)
                                    : error,
                            ),
                        ),
                        () =>
                            performance.now() >= deadline
                                ? Effect.fail(new RestFailure("timeout", progress.outcome))
                                : owner.#request(token, request, route, progress, generation),
                        (release) => Effect.sync(release),
                    ),
                )
                if (attempt._tag === "Failure") {
                    const error = attempt.failure
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
                const response = attempt.success
                if (response.kind === "success") return response.value
                until = performance.now() + response.retry
                if (response.global) owner.#globalUntil = Math.max(owner.#globalUntil, until)
                else owner.#buckets.set(route, { remaining: 0, until })
                if (until >= deadline)
                    return yield* Effect.fail(new RestFailure("rateLimit", progress.outcome, 429, response.retry))
            }
        })
    }

    #prepareUploads(
        token: Redacted.Redacted<string>,
        channel: string,
        body: EncodedBody,
        progress: { outcome: Outcome },
        generation: number,
        deadline: number,
    ): Effect.Effect<void, RestFailure | ClientClosedError> {
        const owner = this
        return Effect.gen(function* () {
            const retainedBytes = Buffer.byteLength(body.json)
            const attachments = body.files.map((file) => ({
                id: file.id,
                filename: file.filename,
                file_size: file.data.byteLength,
                content_type: file.contentType,
            }))
            const plans = yield* owner.#exchange(
                token,
                {
                    method: "POST",
                    channel,
                    bucket: "upload",
                    preparation: true,
                    path: `/channels/${channel}/attachments`,
                    body: { json: JSON.stringify({ attachments }), files: [] },
                    decode: async (response) => {
                        const plans = decodeUploadPlans(await readUploadJson(response), body.files)
                        if (!plans) throw new RestFailure("response", "notDispatched", response.status)
                        return plans
                    },
                },
                progress,
                generation,
                deadline,
                retainedBytes,
            )
            // Charge retained plan capabilities too while queued; they are never exposed as diagnostics
            const queuedBytes = retainedBytes + Buffer.byteLength(JSON.stringify(plans))
            for (const plan of plans) {
                const file = body.files.find((file) => file.id === plan.id)!
                for (const part of plan.parts) {
                    yield* owner.#exchange(
                        token,
                        {
                            method: "PUT",
                            channel,
                            preparation: true,
                            path: "",
                            body: undefined,
                            put: {
                                ...part,
                                data: file.data,
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
                    file_size: file.data.byteLength,
                    upload_filename: plan.key,
                }
            })
            body.json = JSON.stringify(payload)
        })
    }

    guild<A>(
        token: Redacted.Redacted<string>,
        operation: GuildOperation,
        build: () => GuildRequest<A> | undefined,
        options?: GuildOperationOptions,
    ) {
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (
                !input ||
                (options !== undefined &&
                    (!record(options) ||
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
                        )))
            )
                return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new GuildOperationError(operation, error.reason, error.outcome, error.status, error.retryAfterMs)
                    : error,
            ),
        )
    }

    channel<A>(
        token: Redacted.Redacted<string>,
        operation: ChannelOperation,
        build: () => ChannelRequest<A> | undefined,
        options?: ChannelOperationOptions,
    ) {
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (
                !input ||
                (options !== undefined &&
                    (!record(options) || Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal")))
            )
                return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new ChannelOperationError(
                          operation,
                          error.reason,
                          error.outcome,
                          error.status,
                          error.retryAfterMs,
                      )
                    : error,
            ),
        )
    }

    user<A>(
        token: Redacted.Redacted<string>,
        operation: UserOperation,
        build: () => UserRequest<A> | undefined,
        options?: UserOperationOptions,
    ) {
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (
                !input ||
                (options !== undefined &&
                    (!record(options) || Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal")))
            )
                return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new UserOperationError(operation, error.reason, error.outcome, error.status, error.retryAfterMs)
                    : error,
            ),
        )
    }

    webhook<A>(
        token: Redacted.Redacted<string>,
        operation: WebhookOperation,
        build: () => WebhookRequest<A> | undefined,
        options?: WebhookOperationOptions,
    ) {
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (
                !input ||
                (options !== undefined &&
                    (!record(options) ||
                        Object.keys(options).some(
                            (key) =>
                                key !== "timeoutMs" &&
                                key !== "signal" &&
                                !(input.method !== "GET" && !input.tokenAuth && key === "auditReason"),
                        )))
            )
                return Effect.fail(new RestFailure("input", "notDispatched"))
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
        }).pipe(
            Effect.mapError((error) =>
                error instanceof RestFailure
                    ? new WebhookOperationError(
                          operation,
                          error.reason,
                          error.outcome,
                          error.status,
                          error.retryAfterMs,
                      )
                    : error,
            ),
        )
    }

    #execute<A>(
        token: Redacted.Redacted<string>,
        request: Request<A>,
        options?: MessageOperationOptions,
    ): Effect.Effect<A, RestFailure | ClientClosedError> {
        const owner = this
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (owner.#closed) return Effect.fail(new ClientClosedError())
            if (options !== undefined && !record(options)) return Effect.fail(new RestFailure("input", "notDispatched"))
            const timeout = options?.timeoutMs === undefined ? 30_000 : options.timeoutMs
            if (
                typeof timeout !== "number" ||
                !Number.isSafeInteger(timeout) ||
                timeout <= 0 ||
                timeout > 2_147_483_647
            )
                return Effect.fail(new RestFailure("input", "notDispatched"))
            const bytes = Buffer.byteLength(request.body?.json ?? "")
            const uploadBytes = request.body?.files.reduce((sum, file) => sum + file.data.byteLength, 0) ?? 0
            if (!Number.isSafeInteger(uploadBytes) || uploadBytes > owner.uploadMaxBytes - owner.#uploadBytes)
                return Effect.fail(new RestFailure("busy", "notDispatched"))
            // Check JSON/count admission before allocating binary snapshots, then reserve before any wait
            if (owner.#pending.length >= 256 || bytes > queuedJsonMaxBytes - owner.#bytes)
                return Effect.fail(new RestFailure("busy", "notDispatched"))
            owner.#uploadBytes += uploadBytes
            try {
                if (request.body)
                    request.body.files = request.body.files.map((file) => ({
                        ...file,
                        data: new Uint8Array(file.data),
                    }))
            } catch {
                owner.#uploadBytes -= uploadBytes
                return Effect.fail(new RestFailure("input", "notDispatched"))
            }
            const deadline = performance.now() + timeout
            const generation = owner.cache?.generation ?? 0
            const progress: { outcome: Outcome } = { outcome: "notDispatched" }
            const deletionGuard = request.deleteIds && owner.cache?.begin(request.channel, undefined, true, generation)
            // Register before queue/rate waits so events, writes and gaps invalidate the whole operation, including retries
            const resourceGuard = request.resourceCache && owner.resources?.begin(request.resourceCache)
            if (resourceGuard) request = { ...request, resourceGuard }
            const channelGuard = request.channelCache && owner.channels?.begin(request.channelCache)
            if (channelGuard) request = { ...request, channelGuard }
            const operation = Deferred.makeUnsafe<void>()
            owner.#operations.add(operation)
            return Effect.gen(function* () {
                if (request.directMessageUser !== undefined) {
                    const open = directMessageOpen(request.directMessageUser)!
                    const userGeneration = owner.users?.begin("directMessages", true)
                    const channel = yield* owner
                        .#exchange(
                            token,
                            {
                                method: "POST",
                                channel: "@me",
                                bucket: "user:directMessages.open",
                                cache: false,
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
                            Effect.mapError((error) =>
                                error instanceof RestFailure
                                    ? new RestFailure(error.reason, "notDispatched", error.status, error.retryAfterMs)
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
                if (request.body?.files.length && !request.webhookId)
                    yield* owner.#prepareUploads(token, request.channel, request.body, progress, generation, deadline)
                return yield* owner.#exchange(token, request, progress, generation, deadline)
            }).pipe(
                Effect.timeoutOrElse({
                    duration: timeout,
                    orElse: () => Effect.fail(new RestFailure("timeout", progress.outcome)),
                }),
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
                        // A rejected multi-entry reorder can have applied earlier entries before its failure
                        if (channelGuard) owner.channels!.end(channelGuard, progress.outcome !== "notDispatched")
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
        for (const item of pending) item.resume(Effect.fail(new ClientClosedError()))
        for (const controller of this.#controllers) controller.abort()
    }
    shutdown(): Effect.Effect<void> {
        return Effect.suspend(() => {
            this.stop()
            return Effect.forEach([...this.#operations], (operation) => Deferred.await(operation), {
                discard: true,
                concurrency: "unbounded",
            })
        })
    }
}
