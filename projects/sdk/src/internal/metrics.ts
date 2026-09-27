/**
 * Effect metrics for REST duration, rate-limit waits, reconnects, drops and handler failures.
 * Invariant: Updates are synchronous and cheap, and without an exporter they only update the in-memory registry. The
 * observe client option receives matching measurements in both APIs through the observer module.
 * Implements [SDK contracts: Logging](/docs/SDK-CONTRACTS.md#logging)
 */
import * as Context from "effect/Context"
import * as Metric from "effect/Metric"

const durationBoundaries = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000]

const restDuration = Metric.histogram("fluxerly_rest_duration_ms", {
    description: "Duration of completed REST requests in milliseconds, by route template and HTTP status",
    boundaries: durationBoundaries,
})
const rateLimitWait = Metric.histogram("fluxerly_ratelimit_wait_ms", {
    description: "Time REST requests waited for rate limits in milliseconds",
    boundaries: durationBoundaries,
})
const reconnects = Metric.counter("fluxerly_gateway_reconnects_total", {
    description: "Gateway reconnection attempts after an established connection was lost",
    incremental: true,
})
const eventsDropped = Metric.counter("fluxerly_events_dropped_total", {
    description: "Events not delivered to a subscription, by reason",
    incremental: true,
})
const handlerFailures = Metric.counter("fluxerly_handler_failures_total", {
    description: "Event and command callbacks that threw or rejected, by event",
    incremental: true,
})

const empty = Context.empty() as Context.Context<never>

/** Metric updates are synchronous and cheap. Without an exporter they only update the in-memory registry */
export const metrics = {
    rest(route: string, status: number | null, durationMs: number, context: Context.Context<never> = empty) {
        Metric.withAttributes(restDuration, { route, status: status === null ? "none" : String(status) }).updateUnsafe(
            durationMs,
            context,
        )
    },
    rateLimitWait(durationMs: number, context: Context.Context<never> = empty) {
        rateLimitWait.updateUnsafe(durationMs, context)
    },
    reconnect(context: Context.Context<never> = empty) {
        reconnects.updateUnsafe(1, context)
    },
    dropped(reason: string, amount: number, context: Context.Context<never> = empty) {
        Metric.withAttributes(eventsDropped, { reason }).updateUnsafe(amount, context)
    },
    handlerFailure(event: string, context: Context.Context<never> = empty) {
        Metric.withAttributes(handlerFailures, { event }).updateUnsafe(1, context)
    },
}
