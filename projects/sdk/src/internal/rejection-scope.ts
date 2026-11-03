/**
 * Rejection scope: Holds the rest.rejected Warn records of one handler invocation, so a rejected token or permission
 * that fails the handler within one second is logged once, as the handler's failure record, instead of as a Warn and then an Error.
 * Invariant: A held record is logged when the invocation ends, after at most holdMs, or never, when the handler's
 * failure is logged at Error for that rejection's identity, directly or in its cause chain, and names the record's
 * community or channel. A record for another target than the one the failure names is logged. A handler that fails more
 * than one second after the rejection also logs its failure, because the Warn has already been flushed. A failure that reaches an onError hook claims
 * nothing, so the Warn still shows a rejection that the application handles. Native handlers find the scope in their
 * fiber context. Default-API handler code runs in async context storage, which an operation reads when it starts and
 * passes on in its fiber context.
 * A scope is also the callback run of its invocation: Each default operation the invocation's code starts counts as an
 * SDK call of the run until it settles, so a manual test clock can tell a run awaiting the SDK from one awaiting its own
 * work. A client scheduled task run is a callback run without a rejection scope.
 * Implements [SDK contracts: User-handler failures](/docs/SDK-CONTRACTS.md#user-handler-failures)
 */
import { AsyncLocalStorage } from "node:async_hooks"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type { ClientLogger, LogInput } from "./logging.js"

/** Longest time a record waits for its handler, so a handler that runs for a long time still shows its rejections */
const holdMs = 1_000

interface HeldRecord {
    readonly logger: ClientLogger
    readonly input: LogInput
    readonly context: Context.Context<never> | undefined
    readonly error: object
}

/** Private identity links keep domain error conversion from changing which rejection a handler reports */
const rejectionSources = new WeakMap<object, object>()

/** Link a converted failure to its source without changing the public error's cause or retaining either globally */
export function linkRejectionError<A>(error: A, source: object): A {
    if (typeof error === "object" && error !== null) rejectionSources.set(error, source)
    return error
}

/**
 * One running default-API application callback, such as a handler invocation or a scheduled task run, and the SDK calls
 * its code is awaiting. A manual test clock moves past a run only while it awaits an SDK call, because every SDK call of
 * a test client waits only on the test transport or that clock, while the application's own I/O and timers do not
 */
export class CallbackRun {
    #calls = 0

    /** Count an SDK call the run's code started. The returned function ends it, and later calls do nothing */
    beginCall(): () => void {
        this.#calls++
        let ended = false
        return () => {
            if (ended) return
            ended = true
            this.#calls--
        }
    }

    /** Whether the run's code is awaiting at least one SDK call */
    get inSdkCall(): boolean {
        return this.#calls > 0
    }
}

/** The callback runs of one owner that are in progress */
export class CallbackRuns {
    readonly #runs = new Set<CallbackRun>()

    /** List a run until the returned function removes it */
    track(run: CallbackRun): () => void {
        this.#runs.add(run)
        return () => void this.#runs.delete(run)
    }

    /** Runs in progress whose code is not awaiting an SDK call, so they may be waiting on the application's own work */
    get outsideSdk(): number {
        let count = 0
        for (const run of this.#runs) if (!run.inSdkCall) count++
        return count
    }
}

export class RejectionScope extends CallbackRun {
    #held: HeldRecord[] = []
    #timer: ReturnType<typeof setTimeout> | undefined
    #ended = false

    /** Hold a rejection record for this invocation. False when the invocation already ended, so the caller logs it */
    hold(logger: ClientLogger, input: LogInput, context: Context.Context<never> | undefined, error: object): boolean {
        if (this.#ended) return false
        this.#held.push({ logger, input, context, error })
        if (this.#timer === undefined) {
            this.#timer = setTimeout(() => this.flush(), holdMs)
            this.#timer.unref?.()
        }
        return true
    }

    /** Drop only records for this failure's identity, following a bounded cause chain and domain conversion links.
     * A matching record stays held when keep returns true for it, such as one whose target the failure cannot name
     */
    claim(error: unknown, keep: (input: LogInput) => boolean = () => false) {
        if (this.#held.length === 0) return
        const identities = new Set<object>()
        for (let depth = 0; depth <= 4 && typeof error === "object" && error !== null; depth++) {
            if (identities.has(error)) break
            let source: object | undefined = error
            for (let links = 0; links <= 4 && source !== undefined; links++) {
                if (identities.has(source)) break
                identities.add(source)
                source = rejectionSources.get(source)
            }
            try {
                error = (error as { readonly cause?: unknown }).cause
            } catch {
                // allow-silent: A hostile cause getter ends traversal, while already matched identities remain usable
                break
            }
        }
        this.#held = this.#held.filter(({ error, input }) => !identities.has(error) || keep(input))
    }

    /** Log every held record */
    flush() {
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        const held = this.#held
        this.#held = []
        for (const { logger, input, context } of held) logger.log(input, context)
    }

    /** End the invocation: Log what is still held, and log later rejections at once */
    end() {
        this.#ended = true
        this.flush()
    }
}

/** The scope of the handler invocation a fiber runs for */
const CurrentRejectionScope = Context.Reference<RejectionScope | undefined>("@neontechspace/fluxerly/RejectionScope", {
    defaultValue: () => undefined,
})

/** The run of the default-API callback whose code is running, read when an operation starts */
const storage = new AsyncLocalStorage<CallbackRun>()

/**
 * Run default-API callback code so that the operations it starts count as its SDK calls and, for a rejection scope,
 * hold their rejection records in scope
 */
export function inRejectionScope<A>(scope: CallbackRun | undefined, run: () => A): A {
    return scope === undefined ? run() : storage.run(scope, run)
}

/** The run of the running default-API callback code, if any */
export function currentCallbackRun(): CallbackRun | undefined {
    return storage.getStore()
}

/** The scope of the running default-API handler code, if any */
export function currentRejectionScope(): RejectionScope | undefined {
    const run = storage.getStore()
    return run instanceof RejectionScope ? run : undefined
}

/** Provide a scope to an Effect, so its operations and callbacks hold their rejection records in it */
export function withRejectionScope<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    scope: RejectionScope | undefined,
): Effect.Effect<A, E, R> {
    return scope === undefined ? effect : Effect.provideService(effect, CurrentRejectionScope, scope)
}

/** The scope in a fiber context */
export function fiberRejectionScope(context: Context.Context<never>): RejectionScope | undefined {
    return Context.get(context, CurrentRejectionScope)
}
