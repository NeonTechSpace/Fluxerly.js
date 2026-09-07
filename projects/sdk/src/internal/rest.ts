import { randomUUID } from "node:crypto"
import { Deferred, Effect, Redacted } from "effect"
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
import { decodeMessage, encodeEdit, encodeHistory, encodeMessage, record, reference } from "./message.js"

type Pending = {
    route: string
    bytes: number
    resume: (effect: Effect.Effect<() => void, RestFailure | ClientClosedError>) => void
}
type Bucket = { remaining: number; until: number }
type Outcome = MessageOperationError["outcome"]
type Request<A> = {
    method: "POST" | "GET" | "PATCH" | "DELETE"
    channel: string
    bucket?: "history"
    path: string
    body: string | undefined
    status?: number
    decode: (response: Response) => Promise<A>
}

class RestFailure extends Error {
    constructor(
        readonly reason: MessageOperationError["reason"],
        readonly outcome: Outcome,
        readonly status: number | null = null,
        readonly retryAfterMs: number | null = null,
    ) {
        super("REST operation failed")
    }
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
            const until = Math.max(this.#globalUntil, bucket && bucket.remaining <= 0 ? bucket.until : 0)
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

    #acquire(route: string, bytes: number): Effect.Effect<() => void, RestFailure | ClientClosedError> {
        return Effect.callback((resume) => {
            if (this.#closed) {
                resume(Effect.fail(new ClientClosedError()))
                return
            }
            // A new request may enter directly when there is no backlog and a slot is available
            if (this.#pending.length >= 256 || bytes > 4_194_304 - this.#bytes) {
                resume(Effect.fail(new RestFailure("busy", "notDispatched")))
                return
            }
            const item = { route, bytes, resume }
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
    ): Effect.Effect<
        { kind: "success"; value: A } | { kind: "retry"; retry: number; global: boolean },
        RestFailure | ClientClosedError
    > {
        const owner = this
        return Effect.acquireUseRelease(
            Effect.sync(() => {
                const controller = new AbortController()
                owner.#controllers.add(controller)
                return { controller, settled: Promise.resolve() }
            }),
            (state) =>
                Effect.tryPromise({
                    try: () => {
                        const work = (async () => {
                            if (owner.#closed) throw new ClientClosedError()
                            progress.outcome = "unknown"
                            const response = await fetch(`https://api.fluxer.app/v1${request.path}`, {
                                method: request.method,
                                redirect: "error",
                                signal: state.controller.signal,
                                headers: {
                                    Authorization: `Bot ${Redacted.value(token)}`,
                                    ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
                                },
                                ...(request.body === undefined ? {} : { body: request.body }),
                            })
                            owner.#headers(route, response)
                            try {
                                if (response.status === 429) {
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
                                    // Only a received rate-limit rejection is eligible for an automatic resend
                                    progress.outcome = "rejected"
                                    if (!Number.isFinite(delay) || delay <= 0)
                                        throw new RestFailure("rateLimit", "rejected", 429)
                                    const retry = Math.ceil(delay)
                                    const global = record(data) && data.global === true
                                    const until = performance.now() + retry
                                    if (global) owner.#globalUntil = Math.max(owner.#globalUntil, until)
                                    else owner.#buckets.set(route, { remaining: 0, until })
                                    return { kind: "retry" as const, retry, global }
                                }
                                if (!response.ok) {
                                    const rejected = response.status >= 400 && response.status < 500
                                    if (rejected) progress.outcome = "rejected"
                                    throw new RestFailure(
                                        response.status === 404 ? "notFound" : "rejected",
                                        progress.outcome,
                                        response.status,
                                    )
                                }
                                if (request.status !== undefined && response.status !== request.status)
                                    throw new RestFailure("response", "unknown", response.status)
                                return { kind: "success" as const, value: await request.decode(response) }
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
                }),
            (state) =>
                Effect.promise(async () => {
                    state.controller.abort()
                    await state.settled
                    owner.#controllers.delete(state.controller)
                }),
        )
    }

    send(
        token: Redacted.Redacted<string>,
        channel: string,
        input: MessageInput,
        options?: SendOptions,
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
            const bytes = Buffer.byteLength(request.body ?? "")
            const route = `${request.bucket ?? request.method}:${request.channel}`
            const deadline = performance.now() + timeout
            const progress: { outcome: Outcome } = { outcome: "notDispatched" }
            const operation = Deferred.makeUnsafe<void>()
            owner.#operations.add(operation)
            return Effect.gen(function* () {
                while (true) {
                    const response = yield* Effect.acquireUseRelease(
                        Effect.interruptible(owner.#acquire(route, bytes)).pipe(
                            Effect.mapError((error) =>
                                error instanceof RestFailure
                                    ? new RestFailure(error.reason, progress.outcome, error.status, error.retryAfterMs)
                                    : error,
                            ),
                        ),
                        () => owner.#request(token, request, route, progress),
                        (release) => Effect.sync(release),
                    )
                    if (response.kind === "success") return response.value
                    const until = performance.now() + response.retry
                    if (response.global) owner.#globalUntil = Math.max(owner.#globalUntil, until)
                    else owner.#buckets.set(route, { remaining: 0, until })
                    if (until >= deadline)
                        return yield* Effect.fail(new RestFailure("rateLimit", "rejected", 429, response.retry))
                }
            }).pipe(
                Effect.timeoutOrElse({
                    duration: timeout,
                    orElse: () => Effect.fail(new RestFailure("timeout", progress.outcome)),
                }),
                Effect.ensuring(
                    Effect.sync(() => {
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
