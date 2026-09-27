/**
 * Application observer: Delivers structured measurements from the observe client option.
 * Invariant: The observer belongs to the client's logger, so every SDK area that logs can also observe without new
 * plumbing. Observations are frozen and carry only route templates, names, codes, counts and durations, never payloads
 * or credentials. An observer fault is counted and reported like a log sink fault and never changes SDK work.
 * Implements [SDK contracts: Logging](/docs/SDK-CONTRACTS.md#logging)
 */
import type { Observation, Observer } from "#sdk/observer"
import type { ClientLogger } from "./logging.js"
import { maskText } from "./masking.js"

const observers = new WeakMap<ClientLogger, Observer>()

/** Attach the application observer to a client's logger */
export function setObserver(logger: ClientLogger, observer: Observer) {
    observers.set(logger, observer)
}

/** Whether this logger has an observer, so callers can skip measuring work nobody reads */
export function observing(logger: ClientLogger | undefined): logger is ClientLogger {
    return logger !== undefined && observers.has(logger)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        typeof (value as { then?: unknown }).then === "function"
    )
}

/** Deliver one observation synchronously. Faults are counted and reported like log sink faults, and never thrown */
export function emitObservation(logger: ClientLogger | undefined, observation: Observation) {
    if (logger === undefined) return
    const observer = observers.get(logger)
    if (observer === undefined) return
    try {
        const result: unknown = observer(Object.freeze(observation))
        if (isThenable(result))
            void Promise.resolve(result).then(undefined, (error: unknown) => logger.outputFailure(error))
    } catch (error) {
        logger.outputFailure(error)
    }
}

/** The error name and code of a failure for a handler observation, masked like log records */
export function failureFacts(
    error: unknown,
    secrets: readonly string[],
): { readonly errorName?: string; readonly errorCode?: string } {
    try {
        if (!(error instanceof Error)) return { errorName: error === null ? "null" : typeof error }
        const code = (error as { code?: unknown }).code
        return {
            errorName: maskText(String(error.name), secrets),
            ...(typeof code === "string" ? { errorCode: maskText(code, secrets) } : {}),
        }
    } catch {
        // allow-silent: An error whose name or code getter throws still produces its observation, without those facts
        return {}
    }
}
