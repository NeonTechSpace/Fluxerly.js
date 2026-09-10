const tags = new Set([
    "MessageError",
    "MessageOperationError",
    "AttachmentDownloadError",
    "CollectorError",
    "ConfigurationError",
    "ClientClosedError",
    "CancelledError",
    "SdkDefect",
])
const reasons = new Set([
    "input",
    "busy",
    "rejected",
    "network",
    "response",
    "timeout",
    "rateLimit",
    "notFound",
    "notConnected",
    "connectionLost",
    "overflow",
    "filter",
    "tooLarge",
    "untrustedUrl",
])
const outcomes = new Set(["notSent", "notDispatched", "rejected", "unknown"])
const codes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
    "ABORT_ERR",
    "ERR_ASSERTION",
])

/** Project known classifications only, never arbitrary messages, stacks, causes or response bodies */
export function safeFailure(error) {
    try {
        const result = {
            type: tags.has(error?._tag) ? error._tag : error?.name === "SdkDefect" ? "SdkDefect" : "unclassified",
        }
        if (result.type === "SdkDefect" && Array.isArray(error.reasons))
            result.reasons = error.reasons.slice(0, 8).map((reason) => ({
                kind: ["Failure", "Defect", "Interruption"].includes(reason?.kind) ? reason.kind : "unclassified",
                ...(reason?.kind === "Failure" && tags.has(reason.failure?._tag)
                    ? { failure: reason.failure._tag }
                    : {}),
            }))
        if (reasons.has(error?.reason)) result.reason = error.reason
        const outcome = error?.outcome ?? error?.delivery
        if (outcomes.has(outcome)) result.outcome = outcome
        if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) result.status = error.status
        const code = [error?.code, error?.cause?.code].find((value) => codes.has(value))
        if (code) result.code = code
        return result
    } catch {
        return { type: "unclassified" }
    }
}

/** Observe SDK fetch only; preserve requests, responses, streams and thrown errors without reading their bodies */
export function observeUploads(original, emit) {
    const began = performance.now()
    let id = 0,
        count = 0
    return async (...args) => {
        const [input, init] = args
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        const method = init?.method ?? (input instanceof Request ? input.method : "GET")
        const phase =
            url.origin === "https://uploads.fluxer.app"
                ? "put"
                : url.origin !== "https://api.fluxer.app"
                  ? undefined
                  : url.pathname.endsWith("/attachments/complete")
                    ? "complete"
                    : url.pathname.endsWith("/attachments")
                      ? "plan"
                      : ["POST", "PATCH"].includes(method) && /\/messages(?:\/\d+)?$/.test(url.pathname)
                        ? "message"
                        : undefined
        if (!phase) return original(...args)
        const request = ++id,
            start = performance.now()
        const report = (extra) => {
            if (count++ < 128)
                emit({
                    request,
                    phase,
                    elapsedMs: Math.round(performance.now() - began),
                    durationMs: Math.round(performance.now() - start),
                    ...extra,
                })
        }
        report({ event: "start" })
        try {
            const response = await original(...args)
            report({ event: "headers", status: response.status })
            return response
        } catch (error) {
            report({
                event: "error",
                ...safeFailure(error),
                aborted: (init?.signal ?? input?.signal)?.aborted === true,
            })
            throw error
        }
    }
}
