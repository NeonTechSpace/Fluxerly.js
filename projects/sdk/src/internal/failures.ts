/**
 * Failure reporter: Routes application failures to onError hooks or Error records.
 * Invariant: Hooks run one at a time, in order, through a bounded queue owned by the client, subscription or command router, with
 * one worker in the owner's context, so a failure only enqueues its report and never holds a handler slot. Overflowing reports and
 * hook failures are logged with the original failure and counted, and a failing hook is never invoked recursively. Shutdown
 * interrupts running hooks, waits a bounded time and logs the interrupted and queued reports. Reporting never throws: An
 * indescribable value still produces a record, and a fault while reporting counts as a log output failure. Implements [SDK contracts: User-handler failures](/docs/SDK-CONTRACTS.md#user-handler-failures)
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import type { EventName } from "#sdk/events"
import type { FailureKind, FailureMessageReference, FailureReport } from "#sdk/failures"
import type { LogCategory } from "#sdk/logging"
import { errorInfo, errorText, type ClientLogger } from "./logging.js"
import { messageText } from "./masking.js"
import type { LogCode } from "./code-catalogue.js"
import { fiberRejectionScope } from "./rejection-scope.js"

/** A failure report with the native Cause retained for Effect hooks */
export interface InternalReport extends FailureReport {
    readonly cause: Cause.Cause<unknown>
}

export interface ReportInput {
    readonly kind: FailureKind
    readonly error?: unknown
    readonly cause?: Cause.Cause<unknown> | undefined
    readonly event?: EventName | undefined
    readonly command?: string | undefined
    readonly subscriptionId?: string | undefined
    readonly message?: FailureMessageReference | undefined
}

/** The value a failure report exposes: The first typed failure, otherwise the first defect */
export function primaryError(cause: Cause.Cause<unknown>): unknown {
    const fail = cause.reasons.find((reason) => reason._tag === "Fail")
    if (fail?._tag === "Fail") return fail.error
    const die = cause.reasons.find((reason) => reason._tag === "Die")
    if (die?._tag === "Die") return die.defect
    return Cause.squash(cause)
}

/** Keep only IDs from a message-like payload */
export function messageReference(value: unknown): FailureMessageReference | undefined {
    if (typeof value !== "object" || value === null) return undefined
    const candidate = value as { id?: unknown; channelId?: unknown; guildId?: unknown; content?: unknown }
    if (typeof candidate.id !== "string" || typeof candidate.channelId !== "string" || !("content" in candidate))
        return undefined
    return Object.freeze({
        id: candidate.id,
        channelId: candidate.channelId,
        ...(typeof candidate.guildId === "string" ? { guildId: candidate.guildId } : {}),
    })
}

/** IDs of a known message, without its content */
export function messageIds(message: {
    readonly id: string
    readonly channelId: string
    readonly guildId?: string | undefined
}): FailureMessageReference {
    return Object.freeze({
        id: message.id,
        channelId: message.channelId,
        ...(message.guildId === undefined ? {} : { guildId: message.guildId }),
    })
}

/** What failed, as a sentence start that never begins with an identifier */
const kindText: Record<FailureKind, string> = {
    handler: "A handler failed",
    overflow: "A subscription overflowed",
    collector: "A collector callback failed",
    filter: "A collector filter failed",
    progress: "A cleanup progress callback failed",
    cache: "A cache callback failed",
    observer: "A state observer failed",
    task: "A scheduled task failed",
}

function subject(report: ReportInput) {
    if (report.command !== undefined) return `Command ${report.command} failed`
    if (report.event !== undefined && report.kind === "handler") return `The ${report.event} handler failed`
    if (report.event !== undefined && report.kind === "overflow") return `The ${report.event} subscription overflowed`
    return kindText[report.kind]
}

/** The subject in mid-sentence. Only the leading article or noun is lowercased, never an identifier */
function lowerFirst(text: string) {
    return `${text[0]!.toLowerCase()}${text.slice(1)}`
}

function context(report: ReportInput) {
    const parts = [
        report.subscriptionId === undefined ? undefined : `subscription ${report.subscriptionId}`,
        report.message === undefined
            ? undefined
            : `message ${report.message.id} in channel ${report.message.channelId}`,
    ].filter((part) => part !== undefined)
    return parts.length ? ` (${parts.join(", ")})` : ""
}

/** Build a frozen report. The describe method masks the client's credentials */
export function makeReport(input: ReportInput, secrets: readonly string[] = []): InternalReport {
    const cause = input.cause ?? Cause.fail(input.error)
    const error = input.cause !== undefined && !("error" in input) ? primaryError(input.cause) : input.error
    const origin = input.kind === "overflow" ? "sdk" : "application"
    return Object.freeze({
        kind: input.kind,
        error,
        cause,
        ...(input.event === undefined ? {} : { event: input.event }),
        ...(input.command === undefined ? {} : { command: input.command }),
        ...(input.subscriptionId === undefined ? {} : { subscriptionId: input.subscriptionId }),
        ...(input.message === undefined ? {} : { message: input.message }),
        describe: () => `${subject(input)}${context(input)}\n${errorText(errorInfo(error, origin, secrets), "  ")}`,
    })
}

const categories: Record<FailureKind, LogCategory> = {
    handler: "events",
    overflow: "events",
    collector: "collectors",
    filter: "collectors",
    progress: "sdk",
    cache: "cache",
    observer: "lifecycle",
    task: "lifecycle",
}

const codes: Record<FailureKind, LogCode> = {
    handler: "events.handlerFailed",
    overflow: "events.overflow",
    collector: "collectors.callbackFailed",
    filter: "collectors.filterFailed",
    progress: "cleanup.progressFailed",
    cache: "cache.policyFailed",
    observer: "lifecycle.observerFailed",
    task: "lifecycle.taskFailed",
}

/** Why a report was logged instead of reaching its hook, recorded as fields.reportOutcome */
type ReportOutcome = "queueFull" | "interrupted" | "clientClosed" | "subscriptionClosed"

/** Notes appended to the message of a report logged instead of reaching its hook */
const reportNotes: Record<ReportOutcome, string> = {
    queueFull: " (onError queue is full, so this report was logged instead)",
    interrupted: " (interrupted before onError finished)",
    clientClosed: " (the client closed before onError received it)",
    subscriptionClosed: " (the subscription closed before onError received it)",
}

/** Log a report at Error, or Debug when a hook already received it. Never throws: A fault while logging is counted
 * in sinkFailures and described once on standard error
 */
function logReport(
    logger: ClientLogger,
    report: InternalReport,
    options: {
        readonly handled?: boolean
        readonly outcome?: ReportOutcome
        readonly context?: Context.Context<never> | undefined
    } = {},
) {
    try {
        const error = report.error
        const errorMessage = messageText(error)
        logger.log(
            {
                level: options.handled ? "debug" : "error",
                category: report.command === undefined ? categories[report.kind] : "commands",
                code: report.command === undefined ? codes[report.kind] : "commands.failed",
                message: `${subject(report)}${options.handled ? " and was passed to onError" : `: ${errorMessage}`}${options.outcome === undefined ? "" : reportNotes[options.outcome]}`,
                event: report.event,
                command: report.command,
                subscriptionId: report.subscriptionId,
                // Undefined fields are omitted from the record
                fields: {
                    messageId: report.message?.id,
                    channelId: report.message?.channelId,
                    guildId: report.message?.guildId,
                    reportOutcome: options.outcome,
                },
                ...(options.handled ? {} : { error, cause: report.cause }),
                origin: report.kind === "overflow" ? "sdk" : "application",
            },
            options.context,
        )
    } catch (fault) {
        logger.outputFailure(fault)
    }
}

/**
 * Log a report that no hook receives. A handler failure caused by a rejected token or permission claims the held
 * rest.rejected record of its invocation by identity, directly or in its cause chain, if the record is still held.
 * The rejection is logged once unless the handler fails more than one second later. Never throws
 */
export function logHandlerReport(
    logger: ClientLogger,
    report: InternalReport,
    context: Context.Context<never> | undefined,
) {
    if (report.kind === "handler" && context !== undefined) fiberRejectionScope(context)?.claim(report.error)
    logReport(logger, report, { context })
}

/** Log a failed hook together with the original failure it was reporting. Never throws */
function logHookFailure(
    logger: ClientLogger,
    report: InternalReport,
    hookCause: Cause.Cause<unknown>,
    context?: Context.Context<never>,
) {
    logger.count("hookFailures")
    try {
        const hookError = primaryError(hookCause)
        logger.log(
            {
                level: "error",
                category: "events",
                code: "events.hookFailed",
                message: `The onError hook failed while reporting that ${lowerFirst(subject(report))}: ${messageText(hookError)}`,
                event: report.event,
                command: report.command,
                subscriptionId: report.subscriptionId,
                error: hookError,
                cause: hookCause,
                origin: "application",
            },
            context,
        )
    } catch (fault) {
        logger.outputFailure(fault)
    }
    logReport(logger, report, { context })
}

/**
 * One bounded, sequential onError queue. Offering a report only enqueues it. A single worker fiber, forked lazily
 * from the owner's context, calls the hook one report at a time in order and exits when the queue is empty.
 * A full queue logs the report at Error and counts it in reportsDropped. Closing interrupts a running hook without
 * waiting for it and logs the interrupted report and every queued one, so no report disappears
 */
export class HookQueue {
    readonly #queue: Queue.Queue<InternalReport>
    #worker: Fiber.Fiber<void> | undefined
    #current: InternalReport | undefined
    #closed = false

    constructor(
        private readonly logger: () => ClientLogger | undefined,
        private readonly hook: (report: InternalReport) => Effect.Effect<unknown, unknown>,
        private readonly context: () => Context.Context<never> | undefined,
        capacity: number,
        private readonly closedOutcome: "clientClosed" | "subscriptionClosed",
        private readonly track: { add(queue: HookQueue): void; delete(queue: HookQueue): void; closed(): boolean },
    ) {
        this.#queue = Effect.runSync(Queue.bounded<InternalReport>(capacity))
    }

    /** Whether this queue's worker is the given fiber, so a hook that requests shutdown does not join itself */
    owns(fiberId: number) {
        return this.#worker?.id === fiberId
    }

    /** Queue a report for the hook. Never runs the hook inline and never throws */
    offer(report: InternalReport) {
        const logger = this.logger()
        try {
            if (this.#closed || this.track.closed()) {
                if (logger) logReport(logger, report, { outcome: this.closedOutcome })
                return
            }
            if (!Queue.offerUnsafe(this.#queue, report)) {
                logger?.count("reportsDropped")
                if (logger) logReport(logger, report, { outcome: "queueFull" })
                return
            }
            this.#start()
        } catch (fault) {
            logger?.outputFailure(fault)
        }
    }

    #start() {
        if (this.#worker || this.#closed) return
        const owner = this
        const work = Effect.gen(function* () {
            // Because runFork can start synchronously, yield so the worker is recorded before a hook can ask for shutdown
            yield* Effect.yieldNow
            while (!owner.#closed) {
                const next = Queue.takeUnsafe(owner.#queue)
                if (next === undefined || Exit.isFailure(next)) return
                const report = next.value
                owner.#current = report
                const exit = yield* Effect.exit(Effect.suspend(() => owner.hook(report)))
                // The close() call already logged a report whose hook it interrupted
                if (owner.#current !== report) return
                owner.#current = undefined
                owner.#settle(report, exit)
            }
        })
        const context = this.context()
        this.track.add(this)
        const fiber = (context ? Effect.runForkWith(context) : Effect.runFork)(
            work.pipe(
                Effect.ensuring(
                    Effect.sync(() => {
                        if (owner.#worker !== fiber) return
                        owner.#worker = undefined
                        owner.track.delete(owner)
                        // A report offered while this worker was finishing starts a new one
                        if (!owner.#closed && Queue.sizeUnsafe(owner.#queue) > 0) owner.#start()
                    }),
                ),
            ),
        )
        this.#worker = fiber
    }

    #settle(report: InternalReport, exit: Exit.Exit<unknown, unknown>) {
        const logger = this.logger()
        if (!logger) return
        if (Exit.isSuccess(exit)) logReport(logger, report, { handled: true })
        else if (!Cause.hasInterruptsOnly(exit.cause)) logHookFailure(logger, report, exit.cause)
        // The hook interrupted itself: It did not finish, so the report is logged and the next one continues
        else logReport(logger, report, { outcome: "interrupted" })
    }

    /** Stop delivery and interrupt a running hook without waiting for it. The interrupted report and queued reports
     * are logged. Returns the interrupted worker so a caller can allow it a bounded time to finish its cleanup
     */
    close(): Fiber.Fiber<void> | undefined {
        if (this.#closed) return undefined
        this.#closed = true
        const worker = this.#worker
        const current = this.#current
        this.#worker = undefined
        this.#current = undefined
        this.track.delete(this)
        worker?.interruptUnsafe()
        const logger = this.logger()
        if (logger) {
            if (current) logReport(logger, current, { outcome: "interrupted" })
            while (true) {
                const next = Queue.takeUnsafe(this.#queue)
                if (next === undefined || Exit.isFailure(next)) break
                logReport(logger, next.value, { outcome: this.closedOutcome })
            }
        }
        return worker
    }
}

const clientCapacity = 256
/** Longest time shutdown waits for interrupted hooks to finish their cleanup */
const hookInterruptGraceMs = 1_000

/** A wall-clock delay independent of the Effect clock, so a test clock cannot hold shutdown open */
function wallDelay(milliseconds: number): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
        const timer = setTimeout(() => resume(Effect.void), milliseconds)
        return Effect.sync(() => clearTimeout(timer))
    })
}
/** Reports that wait for one subscription's or command router's onError hook */
const subscriptionHookCapacity = 64

/** Client-wide failure reporting: The client-level onError queue, plus every active subscription hook queue so that
 * shutdown can stop them all without waiting for a hook that never finishes
 */
export class FailureReporter {
    readonly #client: HookQueue | undefined
    readonly #active = new Set<HookQueue>()
    #closed = false
    readonly #tracker = {
        add: (queue: HookQueue) => void this.#active.add(queue),
        delete: (queue: HookQueue) => void this.#active.delete(queue),
        closed: () => this.#closed,
    }

    constructor(
        private readonly logger: ClientLogger,
        hook: ((report: InternalReport) => Effect.Effect<unknown, unknown>) | undefined,
        context: () => Context.Context<never> | undefined,
    ) {
        this.#client = hook && new HookQueue(() => logger, hook, context, clientCapacity, "clientClosed", this.#tracker)
    }

    get hasHook() {
        return this.#client !== undefined
    }

    /** Whether the fiber delivers reports to any client or subscription hook */
    owns(fiberId: number) {
        for (const queue of this.#active) if (queue.owns(fiberId)) return true
        return false
    }

    /** A bounded queue for one subscription's own hook, stopped with the client */
    subscriptionQueue(
        hook: (report: InternalReport) => Effect.Effect<unknown, unknown>,
        context: Context.Context<never> | undefined,
    ): HookQueue {
        return new HookQueue(
            () => this.logger,
            hook,
            () => context,
            subscriptionHookCapacity,
            "subscriptionClosed",
            this.#tracker,
        )
    }

    /** Send a report to the client-level hook, or log it. Never throws, so a reporting fault cannot alter the work
     * that failed. The context of the failed handler lets its logged failure replace a held rejection record
     */
    report(input: ReportInput | InternalReport, context?: Context.Context<never>) {
        try {
            const report = "describe" in input ? input : makeReport(input, this.logger.secrets)
            if (report.kind === "handler") this.logger.count("handlerFailures")
            if (!this.#client) logHandlerReport(this.logger, report, context)
            else this.#client.offer(report)
        } catch (fault) {
            this.logger.outputFailure(fault)
        }
    }

    /** Stop hook delivery and interrupt running hooks. Interrupted and queued reports are logged. An interruptible hook
     * gets up to hookInterruptGraceMs to run its cleanup, and a hook that ignores interruption is not awaited
     */
    shutdown(): Effect.Effect<void> {
        return Effect.suspend(() => {
            this.#closed = true
            const workers = [this.#client?.close(), ...[...this.#active].map((queue) => queue.close())].filter(
                (worker) => worker !== undefined,
            )
            if (workers.length === 0) return Effect.void
            return Effect.raceFirst(Fiber.awaitAll(workers).pipe(Effect.asVoid), wallDelay(hookInterruptGraceMs))
        })
    }
}

/** A subscription hook queue for an event bus without a client failure reporter, as in isolated bus use */
export function standaloneHookQueue(
    logger: () => ClientLogger | undefined,
    hook: (report: InternalReport) => Effect.Effect<unknown, unknown>,
    context: Context.Context<never> | undefined,
): HookQueue {
    const tracker = { add: () => undefined, delete: () => undefined, closed: () => false }
    return new HookQueue(logger, hook, () => context, subscriptionHookCapacity, "subscriptionClosed", tracker)
}

/** Adapt a default-API hook to the queue's Effect form, passing the report without its Effect Cause */
export function promiseHook(
    hook: (report: FailureReport) => unknown,
): (report: InternalReport) => Effect.Effect<unknown, unknown> {
    return (report) =>
        Effect.tryPromise({
            try: () => Promise.resolve(hook(publicReport(report))).then(throwIfErr),
            // Keep the thrown or rejected value itself for the hook failure record
            catch: (error) => error,
        })
}

/** A default-API copy of a report without the Effect Cause */
export function publicReport(report: InternalReport): FailureReport {
    const { cause: _cause, ...rest } = report
    return Object.freeze(rest)
}

/**
 * Treat an Err result returned or resolved by an application handler like a throw of its error, so the failure is
 * reported through the same destination instead of being discarded with the handler's return value.
 * Any other returned value is ignored, as before
 */
export function throwIfErr(value: unknown): void {
    if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { isErr?: unknown }).isErr === "function" &&
        "error" in value &&
        (value as unknown as { isErr(): boolean }).isErr()
    )
        throw (value as { readonly error: unknown }).error
}
