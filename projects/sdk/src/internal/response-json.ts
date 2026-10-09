/**
 * Bounded JSON response reading.
 * Invariant: Decoded body bytes are bounded before parsing, and reader cancellation and release are always awaited.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { TransportError } from "./effect-failures.js"

/** Bounded response parsing completed, but releasing its owned reader failed */
export class ResponseJsonCleanupError extends Error {
    constructor(
        readonly cause: unknown,
        readonly status: number,
    ) {
        super("JSON response cleanup failed", { cause })
        this.name = "ResponseJsonCleanupError"
    }
}

/**
 * Bound decoded HTTP body bytes before parsing JSON, then await reader cancellation and release.
 * Invalid UTF-8 or JSON returns undefined. A body whose connection fails mid-read throws a TransportError
 */
export async function readResponseJson(
    response: Response,
    maxBytes = 16_777_216,
    signal?: AbortSignal,
): Promise<unknown> {
    const reader = response.body?.getReader()
    if (!reader) return undefined
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let result = "",
        bytes = 0,
        ended = false
    try {
        while (true) {
            const next = await reader.read().catch((error: unknown) => {
                // A failed read leaves the stream errored, so it needs no cancellation
                ended = true
                throw new TransportError(error, "response body read")
            })
            if (next.done) {
                ended = true
                break
            }
            bytes += next.value.byteLength
            if (bytes > maxBytes) return undefined
            result += decoder.decode(next.value, { stream: true })
        }
        return JSON.parse(result + decoder.decode()) as unknown
    } catch (error) {
        if (error instanceof TransportError) throw error
        // allow-silent: Invalid UTF-8 or JSON returns undefined, which the decoder reports as an unusable response
        return undefined
    } finally {
        const failures: unknown[] = []
        const actions: (() => Promise<void> | void)[] = [
            ...(!ended ? [() => reader.cancel()] : []),
            () => reader.releaseLock(),
        ]
        for (const action of actions) {
            try {
                await action()
            } catch (error) {
                // Re-cancelling a fetch reader after its own request abort can reject with that exact reason
                if (signal?.aborted && error === signal.reason) continue
                failures.push(error)
            }
        }
        if (failures.length)
            // oxlint-disable-next-line no-unsafe-finally -- a reader cleanup failure deliberately replaces the parsed result
            throw new ResponseJsonCleanupError(
                failures.length === 1 ? failures[0] : new AggregateError(failures, "JSON response cleanup failed"),
                response.status,
            )
    }
}
