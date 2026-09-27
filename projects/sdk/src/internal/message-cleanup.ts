/**
 * Message cleanup: Preview and batched own-message deletion.
 * Invariant: Preview never deletes, cleanup reports submitted batches rather than confirmed deletions, and progress callback
 * failures, including a returned or resolved Err and a returned Effect, are reported with kind progress. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { throwIfErr, type FailureReporter } from "./failures.js"
import * as Effect from "effect/Effect"
import { ClientClosedError } from "#sdk/errors"
import { composedStepFacts, type ApiErrorDetail } from "#sdk/api-errors"
import {
    InputValidationFailure,
    inputValidationFailure,
    unsupportedKeyFailure,
    type InputValidationDetail,
} from "#sdk/input-validation"
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
import { identifier, record } from "./decode/primitives.js"
import { readCaller, suspendInput, suspendMarked } from "./defects.js"

const maximum = 10_000
// The owner is the weak key, so an application-held plan cannot retain its producing client
const ownerPlans = new WeakMap<object, WeakSet<MessageCleanupPlan<MessageCore>>>()
const consumedPlans = new WeakSet<MessageCleanupPlan<MessageCore>>()

interface PreviewOptions {
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
    /** The progress callback read with the other options, for cleanup only */
    readonly onProgress?: (event: MessageCleanupProgress) => unknown
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

/** A cleanup failure with frozen copies of the progress it reports. Omitted progress means nothing was scanned or sent */
function error(input: {
    readonly phase: "preview" | "cleanup"
    readonly reason: MessageCleanupErrorReason
    readonly outcome: MessageCleanupOutcome
    readonly scannedCount?: number
    readonly ids?: readonly string[]
    readonly submitted?: readonly MessageCleanupBatch[]
    readonly terminal?: readonly string[] | null
    readonly status?: number | null
    readonly retryAfterMs?: number | null
    readonly inputValidation?: InputValidationDetail | null
    readonly apiError?: ApiErrorDetail | null
    readonly providerCode?: string | null | undefined
    readonly responseField?: string | null | undefined
    readonly cause?: unknown
}): MessageCleanupError {
    const { phase, reason, outcome, scannedCount = 0, ids = [], submitted = [], terminal = null, cause } = input
    const { status = null, retryAfterMs = null, inputValidation = null, apiError = null } = input
    return new MessageCleanupError({
        phase,
        reason,
        outcome,
        status,
        retryAfterMs,
        scannedCount,
        selectedMessageIds: freezeIds(ids),
        submittedBatches: freezeBatches(submitted),
        terminalBatchIds: terminal === null ? null : freezeIds(terminal),
        inputValidation,
        apiError,
        providerCode: input.providerCode ?? null,
        responseField: input.responseField ?? null,
        ...(cause === undefined ? {} : { cause }),
    })
}

/** A cleanup failure caused by a failed message operation or client closure, keeping the progress made so far */
function wrappedFailure(
    source: MessageOperationError | ClientClosedError,
    progress: {
        readonly phase: "preview" | "cleanup"
        readonly scannedCount: number
        readonly ids: readonly string[]
        readonly submitted?: readonly MessageCleanupBatch[]
        readonly terminal?: readonly string[] | null
    },
): MessageCleanupError {
    const { phase, scannedCount, ids, submitted = [], terminal = null } = progress
    if (source instanceof MessageOperationError) {
        const { providerCode, responseField } = composedStepFacts(source)
        return error({
            phase,
            reason: source.reason,
            outcome: source.outcome,
            scannedCount,
            ids,
            submitted,
            terminal,
            status: source.status,
            retryAfterMs: source.retryAfterMs,
            inputValidation: source.inputValidation,
            apiError: source.apiError,
            providerCode,
            responseField,
            cause: source,
        })
    }
    return error({ phase, reason: "closed", outcome: "unknown", scannedCount, ids, submitted, terminal, cause: source })
}

function validOptions(value: unknown, progress: boolean): PreviewOptions | InputValidationFailure {
    if (value === undefined) return {}
    if (!record(value)) return inputValidationFailure("options", "type", "Cleanup options must be an object")
    const unsupported = unsupportedKeyFailure(
        value,
        progress ? ["timeoutMs", "signal", "onProgress"] : ["timeoutMs", "signal"],
        "options",
        progress ? "the cleanup options" : "the preview options",
    )
    if (unsupported) return unsupported
    // Read each option once, so the validated values are the ones used
    const timeoutMs = value.timeoutMs
    if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 2_147_483_647)
    )
        return inputValidationFailure(
            "options.timeoutMs",
            "range",
            "Cleanup timeout must be an integer from 1 through 2,147,483,647 ms",
        )
    const signal = value.signal
    if (
        signal !== undefined &&
        (!record(signal) ||
            typeof signal.aborted !== "boolean" ||
            typeof signal.addEventListener !== "function" ||
            typeof signal.removeEventListener !== "function")
    )
        return inputValidationFailure("options.signal", "type", "Cleanup signal must be an AbortSignal")
    const onProgress = progress ? value.onProgress : undefined
    if (onProgress !== undefined && typeof onProgress !== "function")
        return inputValidationFailure("options.onProgress", "type", "Cleanup progress callback must be a function")
    return {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(signal === undefined ? {} : { signal: signal as unknown as AbortSignal }),
        ...(onProgress === undefined ? {} : { onProgress: onProgress as (event: MessageCleanupProgress) => unknown }),
    }
}

function selection<M extends MessageCore>(value: unknown): ValidSelection<M> | InputValidationFailure {
    if (!record(value)) return inputValidationFailure("selection", "type", "Cleanup selection must be an object")
    const unsupported = unsupportedKeyFailure(
        value,
        ["authorId", "filter", "maxScanned", "maxSelected"],
        "selection",
        "the cleanup selection",
    )
    if (unsupported) return unsupported
    // Read each field once, so the validated values are the ones used
    const authorId = value.authorId
    if (authorId !== undefined && !identifier(authorId))
        return inputValidationFailure("selection.authorId", "format", "Cleanup author ID must be a decimal string")
    const filter = value.filter
    if (filter !== undefined && typeof filter !== "function")
        return inputValidationFailure("selection.filter", "type", "Cleanup filter must be a function")
    if (authorId === undefined && filter === undefined)
        return inputValidationFailure("selection", "required", "Cleanup selection requires authorId or filter")
    const maxScanned = value.maxScanned
    if (typeof maxScanned !== "number" || !Number.isSafeInteger(maxScanned) || maxScanned < 1 || maxScanned > maximum)
        return inputValidationFailure(
            "selection.maxScanned",
            "range",
            "Cleanup maxScanned is required and must be an integer from 1 through 10,000",
        )
    const maxSelected = value.maxSelected
    if (
        typeof maxSelected !== "number" ||
        !Number.isSafeInteger(maxSelected) ||
        maxSelected < 1 ||
        maxSelected > maximum
    )
        return inputValidationFailure(
            "selection.maxSelected",
            "range",
            "Cleanup maxSelected is required and must be an integer from 1 through 10,000",
        )
    return {
        authorId,
        filter: filter as ((message: M) => boolean) | undefined,
        maxScanned,
        maxSelected,
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
                // allow-silent: The invalid asynchronous filter result already fails preview with reason filter
                void Promise.resolve(result).catch(() => undefined)
                return Effect.fail(error({ phase: "preview", reason: "filter", outcome: "notDispatched" }))
            }
            return typeof result === "boolean"
                ? Effect.succeed(result)
                : Effect.fail(error({ phase: "preview", reason: "filter", outcome: "notDispatched" }))
        } catch (thrown) {
            return Effect.fail(error({ phase: "preview", reason: "filter", outcome: "notDispatched", cause: thrown }))
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

function progressCallback(
    callback: ((event: MessageCleanupProgress) => unknown) | undefined,
    failures: FailureReporter,
): ((event: MessageCleanupProgress) => void) | undefined {
    if (callback === undefined) return undefined
    // Like other application callbacks without a returned result, a failure goes to onError or an Error record
    const failed = (thrown: unknown) => failures.report({ kind: "progress", error: thrown })
    return (event) => {
        try {
            const result = callback(event)
            // The callback is synchronous in both APIs, so a returned Effect would never run. Report it rather than drop it
            if (Effect.isEffect(result))
                return failed(
                    new TypeError(
                        "A cleanup onProgress callback returned an Effect, which is not run. Perform the work synchronously, or run the Effect explicitly inside the callback",
                    ),
                )
            if (
                result !== null &&
                (typeof result === "object" || typeof result === "function") &&
                typeof (result as { then?: unknown }).then === "function"
            )
                void Promise.resolve(result).then(throwIfErr).catch(failed)
            // An Err result is reported like a throw of its error
            else throwIfErr(result)
        } catch (thrown) {
            // Callback failures are isolated from the cleanup request but still recorded
            failed(thrown)
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
    // Reading and validating the caller selection and options is marked as application input
    return suspendInput(() => {
        const selected = selection<M>(suppliedSelection)
        const requestOptions = validOptions(suppliedOptions, false)
        const invalid = (failure: InputValidationFailure) =>
            Effect.fail(
                error({ phase: "preview", reason: "input", outcome: "notDispatched", inputValidation: failure.detail }),
            )
        if (!identifier(channelId))
            return invalid(inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings"))
        if (selected instanceof InputValidationFailure) return invalid(selected)
        if (requestOptions instanceof InputValidationFailure) return invalid(requestOptions)
        return Effect.gen(function* () {
            const now = () => owner.logical.now()
            const deadline = now() + (requestOptions.timeoutMs ?? owner.defaultTimeoutMs)
            const messages: M[] = []
            let scannedCount = 0
            let before: string | undefined
            let stopReason: MessageCleanupStopReason = "historyExhausted"
            while (scannedCount < selected.maxScanned && messages.length < selected.maxSelected) {
                const options = remaining(deadline, requestOptions.signal, now)
                if (!options)
                    return yield* Effect.fail(
                        error({
                            phase: "preview",
                            reason: "timeout",
                            outcome: "notDispatched",
                            scannedCount,
                            ids: selectedIds(messages),
                        }),
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
                            wrappedFailure(source, { phase: "preview", scannedCount, ids: selectedIds(messages) }),
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
                            error({
                                phase: "preview",
                                reason: "filter",
                                outcome: "notDispatched",
                                scannedCount,
                                ids: selectedIds(messages),
                            }),
                        ),
                    )
                    if (!remaining(deadline, requestOptions.signal, now))
                        return yield* Effect.fail(
                            error({
                                phase: "preview",
                                reason: "timeout",
                                outcome: "notDispatched",
                                scannedCount,
                                ids: selectedIds(messages),
                            }),
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
    // Only reading the caller options is marked, so plan ownership and scheduling faults stay SDK faults
    return suspendMarked(() => {
        const requestOptions = readCaller(() => validOptions(suppliedOptions, true))
        if (requestOptions instanceof InputValidationFailure)
            return Effect.fail(
                error({
                    phase: "cleanup",
                    reason: "input",
                    outcome: "notDispatched",
                    inputValidation: requestOptions.detail,
                }),
            )
        if (!ownsPlan(owner, plan) || consumedPlans.has(plan))
            return Effect.fail(
                error({
                    phase: "cleanup",
                    reason: "input",
                    outcome: "notDispatched",
                    inputValidation: inputValidationFailure(
                        "plan",
                        "relationship",
                        "Cleanup requires an unused preview plan from this client",
                    ).detail,
                }),
            )
        consumedPlans.add(plan)
        const notify = progressCallback(requestOptions.onProgress, owner.failures)
        const ids = selectedIds(plan.selectedMessages)
        return Effect.gen(function* () {
            const now = () => owner.logical.now()
            const deadline = now() + (requestOptions.timeoutMs ?? owner.defaultTimeoutMs)
            const submitted: MessageCleanupBatch[] = []
            for (let offset = 0; offset < ids.length; offset += 100) {
                const current = batch(offset / 100, ids.slice(offset, offset + 100))
                if (!remaining(deadline, requestOptions.signal, now))
                    return yield* Effect.fail(
                        error({
                            phase: "cleanup",
                            reason: "timeout",
                            outcome: "notDispatched",
                            scannedCount: plan.scannedCount,
                            ids,
                            submitted,
                        }),
                    )
                if (owner.state === "Closing" || owner.state === "Closed")
                    return yield* Effect.fail(
                        error({
                            phase: "cleanup",
                            reason: "closed",
                            outcome: "notDispatched",
                            scannedCount: plan.scannedCount,
                            ids,
                            submitted,
                        }),
                    )
                yield* Effect.sync(() => notify?.(Object.freeze({ state: "submitting", batch: current })))
                const options = remaining(deadline, requestOptions.signal, now)
                if (!options)
                    return yield* Effect.fail(
                        error({
                            phase: "cleanup",
                            reason: "timeout",
                            outcome: "notDispatched",
                            scannedCount: plan.scannedCount,
                            ids,
                            submitted,
                        }),
                    )
                yield* owner.deleteMany(plan.channelId, current.messageIds, options).pipe(
                    mapFailureCause((source) => {
                        const failure = wrappedFailure(source, {
                            phase: "cleanup",
                            scannedCount: plan.scannedCount,
                            ids,
                            submitted,
                            terminal: current.messageIds,
                        })
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
