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

/** Bound decoded HTTP body bytes before parsing JSON, then await reader cancellation and release */
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
            const next = await reader.read()
            if (next.done) {
                ended = true
                break
            }
            bytes += next.value.byteLength
            if (bytes > maxBytes) return undefined
            result += decoder.decode(next.value, { stream: true })
        }
        return JSON.parse(result + decoder.decode()) as unknown
    } catch {
        return undefined
    } finally {
        const failures: unknown[] = []
        for (const action of [...(!ended ? [() => reader.cancel()] : []), () => reader.releaseLock()]) {
            try {
                await action()
            } catch (error) {
                // Re-cancelling a fetch reader after its own request abort can reject with that exact reason
                if (signal?.aborted && error === signal.reason) continue
                failures.push(error)
            }
        }
        if (failures.length)
            throw new ResponseJsonCleanupError(
                failures.length === 1 ? failures[0] : new AggregateError(failures, "JSON response cleanup failed"),
                response.status,
            )
    }
}
