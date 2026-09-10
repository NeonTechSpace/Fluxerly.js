import { Effect } from "effect"
import { ClientClosedError } from "#sdk/errors"
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
import type { Message, MessageOperationOptions } from "#sdk/messages"
import type { ClientOwner } from "./client.js"
import { mapFailureCause } from "./effect-failures.js"
import { identifier, record } from "./message.js"

const maximum = 10_000
// The owner is the weak key, so an application-held plan cannot retain its producing client
const ownerPlans = new WeakMap<ClientOwner, WeakSet<MessageCleanupPlan>>()
const consumedPlans = new WeakSet<MessageCleanupPlan>()

interface PreviewOptions {
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
}

interface ValidSelection {
    readonly authorId: string | undefined
    readonly filter: ((message: Message) => boolean) | undefined
    readonly maxScanned: number
    readonly maxSelected: number
}

const freezeIds = (ids: readonly string[]) => Object.freeze([...ids])
const freezeBatches = (batches: readonly MessageCleanupBatch[]) => Object.freeze([...batches])
const selectedIds = (messages: readonly Message[]) => freezeIds(messages.map((message) => message.id))

function ownPlan(owner: ClientOwner, plan: MessageCleanupPlan): void {
    let plans = ownerPlans.get(owner)
    if (!plans) {
        plans = new WeakSet()
        ownerPlans.set(owner, plans)
    }
    plans.add(plan)
}

const ownsPlan = (owner: ClientOwner, plan: MessageCleanupPlan): boolean => ownerPlans.get(owner)?.has(plan) === true

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
        )
    return error(phase, "closed", "unknown", scannedCount, ids, submitted, terminal)
}

function validOptions(value: unknown, progress: boolean): PreviewOptions | undefined {
    if (value === undefined) return {}
    if (
        !record(value) ||
        Object.keys(value).some(
            (key) => key !== "timeoutMs" && key !== "signal" && (progress ? key !== "onProgress" : true),
        ) ||
        (value.timeoutMs !== undefined &&
            (typeof value.timeoutMs !== "number" ||
                !Number.isSafeInteger(value.timeoutMs) ||
                value.timeoutMs < 1 ||
                value.timeoutMs > 2_147_483_647)) ||
        (value.signal !== undefined &&
            (!record(value.signal) ||
                typeof value.signal.aborted !== "boolean" ||
                typeof value.signal.addEventListener !== "function" ||
                typeof value.signal.removeEventListener !== "function")) ||
        (progress && value.onProgress !== undefined && typeof value.onProgress !== "function")
    )
        return undefined
    return {
        ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
        ...(value.signal === undefined ? {} : { signal: value.signal as unknown as AbortSignal }),
    }
}

function selection(value: unknown): ValidSelection | undefined {
    if (
        !record(value) ||
        Object.keys(value).some((key) => !["authorId", "filter", "maxScanned", "maxSelected"].includes(key)) ||
        (value.authorId !== undefined && !identifier(value.authorId)) ||
        (value.filter !== undefined && typeof value.filter !== "function") ||
        (value.authorId === undefined && value.filter === undefined) ||
        typeof value.maxScanned !== "number" ||
        !Number.isSafeInteger(value.maxScanned) ||
        value.maxScanned < 1 ||
        value.maxScanned > maximum ||
        typeof value.maxSelected !== "number" ||
        !Number.isSafeInteger(value.maxSelected) ||
        value.maxSelected < 1 ||
        value.maxSelected > maximum
    )
        return undefined
    return {
        authorId: value.authorId,
        filter: value.filter as ((message: Message) => boolean) | undefined,
        maxScanned: value.maxScanned,
        maxSelected: value.maxSelected,
    }
}

function remaining(deadline: number, signal: AbortSignal | undefined): MessageOperationOptions | undefined {
    const timeoutMs = Math.floor(deadline - performance.now())
    return timeoutMs > 0 ? { timeoutMs, ...(signal === undefined ? {} : { signal }) } : undefined
}

function matches(selected: ValidSelection, message: Message): Effect.Effect<boolean, MessageCleanupError> {
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
export function previewCleanup(
    owner: ClientOwner,
    channelId: string,
    suppliedSelection: MessageCleanupSelection,
    suppliedOptions?: MessageOperationOptions,
): Effect.Effect<MessageCleanupPlan, MessageCleanupError> {
    return Effect.suspend(() => {
        const selected = selection(suppliedSelection)
        const requestOptions = validOptions(suppliedOptions, false)
        if (!identifier(channelId) || !selected || !requestOptions)
            return Effect.fail(error("preview", "input", "notDispatched", 0, [], []))
        const deadline = performance.now() + (requestOptions.timeoutMs ?? 30_000)
        return Effect.gen(function* () {
            const messages: Message[] = []
            let scannedCount = 0
            let before: string | undefined
            let stopReason: MessageCleanupStopReason = "historyExhausted"
            while (scannedCount < selected.maxScanned && messages.length < selected.maxSelected) {
                const options = remaining(deadline, requestOptions.signal)
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
                    if (!remaining(deadline, requestOptions.signal))
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
            const plan: MessageCleanupPlan = Object.freeze({
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
export function cleanup(
    owner: ClientOwner,
    plan: MessageCleanupPlan,
    suppliedOptions?: MessageCleanupOptions,
): Effect.Effect<MessageCleanupReport, MessageCleanupError> {
    return Effect.suspend(() => {
        const requestOptions = validOptions(suppliedOptions, true)
        if (!requestOptions || !ownsPlan(owner, plan) || consumedPlans.has(plan))
            return Effect.fail(error("cleanup", "input", "notDispatched", 0, [], []))
        consumedPlans.add(plan)
        const notify = progressCallback(suppliedOptions)
        const ids = selectedIds(plan.selectedMessages)
        const deadline = performance.now() + (requestOptions.timeoutMs ?? 30_000)
        return Effect.gen(function* () {
            const submitted: MessageCleanupBatch[] = []
            for (let offset = 0; offset < ids.length; offset += 100) {
                const current = batch(offset / 100, ids.slice(offset, offset + 100))
                if (!remaining(deadline, requestOptions.signal))
                    return yield* Effect.fail(
                        error("cleanup", "timeout", "notDispatched", plan.scannedCount, ids, submitted),
                    )
                yield* Effect.sync(() => notify?.(Object.freeze({ state: "submitting", batch: current })))
                const options = remaining(deadline, requestOptions.signal)
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
