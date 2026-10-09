import * as Cause from "effect/Cause"
import { FluxerlyError } from "./errors.js"
import type { ApiErrorCode, ApiErrorDetail } from "./api-errors.js"
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
    /** Whether repeating the same call is safe and may succeed, such as after a rate limit, full local capacity,
     * or a network failure or timeout of a read or of a write that was not sent.
     * A write whose outcome is unknown is not retryable, because Fluxer may already have applied it
     */
    readonly isRetryable: (error: unknown) => boolean
    /** Call the handler named by the error's _tag, or the _ fallback, and return its result.
     * Returns undefined when no handler applies
     */
    readonly match: <E, R>(error: E, handlers: ErrorMatchHandlers<E, R>) => R | undefined
}

/**
 * Error helpers that classify and match errors through apiCode, isRetryable and match. To print an error, use describeError
 *
 * @example
 * ```ts
 * import { describeError, errors, type Client } from "@neontechspace/fluxerly"
 *
 * export async function sendWithOneRetry(client: Client, channelId: string) {
 *     let sent = await client.messages.send(channelId, { content: "Hello" })
 *     if (sent.isErr() && errors.isRetryable(sent.error)) sent = await client.messages.send(channelId, { content: "Hello" })
 *     if (sent.isErr() && errors.apiCode(sent.error) === "missingPermissions") return console.warn("The bot cannot post here")
 *     if (sent.isErr())
 *         errors.match(sent.error, {
 *             MessageError: (error) => console.warn("Send failed", error.reason),
 *             _: (error) => console.error(describeError(error)),
 *         })
 * }
 * ```
 *
 * @category Errors
 */
export const errors: ErrorTools = Object.freeze({ apiCode, isRetryable, match })
