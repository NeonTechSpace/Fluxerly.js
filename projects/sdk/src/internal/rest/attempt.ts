/**
 * One REST attempt: Send a scheduled request through the HTTP transport, classify the response, decode it and record
 * cache effects, then release every resource the attempt acquired.
 * Invariant: An attempt registers its abort controller and message-cache guard only after caller-owned sources open,
 * always awaits response-body and transfer cleanup, and reports cleanup failures without replacing the operation result.
 * Cancellation or a lost response after dispatch cannot establish non-delivery or rollback.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Fiber from "effect/Fiber"
import * as Redacted from "effect/Redacted"
import { ClientClosedError } from "#sdk/errors"
import { apiErrorHint, routeAction, type ApiErrorDetail } from "#sdk/api-errors"
import type { MessageCore } from "#sdk/messages"
import type { EncodedBody } from "../attachments.js"
import type { CacheRequest } from "../cache.js"
import type { ChannelCacheGuard, ChannelCacheRequest } from "../channel-cache.js"
import { TransportError } from "../effect-failures.js"
import type { ResourceGuard, ResourceRequest } from "../guild-cache.js"
import type { InstanceEndpointContext } from "../instance.js"
import { metrics } from "../metrics.js"
import { emitObservation } from "../observer.js"
import type { LogInput } from "../logging.js"
import { fiberRejectionScope } from "../rejection-scope.js"
import { multipart } from "../multipart.js"
import { routeTemplate, type RateRoute } from "../rate-limits.js"
import { ResponseJsonCleanupError } from "../response-json.js"
import {
    AttachmentTransferCleanupError,
    AttachmentTransferSource,
    AttachmentTransferVerificationCleanupError,
} from "../transfer-source.js"
import { classifyResponse, RestFailure, type Outcome } from "./classify.js"
import type { RestRuntime } from "./owner.js"

/**
 * One REST request as the owner schedules it: Routing, cache coordination, upload handling and decoding.
 * The owner fills instance, sources and the cache guards before the first attempt
 */
export type Request<A> = {
    method: "POST" | "GET" | "PATCH" | "DELETE" | "PUT"
    /** Major resource for route grouping and message-cache ownership: A channel or guild ID, or a fixed label such as "application" */
    channel: string
    /** Path after /v1, including any query string. Empty for a signed upload PUT */
    path: string
    /** Log-safe route template, when the owner builds a stricter one than routeTemplate for a caller-supplied path */
    template?: string
    /** JSON text and attachment files. The owner snapshots byte files before any wait */
    body: EncodedBody | undefined
    /** Required success status. Another 2xx status is a response failure */
    status?: number
    /** Decode an accepted response. A thrown RestFailure keeps its reason, other throws become response failures */
    decode: (response: Response, instance: InstanceEndpointContext, signal: AbortSignal) => Promise<A>
    /** Rate-limit group that separates routes sharing a major resource, such as "history" or "pins" */
    bucket?: string
    /** A false value skips message-cache coordination for requests that never read or change cached messages */
    cache?: false
    /** Message ID the request reads or changes, used by the message-cache guard and deletion */
    target?: string
    /** Record a successful value in the message cache under the attempt's guard */
    observe?: (value: A, guard: CacheRequest) => void
    /** Message IDs a bulk deletion removes from the message cache once dispatched */
    deleteIds?: readonly string[]
    /** Author whose cached messages are removed once the request is dispatched */
    deleteAuthorId?: string
    /** Clear the message cache when the request is sent and again after it completes, because it can delete any message */
    invalidateMessages?: true
    /** A moderation request invalidates its guarded resources once dispatched, not only when its outcome is unknown */
    moderation?: true
    /** X-Audit-Log-Reason header value */
    auditReason?: string
    /** X-Fluxer-Features capabilities required by one provider-gated route */
    features?: readonly string[]
    /** Guild-cache resources this request reads or changes, registered as a guard before any wait */
    resourceCache?: ResourceRequest
    /** The registered guild-cache guard, set by the owner */
    resourceGuard?: ResourceGuard
    /** Channel-cache resources this request reads or changes, registered as a guard before any wait */
    channelCache?: ChannelCacheRequest
    /** The registered channel-cache guard, set by the owner */
    channelGuard?: ChannelCacheGuard
    /** Webhook ID for token-authenticated webhook routes, which carry the token in the path instead of a header */
    webhookId?: string
    /** Recipient of a direct message. The owner opens the conversation first, then sends to its channel */
    directMessageUser?: string
    /** Decoder used once the direct-message channel is known */
    decodeDirectMessage?: (response: Response, channel: string, signal: AbortSignal) => Promise<A>
    /** A preparation step, such as opening a DM or planning uploads, that never marks the operation dispatched or rejected */
    preparation?: boolean
    /** The resolved instance, set by the owner before the first attempt */
    instance?: InstanceEndpointContext
    /** Transfer sources for the body's files, created by the owner */
    sources?: readonly AttachmentTransferSource[]
    /** Send files inline as multipart because presigned uploads are unavailable */
    inlineAttachments?: true
    /** A client.rest.request route, which has no expected response shape, so an unusable response is not logged */
    callerDescribed?: true
    /** Successful value for Fluxer's temporarily-disabled-feature rejection */
    featureDisabled?: () => A
    /** Signed upload of one part of a source to external storage, sent without SDK credentials */
    put?: {
        url: string
        source: AttachmentTransferSource
        offset: number
        size: number
        contentType?: string
    }
}

/** Everything one attempt needs from its operation */
export interface AttemptContext<A, M extends MessageCore = MessageCore> {
    readonly runtime: RestRuntime<M>
    readonly token: Redacted.Redacted<string>
    readonly request: Request<A>
    readonly route: RateRoute
    /** The operation's outcome, shared across its attempts and preparation steps */
    readonly progress: { outcome: Outcome }
    /** Message-cache generation at operation start, so a later gap stops this operation's cache writes */
    readonly generation: number
    /** Fiber whose context carries the caller's logger, tracing and metrics services */
    readonly fiber: Fiber.Fiber<unknown, unknown>
    /** Zero-based attempt number, reported in logs and spans */
    readonly retryCount: number
}

/** A decoded value, or a confirmed rate limit that the operation waits out before sending again */
export type AttemptResult<A> =
    | { readonly kind: "success"; readonly value: A }
    | {
          readonly kind: "retry"
          readonly retry: number
          readonly global: boolean
          readonly bucket: string
          readonly apiError: ApiErrorDetail | null
      }

/** Run every cleanup action, then rethrow the one failure or an AggregateError of several */
export async function completeCleanup(actions: readonly (() => void | PromiseLike<void>)[]) {
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

/** Parse a payload for unsafe debugging, keeping text that is not JSON */
function parsedPayload(text: string): unknown {
    try {
        return JSON.parse(text) as unknown
    } catch {
        // allow-silent: Non-JSON bodies are logged as their text instead
        return text
    }
}

/** Bytes of a response body that unsafe payload logging reads before cancelling its copy */
const payloadReadLimit = 65_536

/** Read at most payloadReadLimit bytes from a copy of the response, then cancel the copy so the rest is never held */
async function payloadText(response: Response): Promise<{ readonly text: string; readonly truncated: boolean }> {
    const body = response.clone().body
    if (!body) return { text: "", truncated: false }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let truncated = false
    try {
        while (true) {
            const next = await reader.read()
            if (next.done) break
            chunks.push(next.value)
            size += next.value.byteLength
            if (size > payloadReadLimit) {
                truncated = true
                break
            }
        }
    } finally {
        // allow-silent: Cancelling the logging copy cannot affect the response that decoding reads
        reader.cancel().catch(() => undefined)
    }
    return { text: Buffer.concat(chunks).subarray(0, payloadReadLimit).toString("utf8"), truncated }
}

/** Resources one attempt holds until its release step */
interface AttemptState {
    readonly controller: AbortController
    settled: Promise<void>
    response: Response | undefined
    readonly guard: CacheRequest | undefined
    success: boolean
    readonly upload: ReturnType<typeof multipart> | ReturnType<AttachmentTransferSource["open"]> | undefined
    readonly putUpload: ReturnType<AttachmentTransferSource["open"]> | undefined
    readonly multipartHeaders: Record<string, string> | undefined
    readonly cleanupDefects: unknown[]
    /** Milliseconds from sending the request until its response headers or failure, set when that step ends */
    requestMs?: number | undefined
}

function requestUrl(context: Pick<AttemptContext<unknown>, "request" | "token">): string {
    const { request, token } = context
    return (
        request.put?.url ??
        `${request.instance!.apiPublic}/v1${request.webhookId ? `/webhooks/${request.webhookId}/${encodeURIComponent(Redacted.value(token))}` : ""}${request.path}`
    )
}

function requestHeaders(
    context: Pick<AttemptContext<unknown>, "request" | "token">,
    state: AttemptState,
): Record<string, string> {
    const { request, token } = context
    if (request.put)
        return {
            "Content-Length": String(request.put.size),
            ...(request.put.contentType ? { "Content-Type": request.put.contentType } : {}),
        }
    return {
        ...(request.webhookId ? {} : { Authorization: `Bot ${Redacted.value(token)}` }),
        ...(request.auditReason === undefined ? {} : { "X-Audit-Log-Reason": request.auditReason }),
        ...(request.features === undefined ? {} : { "X-Fluxer-Features": request.features.join(",") }),
        ...(state.multipartHeaders
            ? state.multipartHeaders
            : request.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
    }
}

/** Send one request, classify and decode its response and apply cache effects */
export function runAttempt<A, M extends MessageCore>(
    context: AttemptContext<A, M>,
): Effect.Effect<AttemptResult<A>, RestFailure | ClientClosedError> {
    const { runtime, request, route, progress, generation, fiber, retryCount } = context
    const rateAttempt = runtime.admission.rates.begin(route)
    const template =
        request.template ?? routeTemplate(request.put ? "/attachments/upload" : request.path, request.webhookId)
    const failure = (error: unknown, state?: { cleanupDefects: unknown[] }): RestFailure | ClientClosedError => {
        if (error instanceof AttachmentTransferCleanupError) throw error
        if (error instanceof AttachmentTransferVerificationCleanupError) {
            state?.cleanupDefects.push(error.cleanup)
            return new RestFailure({ reason: "network", outcome: progress.outcome })
        }
        if (error instanceof ResponseJsonCleanupError) {
            state?.cleanupDefects.push(error.cause)
            const rejected = error.status >= 400
            if (rejected && !request.preparation) progress.outcome = "rejected"
            return new RestFailure({
                reason: rejected ? "rejected" : "response",
                outcome: progress.outcome,
                status: error.status,
            })
        }
        return runtime.closed
            ? new ClientClosedError()
            : error instanceof RestFailure || error instanceof ClientClosedError
              ? error
              : new RestFailure({ reason: "network", outcome: progress.outcome })
    }
    const send = (state: AttemptState) =>
        Effect.suspend(() => {
            const startedAt = runtime.logical.now()
            return Effect.tryPromise({
                try: () => {
                    if (runtime.closed) throw new ClientClosedError()
                    if (!request.preparation) {
                        progress.outcome = "unknown"
                        if (request.invalidateMessages) runtime.cache?.gap()
                    }
                    if (request.body && !request.put && runtime.logging?.unsafePayloads("rest")) {
                        const route = template
                        runtime.logging.payload(
                            "rest",
                            "rest.payloadSent",
                            `${request.method} ${route} request body`,
                            parsedPayload(request.body.json),
                            { route },
                        )
                    }
                    const work = runtime
                        .http(requestUrl(context as Pick<AttemptContext<unknown>, "request" | "token">), {
                            method: request.method,
                            redirect: "error",
                            signal: state.controller.signal,
                            headers: requestHeaders(
                                context as Pick<AttemptContext<unknown>, "request" | "token">,
                                state,
                            ),
                            ...(state.upload
                                ? { body: state.upload.body }
                                : request.body
                                  ? { body: request.body.json }
                                  : {}),
                            ...(state.upload === undefined ? {} : { duplex: "half" }),
                        } as RequestInit)
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
                            throw new RestFailure({
                                reason: "network",
                                outcome: progress.outcome,
                                retryableRead: true,
                                cause: new TransportError(error),
                            })
                        })
                    // allow-silent: The work promise itself is returned and its rejection observed by the caller, so this only records settlement
                    state.settled = work.then(
                        () => undefined,
                        () => undefined,
                    )
                    return work
                },
                catch: (error) => failure(error, state),
            }).pipe(
                Effect.onExit(() =>
                    Effect.sync(() => {
                        const durationMs = Math.round(runtime.logical.now() - startedAt)
                        state.requestMs = durationMs
                        metrics.rest(template, state.response?.status ?? null, durationMs, fiber.context)
                        emitObservation(runtime.logging, {
                            type: "rest",
                            method: request.method,
                            route: template,
                            status: state.response?.status ?? null,
                            durationMs,
                            attempt: retryCount + 1,
                        })
                    }),
                ),
                Effect.withSpan("fluxerly.rest.request", {
                    attributes: {
                        "http.request.method": request.method,
                        "fluxerly.route": template,
                        "fluxerly.attempt": retryCount + 1,
                    },
                }),
            )
        })
    /** The guild or channel a request targets, for rejection records. IDs are safe to log, unlike other path segments */
    const targetText = (path: string) => {
        const target = /^\/(channels|guilds)\/(\d{1,20})(?:[/?]|$)/.exec(path)
        return target === null ? "" : ` for ${target[1] === "channels" ? "channel" : "community"} ${target[2]}`
    }
    /** Log one attempt after its response was classified. The duration covers the request until response headers */
    const logRequest = (state: AttemptState, exit: Exit.Exit<unknown, unknown>) =>
        Effect.sync(() => {
            const durationMs = state.requestMs ?? 0
            const status = state.response?.status ?? null
            const failed = Exit.isFailure(exit)
                ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
                : undefined
            const rejection = failed?._tag === "Fail" && failed.error instanceof RestFailure ? failed.error : undefined
            // The sanitized Fluxer code, recognized or not, so even Debug output names the rejection
            const apiError = rejection?.apiError?.providerCode ?? rejection?.providerCode ?? undefined
            // A rejected token or permission persists until someone changes the configuration, so it is
            // logged once per route and code even when the application handles the Result. Signed upload
            // destinations are external storage and never report Fluxer permissions. Inside a handler the record
            // waits in the invocation's rejection scope, so a handler failure that reports it is logged only once
            if (
                runtime.logging !== undefined &&
                rejection !== undefined &&
                (status === 401 || status === 403) &&
                request.put === undefined
            ) {
                const rejected: LogInput = {
                    level: "warn",
                    category: "rest",
                    code: "rest.rejected",
                    message: `${request.method} ${template} was rejected${targetText(request.path)}: ${
                        rejection.apiError?.explanation ??
                        (apiError === undefined
                            ? "Fluxer refused the request"
                            : `Fluxer returned ${apiError}, a code this SDK version does not describe yet`)
                    } (${rejection.apiError === null || apiError === undefined ? "" : `${apiError}, `}HTTP ${status})`,
                    route: template,
                    status,
                    fields: {
                        method: request.method,
                        apiError,
                        // Token-authenticated webhook routes send the webhook token, not the bot token
                        hint: apiErrorHint(
                            rejection.apiError,
                            status,
                            request.webhookId === undefined ? "bot" : "webhook",
                            routeAction(template),
                        ),
                    },
                }
                if (!fiberRejectionScope(fiber.context)?.hold(runtime.logging, rejected, fiber.context))
                    runtime.logging.log(rejected, fiber.context)
            }
            if (!runtime.logging?.enabled("debug", "rest")) return
            runtime.logging.log(
                {
                    level: "debug",
                    category: "rest",
                    code: "rest.request",
                    message: `${request.method} ${template} ${
                        status !== null
                            ? `returned ${status}`
                            : Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
                              ? "was cancelled"
                              : "failed before a response"
                    } in ${durationMs} ms`,
                    route: template,
                    ...(status === null ? {} : { status }),
                    durationMs,
                    attempt: retryCount + 1,
                    fields: { method: request.method, apiError },
                },
                fiber.context,
            )
        })
    const receive = (state: AttemptState, response: Response) => {
        const bucket = request.put
            ? route.key
            : runtime.admission.rates.observe(rateAttempt, response, runtime.logical.now())
        return Effect.tryPromise({
            try: () => {
                const work = (async (): Promise<AttemptResult<A>> => {
                    const classified = await classifyResponse(response, {
                        method: request.method,
                        upload: request.put !== undefined,
                        preparation: request.preparation === true,
                        hasFeatureFallback: request.featureDisabled !== undefined,
                        progress,
                        signal: state.controller.signal,
                        cleanupDefects: state.cleanupDefects,
                        now: () => runtime.logical.now(),
                        pauseGlobal: (until) => runtime.admission.pauseGlobal(until),
                        pauseBucket: (until) =>
                            runtime.admission.rates.pause(bucket, until, runtime.logical.now(), rateAttempt.sequence),
                        notFound: () => {
                            if (request.resourceGuard) runtime.resources!.missing(request.resourceGuard)
                            if (request.channelGuard) runtime.channels!.missing(request.channelGuard)
                        },
                    })
                    if (classified.kind === "retry") return { ...classified, bucket }
                    if (classified.kind === "featureDisabled")
                        return { kind: "success", value: request.featureDisabled!() }
                    if (request.status !== undefined && response.status !== request.status)
                        throw new RestFailure({
                            reason: "response",
                            outcome: progress.outcome,
                            status: response.status,
                        })
                    if (runtime.logging?.unsafePayloads("rest")) {
                        // Unsafe debugging reads a copy, so decoding keeps its own bounded stream
                        const route = template
                        void payloadText(response).then(
                            ({ text, truncated }) =>
                                runtime.logging?.payload(
                                    "rest",
                                    "rest.payloadReceived",
                                    `${request.method} ${route} response body${truncated ? `, first ${payloadReadLimit} bytes` : ""}`,
                                    truncated ? text : parsedPayload(text),
                                    { route, status: response.status, fields: { truncated } },
                                ),
                            // allow-silent: A failed read of the logging copy leaves decoding to report the body
                            () => undefined,
                        )
                    }
                    const value = await request.decode(response, request.instance!, state.controller.signal)
                    return { kind: "success", value }
                })()
                // allow-silent: The work promise itself is returned and its rejection observed by the caller, so this only records settlement
                state.settled = work.then(
                    () => undefined,
                    () => undefined,
                )
                return work
            },
            catch: (error) => failure(error, state),
        })
    }
    return Effect.acquireUseRelease(
        Effect.sync((): AttemptState => {
            // Opening a caller-owned source can throw before it is consumed. Do that
            // before registering client-owned controller or cache state, whose release
            // only runs after successful acquisition
            const putUpload = request.put ? request.put.source.open(request.put.offset, request.put.size) : undefined
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
            runtime.controllers.add(controller)
            const guard =
                request.cache === false ||
                request.preparation ||
                request.bucket === "reaction" ||
                (request.bucket === "pins" && request.method === "GET")
                    ? undefined
                    : runtime.cache?.begin(
                          request.channel,
                          request.target,
                          request.method === "PATCH" || request.method === "DELETE" || request.bucket === "pins",
                          generation,
                      )
            return {
                controller,
                settled: Promise.resolve(),
                response: undefined,
                guard,
                success: false,
                upload,
                putUpload,
                multipartHeaders,
                cleanupDefects: [],
            }
        }),
        (state) =>
            send(state).pipe(
                Effect.flatMap((response) => receive(state, response)),
                Effect.onExit((exit) => logRequest(state, exit)),
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
                        if (request.resourceGuard) runtime.resources!.complete(request.resourceGuard, result.value)
                        if (request.channelGuard) runtime.channels!.complete(request.channelGuard, result.value)
                        if (state.guard) {
                            if (request.method === "DELETE" || request.bucket === "pins")
                                runtime.cache!.delete({ id: request.target!, channelId: request.channel }, state.guard)
                            else request.observe?.(result.value, state.guard)
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
                                    if (!state.controller.signal.aborted || error !== state.controller.signal.reason)
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
                            runtime.controllers.delete(state.controller)
                            if (state.guard) {
                                if (!state.success && progress.outcome === "unknown" && state.guard.mutation)
                                    runtime.cache!.delete(
                                        { id: request.target!, channelId: request.channel },
                                        state.guard,
                                    )
                                runtime.cache!.end(state.guard)
                            }
                        }),
                    ),
                ),
            ),
    )
}
