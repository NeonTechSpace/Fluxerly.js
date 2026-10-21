import * as Cause from "effect/Cause"
import { FluxerlyError, type ConnectionError, type OperationOutcome } from "./errors.js"
import { retryableConnection } from "#sdk/internal/retryable-connection"
import { HelperError } from "./helpers.js"
import type { ApiErrorCode, ApiErrorDetail, ApiProviderCode } from "./api-errors.js"
import { errorInfo, errorText } from "#sdk/internal/logging"

/**
 * Settings for describeError
 *
 * @category Errors
 */
export interface DescribeErrorOptions {
    /** Include stack frames for each error in the cause chain. Defaults to true.
     * Consecutive frames inside the SDK and Effect collapse into one line, and expected SDK errors other than
     * ConfigurationError and SdkDefect print no frames, because their stacks only show SDK internals
     */
    readonly stack?: boolean
}

/**
 * Describe any error as readable multi-line text: Its name, SDK code, message, suggested fix, safe details and cause chain.
 * Works for SDK errors, application errors, thrown non-Error values and Effect Causes, and never throws.
 * A Cause is described reason by reason, as Failure, Defect or Interrupted, so pass exit.cause directly rather than
 * squashing it first.
 * Credential patterns, such as Authorization values, bare bot tokens, values assigned to keys ending in token or secret,
 * token-shaped Bot or Bearer values, webhook URL tokens and the user information of a URL, such as user:password in
 * https://user:password@host/path, are masked in names, application error codes, messages and stacks.
 * A client's own configured token is masked only in that client's log records and failure reports.
 * Use it to print a failed Result, an SdkDefect or a FailureReport's error
 *
 * @example
 * ```ts
 * import { createClient, describeError, orThrow } from "@neontechspace/fluxerly"
 *
 * try {
 *     await using client = createClient({ token: process.env.FLUXER_BOT_TOKEN })
 *     orThrow(await client.run())
 * } catch (error) {
 *     // Configuration errors, connection failures and SDK defects all print with their cause chain
 *     console.error(describeError(error))
 * }
 * ```
 *
 * @category Errors
 */
export function describeError(error: unknown, options?: DescribeErrorOptions): string {
    const stack = options?.stack !== false
    const cause = causeOf(error)
    if (!cause) return describeOne(error, "", stack)
    // Each reason of an Effect Cause is described in order, so a cleanup defect is not lost behind the first failure
    const reasons = cause.reasons.map((reason) =>
        reason._tag === "Interrupt"
            ? "Interrupted"
            : reason._tag === "Fail"
              ? `Failure:\n${describeOne(reason.error, "  ", stack)}`
              : `Defect:\n${describeOne(reason.defect, "  ", stack)}`,
    )
    return reasons.length ? reasons.join("\n") : "Empty Cause with no failure, defect or interruption"
}

/** Describe one failure or defect value with masked text, indented for a Cause reason */
function describeOne(error: unknown, indent: string, stack: boolean): string {
    return errorText(errorInfo(error, sdkErrorOf(error) ? "sdk" : "application"), indent, stack)
}

const retryableReasons = new Set(["busy", "network", "timeout", "rateLimit"])

/** The Effect Cause a value is, or undefined for any other value, including a proxy that rejects inspection */
function causeOf(value: unknown): Cause.Cause<unknown> | undefined {
    try {
        return Cause.isCause(value) ? (value as Cause.Cause<unknown>) : undefined
    } catch {
        // allow-silent: a proxy that rejects inspection is read as a plain value
        return undefined
    }
}

/** The value as an SDK error, or undefined for any other value, including a proxy that rejects prototype inspection */
function sdkErrorOf(value: unknown): FluxerlyError | undefined {
    try {
        return value instanceof FluxerlyError ? value : undefined
    } catch {
        // allow-silent: a proxy that rejects prototype inspection is read as an application value
        return undefined
    }
}

/** Whether one failure value is an SDK error whose call is safe to repeat */
function isRetryableError(error: unknown): boolean {
    if (!(error instanceof FluxerlyError)) return false
    switch (error._tag) {
        case "RateLimitError":
        case "ConnectionTimeoutError":
            return true
        case "ConnectionError":
            return retryableConnection(error as ConnectionError)
        case "ShardConnectionError":
            return isRetryableError(error.cause)
    }
    const fields = error as unknown as { reason?: unknown; outcome?: unknown }
    if (typeof fields.reason !== "string" || !retryableReasons.has(fields.reason)) return false
    const outcome = fields.outcome
    // A read cannot have changed remote state, so an unknown outcome only matters for writes
    return outcome !== "unknown" || fields.reason === "rateLimit" || error.details.read === true
}

/** Whether repeating the same call is safe and may succeed. True for rate limits, full local capacity, and network
 * failures and timeouts of reads or of writes that were not sent. False for rejections, invalid input, writes with an
 * unknown outcome, cancellation and closed clients. An Effect Cause is retryable when it has a reason and every reason
 * is a retryable failure, so a defect or an interruption in it makes it false
 */
function isRetryable(error: unknown): boolean {
    const cause = causeOf(error)
    if (cause === undefined) return isRetryableError(error)
    const reasons = cause.reasons
    return reasons.length > 0 && reasons.every((reason) => reason._tag === "Fail" && isRetryableError(reason.error))
}

/** The server-required wait of one failure value in milliseconds, or undefined when it carries none */
function ownRetryAfterMs(error: unknown): number | undefined {
    const sdk = sdkErrorOf(error)
    if (sdk === undefined) return undefined
    try {
        // A shard failure carries the wait of the failure that stopped it
        if (sdk._tag === "ShardConnectionError") return ownRetryAfterMs(sdk.cause)
        const wait = (sdk as { readonly retryAfterMs?: unknown }).retryAfterMs
        return typeof wait === "number" && Number.isFinite(wait) && wait >= 0 ? wait : undefined
    } catch {
        // allow-silent: a proxy of an SDK error whose properties reject reads carries no usable wait
        return undefined
    }
}

/** The wait of an error, or the largest wait among the failures of an Effect Cause */
function retryAfterMs(error: unknown): number | undefined {
    const cause = causeOf(error)
    if (cause === undefined) return ownRetryAfterMs(error)
    let longest: number | undefined
    for (const reason of cause.reasons) {
        const wait = reason._tag === "Fail" ? ownRetryAfterMs(reason.error) : undefined
        if (wait !== undefined && (longest === undefined || wait > longest)) longest = wait
    }
    return longest
}

const outcomeRank = { notDispatched: 0, rejected: 1, unknown: 2 } as const

/** The SDK error's own outcome, or undefined for any other value or an error without one */
function ownOutcome(error: unknown): OperationOutcome | undefined {
    if (!(error instanceof FluxerlyError)) return undefined
    const outcome = (error as { readonly outcome?: unknown }).outcome
    return outcome === "notDispatched" || outcome === "rejected" || outcome === "unknown" ? outcome : undefined
}

/** The outcome of an error, or the least certain outcome across every failure of an Effect Cause */
function outcome(error: unknown): OperationOutcome | undefined {
    const cause = causeOf(error)
    if (cause === undefined) return ownOutcome(error)
    let result: OperationOutcome | undefined
    for (const reason of cause.reasons) {
        // A defect or interruption can hide any progress, and a failure without an outcome says nothing about progress
        const own = reason._tag === "Fail" ? ownOutcome(reason.error) : undefined
        if (own === undefined) return undefined
        if (result === undefined || outcomeRank[own] > outcomeRank[result]) result = own
    }
    return result
}

/**
 * Resources that Fluxer reports as missing, accepted by errors.isNotFound.
 * A thread is a channel
 *
 * @category Errors
 */
export type NotFoundResource =
    | "application"
    | "channel"
    | "emoji"
    | "forumTag"
    | "guild"
    | "invite"
    | "member"
    | "message"
    | "role"
    | "sticker"
    | "threadMember"
    | "user"
    | "webhook"

const notFoundCodes: Readonly<Record<NotFoundResource, ApiProviderCode>> = {
    application: "UNKNOWN_APPLICATION",
    channel: "UNKNOWN_CHANNEL",
    emoji: "UNKNOWN_EMOJI",
    forumTag: "UNKNOWN_FORUM_TAG",
    guild: "UNKNOWN_GUILD",
    invite: "UNKNOWN_INVITE",
    member: "UNKNOWN_MEMBER",
    message: "UNKNOWN_MESSAGE",
    role: "UNKNOWN_ROLE",
    sticker: "UNKNOWN_STICKER",
    threadMember: "UNKNOWN_THREAD_MEMBER",
    user: "UNKNOWN_USER",
    webhook: "UNKNOWN_WEBHOOK",
}

/** Whether the value is an SDK error for an HTTP 404, optionally for the named missing resource */
function isNotFound(error: unknown, resource?: NotFoundResource): boolean {
    if (resource !== undefined && (typeof resource !== "string" || !Object.hasOwn(notFoundCodes, resource)))
        throw new HelperError("errors.isNotFound", "resource")
    if (!(error instanceof FluxerlyError) || (error as { readonly status?: unknown }).status !== 404) return false
    if (resource === undefined) return true
    return (error as { readonly apiError?: ApiErrorDetail | null }).apiError?.providerCode === notFoundCodes[resource]
}

/** Recognized Fluxer rejection category of an SDK operation error, or undefined for any other value */
function apiCode(error: unknown): ApiErrorCode | undefined {
    if (!(error instanceof FluxerlyError)) return undefined
    const detail = (error as { readonly apiError?: ApiErrorDetail | null }).apiError
    return detail?.code
}

/**
 * Handlers for errors.match, keyed by each possible error's _tag, plus an optional _ fallback
 *
 * @category Errors
 */
export type ErrorMatchHandlers<E, R> = {
    readonly [
        K in E extends {
            /** Discriminator of a tagged error */
            readonly _tag: string
        }
            ? E["_tag"]
            : never
    ]?: (
        error: Extract<
            E,
            {
                /** Discriminator selecting this handler */
                readonly _tag: K
            }
        >,
    ) => R
} & {
    /** Called for any value without a matching handler, including non-SDK values */
    readonly _?: (error: unknown) => R
}

/** Call the handler named by the error's _tag, or the _ fallback. Returns undefined when neither applies */
function match<E, R>(error: E, handlers: ErrorMatchHandlers<E, R>): R | undefined {
    const tag =
        typeof error === "object" && error !== null && typeof (error as { _tag?: unknown })._tag === "string"
            ? (error as unknown as { readonly _tag: string })._tag
            : undefined
    const handler =
        tag !== undefined && tag !== "_" && Object.hasOwn(handlers, tag)
            ? (handlers as Record<string, ((error: unknown) => R) | undefined>)[tag]
            : undefined
    if (handler) return handler(error)
    return handlers._ ? handlers._(error) : undefined
}

/**
 * Helpers for inspecting SDK errors in either entry point
 *
 * @category Errors
 */
export interface ErrorTools {
    /** The recognized Fluxer rejection category of an operation error, such as `"missingPermissions"`, read from its
     * apiError. Returns undefined for any other value, including cancellation, closed clients, invalid input and
     * rejections Fluxer did not describe with a recognized code, so one condition works on every error of an operation's Result
     */
    readonly apiCode: (error: unknown) => ApiErrorCode | undefined
    /** Whether the value is an SDK error for an HTTP 404, such as a deleted channel or a member who left.
     * Fluxer answers UNKNOWN_CHANNEL for a missing channel and also for message and reaction requests in a thread from a bot
     * that is no longer in the community. Other requests from such a bot get a 403 missingPermissions, so a 404 does not tell
     * why a resource is missing.
     * The check reads the error's HTTP status, so it also holds for a 404 that an operation reports with reason
     * rejected, such as messages.send to a missing channel.
     * Pass a resource, such as `"member"`, to also require that Fluxer named that resource as the missing one, which
     * separates a missing member from a missing guild. A thread counts as a `"channel"`.
     * A 404 without a recognized Fluxer code is true without a resource and false with one.
     * Returns false for any other value, so one condition works on every error of an operation's Result.
     * Throws HelperError with operation errors.isNotFound and reason resource for a resource that is not a NotFoundResource,
     * which is a defect in the native API. A 404 does not prove that an earlier deletion succeeded
     */
    readonly isNotFound: (error: unknown, resource?: NotFoundResource) => boolean
    /** Whether repeating the same call is safe and may succeed, such as after a rate limit, full local capacity,
     * or a network failure or timeout of a read or of a write that was not sent.
     * A write whose outcome is unknown is not retryable, because Fluxer may already have applied it.
     * Rejections, invalid input, cancellation and closed clients are never retryable, because a closed client
     * cannot send again and a new client is needed.
     * An Effect Cause, such as that of a failed Exit, is retryable only when it has at least one reason and every reason
     * is a retryable failure. A defect, an interruption or an empty Cause gives false, because the work may have stopped
     * part-way.
     * Concurrent forEach and all can drop the reasons of siblings they interrupt, as described for outcome, so for several
     * concurrent writes check each item's own result rather than the combined Cause
     */
    readonly isRetryable: (error: unknown) => boolean
    /** How many milliseconds to wait before repeating the call, as Fluxer or the SDK's own rate limiting requires.
     * It reads the error's retryAfterMs, which every operation error and RateLimitError carries when the wait is known.
     * For a ShardConnectionError it is the wait of the failure that stopped the shard.
     * For an Effect Cause it is the longest wait among its failures, which covers all of them, and defects and
     * interruptions in the Cause are ignored.
     * Returns undefined when there is no usable wait, including for a value that is not an SDK error, so the caller can
     * use its own backoff. It never throws. It does not say whether repeating the call is safe, so check isRetryable too
     */
    readonly retryAfterMs: (error: unknown) => number | undefined
    /** Call the handler named by the error's _tag, or the _ fallback, and return its result.
     * Returns undefined when no handler applies
     */
    readonly match: <E, R>(error: E, handlers: ErrorMatchHandlers<E, R>) => R | undefined
    /** Whether the failed request may have reached Fluxer: `"notDispatched"` when it was not sent, `"rejected"` when
     * Fluxer refused it and `"unknown"` when the result is uncertain, such as a write whose response was lost.
     * An unknown write may already have applied, so check remote state before repeating it.
     * Only `"notDispatched"` shows that a write was not sent. Treat every other value, including undefined, as a write that
     * may have applied, and reconcile before sending it again.
     * Reads the outcome of an SDK error, including a closed client's, and for an Effect Cause the least certain
     * outcome of its failures, where unknown outranks rejected and rejected outranks notDispatched.
     * A Cause covers only the failures it kept. Effect's concurrent forEach and all drop the reasons of siblings that they
     * interrupt, so for several concurrent writes check each item's own result, such as with `{ mode: "result" }` or
     * Effect.result, instead of the combined Cause.
     * Returns undefined when the SDK cannot establish an outcome, so the caller applies its own policy. That holds
     * for errors without an outcome, such as CancelledError, SdkDefect, collector and gateway failures and non-SDK
     * values, and for a Cause that is empty or holds a defect, an interruption or a failure without an outcome.
     * For a multi-step operation the outcome covers the failed step, not the steps before it. The preparation steps of a
     * message send, namely opening a direct message and uploading attachments, count as not sent for the message, so a
     * closure during them reports `"notDispatched"` for the message request even if the earlier step took effect.
     * Wrapping an SDK call in Effect.timeout yields only a TimeoutError, which has no outcome, so pass the operation's
     * timeoutMs option instead to keep it. A default-API CancelledError carries no outcome either
     */
    readonly outcome: (error: unknown) => OperationOutcome | undefined
}

/**
 * Error helpers that classify and match errors through apiCode, isNotFound, isRetryable, retryAfterMs, outcome and match.
 * To print an error, use describeError
 *
 * @example
 * ```ts
 * import { describeError, errors, type Client } from "@neontechspace/fluxerly"
 *
 * export async function sendWithOneRetry(client: Client, channelId: string) {
 *     let sent = await client.messages.send(channelId, { content: "Hello" })
 *     if (sent.isErr() && errors.isRetryable(sent.error)) sent = await client.messages.send(channelId, { content: "Hello" })
 *     if (sent.isErr() && errors.isNotFound(sent.error, "channel")) return console.warn("The channel was not found")
 *     if (sent.isErr() && errors.apiCode(sent.error) === "missingPermissions") return console.warn("The bot cannot post here")
 *     if (sent.isErr() && errors.outcome(sent.error) === "rejected")
 *         return console.warn("Fluxer refused the message", describeError(sent.error))
 *     if (sent.isErr() && errors.outcome(sent.error) !== "notDispatched")
 *         return console.warn("The message may have been sent, so check the channel before sending it again")
 *     // Only a request that was not dispatched is safe to send again
 *     if (sent.isErr())
 *         errors.match(sent.error, {
 *             MessageError: (error) => console.warn("The message was not sent", error.reason),
 *             _: (error) => console.error(describeError(error)),
 *         })
 * }
 * ```
 *
 * @category Errors
 */
export const errors: ErrorTools = Object.freeze({ apiCode, isNotFound, isRetryable, match, outcome, retryAfterMs })
