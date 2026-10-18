import * as Cause from "effect/Cause"
import { FluxerlyError, type OperationOutcome } from "./errors.js"
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
    let cause = false
    try {
        cause = Cause.isCause(error)
    } catch {
        // allow-silent: a proxy that rejects inspection is described as a plain value below
    }
    if (!cause) return describeOne(error, "", stack)
    // Each reason of an Effect Cause is described in order, so a cleanup defect is not lost behind the first failure
    const reasons = (error as Cause.Cause<unknown>).reasons.map((reason) =>
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
    let sdk = false
    try {
        sdk = error instanceof FluxerlyError
    } catch {
        // allow-silent: a proxy that rejects prototype inspection is described as an application value below
    }
    return errorText(errorInfo(error, sdk ? "sdk" : "application"), indent, stack)
}

const retryableReasons = new Set(["busy", "network", "timeout", "rateLimit"])

/** Whether repeating the same call is safe and may succeed. True for rate limits, full local capacity, and network
 * failures and timeouts of reads or of writes that were not sent. False for rejections, invalid input, writes with an
 * unknown outcome, cancellation and closed clients
 */
function isRetryable(error: unknown): boolean {
    if (!(error instanceof FluxerlyError)) return false
    switch (error._tag) {
        case "RateLimitError":
        case "ConnectionTimeoutError":
            return true
        case "ConnectionError":
            return (error as unknown as { reason: string }).reason === "network"
        case "ShardConnectionError":
            return isRetryable(error.cause)
    }
    const fields = error as unknown as { reason?: unknown; outcome?: unknown }
    if (typeof fields.reason !== "string" || !retryableReasons.has(fields.reason)) return false
    const outcome = fields.outcome
    // A read cannot have changed remote state, so an unknown outcome only matters for writes
    return outcome !== "unknown" || fields.reason === "rateLimit" || error.details.read === true
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
    let cause = false
    try {
        cause = Cause.isCause(error)
    } catch {
        // allow-silent: a proxy that rejects inspection is read as a plain value below
    }
    if (!cause) return ownOutcome(error)
    let result: OperationOutcome | undefined
    for (const reason of (error as Cause.Cause<unknown>).reasons) {
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
     * cannot send again and a new client is needed
     */
    readonly isRetryable: (error: unknown) => boolean
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
 * Error helpers that classify and match errors through apiCode, isNotFound, isRetryable, outcome and match.
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
export const errors: ErrorTools = Object.freeze({ apiCode, isNotFound, isRetryable, match, outcome })
