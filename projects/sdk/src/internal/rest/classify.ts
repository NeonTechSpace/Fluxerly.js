/**
 * REST failure classification: The internal RestFailure, response rejection and rate-limit classification, bounded
 * provider error-body reads and the conversion into public operation errors.
 * Invariant: Mutations retry only after a confirmed rate-limit rejection, a rejected response marks the outcome rejected
 * only for real operation requests, and provider error bodies keep only sanitized codes, messages and field paths.
 * Implements [SDK contracts: Results and failures](/docs/SDK-CONTRACTS.md#results-and-failures)
 */
import { ClientClosedError, ConnectionError, RateLimitError, type OperationErrorOptions } from "#sdk/errors"
import type { MessageOperationError } from "#sdk/message-errors"
import { apiErrorDetail, unrecognizedProviderCode, type ApiErrorDetail } from "#sdk/api-errors"
import {
    inputValidationFailure,
    type InputValidationConstraint,
    type InputValidationDetail,
} from "#sdk/input-validation"
import { record } from "../decode/primitives.js"
import { TransportError } from "../effect-failures.js"
import { linkRejectionError } from "../rejection-scope.js"

/** Whether an operation's request may have reached Fluxer */
export type Outcome = MessageOperationError["outcome"]

/** Fields of one internal REST failure. Omitted values are null or false */
export interface RestFailureOptions {
    readonly reason: MessageOperationError["reason"]
    readonly outcome: Outcome
    readonly status?: number | null
    readonly retryAfterMs?: number | null
    /** Whether a GET may be repeated after this failure under the bounded read-retry policy */
    readonly retryableRead?: boolean
    readonly apiError?: ApiErrorDetail | null
    readonly inputValidation?: InputValidationDetail | null
    /** Unrecognized Fluxer error code with a safe shape, when apiError is null */
    readonly providerCode?: string | null
    /** For reason response, the response field path or named check that failed */
    readonly responseField?: string | null
    /** Underlying transport failure, kept as the public error's cause */
    readonly cause?: unknown
}

/** One REST operation failure before it becomes a domain-specific public error */
export class RestFailure extends Error {
    readonly reason: MessageOperationError["reason"]
    readonly outcome: Outcome
    readonly status: number | null
    readonly retryAfterMs: number | null
    readonly retryableRead: boolean
    readonly apiError: ApiErrorDetail | null
    readonly inputValidation: InputValidationDetail | null
    readonly providerCode: string | null
    readonly responseField: string | null
    override readonly cause?: unknown
    /** Whether the failed request was a GET, set once where the request method is known */
    read = false

    constructor(options: RestFailureOptions) {
        super("REST operation failed")
        this.reason = options.reason
        this.outcome = options.outcome
        this.status = options.status ?? null
        this.retryAfterMs = options.retryAfterMs ?? null
        this.retryableRead = options.retryableRead ?? false
        this.apiError = options.apiError ?? null
        this.inputValidation = options.inputValidation ?? null
        this.providerCode = options.providerCode ?? null
        this.responseField = options.responseField ?? null
        this.cause = options.cause
    }

    /** The same failure recorded under the operation's current outcome */
    withOutcome(outcome: Outcome): RestFailure {
        return linkRejectionError(
            new RestFailure({
                reason: this.reason,
                outcome,
                status: this.status,
                retryAfterMs: this.retryAfterMs,
                retryableRead: this.retryableRead,
                apiError: this.apiError,
                inputValidation: this.inputValidation,
                providerCode: this.providerCode,
                responseField: this.responseField,
                cause: this.cause,
            }),
            this,
        )
    }
}

/** A local validation failure before any request was sent */
export function inputFailure(detail: InputValidationDetail): RestFailure {
    return new RestFailure({ reason: "input", outcome: "notDispatched", inputValidation: detail })
}

export function localInputFailure(
    path: string,
    constraint: InputValidationConstraint,
    explanation: string,
): RestFailure {
    return inputFailure(inputValidationFailure(path, constraint, explanation).detail)
}

// Keep the named REST metadata at one constructor boundary, while domain tags and operation types stay distinct
export function operationFailure<Operation extends string, Failure>(
    error: RestFailure | ClientClosedError,
    ErrorType: new (options: OperationErrorOptions<Operation>) => Failure,
    operation: NoInfer<Operation>,
): Failure | ClientClosedError {
    if (!(error instanceof RestFailure)) return error
    return linkRejectionError(
        new ErrorType({
            operation,
            reason: error.reason,
            outcome: error.outcome,
            status: error.status,
            retryAfterMs: error.retryAfterMs,
            apiError: error.apiError,
            inputValidation: error.inputValidation,
            providerCode: error.providerCode,
            responseField: error.responseField,
            ...(error.read ? { read: true } : {}),
            ...(error.cause === undefined ? {} : { cause: error.cause }),
        }),
        error,
    )
}

/** Translate an instance-discovery failure into the operation's not-dispatched failure */
export function instanceFailure(error: unknown): RestFailure | ClientClosedError {
    if (error instanceof ClientClosedError) return error
    if (error instanceof RestFailure) return error
    if (error instanceof RateLimitError)
        return new RestFailure({ reason: "rateLimit", outcome: "notDispatched", retryAfterMs: error.retryAfterMs })
    if (error instanceof ConnectionError)
        return new RestFailure({
            reason: "network",
            outcome: "notDispatched",
            status: error.status,
            cause: new TransportError(error),
        })
    return new RestFailure({ reason: "network", outcome: "notDispatched", cause: new TransportError(error) })
}

function retryAfter(response: Response, now: number): number | null {
    const value = response.headers.get("retry-after")?.trim()
    if (!value) return null
    const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
    return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : null
}

function globalRateLimit(response: Response): boolean {
    // A positive scope assertion wins over conflicting local metadata. Do not
    // interpret malformed or combined header values as a global rejection
    return (
        response.headers.get("x-ratelimit-global")?.trim().toLowerCase() === "true" ||
        response.headers.get("x-ratelimit-scope")?.trim().toLowerCase() === "global"
    )
}

/** Largest provider error body read for its reviewed detail */
const errorBodyMaxBytes = 8_192
/** Time allowed for reading an error body before it is cancelled */
const errorBodyReadTimeoutMs = 100

type ApiErrorRead = {
    readonly detail: ApiErrorDetail | null
    /** Unrecognized Fluxer error code with a safe shape */
    readonly providerCode: string | null
    readonly retryAfterMs: number | null
    readonly global: boolean
    readonly cleanupDefect: unknown
}

class ApiErrorBodyCleanupError extends Error {
    constructor(cause?: unknown) {
        super("Failed to release an API error response body", cause === undefined ? undefined : { cause })
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
        return { detail: null, providerCode: null, retryAfterMs: null, global: false, cleanupDefect: null }
    const declared = response.headers.get("content-length")
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > errorBodyMaxBytes))
        return { detail: null, providerCode: null, retryAfterMs: null, global: false, cleanupDefect: null }
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
    let providerCode: string | null = null
    let retryAfterMs: number | null = null
    let global = false
    let cleanupDefect: unknown = null
    const recordCleanupDefect = (cause: unknown) => {
        const defect = new ApiErrorBodyCleanupError(cause)
        cleanupDefect =
            cleanupDefect === null
                ? defect
                : new AggregateError([cleanupDefect, defect], "API error response cleanup failed")
    }
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
            providerCode = source === "fluxer" ? unrecognizedProviderCode(data) : null
            if (record(data)) {
                if (typeof data.retry_after === "number" && data.retry_after >= 0) {
                    const milliseconds = data.retry_after * 1000
                    if (Number.isFinite(milliseconds)) retryAfterMs = milliseconds
                }
                global = data.global === true
            }
        }
    } catch {
        // allow-silent: An unreadable error body only removes the optional reviewed detail from the returned failure
        result = null
        providerCode = null
    } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (cancel !== undefined) signal.removeEventListener("abort", cancel)
        try {
            reader.releaseLock()
        } catch (error) {
            recordCleanupDefect(error)
        }
    }
    if (cancelBody) {
        try {
            await body.cancel()
        } catch (error) {
            recordCleanupDefect(error)
        }
    }
    return { detail: result, providerCode, retryAfterMs, global, cleanupDefect }
}

/** What classification needs from the attempt that received the response */
export interface ClassifyContext {
    readonly method: string
    /** A signed upload PUT, whose destination is external storage rather than the Fluxer API */
    readonly upload: boolean
    /** A preparation step, such as upload planning, that cannot change the operation's outcome */
    readonly preparation: boolean
    /** The request accepts Fluxer's temporarily-disabled-feature rejection as a successful fallback */
    readonly hasFeatureFallback: boolean
    /** The operation's shared outcome, updated when Fluxer confirms a rejection */
    readonly progress: { outcome: Outcome }
    readonly signal: AbortSignal
    /** Cleanup failures collected for the attempt's release step */
    readonly cleanupDefects: unknown[]
    readonly now: () => number
    /** Pause every route until the given logical time */
    readonly pauseGlobal: (until: number) => void
    /** Pause the learned bucket until the given logical time */
    readonly pauseBucket: (until: number) => void
    /** Tell guarded caches that a GET found no resource */
    readonly notFound: () => void
}

/** A response the attempt continues with, or a rate-limit wait before the same request is sent again */
export type ResponseClass =
    | { readonly kind: "accepted" }
    | { readonly kind: "featureDisabled" }
    | {
          readonly kind: "retry"
          readonly retry: number
          readonly global: boolean
          readonly apiError: ApiErrorDetail | null
          readonly providerCode: string | undefined
      }

function collect(context: ClassifyContext, read: ApiErrorRead) {
    if (read.cleanupDefect !== null && !context.cleanupDefects.includes(read.cleanupDefect))
        context.cleanupDefects.push(read.cleanupDefect)
}

/** Classify a received response. Rejections throw a RestFailure with the outcome Fluxer established */
export async function classifyResponse(response: Response, context: ClassifyContext): Promise<ResponseClass> {
    const { progress } = context
    if (response.status === 429) {
        if (context.upload) {
            const apiRead = await readApiError(response, context.signal, "upload", false)
            collect(context, apiRead)
            throw new RestFailure({
                reason: "rateLimit",
                outcome: progress.outcome,
                status: 429,
                retryAfterMs: apiRead.retryAfterMs,
                apiError: apiRead.detail,
            })
        }
        const header = response.headers.get("retry-after")
        let delay = header === null ? NaN : Number(header) * 1000
        if (header !== null && !Number.isFinite(delay)) delay = Date.parse(header) - Date.now()
        const headerGlobal = globalRateLimit(response)
        // Protect other routes before bounded body inspection, including
        // when the request is interrupted while waiting for that body
        if (headerGlobal && Number.isFinite(delay) && delay > 0) context.pauseGlobal(context.now() + Math.ceil(delay))
        const apiRead = await readApiError(response, context.signal, "fluxer", false)
        collect(context, apiRead)
        if (apiRead.retryAfterMs !== null) delay = apiRead.retryAfterMs
        // Mutation resends require a received rate-limit rejection
        if (!context.preparation) progress.outcome = "rejected"
        if (!Number.isFinite(delay) || delay <= 0)
            throw new RestFailure({
                reason: "rateLimit",
                outcome: progress.outcome,
                status: 429,
                apiError: apiRead.detail,
                providerCode: apiRead.providerCode,
            })
        const retry = Math.ceil(delay)
        const global = headerGlobal || apiRead.global
        const until = context.now() + retry
        if (global) context.pauseGlobal(until)
        else context.pauseBucket(until)
        return {
            kind: "retry",
            retry,
            global,
            apiError: apiRead.detail,
            providerCode: apiRead.providerCode ?? undefined,
        }
    }
    if (response.ok) return { kind: "accepted" }
    let apiRead: ApiErrorRead | undefined
    if (response.status === 403 && context.hasFeatureFallback) {
        apiRead = await readApiError(response, context.signal)
        collect(context, apiRead)
        if (apiRead.detail?.providerCode === "FEATURE_TEMPORARILY_DISABLED") return { kind: "featureDisabled" }
    }
    if (response.status === 404 && context.method === "GET") context.notFound()
    const rejected = response.status >= 400 && response.status < 500
    if (rejected && !context.preparation) progress.outcome = "rejected"
    const retryableRead = context.method === "GET" && [500, 502, 503, 504].includes(response.status)
    apiRead ??= await readApiError(response, context.signal, context.upload ? "upload" : "fluxer")
    collect(context, apiRead)
    const headerRetryAfterMs = retryAfter(response, Date.now())
    const retryAfterMs =
        headerRetryAfterMs === null
            ? apiRead.retryAfterMs
            : apiRead.retryAfterMs === null
              ? headerRetryAfterMs
              : Math.max(headerRetryAfterMs, apiRead.retryAfterMs)
    throw new RestFailure({
        reason: response.status === 404 && !context.preparation ? "notFound" : "rejected",
        outcome: progress.outcome,
        status: response.status,
        retryAfterMs,
        retryableRead,
        apiError: apiRead.detail,
        providerCode: apiRead.providerCode,
    })
}
