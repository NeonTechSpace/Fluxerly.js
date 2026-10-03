/**
 * One client's REST owner: Request validation per operation group, instance resolution, uploads, bounded read retries,
 * rate-limit waits and cache guards around each operation.
 * Invariant: Every operation registers its cache guards before discovery and queue or rate waits, releases upload
 * reservations and transfer sources however it ends, and no rate-limit learning crosses REST owners, credentials or
 * instance selections. Reads retry only under the bounded read policy, and mutations retry only after a confirmed
 * rate-limit rejection. Implements
 * [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { randomUUID } from "node:crypto"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Random from "effect/Random"
import type * as Redacted from "effect/Redacted"
import { ClientClosedError } from "#sdk/errors"
import { responseFieldText } from "#sdk/api-errors"
import { MessageError, MessageOperationError, type MessageOperationFailure, type SendError } from "#sdk/message-errors"
import { InputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import type {
    EditMessageInput,
    ForwardMessageInput,
    Message,
    MessageCore,
    MessageInput,
    MessageHistoryQuery,
    MessageOperationOptions,
    MessageAuditOperationOptions,
    MessageReference,
    SendOptions,
} from "#sdk/messages"
import type {
    Attachment,
    AttachmentDownloadFailure,
    AttachmentDownloadOptions,
    AttachmentRefreshFailure,
    AttachmentRefreshOptions,
    RefreshedAttachmentUrl,
} from "#sdk/attachments"
import { AttachmentRefreshError } from "#sdk/attachments"
import type { ReactionEmojiInput, ReactionUsersQuery, ReactionUsersPage } from "#sdk/reactions"
import type { MessagePinsPage, MessagePinsQuery } from "#sdk/pins"
import type { MessageSearchContext, MessageSearchPage, MessageSearchQuery } from "#sdk/message-search"
import { GuildOperationError, type GuildOperation, type GuildOperationOptions } from "#sdk/guilds"
import { ChannelOperationError, type ChannelOperation, type ChannelOperationOptions } from "#sdk/channels"
import { WebhookOperationError, type WebhookOperation, type WebhookOperationOptions } from "#sdk/webhooks"
import { UserOperationError, type UserOperation, type UserOperationOptions } from "#sdk/users"
import {
    BotApplicationOperationError,
    type BotApplicationOperation,
    type BotApplicationOperationOptions,
} from "#sdk/application"
import { identifier, record, snapshotArray } from "../decode/primitives.js"
import { failingFieldPath } from "../decode/trace.js"
import { inputDefect, suspendInput } from "../defects.js"
import { mapFailureCause, withDeadline } from "../effect-failures.js"
import {
    decodeCrosspostSource,
    encodeEdit,
    encodeForward,
    encodeHistory,
    encodeMessage,
    snapshotReference,
} from "../message.js"
import type { MessageDecoder } from "../message-fields.js"
import type { MessageCache, CacheRequest } from "../cache.js"
import type { EncodedBody } from "../attachments.js"
import { decodeUploadPlans, type UploadPlan } from "../uploads.js"
import { readResponseJson } from "../response-json.js"
import { AttachmentTransferSource } from "../transfer-source.js"
import type { InstanceEndpointContext } from "../instance.js"
import { encodeReactionEmoji, encodeReactionUsersQuery, decodeReactionUsersPage } from "../reactions.js"
import { decodePinsPage, encodePinsQuery } from "../pins.js"
import { decodeMessageSearchPage, encodeMessageSearch } from "../message-search.js"
import type { GuildRequest } from "../guilds.js"
import type { GuildCache } from "../guild-cache.js"
import type { ChannelRequest } from "../channels.js"
import type { ChannelCache } from "../channel-cache.js"
import { auditSettings } from "../audit.js"
import type { WebhookRequest } from "../webhooks.js"
import type { UserRequest } from "../users.js"
import { directMessageOpen } from "../users.js"
import type { UserCache } from "../user-cache.js"
import type { BotApplicationRequest } from "../application.js"
import { attachmentRefresh } from "../attachment-refresh.js"
import type { ClientLogger } from "../logging.js"
import type { LogicalScheduler } from "../logical-scheduler.js"
import { metrics } from "../metrics.js"
import { emitObservation } from "../observer.js"
import { linkRejectionError } from "../rejection-scope.js"
import { rateRoute, routeTemplate } from "../rate-limits.js"
import { defaultHttpTransport, type HttpTransport } from "../transport/index.js"
import { RestAdmission } from "./admission.js"
import { defaultRestConfiguration, type RestConfiguration } from "./options.js"
import {
    RestRequestError,
    type DefaultRestRequest,
    type RestRequest,
    type RestRequestFailure,
    type RestResponse,
} from "#sdk/rest"
import { completeCleanup, runAttempt, type Request } from "./attempt.js"
import { encodeRestRequest, readRestResponse } from "./request.js"
import {
    inputFailure,
    instanceFailure,
    localInputFailure,
    operationFailure,
    RestFailure,
    type Outcome,
} from "./classify.js"
import {
    UnobservedDownloadDefects,
    downloadAttachment,
    openAttachmentStream,
    type AttachmentDownloadSource,
} from "./download.js"

/** Longest single timer delay, and the largest accepted timeoutMs */
const maximumTimerMs = 2_147_483_647
/** Bounded retries for a GET after a transient failure */
const maximumReadRetries = 2
/** Minimum backoff before the first and later read retries, before jitter */
const firstReadRetryMs = 125
const laterReadRetryMs = 250
/** Rate-limit waits of at least this long are logged at Warn */
const longRateLimitWaitMs = 1_000
/** Largest upload-planning and upload-completion response */
const uploadResponseMaxBytes = 1_048_576
/** Least time between two rest.busy Warn records of one client */
const busyWarnIntervalMs = 60_000

/** Construction settings for one REST owner */
export interface RestOwnerOptions<M extends MessageCore> {
    /** Message cache coordinated with message reads and writes, when enabled */
    readonly cache?: MessageCache<M> | undefined
    /** Total bytes of attachment files that may be reserved by running operations */
    readonly uploadMaxBytes: number
    readonly resources?: GuildCache | undefined
    readonly channels?: ChannelCache | undefined
    readonly users?: UserCache | undefined
    /** The owner's instance resolver. The first successful result is kept for the owner's lifetime */
    readonly resolveInstance: () => Effect.Effect<InstanceEndpointContext, unknown>
    readonly decodeMessage: MessageDecoder<M>
    readonly logical: LogicalScheduler
    readonly logging?: ClientLogger | undefined
    /** HTTP transport, defaulting to the platform fetch */
    readonly http?: HttpTransport | undefined
    /** Scheduling limits and default deadline, defaulting to the built-in limits */
    readonly settings?: RestConfiguration | undefined
}

/** Mutable state shared by one owner's operations, attempts and downloads */
export class RestRuntime<M extends MessageCore> {
    /** Set by stop. No operation starts or continues its request after closure */
    closed = false
    /** The owner's resolved instance, kept after the first successful discovery */
    instance: InstanceEndpointContext | undefined
    /** Attachment file bytes reserved by running operations */
    uploadBytes = 0
    /** Stream cleanup failures that no caller observed, surfaced by shutdown */
    readonly unobservedDownloadDefects = new UnobservedDownloadDefects()
    readonly controllers = new Set<AbortController>()
    readonly downloads = new Set<AttachmentDownloadSource>()
    /** Completion signals for every running operation, awaited by shutdown */
    readonly operations = new Set<Deferred.Deferred<void>>()
    readonly admission: RestAdmission
    readonly http: HttpTransport
    /** Scheduling limits and the default deadline for operations and downloads that omit timeoutMs */
    readonly settings: RestConfiguration
    readonly cache: MessageCache<M> | undefined
    readonly resources: GuildCache | undefined
    readonly channels: ChannelCache | undefined
    readonly users: UserCache | undefined
    readonly logical: LogicalScheduler
    readonly logging: ClientLogger | undefined
    readonly resolveInstance: () => Effect.Effect<InstanceEndpointContext, unknown>

    /** Logical time of the last rest.busy Warn, repeated at most once per busyWarnIntervalMs */
    #busyWarnedAt: number | undefined

    constructor(options: RestOwnerOptions<M>) {
        this.settings = options.settings ?? defaultRestConfiguration
        this.admission = new RestAdmission(options.logical, this.settings, () => this.busy("queue"))
        this.http = options.http ?? defaultHttpTransport
        this.cache = options.cache
        this.resources = options.resources
        this.channels = options.channels
        this.users = options.users
        this.logical = options.logical
        this.logging = options.logging
        this.resolveInstance = options.resolveInstance
    }

    /**
     * Count a request that failed with busy, and warn at most once a minute that a REST budget is full, naming the full
     * budget. Busy failures are returned to the caller, so the Warn exists only to make a saturated client visible
     */
    busy(budget: "queue" | "uploads") {
        this.logging?.count("restBusy")
        const now = this.logical.now()
        if (this.#busyWarnedAt !== undefined && now - this.#busyWarnedAt < busyWarnIntervalMs) return
        this.#busyWarnedAt = now
        const queue = this.admission.diagnostics()
        const full =
            budget === "uploads"
                ? "attachments reserved by running uploads reached uploads.maxBytes"
                : queue.queuedRequests >= queue.queuedCapacity
                  ? `${queue.queuedRequests} requests already wait for a slot (rest.maxQueued)`
                  : "the bodies of waiting requests reached rest.queuedJsonMaxBytes"
        this.logging?.log({
            level: "warn",
            category: "rest",
            code: "rest.busy",
            message: `The REST queue is full because ${full}, so new requests fail with reason busy until it drains. Send fewer requests at once, or raise that limit. Further busy failures within a minute are counted in diagnostics().counters.restBusy without another record`,
            fields: {
                budget,
                activeRequests: queue.activeRequests,
                queuedRequests: queue.queuedRequests,
                queuedCapacity: queue.queuedCapacity,
            },
        })
    }
}

async function readMessage<M extends MessageCore>(
    response: Response,
    channel: string,
    id: string | undefined,
    signal: AbortSignal | undefined,
    decode: MessageDecoder<M>,
): Promise<M> {
    const decoded = await readDecoded(response, signal, decode)
    if (decoded.channelId !== channel) throw responseFailure(response, "channelMismatch")
    if (id !== undefined && decoded.id !== id) throw responseFailure(response, "idMismatch")
    return decoded
}

async function readHistory<M extends MessageCore>(
    response: Response,
    channel: string,
    query: { readonly limit: number; readonly params: URLSearchParams },
    signal: AbortSignal,
    decode: MessageDecoder<M>,
) {
    const body: unknown = await readResponseJson(response, undefined, signal)
    const invalid = (field: string) => responseFailure(response, field)
    if (!Array.isArray(body)) throw invalid("body")
    if (body.length > query.limit) throw invalid("tooMany")
    const messages: M[] = []
    const before = query.params.get("before")
    const after = query.params.get("after")
    let previous: bigint | undefined
    for (const [index, item] of body.entries()) {
        const message = decode(item)
        if (!message) throw invalid(`${index}.${failingFieldPath(decode, item) ?? "message"}`)
        if (message.channelId !== channel) throw invalid("channelMismatch")
        const id = BigInt(message.id)
        if (
            (previous !== undefined && id >= previous) ||
            (before !== null && id >= BigInt(before)) ||
            (after !== null && id <= BigInt(after))
        )
            throw invalid("order")
        previous = id
        messages.push(message)
    }
    return Object.freeze(messages)
}

/** A response failure for a decoded value that did not match the operation's expected shape. The field names the
 * response field path or check that failed, never a value
 */
const responseFailure = (response: Response, field?: string) =>
    new RestFailure({ reason: "response", outcome: "unknown", status: response.status, responseField: field ?? null })

/** Read and decode a JSON response with a pure decoder, failing with the field where the decoder stopped */
async function readDecoded<A>(
    response: Response,
    signal: AbortSignal | undefined,
    decode: (value: unknown) => A | undefined,
): Promise<A> {
    const value: unknown = await readResponseJson(response, undefined, signal)
    const decoded = decode(value)
    if (decoded === undefined) throw responseFailure(response, failingFieldPath(decode, value))
    return decoded
}

/** Read operation options and their requested deadline once. Only an application getter or proxy can throw here */
function deadlineOption(options: unknown): { readonly valid: boolean; readonly timeoutMs: unknown } {
    if (options !== undefined && !record(options)) return { valid: false, timeoutMs: undefined }
    return { valid: true, timeoutMs: options?.timeoutMs }
}

/** Options every REST operation accepts. The Effect API has no signal, but accepting it keeps both APIs' checks equal */
const operationOptionKeys: readonly string[] = ["timeoutMs", "signal"]

/** Reject the first options key outside keys, naming it with the closest supported key */
function unsupportedOptionFailure(options: unknown, keys: readonly string[]): RestFailure | undefined {
    const unsupported = record(options)
        ? unsupportedKeyFailure(options, keys, "options", "the operation options")
        : undefined
    return unsupported && inputFailure(unsupported.detail)
}

/** Reject options that are not an object or contain fields other than timeoutMs and signal */
function timeoutOptionsFailure(options: unknown): RestFailure | undefined {
    if (options !== undefined && !record(options))
        return localInputFailure("options", "type", "the operation options must be an object")
    return unsupportedOptionFailure(options, operationOptionKeys)
}

/** How one operation is scheduled through repeated attempts */
interface ExchangeOptions<A> {
    readonly request: Request<A>
    readonly progress: { outcome: Outcome }
    readonly generation: number
    /** Logical deadline for the whole operation */
    readonly deadline: number
    /** Extra queued bytes charged while waiting, such as retained upload plans */
    readonly retainedBytes?: number
}

/** One client's transient REST scheduler, without shared-token coordination or durable delivery */
export class RestOwner<M extends MessageCore = Message> {
    readonly #runtime: RestRuntime<M>
    readonly #uploadMaxBytes: number
    readonly #decodeMessage: MessageDecoder<M>

    constructor(options: RestOwnerOptions<M>) {
        this.#runtime = new RestRuntime(options)
        this.#uploadMaxBytes = options.uploadMaxBytes
        this.#decodeMessage = options.decodeMessage
    }

    /** The client's default operation deadline in milliseconds, from rest.defaultTimeoutMs */
    get defaultTimeoutMs(): number {
        return this.#runtime.settings.defaultTimeoutMs
    }

    /** Size the default API request slots for the client's local shard count */
    scaleConcurrency(localShards: number) {
        this.#runtime.admission.scaleConcurrency(localShards)
    }

    /** Completion signals of the operations and downloads running now, queued ones included, for a draining shutdown */
    inFlight(): readonly Deferred.Deferred<void>[] {
        return [...this.#runtime.operations]
    }

    diagnostics() {
        return {
            ...this.#runtime.admission.diagnostics(),
            reservedUploadBytes: this.#runtime.uploadBytes,
            uploadByteCapacity: this.#uploadMaxBytes,
        }
    }

    refreshAttachmentUrls(
        token: Redacted.Redacted<string>,
        urls: readonly string[],
        options?: AttachmentRefreshOptions,
    ): Effect.Effect<readonly RefreshedAttachmentUrl[], AttachmentRefreshFailure> {
        return suspendInput((): Effect.Effect<readonly RefreshedAttachmentUrl[], RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const input = attachmentRefresh(urls)
            if (input instanceof InputValidationFailure) return Effect.fail(inputFailure(input.detail))
            const invalid = timeoutOptionsFailure(options)
            if (invalid) return Effect.fail(invalid)
            return this.#execute(
                token,
                {
                    channel: "attachments",
                    bucket: "attachments:refresh",
                    cache: false,
                    path: input.path,
                    method: input.method,
                    status: input.status,
                    body: { json: input.json, files: [] },
                    decode: async (response, _instance, signal) => {
                        return readDecoded(response, signal, (value) => input.decode(value))
                    },
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, AttachmentRefreshError, "attachments.refreshUrls")))
    }

    openDownload(
        attachment: Attachment,
        options?: AttachmentDownloadOptions,
    ): Effect.Effect<AttachmentDownloadSource, AttachmentDownloadFailure> {
        return openAttachmentStream(this.#runtime, attachment, options)
    }

    download(
        attachment: Attachment,
        options?: AttachmentDownloadOptions,
    ): Effect.Effect<Uint8Array, AttachmentDownloadFailure> {
        return downloadAttachment(this.#runtime, attachment, options)
    }

    reply(
        token: Redacted.Redacted<string>,
        target: MessageReference,
        input: MessageInput | string,
        options?: SendOptions,
    ) {
        return this.#send(
            token,
            target.channelId,
            () => encodeMessage(target.channelId, input, randomUUID().replaceAll("-", ""), target),
            options,
        )
    }

    send(
        token: Redacted.Redacted<string>,
        channel: string,
        input: MessageInput | string,
        options?: SendOptions,
        directMessageUser?: string,
    ): Effect.Effect<M, SendError> {
        return this.#send(
            token,
            channel,
            () =>
                encodeMessage(
                    channel,
                    input,
                    randomUUID().replaceAll("-", ""),
                    undefined,
                    directMessageUser !== undefined,
                ),
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
    ): Effect.Effect<M, SendError> {
        return suspendInput((): Effect.Effect<M, SendError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
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
                    decodeDirectMessage: (response, channelId, signal) =>
                        readMessage(response, channelId, undefined, signal, this.#decodeMessage),
                    observe: (message, guard) => this.#runtime.cache!.complete(guard, [message]),
                    decode: (response, _instance, signal) =>
                        readMessage(response, channel, undefined, signal, this.#decodeMessage),
                },
                options,
            ).pipe(
                mapFailureCause((error) =>
                    error instanceof RestFailure
                        ? linkRejectionError(
                              new MessageError({
                                  reason: error.reason === "notFound" ? "rejected" : error.reason,
                                  outcome: error.outcome,
                                  status: error.status,
                                  retryAfterMs: error.retryAfterMs,
                                  apiError: error.apiError,
                                  inputValidation: error.inputValidation,
                                  providerCode: error.providerCode,
                                  responseField: error.responseField,
                                  // Keep the transport failure visible, as the other operation errors do
                                  ...(error.cause === undefined ? {} : { cause: error.cause }),
                              }),
                              error,
                          )
                        : error,
                ),
            )
        })
    }

    fetch(token: Redacted.Redacted<string>, target: MessageReference, options?: MessageOperationOptions) {
        return this.#manage(
            token,
            "fetch",
            target,
            undefined,
            options,
            (response, ref, signal) => readMessage(response, ref.channelId, ref.id, signal, this.#decodeMessage),
            (message, guard) => this.#runtime.cache!.complete(guard, [message]),
        )
    }

    publish(token: Redacted.Redacted<string>, target: MessageReference, options?: MessageOperationOptions) {
        return this.#manage(
            token,
            "publish",
            target,
            undefined,
            options,
            (response, ref, signal) => readMessage(response, ref.channelId, ref.id, signal, this.#decodeMessage),
            (message, guard) => this.#runtime.cache!.complete(guard, [message]),
        )
    }

    fetchCrosspostSource(
        token: Redacted.Redacted<string>,
        target: MessageReference,
        options?: MessageOperationOptions,
    ) {
        return this.#manage(token, "fetchCrosspostSource", target, undefined, options, (response, _ref, signal) =>
            readDecoded(response, signal, decodeCrosspostSource),
        )
    }

    typing(
        token: Redacted.Redacted<string>,
        channel: string,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return suspendInput((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            if (!identifier(channel))
                return Effect.fail(localInputFailure("channelId", "format", "Channel IDs must be decimal strings"))
            const invalid = timeoutOptionsFailure(options)
            if (invalid) return Effect.fail(invalid)
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
    ): Effect.Effect<readonly M[], MessageOperationFailure> {
        return suspendInput((): Effect.Effect<readonly M[], RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const encoded = encodeHistory(channel, query)
            if (encoded instanceof InputValidationFailure) return Effect.fail(inputFailure(encoded.detail))
            return this.#execute(
                token,
                {
                    method: "GET",
                    channel,
                    bucket: "history",
                    path: `/channels/${channel}/messages?${encoded.params}`,
                    body: undefined,
                    status: 200,
                    decode: (response, _instance, signal) =>
                        readHistory(response, channel, encoded, signal, this.#decodeMessage),
                    observe: (messages, guard) => this.#runtime.cache!.complete(guard, messages),
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
    ): Effect.Effect<MessageSearchPage<M>, MessageOperationFailure> {
        return suspendInput((): Effect.Effect<MessageSearchPage<M>, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const encoded = encodeMessageSearch(context, query)
            if (encoded instanceof InputValidationFailure) return Effect.fail(inputFailure(encoded.detail))
            return this.#execute(
                token,
                {
                    method: "POST",
                    channel: encoded.context.channelId ?? encoded.context.guildId!,
                    bucket: "search",
                    cache: false,
                    path: "/search/messages",
                    body: { json: encoded.json, files: [] },
                    status: 200,
                    decode: async (response, _instance, signal) => {
                        return readDecoded(response, signal, (value) =>
                            decodeMessageSearchPage(value, this.#decodeMessage),
                        )
                    },
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, "search")))
    }

    edit(
        token: Redacted.Redacted<string>,
        target: MessageReference,
        input: EditMessageInput | string,
        options?: MessageOperationOptions,
    ) {
        return this.#manage(
            token,
            "edit",
            target,
            input,
            options,
            (response, ref, signal) => readMessage(response, ref.channelId, ref.id, signal, this.#decodeMessage),
            (message, guard) => this.#runtime.cache!.complete(guard, [message]),
        )
    }

    delete(token: Redacted.Redacted<string>, target: MessageReference, options?: MessageAuditOperationOptions) {
        return this.#manage(token, "delete", target, undefined, options, async () => {})
    }

    deleteAttachment(
        token: Redacted.Redacted<string>,
        target: MessageReference,
        attachmentId: string,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return suspendInput((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const ref = snapshotReference(target)
            if (ref === undefined)
                return Effect.fail(
                    localInputFailure("target", "format", "Message targets require decimal id and channelId strings"),
                )
            if (!identifier(attachmentId))
                return Effect.fail(
                    localInputFailure("attachmentId", "format", "Attachment IDs must be decimal strings"),
                )
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
        options?: MessageAuditOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return suspendInput((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            if (!identifier(channelId))
                return Effect.fail(localInputFailure("channelId", "format", "Channel IDs must be decimal strings"))
            if (!Array.isArray(ids))
                return Effect.fail(localInputFailure("messageIds", "type", "Message IDs must be an array"))
            // Copy the caller array once and validate the copy, so the validated IDs are the ones sent
            const snapshot = snapshotArray(ids, 100)
            if (snapshot === undefined || snapshot.length < 1)
                return Effect.fail(
                    localInputFailure("messageIds", "length", "Bulk deletion requires 1 through 100 message IDs"),
                )
            if (!snapshot.every(identifier))
                return Effect.fail(localInputFailure("messageIds[]", "format", "Message IDs must be decimal strings"))
            if (new Set(snapshot).size !== snapshot.length)
                return Effect.fail(localInputFailure("messageIds", "unique", "Message IDs must be unique"))
            const audit = auditSettings(options)
            if (audit instanceof InputValidationFailure) return Effect.fail(inputFailure(audit.detail))
            return this.#execute(
                token,
                {
                    method: "POST",
                    channel: channelId,
                    bucket: "bulk-delete",
                    ...(audit.auditReason === undefined ? {} : { auditReason: audit.auditReason }),
                    cache: false,
                    deleteIds: snapshot as readonly string[],
                    path: `/channels/${channelId}/messages/bulk-delete`,
                    body: { json: JSON.stringify({ message_ids: snapshot }), files: [] },
                    status: 204,
                    decode: async () => {},
                },
                options,
                [...operationOptionKeys, "auditReason"],
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, "deleteMany")))
    }

    deleteOwnMessages(
        token: Redacted.Redacted<string>,
        channelId: string,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return suspendInput((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            if (!identifier(channelId))
                return Effect.fail(localInputFailure("channelId", "format", "Channel IDs must be decimal strings"))
            const invalid = timeoutOptionsFailure(options)
            if (invalid) return Effect.fail(invalid)
            return this.#execute(
                token,
                {
                    method: "POST",
                    channel: channelId,
                    bucket: "bulk-delete-mine",
                    cache: false,
                    invalidateMessages: true,
                    path: `/channels/${channelId}/messages/bulk-delete-mine`,
                    body: undefined,
                    status: 202,
                    decode: async () => {},
                },
                options,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, "deleteOwnMessages")))
    }

    fetchReactionUsers(
        token: Redacted.Redacted<string>,
        target: MessageReference,
        emoji: ReactionEmojiInput,
        query?: ReactionUsersQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<ReactionUsersPage, MessageOperationFailure> {
        return suspendInput((): Effect.Effect<ReactionUsersPage, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const encoded = encodeReactionEmoji(emoji)
            const page = encodeReactionUsersQuery(query)
            const ref = snapshotReference(target)
            if (ref === undefined)
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
            if (page instanceof InputValidationFailure) return Effect.fail(inputFailure(page.detail))
            return this.#execute(
                token,
                {
                    method: "GET",
                    channel: ref.channelId,
                    bucket: "reaction",
                    path: `/channels/${ref.channelId}/messages/${ref.id}/reactions/${encoded}/users?${page.params}`,
                    body: undefined,
                    status: 200,
                    decode: async (response, _instance, signal) => {
                        return readDecoded(response, signal, (value) => decodeReactionUsersPage(value, page))
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
    ): Effect.Effect<MessagePinsPage<M>, MessageOperationFailure> {
        return suspendInput((): Effect.Effect<MessagePinsPage<M>, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const page = encodePinsQuery(channel, query)
            if (page instanceof InputValidationFailure) return Effect.fail(inputFailure(page.detail))
            return this.#execute(
                token,
                {
                    method: "GET",
                    channel,
                    bucket: "pins",
                    path: `/channels/${channel}/messages/pins?${page.params}`,
                    body: undefined,
                    status: 200,
                    decode: async (response, _instance, signal) => {
                        return readDecoded(response, signal, (value) =>
                            decodePinsPage(value, channel, page, this.#decodeMessage),
                        )
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
        options?: MessageAuditOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure> {
        return suspendInput((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const ref = snapshotReference(target)
            if (ref === undefined)
                return Effect.fail(
                    localInputFailure("target", "format", "Message targets require decimal id and channelId strings"),
                )
            const audit = auditSettings(options)
            if (audit instanceof InputValidationFailure) return Effect.fail(inputFailure(audit.detail))
            return this.#execute(
                token,
                {
                    method: operation === "pin" ? "PUT" : "DELETE",
                    ...(audit.auditReason === undefined ? {} : { auditReason: audit.auditReason }),
                    channel: ref.channelId,
                    target: ref.id,
                    bucket: "pins",
                    path: `/channels/${ref.channelId}/pins/${ref.id}`,
                    body: undefined,
                    status: 204,
                    decode: async () => {},
                },
                options,
                [...operationOptionKeys, "auditReason"],
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
        return suspendInput((): Effect.Effect<void, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const encoded = operation === "clearReactions" ? "" : encodeReactionEmoji(emoji as ReactionEmojiInput)
            const ref = snapshotReference(target)
            if (ref === undefined)
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
                    channel: ref.channelId,
                    bucket: "reaction",
                    path: `/channels/${ref.channelId}/messages/${ref.id}/reactions${suffix}`,
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
        operation: "fetch" | "edit" | "delete" | "publish" | "fetchCrosspostSource",
        target: MessageReference,
        input: EditMessageInput | string | undefined,
        options: MessageOperationOptions | undefined,
        decode: (response: Response, ref: MessageReference, signal: AbortSignal) => Promise<A>,
        observe?: (value: A, guard: CacheRequest) => void,
    ): Effect.Effect<A, MessageOperationFailure> {
        return suspendInput((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const ref = snapshotReference(target)
            if (ref === undefined)
                return Effect.fail(
                    localInputFailure("target", "format", "Message targets require decimal id and channelId strings"),
                )
            const body = operation === "edit" ? encodeEdit(input) : undefined
            if (body instanceof InputValidationFailure) return Effect.fail(inputFailure(body.detail))
            const audit = operation === "delete" ? auditSettings(options) : undefined
            if (audit instanceof InputValidationFailure) return Effect.fail(inputFailure(audit.detail))
            return this.#execute(
                token,
                {
                    method:
                        operation === "fetch" || operation === "fetchCrosspostSource"
                            ? "GET"
                            : operation === "publish"
                              ? "POST"
                              : operation === "edit"
                                ? "PATCH"
                                : "DELETE",
                    channel: ref.channelId,
                    target: ref.id,
                    ...(operation === "publish"
                        ? { bucket: "channel:message:crosspost", messageMutation: true as const }
                        : operation === "fetchCrosspostSource"
                          ? { bucket: "channel:message:crosspost_source", cache: false as const }
                          : {}),
                    path: `/channels/${ref.channelId}/messages/${ref.id}${
                        operation === "publish"
                            ? "/crosspost"
                            : operation === "fetchCrosspostSource"
                              ? "/crosspost-source"
                              : ""
                    }`,
                    body,
                    status: operation === "delete" ? 204 : 200,
                    ...(audit?.auditReason === undefined ? {} : { auditReason: audit.auditReason }),
                    decode: (response, _instance, signal) => decode(response, ref, signal),
                    ...(observe === undefined ? {} : { observe }),
                },
                options,
                operation === "delete" ? [...operationOptionKeys, "auditReason"] : operationOptionKeys,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, MessageOperationError, operation)))
    }

    /** Run attempts for one request until it succeeds, fails permanently, runs out of read retries or passes its deadline */
    #exchange<A>(
        token: Redacted.Redacted<string>,
        options: ExchangeOptions<A>,
    ): Effect.Effect<A, RestFailure | ClientClosedError> {
        const runtime = this.#runtime
        const { request, progress, generation, deadline, retainedBytes = 0 } = options
        const route = rateRoute(request.method, request.path, request.channel, request.bucket, request.webhookId)
        const template =
            request.template ?? routeTemplate(request.put ? "/attachments/upload" : request.path, request.webhookId)
        const bytes = retainedBytes + Buffer.byteLength(request.body?.json ?? "")
        return Effect.gen(function* () {
            const fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber))
            let retries = 0
            let attempts = 0
            let until = 0
            while (true) {
                const retryCount = attempts++
                const attempt = yield* Effect.uninterruptibleMask((restore) =>
                    Effect.exit(
                        restore(
                            Effect.acquireUseRelease(
                                Effect.interruptible(
                                    runtime.admission.acquire({ route: route.key, bytes, until }),
                                ).pipe(
                                    mapFailureCause((error) =>
                                        error instanceof RestFailure ? error.withOutcome(progress.outcome) : error,
                                    ),
                                ),
                                () =>
                                    runtime.logical.now() >= deadline
                                        ? Effect.fail(new RestFailure({ reason: "timeout", outcome: progress.outcome }))
                                        : runAttempt({
                                              runtime,
                                              token,
                                              request,
                                              route,
                                              progress,
                                              generation,
                                              fiber,
                                              retryCount,
                                          }),
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
                    // An unusable success response usually means a Fluxer schema change or a wrong test fixture,
                    // so it is logged once per route and field, mirroring gateway.dispatchRejected. A caller-described
                    // route has no expected shape, so its failure is only returned to the caller
                    if (error instanceof RestFailure && error.reason === "response" && !request.callerDescribed)
                        runtime.logging?.log(
                            {
                                level: "warn",
                                category: "rest",
                                code: "rest.responseRejected",
                                message: `${request.method} ${template} returned an answer in an unexpected format${error.responseField === null ? "" : `: ${responseFieldText(error.responseField)}`}`,
                                route: template,
                                ...(error.status === null ? {} : { status: error.status }),
                                fields: { method: request.method, field: error.responseField ?? undefined },
                            },
                            fiber.context,
                        )
                    if (
                        request.method !== "GET" ||
                        !(error instanceof RestFailure) ||
                        !error.retryableRead ||
                        retries === maximumReadRetries
                    )
                        return yield* Effect.fail(error)
                    const minimum = retries++ === 0 ? firstReadRetryMs : laterReadRetryMs
                    const delay = Math.max(minimum * (1 + (yield* Random.next)), error.retryAfterMs ?? 0)
                    // A retry that cannot start before the deadline would only end as a timeout, so the received failure is returned now
                    if (runtime.logical.now() + Math.ceil(delay) >= deadline) return yield* Effect.fail(error)
                    until = runtime.logical.now() + Math.ceil(delay)
                    runtime.logging?.drop(
                        "restRetries",
                        {
                            level: "debug",
                            category: "rest",
                            code: "rest.retry",
                            message: `Retrying ${request.method} ${template} after ${error.status === null ? `a ${error.reason} failure` : `HTTP ${error.status}`} in ${Math.ceil(delay)} ms`,
                            route: template,
                            attempt: attempts + 1,
                            delayMs: Math.ceil(delay),
                            ...(error.status === null ? {} : { status: error.status }),
                            fields: { method: request.method, reason: error.reason },
                        },
                        fiber.context,
                    )
                    continue
                }
                const response = attempt.value
                if (response.kind === "success") return response.value
                if (
                    (request.inlineAttachments || request.webhookId) &&
                    request.sources?.some((source) => !source.replayable)
                )
                    return yield* Effect.fail(
                        new RestFailure({
                            reason: "rateLimit",
                            outcome: progress.outcome,
                            status: 429,
                            retryAfterMs: response.retry,
                            apiError: response.apiError,
                            providerCode: response.providerCode ?? null,
                        }),
                    )
                until = runtime.logical.now() + response.retry
                if (response.global) runtime.admission.pauseGlobal(until)
                if (until >= deadline) {
                    // No wait happens: The request fails now, so this is not counted as a rate-limit wait
                    runtime.logging?.log(
                        {
                            level: response.retry >= longRateLimitWaitMs ? "warn" : "debug",
                            category: "ratelimit",
                            code: "ratelimit.deadline",
                            message: `${request.method} ${template} was rate-limited${response.global ? " globally" : ""} for ${response.retry} ms, which is past its timeout, so it fails without waiting`,
                            route: template,
                            status: 429,
                            delayMs: response.retry,
                            attempt: attempts,
                            fields: { method: request.method, global: response.global },
                        },
                        fiber.context,
                    )
                    return yield* Effect.fail(
                        new RestFailure({
                            reason: "rateLimit",
                            outcome: progress.outcome,
                            status: 429,
                            retryAfterMs: response.retry,
                            apiError: response.apiError,
                            providerCode: response.providerCode ?? null,
                        }),
                    )
                }
                metrics.rateLimitWait(response.retry, fiber.context)
                emitObservation(runtime.logging, {
                    type: "rateLimit",
                    method: request.method,
                    route: template,
                    waitMs: response.retry,
                    global: response.global,
                })
                runtime.logging?.drop(
                    "rateLimitWaits",
                    {
                        level: response.retry >= longRateLimitWaitMs ? "warn" : "debug",
                        category: "ratelimit",
                        code: "ratelimit.wait",
                        message: `${request.method} ${template} was rate-limited${response.global ? " globally" : ""}, so it waits ${response.retry} ms before retrying`,
                        route: template,
                        status: 429,
                        delayMs: response.retry,
                        attempt: attempts,
                        fields: { method: request.method, global: response.global },
                    },
                    fiber.context,
                )
            }
        })
    }

    /** Plan and upload attachment files through presigned destinations, or fall back to inline multipart */
    #prepareUploads(
        token: Redacted.Redacted<string>,
        body: EncodedBody,
        sources: readonly AttachmentTransferSource[],
        context: {
            readonly channel: string
            readonly instance: InstanceEndpointContext
            readonly progress: { outcome: Outcome }
            readonly generation: number
            readonly deadline: number
        },
    ): Effect.Effect<"preuploaded" | "inline", RestFailure | ClientClosedError> {
        const owner = this
        const { channel, instance, progress, generation, deadline } = context
        return Effect.gen(function* () {
            const inline = (): "inline" => {
                const payload = JSON.parse(body.json) as { attachments: Record<string, unknown>[] }
                payload.attachments = payload.attachments.map((item) => {
                    const file = body.files.find((file) => file.id === item.id)
                    if (!file) return item
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
                    request: {
                        method: "POST",
                        channel,
                        bucket: "upload",
                        preparation: true,
                        instance,
                        path: `/channels/${channel}/attachments`,
                        body: { json: JSON.stringify({ attachments }), files: [] },
                        decode: async (
                            response,
                            _instance,
                            signal,
                        ): Promise<{ kind: "plans"; plans: UploadPlan[] }> => {
                            const plans = decodeUploadPlans(
                                await readResponseJson(response, uploadResponseMaxBytes, signal),
                                body.files,
                                instance.allowInsecure,
                            )
                            if (!plans)
                                throw new RestFailure({
                                    reason: "response",
                                    outcome: "notDispatched",
                                    status: response.status,
                                })
                            return { kind: "plans" as const, plans }
                        },
                        featureDisabled: () => ({ kind: "disabled" as const }),
                    },
                    progress,
                    generation,
                    deadline,
                    retainedBytes,
                },
            )
            if (planned.kind === "disabled") return inline()
            const plans = planned.plans
            // Charge retained plan capabilities too while queued. They are never exposed as diagnostics
            const queuedBytes = retainedBytes + Buffer.byteLength(JSON.stringify(plans))
            for (const plan of plans) {
                const file = body.files.find((file) => file.id === plan.id)!
                const source = sources[body.files.indexOf(file)]
                if (!source)
                    return yield* Effect.fail(new RestFailure({ reason: "response", outcome: "notDispatched" }))
                for (const part of plan.parts) {
                    yield* owner.#exchange(token, {
                        request: {
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
                        retainedBytes: queuedBytes,
                    })
                }
            }
            const uploads = plans
                .filter((plan) => plan.uploadId !== undefined)
                .map((plan) => ({ upload_filename: plan.key, upload_id: plan.uploadId! }))
            if (uploads.length)
                yield* owner.#exchange(token, {
                    request: {
                        method: "POST",
                        channel,
                        bucket: "upload",
                        preparation: true,
                        instance,
                        path: `/channels/${channel}/attachments/complete`,
                        body: { json: JSON.stringify({ uploads }), files: [] },
                        decode: async (response, _instance, signal) => {
                            const value = await readResponseJson(response, uploadResponseMaxBytes, signal)
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
                                throw new RestFailure({
                                    reason: "response",
                                    outcome: "notDispatched",
                                    status: response.status,
                                })
                        },
                    },
                    progress,
                    generation,
                    deadline,
                    retainedBytes: queuedBytes,
                })
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
        return suspendInput((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (input instanceof InputValidationFailure) return Effect.fail(inputFailure(input.detail))
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            const audit = input.audited ? auditSettings(options) : undefined
            if (audit instanceof InputValidationFailure) return Effect.fail(inputFailure(audit.detail))
            const auditReason = input.auditReason ?? audit?.auditReason
            const acceptedOptions = [
                "timeoutMs",
                "signal",
                ...(input.moderation || input.audited ? ["auditReason"] : []),
                ...(input.timeoutReason ? ["timeoutReason"] : []),
                ...(input.method === "DELETE" && ["guild:emojis", "guild:stickers"].includes(input.bucket)
                    ? ["purge"]
                    : []),
            ]
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
                    ...(auditReason === undefined ? {} : { auditReason }),
                    ...(input.deleteAuthorId === undefined ? {} : { deleteAuthorId: input.deleteAuthorId }),
                    ...(input.invalidateMessages === undefined ? {} : { invalidateMessages: input.invalidateMessages }),
                    ...(input.features === undefined ? {} : { features: input.features }),
                    path: input.path,
                    method: input.method,
                    status: input.status,
                    body: input.json === undefined ? undefined : { json: input.json, files: [] },
                    decode: async (response, instance, signal) => {
                        if (input.status === 202 || input.status === 204) return undefined as A
                        return readDecoded(response, signal, (value) => input.decode(value, instance))
                    },
                },
                options,
                acceptedOptions,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, GuildOperationError, operation)))
    }

    channel<A>(
        token: Redacted.Redacted<string>,
        operation: ChannelOperation,
        build: () => ChannelRequest<A> | InputValidationFailure,
        options?: ChannelOperationOptions,
    ) {
        return suspendInput((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (input instanceof InputValidationFailure) return Effect.fail(inputFailure(input.detail))
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            const audit = input.audited ? auditSettings(options) : undefined
            if (audit instanceof InputValidationFailure) return Effect.fail(inputFailure(audit.detail))
            const acceptedOptions = input.audited ? [...operationOptionKeys, "auditReason"] : operationOptionKeys
            return this.#execute(
                token,
                {
                    channel: input.majorId,
                    bucket: input.bucket,
                    cache: false,
                    ...(input.cache === undefined ? {} : { channelCache: input.cache }),
                    ...(audit?.auditReason === undefined ? {} : { auditReason: audit.auditReason }),
                    ...(input.features === undefined ? {} : { features: input.features }),
                    path: input.path,
                    method: input.method,
                    status: input.status,
                    body: input.json === undefined ? undefined : { json: input.json, files: [] },
                    decode: async (response, _instance, signal) => {
                        if (input.status === 204) return undefined as A
                        return readDecoded(response, signal, (value) => input.decode(value))
                    },
                },
                options,
                acceptedOptions,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, ChannelOperationError, operation)))
    }

    user<A>(
        token: Redacted.Redacted<string>,
        operation: UserOperation,
        build: () => UserRequest<A> | InputValidationFailure,
        options?: UserOperationOptions,
    ) {
        return suspendInput((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (input instanceof InputValidationFailure) return Effect.fail(inputFailure(input.detail))
            const invalid = timeoutOptionsFailure(options)
            if (invalid) return Effect.fail(invalid)
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
                    decode: async (response, _instance, signal) => {
                        if (input.status === 204) return undefined as A
                        return readDecoded(response, signal, (value) => input.decode(value))
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
        return suspendInput((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const input = build()
            const invalid = timeoutOptionsFailure(options)
            if (invalid) return Effect.fail(invalid)
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
                    decode: async (response, _instance, signal) => {
                        return readDecoded(response, signal, (value) => input.decode(value))
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
        return suspendInput((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const input = build()
            if (input instanceof InputValidationFailure) return Effect.fail(inputFailure(input.detail))
            if (options !== undefined && !record(options))
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            const acceptedOptions =
                input.method !== "GET" && !input.tokenAuth
                    ? [...operationOptionKeys, "auditReason"]
                    : operationOptionKeys
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
                    decode: async (response, _instance, signal) => {
                        if (input.status === 204) return undefined as A
                        return readDecoded(response, signal, (value) => input.decode(value))
                    },
                },
                options,
                acceptedOptions,
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, WebhookOperationError, operation)))
    }

    /**
     * Validate the options and deadline, reserve upload bytes, register cache guards and run the operation to completion.
     * The options may contain only optionKeys, which each operation family lists beside its own validation
     */
    #execute<A>(
        token: Redacted.Redacted<string>,
        request: Request<A>,
        options?: MessageOperationOptions,
        optionKeys: readonly string[] = operationOptionKeys,
    ): Effect.Effect<A, RestFailure | ClientClosedError> {
        const owner = this
        const runtime = this.#runtime
        return Effect.suspend((): Effect.Effect<A, RestFailure | ClientClosedError> => {
            if (runtime.closed) return Effect.fail(new ClientClosedError())
            let requested: ReturnType<typeof deadlineOption>
            let unsupported: RestFailure | undefined
            try {
                requested = deadlineOption(options)
                unsupported = unsupportedOptionFailure(options, optionKeys)
            } catch (error) {
                return Effect.failCause(inputDefect(error))
            }
            if (!requested.valid)
                return Effect.fail(localInputFailure("options", "type", "Operation options must be an object"))
            if (unsupported) return Effect.fail(unsupported)
            const timeout = requested.timeoutMs === undefined ? runtime.settings.defaultTimeoutMs : requested.timeoutMs
            if (
                typeof timeout !== "number" ||
                !Number.isSafeInteger(timeout) ||
                timeout <= 0 ||
                timeout > maximumTimerMs
            )
                return Effect.fail(
                    localInputFailure(
                        "options.timeoutMs",
                        "range",
                        "Operation timeoutMs must be an integer from 1 through 2,147,483,647 ms",
                    ),
                )
            const bytes = Buffer.byteLength(request.body?.json ?? "")
            const uploadBytes = request.body?.files.reduce((sum, file) => sum + file.size, 0) ?? 0
            if (!Number.isSafeInteger(uploadBytes) || uploadBytes > owner.#uploadMaxBytes - runtime.uploadBytes) {
                runtime.busy("uploads")
                return Effect.fail(new RestFailure({ reason: "busy", outcome: "notDispatched" }))
            }
            // Check JSON/count admission before allocating binary snapshots, then reserve before any wait
            if (!runtime.admission.hasRoom(bytes)) {
                runtime.busy("queue")
                return Effect.fail(new RestFailure({ reason: "busy", outcome: "notDispatched" }))
            }
            runtime.uploadBytes += uploadBytes
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
                // allow-silent: An unreadable caller source becomes the typed input failure returned below
                runtime.uploadBytes -= uploadBytes
                return Effect.fail(
                    localInputFailure(
                        "attachments[].data",
                        "type",
                        "Attachment byte data must stay readable until the operation has copied it",
                    ),
                )
            }
            const deadline = runtime.logical.now() + timeout
            const generation = runtime.cache?.generation ?? 0
            const progress: { outcome: Outcome } = { outcome: "notDispatched" }
            const deletionGuard =
                request.deleteIds && runtime.cache?.begin(request.channel, undefined, true, generation)
            // Register before discovery and queue/rate waits so events, writes and gaps invalidate the whole operation
            const resourceGuard = request.resourceCache && runtime.resources?.begin(request.resourceCache)
            if (resourceGuard) request = { ...request, resourceGuard }
            const channelGuard = request.channelCache && runtime.channels?.begin(request.channelCache)
            if (channelGuard) request = { ...request, channelGuard }
            const operation = Deferred.makeUnsafe<void>()
            runtime.operations.add(operation)
            return Effect.gen(function* () {
                const resolved = runtime.instance
                const instance =
                    resolved ??
                    (yield* Effect.acquireUseRelease(
                        Effect.interruptible(runtime.admission.acquire({ route: "discovery", bytes })),
                        () => runtime.resolveInstance(),
                        (release) => Effect.sync(release),
                    ).pipe(mapFailureCause(instanceFailure)))
                if (!resolved) runtime.instance = instance
                request = { ...request, instance }
                if (request.directMessageUser !== undefined) {
                    const open = directMessageOpen(request.directMessageUser)!
                    if (open instanceof InputValidationFailure) return yield* Effect.fail(inputFailure(open.detail))
                    const userGuard = runtime.users?.begin("directMessages", { mutation: true })
                    const channel = yield* owner
                        .#exchange(token, {
                            request: {
                                method: "POST",
                                channel: "@me",
                                bucket: "user:directMessages.open",
                                cache: false,
                                instance,
                                path: open.path,
                                body: { json: open.json!, files: [] },
                                status: 200,
                                preparation: true,
                                decode: async (response, _instance, signal) => {
                                    const channel = open.decode(await readResponseJson(response, undefined, signal))
                                    if (!channel)
                                        throw new RestFailure({
                                            reason: "response",
                                            outcome: "notDispatched",
                                            status: response.status,
                                        })
                                    return channel
                                },
                            },
                            progress: { outcome: "notDispatched" },
                            generation,
                            deadline,
                            retainedBytes: bytes,
                        })
                        .pipe(
                            mapFailureCause((error) =>
                                error instanceof RestFailure ? error.withOutcome("notDispatched") : error,
                            ),
                            Effect.onExit((exit) =>
                                Effect.sync(() => {
                                    if (exit._tag === "Failure" && userGuard !== undefined)
                                        runtime.users!.failed(userGuard)
                                }),
                            ),
                        )
                    if (userGuard !== undefined) runtime.users!.complete(userGuard, [channel])
                    request = {
                        ...request,
                        channel: channel.id,
                        path: `/channels/${channel.id}/messages`,
                        decode: (response, _instance, signal) =>
                            request.decodeDirectMessage!(response, channel.id, signal),
                    }
                }
                if (request.body?.files.length && !request.webhookId && !request.inlineAttachments) {
                    const uploadMode = yield* owner.#prepareUploads(token, request.body, request.sources ?? [], {
                        channel: request.channel,
                        instance,
                        progress,
                        generation,
                        deadline,
                    })
                    if (uploadMode === "inline") request = { ...request, inlineAttachments: true }
                }
                return yield* owner.#exchange(token, { request, progress, generation, deadline })
            }).pipe(
                withDeadline(timeout, () => new RestFailure({ reason: "timeout", outcome: progress.outcome })),
                Effect.provideService(Clock.Clock, runtime.logical.clock),
                Effect.ensuring(
                    Effect.promise(() =>
                        completeCleanup((request.sources ?? []).map((source) => () => source.close())),
                    ).pipe(
                        Effect.ensuring(
                            Effect.sync(() => {
                                if (request.deleteIds && progress.outcome !== "notDispatched")
                                    runtime.cache?.deleteMany(request.channel, request.deleteIds)
                                if (deletionGuard) runtime.cache!.end(deletionGuard)
                                if (resourceGuard)
                                    runtime.resources!.end(
                                        resourceGuard,
                                        request.moderation
                                            ? progress.outcome !== "notDispatched"
                                            : progress.outcome === "unknown",
                                    )
                                if (request.deleteAuthorId && progress.outcome !== "notDispatched")
                                    runtime.cache?.deleteAuthor(request.deleteAuthorId)
                                // A read begun after deletion dispatch can still observe pre-deletion data, so clear again at completion
                                if (request.invalidateMessages && progress.outcome !== "notDispatched")
                                    runtime.cache?.gap()
                                // A rejected multi-entry reorder can have applied earlier entries before its failure
                                if (channelGuard)
                                    runtime.channels!.end(channelGuard, progress.outcome !== "notDispatched")
                                if (
                                    request.channelCache?.mutation &&
                                    request.method === "DELETE" &&
                                    request.bucket === "channel:delete" &&
                                    progress.outcome === "unknown"
                                )
                                    runtime.cache?.deleteChannel(request.channel)
                                if (request.body) request.body.files.length = 0
                                runtime.uploadBytes -= uploadBytes
                                runtime.operations.delete(operation)
                                Deferred.doneUnsafe(operation, Effect.void)
                            }),
                        ),
                    ),
                ),
            )
        }).pipe(
            // A read that failed after dispatch cannot have changed remote state, so its unknown outcome stays retryable.
            // Mark it in place: The failure's Cause, including any cleanup defects beside it, stays unchanged
            Effect.onExit((exit) =>
                Effect.sync(() => {
                    if (request.method !== "GET" || Exit.isSuccess(exit)) return
                    for (const reason of exit.cause.reasons)
                        if (reason._tag === "Fail" && reason.error instanceof RestFailure) reason.error.read = true
                }),
            ),
        )
    }

    /**
     * Send one caller-described request through the same discovery, admission, rate-limit learning, 429 waits,
     * deadline, logging and retry rules as wrapped operations, without message or resource cache coordination.
     * Files are always sent inline as multipart, never through presigned uploads, because the route is unknown
     */
    request<T>(
        token: Redacted.Redacted<string>,
        input: RestRequest | DefaultRestRequest,
    ): Effect.Effect<RestResponse<T>, RestRequestFailure> {
        return suspendInput((): Effect.Effect<RestResponse<T>, RestFailure | ClientClosedError> => {
            if (this.#runtime.closed) return Effect.fail(new ClientClosedError())
            const encoded = encodeRestRequest(input)
            if (encoded instanceof InputValidationFailure) return Effect.fail(inputFailure(encoded.detail))
            return this.#execute(
                token,
                {
                    method: encoded.method,
                    channel: encoded.major,
                    // Requests to one caller route share provisional rate-limit state until Fluxer names its bucket
                    bucket: `rest:${encoded.method} ${encoded.template}`,
                    cache: false,
                    callerDescribed: true,
                    path: encoded.path,
                    template: encoded.template,
                    body: encoded.body,
                    ...(encoded.body?.files.length ? { inlineAttachments: true as const } : {}),
                    ...(encoded.auditReason === undefined ? {} : { auditReason: encoded.auditReason }),
                    decode: (response, _instance, signal) => readRestResponse<T>(response, signal),
                },
                encoded.timeoutMs === undefined ? undefined : { timeoutMs: encoded.timeoutMs },
            )
        }).pipe(mapFailureCause((error) => operationFailure(error, RestRequestError, "rest.request")))
    }

    /** Close admission and abort every request and download without waiting */
    stop() {
        const runtime = this.#runtime
        runtime.closed = true
        runtime.instance = undefined
        runtime.admission.close()
        for (const source of runtime.downloads) source.fail(new ClientClosedError())
        for (const controller of runtime.controllers) controller.abort()
    }

    /** Stop, then wait for every running operation and surface unobserved stream cleanup failures */
    shutdown(): Effect.Effect<void> {
        return Effect.suspend(() => {
            this.stop()
            const runtime = this.#runtime
            return Effect.forEach([...runtime.operations], (operation) => Deferred.await(operation), {
                discard: true,
                concurrency: "unbounded",
            }).pipe(
                Effect.andThen(
                    Effect.suspend(() => {
                        const defects = runtime.unobservedDownloadDefects.take()
                        return defects ? Effect.failCause(defects) : Effect.void
                    }),
                ),
            )
        })
    }
}
