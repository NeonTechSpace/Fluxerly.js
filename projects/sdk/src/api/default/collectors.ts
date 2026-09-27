import type { ResultAsync } from "neverthrow"
import type { OperationOptions } from "#sdk/client"
import type { CancelledError, ConfigurationError } from "#sdk/errors"
import type { ReactionCollectorResult, CollectorFailure, CollectorResult } from "#sdk/collectors"
import type { Message, MessageCore } from "#sdk/messages"

/**
 * Wait for the bounded message collection created by messages.collect.
 * Use close to end intake early and result to obtain its final result.
 * Use `await using` to close the collector and wait for its cleanup when the enclosing block ends
 *
 * @category Events and collectors
 */
export interface Collector<M extends MessageCore = Message> {
    /**
     * Stop accepting messages now, keeping accepted replies for a successful partial result.
     * Repeated calls preserve whichever terminal outcome was recorded first.
     * Use result to await callback cleanup and read the collection
     *
     * @remarks
     * Returns immediately
     */
    close(): void
    /**
     * Wait for the final frozen collection result after timer, queue, filter, listener and callback cleanup.
     * Idle, timeout or stop can succeed with no messages or a partial collection.
     * Collection cancellation, filter or callback failure, overflow, gateway loss and client closure fail without partial replies.
     * Multiple or later waiters receive the same collection outcome.
     * Cancelling this wait affects only the waiter, not collection.
     * Keeping the handle or successful result keeps its message snapshots in memory
     *
     * @remarks
     * Unexpected SDK failures reject with SdkDefect
     */
    result(
        options?: OperationOptions,
    ): ResultAsync<CollectorResult<M>, CollectorFailure | CancelledError | ConfigurationError>
    /**
     * Close this collector and wait for its cleanup, as `await using` does at the end of a block.
     * The collection outcome is not rethrown here. Read it from result when it matters
     */
    [Symbol.asyncDispose](): Promise<void>
}

/**
 * Wait for the reaction-addition collection created by messages.collectReactions.
 * Use close to end intake early and result to obtain the observations.
 * Collected additions are observations, not current votes
 *
 * @category Events and collectors
 */
export interface ReactionCollector {
    /**
     * Stop accepting additions now and keep accepted observations for a successful partial result.
     * Repeated calls preserve the first recorded outcome.
     * Use result to await callback cleanup and read the observations
     *
     * @remarks
     * Returns immediately
     */
    close(): void
    /**
     * Wait for the final frozen reaction result after queue, timer, filter, listener and callback cleanup.
     * Idle, timeout or stop can succeed with empty or partial observations.
     * Collection cancellation, filter or callback failure, overflow, gateway loss and client shutdown fail without partial observations.
     * Multiple or later waiters receive the same outcome.
     * Cancelling this wait affects only the waiter, not collection.
     * Keeping the handle or successful result retains its snapshots in memory
     *
     * @remarks
     * Unexpected failures reject with SdkDefect
     */
    result(
        options?: OperationOptions,
    ): ResultAsync<ReactionCollectorResult, CollectorFailure | CancelledError | ConfigurationError>
    /**
     * Close this collector and wait for its cleanup, as `await using` does at the end of a block.
     * The collection outcome is not rethrown here. Read it from result when it matters
     */
    [Symbol.asyncDispose](): Promise<void>
}
