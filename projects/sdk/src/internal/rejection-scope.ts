/**
 * Rejection scope: Holds the rest.rejected Warn records of one handler invocation, so a rejected token or permission
 * that fails the handler is logged once, as the handler's failure record, instead of as a Warn and then an Error.
 * Invariant: A held record is logged when the invocation ends, after at most holdMs, or never, when the handler's
 * failure is logged at Error for the same status and Fluxer code. A failure that reaches an onError hook claims
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
}

export class RejectionScope {
    #held: HeldRecord[] = []
    #timer: ReturnType<typeof setTimeout> | undefined
    #ended = false

    /** Hold a rejection record for this invocation. False when the invocation already ended, so the caller logs it */
    hold(logger: ClientLogger, input: LogInput, context: Context.Context<never> | undefined): boolean {
        if (this.#ended) return false
        this.#held.push({ logger, input, context })
        if (this.#timer === undefined) {
            this.#timer = setTimeout(() => this.flush(), holdMs)
            this.#timer.unref?.()
        }
        return true
    }

    /** Drop the held records with the status and Fluxer code of a failure that the handler failure record reports */
    claim(error: unknown) {
        if (this.#held.length === 0 || typeof error !== "object" || error === null) return
        let status: unknown
        let code: unknown
        try {
            const failure = error as {
                readonly status?: unknown
                readonly apiError?: { readonly providerCode?: unknown } | null
            }
            status = failure.status
            code = failure.apiError?.providerCode
        } catch {
            // allow-silent: A thrown value with hostile getters claims nothing, so its rejection record is still logged
            return
        }
        if (status !== 401 && status !== 403) return
        this.#held = this.#held.filter(
            ({ input }) => input.status !== status || (input.fields?.apiError ?? undefined) !== (code ?? undefined),
        )
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
