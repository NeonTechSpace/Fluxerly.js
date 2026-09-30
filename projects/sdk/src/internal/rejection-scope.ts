/**
 * Rejection scope: Holds the rest.rejected Warn records of one handler invocation, so a rejected token or permission
 * that fails the handler within one second is logged once, as the handler's failure record, instead of as a Warn and then an Error.
 * Invariant: A held record is logged when the invocation ends, after at most holdMs, or never, when the handler's
 * failure is logged at Error for that rejection's identity, directly or in its cause chain. A handler that fails more
 * than one second after the rejection also logs its failure, because the Warn has already been flushed. A failure that reaches an onError hook claims
 * nothing, so the Warn still shows a rejection that the application handles. Native handlers find the scope in their
 * fiber context. Default-API handler code runs in async context storage, which an operation reads when it starts and
 * passes on in its fiber context.
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

export class RejectionScope {
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

    /** Drop only records for this failure's identity, following a bounded cause chain and domain conversion links */
    claim(error: unknown) {
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
        this.#held = this.#held.filter(({ error }) => !identities.has(error))
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

/** The scope of the default-API handler whose code is running, read when an operation starts */
const storage = new AsyncLocalStorage<RejectionScope>()

/** Run default-API handler code so that the operations it starts hold their rejection records in scope */
export function inRejectionScope<A>(scope: RejectionScope | undefined, run: () => A): A {
    return scope === undefined ? run() : storage.run(scope, run)
}

/** The scope of the running default-API handler code, if any */
export function currentRejectionScope(): RejectionScope | undefined {
    return storage.getStore()
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
