import { Effect } from "effect"
import { ClientClosedError } from "#sdk/errors"
import type { ApiErrorDetail } from "#sdk/api-errors"
import { InputValidationFailure, inputValidationFailure, type InputValidationDetail } from "#sdk/input-validation"
import {
    MessageCleanupError,
    type MessageCleanupBatch,
    type MessageCleanupErrorReason,
    type MessageCleanupFailureMetadata,
    type MessageCleanupOptions,
    type MessageCleanupOutcome,
    type MessageCleanupPlan,
    type MessageCleanupProgress,
    type MessageCleanupReport,
    type MessageCleanupSelection,
    type MessageCleanupStopReason,
} from "#sdk/message-cleanup"
import { MessageOperationError } from "#sdk/message-errors"
import type { Message, MessageCore, MessageOperationOptions } from "#sdk/messages"
import type { ClientOwner } from "./client.js"
import { mapFailureCause } from "./effect-failures.js"
import { identifier, record } from "./message.js"

const maximum = 10_000
// The owner is the weak key, so an application-held plan cannot retain its producing client
const ownerPlans = new WeakMap<object, WeakSet<MessageCleanupPlan<MessageCore>>>()
const consumedPlans = new WeakSet<MessageCleanupPlan<MessageCore>>()

interface PreviewOptions {
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
}

interface ValidSelection<M extends MessageCore> {
    readonly authorId: string | undefined
    readonly filter: ((message: M) => boolean) | undefined
    readonly maxScanned: number
    readonly maxSelected: number
}

const freezeIds = (ids: readonly string[]) => Object.freeze([...ids])
const freezeBatches = (batches: readonly MessageCleanupBatch[]) => Object.freeze([...batches])
const selectedIds = (messages: readonly MessageCore[]) => freezeIds(messages.map((message) => message.id))

function ownPlan<M extends MessageCore>(owner: ClientOwner<M>, plan: MessageCleanupPlan<M>): void {
    let plans = ownerPlans.get(owner)
    if (!plans) {
        plans = new WeakSet()
        ownerPlans.set(owner, plans)
    }
    plans.add(plan)
}

const ownsPlan = <M extends MessageCore>(owner: ClientOwner<M>, plan: MessageCleanupPlan<M>): boolean =>
    ownerPlans.get(owner)?.has(plan) === true

function error(
    phase: "preview" | "cleanup",
    reason: MessageCleanupErrorReason,
    outcome: MessageCleanupOutcome,
    scannedCount: number,
    ids: readonly string[],
    submitted: readonly MessageCleanupBatch[],
    terminal: readonly string[] | null = null,
    status: number | null = null,
    retryAfterMs: number | null = null,
    inputValidation: InputValidationDetail | null = null,
    apiError: ApiErrorDetail | null = null,
): MessageCleanupError {
    return new MessageCleanupError(
        phase,
        reason,
        outcome,
        status,
        retryAfterMs,
        scannedCount,
        freezeIds(ids),
        freezeBatches(submitted),
        terminal === null ? null : freezeIds(terminal),
        inputValidation,
        apiError,
    )
}

function wrappedFailure(
    phase: "preview" | "cleanup",
    source: MessageOperationError | ClientClosedError,
    scannedCount: number,
    ids: readonly string[],
    submitted: readonly MessageCleanupBatch[],
    terminal: readonly string[] | null = null,
): MessageCleanupError {
    if (source instanceof MessageOperationError)
        return error(
            phase,
            source.reason,
            source.outcome,
            scannedCount,
            ids,
            submitted,
            terminal,
            source.status,
            source.retryAfterMs,
            source.inputValidation,
            source.apiError,
        )
    return error(phase, "closed", "unknown", scannedCount, ids, submitted, terminal)
}

function validOptions(value: unknown, progress: boolean): PreviewOptions | InputValidationFailure {
    if (value === undefined) return {}
    if (!record(value)) return inputValidationFailure("options", "type", "Cleanup options must be an object")
    if (
        Object.keys(value).some(
            (key) => key !== "timeoutMs" && key !== "signal" && (progress ? key !== "onProgress" : true),
        )
    )
        return inputValidationFailure(
            "options",
            "allowedFields",
            progress
                ? "Cleanup options may contain only timeoutMs, signal, and onProgress"
                : "Preview options may contain only timeoutMs and signal",
        )
    if (
        value.timeoutMs !== undefined &&
        (typeof value.timeoutMs !== "number" ||
            !Number.isSafeInteger(value.timeoutMs) ||
            value.timeoutMs < 1 ||
            value.timeoutMs > 2_147_483_647)
    )
        return inputValidationFailure(
            "options.timeoutMs",
            "range",
            "Cleanup timeout must be an integer from 1 through 2,147,483,647 milliseconds",
        )
    if (
        value.signal !== undefined &&
        (!record(value.signal) ||
            typeof value.signal.aborted !== "boolean" ||
            typeof value.signal.addEventListener !== "function" ||
            typeof value.signal.removeEventListener !== "function")
    )
        return inputValidationFailure("options.signal", "type", "Cleanup signal must be an AbortSignal")
    if (progress && value.onProgress !== undefined && typeof value.onProgress !== "function")
        return inputValidationFailure("options.onProgress", "type", "Cleanup progress callback must be a function")
    return {
        ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
        ...(value.signal === undefined ? {} : { signal: value.signal as unknown as AbortSignal }),
    }
}

function selection<M extends MessageCore>(value: unknown): ValidSelection<M> | InputValidationFailure {
    if (!record(value)) return inputValidationFailure("selection", "type", "Cleanup selection must be an object")
    if (Object.keys(value).some((key) => !["authorId", "filter", "maxScanned", "maxSelected"].includes(key)))
        return inputValidationFailure(
            "selection",
            "allowedFields",
            "Cleanup selection may contain only authorId, filter, maxScanned, and maxSelected",
        )
    if (value.authorId !== undefined && !identifier(value.authorId))
        return inputValidationFailure("selection.authorId", "format", "Cleanup author ID must be a decimal string")
    if (value.filter !== undefined && typeof value.filter !== "function")
        return inputValidationFailure("selection.filter", "type", "Cleanup filter must be a function")
    if (value.authorId === undefined && value.filter === undefined)
        return inputValidationFailure("selection", "required", "Cleanup selection requires authorId or filter")
    if (
        typeof value.maxScanned !== "number" ||
        !Number.isSafeInteger(value.maxScanned) ||
        value.maxScanned < 1 ||
        value.maxScanned > maximum
    )
        return inputValidationFailure(
            "selection.maxScanned",
            "range",
            "Cleanup maxScanned must be an integer from 1 through 10,000",
        )
    if (
        typeof value.maxSelected !== "number" ||
        !Number.isSafeInteger(value.maxSelected) ||
        value.maxSelected < 1 ||
        value.maxSelected > maximum
    )
        return inputValidationFailure(
            "selection.maxSelected",
            "range",
            "Cleanup maxSelected must be an integer from 1 through 10,000",
        )
    return {
        authorId: value.authorId,
        filter: value.filter as ((message: M) => boolean) | undefined,
        maxScanned: value.maxScanned,
        maxSelected: value.maxSelected,
    }
}

function remaining(
    deadline: number,
    signal: AbortSignal | undefined,
    now: () => number,
): MessageOperationOptions | undefined {
    const timeoutMs = Math.floor(deadline - now())
    return timeoutMs > 0 ? { timeoutMs, ...(signal === undefined ? {} : { signal }) } : undefined
}

function matches<M extends MessageCore>(
    selected: ValidSelection<M>,
    message: M,
): Effect.Effect<boolean, MessageCleanupError> {
    if (selected.authorId !== undefined && message.author.id !== selected.authorId) return Effect.succeed(false)
    if (!selected.filter) return Effect.succeed(true)
    return Effect.suspend(() => {
        try {
            const result = selected.filter!(message)
            if (
                result !== null &&
                (typeof result === "object" || typeof result === "function") &&
                typeof (result as { then?: unknown }).then === "function"
            ) {
                void Promise.resolve(result).catch(() => undefined)
                return Effect.fail(error("preview", "filter", "notDispatched", 0, [], []))
            }
            return typeof result === "boolean"
                ? Effect.succeed(result)
                : Effect.fail(error("preview", "filter", "notDispatched", 0, [], []))
        } catch {
            return Effect.fail(error("preview", "filter", "notDispatched", 0, [], []))
        }
    })
}

function failureMetadata(value: MessageCleanupError): MessageCleanupFailureMetadata {
    return Object.freeze({
        reason: value.reason,
        outcome: value.outcome,
        status: value.status,
        retryAfterMs: value.retryAfterMs,
        apiError: value.apiError,
    })
}

function progressCallback(value: unknown): ((event: MessageCleanupProgress) => void) | undefined {
    if (!record(value) || typeof value.onProgress !== "function") return undefined
    const callback = value.onProgress as (event: MessageCleanupProgress) => unknown
    return (event) => {
        try {
            const result = callback(event)
            if (
                result !== null &&
                (typeof result === "object" || typeof result === "function") &&
                typeof (result as { then?: unknown }).then === "function"
            )
                void Promise.resolve(result).catch(() => undefined)
        } catch {
            // User callback failures are deliberately isolated from the cleanup request
        }
    }
}

const batch = (batchIndex: number, ids: readonly string[]): MessageCleanupBatch =>
    Object.freeze({ batchIndex, messageIds: freezeIds(ids) })

/** Builds an owned, immutable, exact message selection without submitting a deletion */
export function previewCleanup<M extends MessageCore = Message>(
    owner: ClientOwner<M>,
    channelId: string,
    suppliedSelection: MessageCleanupSelection<M>,
    suppliedOptions?: MessageOperationOptions,
): Effect.Effect<MessageCleanupPlan<M>, MessageCleanupError> {
    return Effect.suspend(() => {
        const selected = selection<M>(suppliedSelection)
        const requestOptions = validOptions(suppliedOptions, false)
        const invalid = (failure: InputValidationFailure) =>
            Effect.fail(error("preview", "input", "notDispatched", 0, [], [], null, null, null, failure.detail))
        if (!identifier(channelId))
            return invalid(inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings"))
        if (selected instanceof InputValidationFailure) return invalid(selected)
        if (requestOptions instanceof InputValidationFailure) return invalid(requestOptions)
        return Effect.gen(function* () {
            const now = () => owner.logical.now()
            const deadline = now() + (requestOptions.timeoutMs ?? 30_000)
            const messages: M[] = []
            let scannedCount = 0
            let before: string | undefined
            let stopReason: MessageCleanupStopReason = "historyExhausted"
            while (scannedCount < selected.maxScanned && messages.length < selected.maxSelected) {
                const options = remaining(deadline, requestOptions.signal, now)
                if (!options)
                    return yield* Effect.fail(
                        error("preview", "timeout", "notDispatched", scannedCount, selectedIds(messages), []),
                    )
                const page = yield* owner
                    .fetchHistory(
                        channelId,
                        {
                            limit: Math.min(100, selected.maxScanned - scannedCount),
                            ...(before === undefined ? {} : { before }),
                        },
                        options,
                    )
                    .pipe(
                        mapFailureCause((source) =>
                            wrappedFailure("preview", source, scannedCount, selectedIds(messages), []),
                        ),
                    )
                if (page.length === 0) {
                    stopReason = "historyExhausted"
                    break
                }
                for (const message of page) {
                    scannedCount++
                    const accepted = yield* matches(selected, message).pipe(
                        mapFailureCause(() =>
                            error("preview", "filter", "notDispatched", scannedCount, selectedIds(messages), []),
                        ),
                    )
                    if (!remaining(deadline, requestOptions.signal, now))
                        return yield* Effect.fail(
                            error("preview", "timeout", "notDispatched", scannedCount, selectedIds(messages), []),
                        )
                    if (accepted) messages.push(message)
                    if (messages.length === selected.maxSelected) {
                        stopReason = "selectionLimit"
                        break
                    }
                    if (scannedCount === selected.maxScanned) {
                        stopReason = "scanLimit"
                        break
                    }
                }
                if (stopReason !== "historyExhausted") break
                before = page.at(-1)!.id
            }
            if (scannedCount === selected.maxScanned && messages.length < selected.maxSelected) stopReason = "scanLimit"
            const plan: MessageCleanupPlan<M> = Object.freeze({
                channelId,
                selectedMessages: Object.freeze([...messages]),
                scannedCount,
                stopReason,
            })
            ownPlan(owner, plan)
            return plan
        })
    })
}

/** Submit an owned preview's exact IDs sequentially through deleteMany, without rescanning or replaying an unknown batch */
export function cleanup<M extends MessageCore = Message>(
    owner: ClientOwner<M>,
    plan: MessageCleanupPlan<M>,
    suppliedOptions?: MessageCleanupOptions,
): Effect.Effect<MessageCleanupReport, MessageCleanupError> {
    return Effect.suspend(() => {
        const requestOptions = validOptions(suppliedOptions, true)
        if (requestOptions instanceof InputValidationFailure)
            return Effect.fail(
                error("cleanup", "input", "notDispatched", 0, [], [], null, null, null, requestOptions.detail),
            )
        if (!ownsPlan(owner, plan) || consumedPlans.has(plan))
            return Effect.fail(
                error(
                    "cleanup",
                    "input",
                    "notDispatched",
                    0,
                    [],
                    [],
                    null,
                    null,
                    null,
                    inputValidationFailure(
                        "plan",
                        "relationship",
                        "Cleanup requires an unused preview plan from this client",
                    ).detail,
                ),
            )
        consumedPlans.add(plan)
        const notify = progressCallback(suppliedOptions)
        const ids = selectedIds(plan.selectedMessages)
        return Effect.gen(function* () {
            const now = () => owner.logical.now()
            const deadline = now() + (requestOptions.timeoutMs ?? 30_000)
            const submitted: MessageCleanupBatch[] = []
            for (let offset = 0; offset < ids.length; offset += 100) {
                const current = batch(offset / 100, ids.slice(offset, offset + 100))
                if (!remaining(deadline, requestOptions.signal, now))
                    return yield* Effect.fail(
                        error("cleanup", "timeout", "notDispatched", plan.scannedCount, ids, submitted),
                    )
                if (owner.state === "Closing" || owner.state === "Closed")
                    return yield* Effect.fail(
                        error("cleanup", "closed", "notDispatched", plan.scannedCount, ids, submitted),
                    )
                yield* Effect.sync(() => notify?.(Object.freeze({ state: "submitting", batch: current })))
                const options = remaining(deadline, requestOptions.signal, now)
                if (!options)
                    return yield* Effect.fail(
                        error("cleanup", "timeout", "notDispatched", plan.scannedCount, ids, submitted),
                    )
                yield* owner.deleteMany(plan.channelId, current.messageIds, options).pipe(
                    mapFailureCause((source) => {
                        const failure = wrappedFailure(
                            "cleanup",
                            source,
                            plan.scannedCount,
                            ids,
                            submitted,
                            current.messageIds,
                        )
                        notify?.(Object.freeze({ state: "failed", batch: current, failure: failureMetadata(failure) }))
                        return failure
                    }),
                )
                submitted.push(current)
                yield* Effect.sync(() => notify?.(Object.freeze({ state: "submitted", batch: current })))
            }
            return Object.freeze({
                channelId: plan.channelId,
                selectedMessageIds: ids,
                scannedCount: plan.scannedCount,
                submittedBatches: freezeBatches(submitted),
            })
        })
    })
}
