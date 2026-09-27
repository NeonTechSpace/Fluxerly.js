/**
 * Default execution: Runs shared Effect operations for the default API and converts their exits to neverthrow results.
 * Invariant: Expected failures become Err values, cancellation becomes CancelledError after cleanup, and defects,
 * including cleanup defects combined with another failure, throw or reject as SdkDefect naming the public operation.
 * Reading the caller options and calling the caller signal listener methods are application code, so their throws are
 * application faults.
 * Implements [SDK contracts: Results and failures](/docs/SDK-CONTRACTS.md#results-and-failures)
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { err, ok, ResultAsync, type Result } from "neverthrow"
import { operationSignalError } from "#sdk/internal/operation-signal"
import { currentRejectionScope, withRejectionScope } from "#sdk/internal/rejection-scope"
import { causeReasons, defectReason, inputDefect, readCaller, thrownReason } from "#sdk/internal/defects"
import {
    CancelledError,
    SdkDefect,
    type ClientClosedError,
    type ConfigurationError,
    type ConnectError,
    type Operation,
} from "#sdk/errors"
import type { MemberChunkError } from "#sdk/member-chunks"
import type { CountOperationError } from "#sdk/counts"
import type { BotApplicationOperationError } from "#sdk/application"
import type { PresenceError } from "#sdk/presence"
import type { UserOperationError } from "#sdk/users"
import type { WebhookOperationError } from "#sdk/webhooks"
import type { PaginationError, PaginationOperation } from "#sdk/pagination"
import type { MessageCore, MessageOperationOptions } from "#sdk/messages"
import type { ClientOwner } from "#sdk/internal/client"
import type { Pagination } from "#sdk/internal/pagination"
import type { AttachmentDownloadFailure, AttachmentRefreshFailure } from "#sdk/attachments"
import type { CriticalWorkerStoppedError } from "#sdk/bot-runner"
import type { OAuthOperationFailure } from "#sdk/oauth"
import type { OperationOptions } from "#sdk/client"
import type { InstanceResolveError } from "#sdk/instance"
import type { ChannelOperationError } from "#sdk/channels"
import type { GuildOperationError } from "#sdk/guilds"
import type { CollectorError } from "#sdk/collectors"
import type { EventReadError, EventWaitFailure, MessageError, MessageOperationError } from "#sdk/message-errors"
import type { MessageCleanupError } from "#sdk/message-cleanup"
import type { RestRequestFailure } from "#sdk/rest"

/** Every expected failure a default operation can return */
export type OperationFailure =
    | ConfigurationError
    | CancelledError
    | ConnectError
    | CriticalWorkerStoppedError
    | InstanceResolveError
    | EventReadError
    | EventWaitFailure
    | MessageError
    | MessageOperationError
    | MessageCleanupError
    | CollectorError
    | GuildOperationError
    | ChannelOperationError
    | WebhookOperationError
    | UserOperationError
    | BotApplicationOperationError
    | CountOperationError
    | MemberChunkError
    | PresenceError
    | PaginationError
    | AttachmentDownloadFailure
    | AttachmentRefreshFailure
    | OAuthOperationFailure
    | RestRequestFailure

/** Start one operation now and settle its ResultAsync after the Effect and required cleanup finish */
export const executeOperation = <A, E extends OperationFailure>(
    effect: Effect.Effect<A, E>,
    operation: Operation,
    options?: OperationOptions,
) => {
    let signal: OperationOptions["signal"]
    let abort: (() => void) | undefined
    let registered = false
    let invalidSignal: ConfigurationError | undefined
    let aborted = false
    try {
        // Reading caller options and the signal state can throw only from application getters or proxies
        signal = options?.signal
        invalidSignal = operationSignalError(signal)
        aborted = invalidSignal === undefined && signal?.aborted === true
    } catch (error) {
        return new ResultAsync<A, E | CancelledError | ConfigurationError>(
            Promise.reject(new SdkDefect(operation, [defectReason(error, "application")])),
        )
    }
    try {
        if (invalidSignal)
            return new ResultAsync<A, E | CancelledError | ConfigurationError>(Promise.resolve(err(invalidSignal)))
        if (aborted)
            return new ResultAsync<A, E | CancelledError | ConfigurationError>(
                Promise.resolve(err(new CancelledError(operation))),
            )
        const controller = signal ? new AbortController() : undefined
        abort = () => controller?.abort()
        // Read while the calling handler code runs, so a rejection inside a handler is reported once
        const scope = currentRejectionScope()
        if (signal) {
            // Treat registration as owned before calling it: A custom signal can attach then throw
            registered = true
            readCaller(() => signal!.addEventListener("abort", abort!, { once: true }))
        }
        // Interrupt the operation itself rather than discarding a losing race's cleanup cause
        return new ResultAsync(
            (async () => {
                let exit: Exit.Exit<A, E>
                try {
                    exit = await Effect.runPromiseExit(
                        withRejectionScope(effect, scope),
                        controller ? { signal: controller.signal } : undefined,
                    )
                } catch (error) {
                    exit = Exit.failCause(Cause.die(error))
                }
                if (registered) {
                    registered = false
                    try {
                        signal!.removeEventListener("abort", abort!)
                    } catch (error) {
                        exit = Exit.failCause(
                            Cause.combine(Exit.isFailure(exit) ? exit.cause : Cause.empty, inputDefect(error)),
                        )
                    }
                }
                return fromExit(exit, operation)
            })(),
        )
    } catch (error) {
        let cleanupDefect = false
        let cleanupError: unknown
        if (registered) {
            registered = false
            try {
                signal!.removeEventListener("abort", abort!)
            } catch (failure) {
                cleanupDefect = true
                cleanupError = failure
            }
        }
        return new ResultAsync<A, E | CancelledError | ConfigurationError>(
            Promise.reject(
                new SdkDefect(
                    operation,
                    cleanupDefect
                        ? [thrownReason(error), defectReason(cleanupError, "application")]
                        : [thrownReason(error)],
                ),
            ),
        )
    }
}

/** Convert an exit to a Result, throwing SdkDefect for defects and returning CancelledError for interruption only */
export function fromExit<A, E extends OperationFailure>(
    exit: Exit.Exit<A, E>,
    operation: Operation,
): Result<A, E | CancelledError> {
    if (Exit.isSuccess(exit)) return ok(exit.value)
    if (Cause.hasDies(exit.cause)) {
        throw new SdkDefect(operation, causeReasons(exit.cause))
    }
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    return failure?._tag === "Fail" ? err(failure.error) : err(new CancelledError(operation))
}

/**
 * Run a local cache lookup or pure calculation and return its value directly.
 * Input misuse throws the operation's own error, and defects or interruption throw SdkDefect.
 * With closedAsAbsent, a closing or closed client has no cache and reads undefined instead of failing
 */
export function localValue<A, E>(effect: Effect.Effect<A, E>, operation: Operation, closedAsAbsent: true): A | undefined
export function localValue<A, E>(effect: Effect.Effect<A, E>, operation: Operation): A
export function localValue<A, E>(effect: Effect.Effect<A, E>, operation: Operation, closedAsAbsent = false) {
    const exit = Effect.runSyncExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
        throw new SdkDefect(operation, causeReasons(exit.cause))
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (failure?._tag !== "Fail") throw new SdkDefect(operation, causeReasons(exit.cause))
    if (closedAsAbsent && isClientClosed(failure.error)) return undefined
    throw failure.error
}

/** Whether a failure is the closing-client failure that a cache lookup reads as an absent entry */
export const isClientClosed = (error: unknown): error is ClientClosedError =>
    typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "ClientClosedError"

/** Run a synchronous local lookup. Expected failures return Err, while defects and interruption throw SdkDefect */
export function lookup<A, E>(effect: Effect.Effect<A, E>, operation: Operation): Result<A, E> {
    const exit = Effect.runSyncExit(effect)
    if (Exit.isSuccess(exit)) return ok(exit.value)
    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
        throw new SdkDefect(operation, causeReasons(exit.cause))
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (failure?._tag === "Fail") return err(failure.error)
    throw new SdkDefect(operation, causeReasons(exit.cause))
}

/** What default adapters need from one client: Its owner and executors that provide the client's logger */
export interface DefaultContext<M extends MessageCore> {
    readonly owner: ClientOwner<M>
    /** Start an operation now with the client's logger, honoring options.signal */
    readonly execute: <A, E extends OperationFailure>(
        effect: Effect.Effect<A, E>,
        operation: Operation,
        options?: OperationOptions,
    ) => ResultAsync<A, E | CancelledError | ConfigurationError>
    /** Open a lazy page iterator whose pages start when a loop pulls them */
    readonly iterate: <A, E extends OperationFailure>(
        create: (options: MessageOperationOptions) => Effect.Effect<Pagination<A, E>, PaginationError>,
        operation: PaginationOperation,
        options?: OperationOptions,
    ) => AsyncIterable<Result<A, E | PaginationError | CancelledError | ConfigurationError | ClientClosedError>>
}
