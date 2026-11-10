import { expect, test } from "vitest"
import { observeUploads, safeFailure } from "./upload-diagnostics.mjs"

test("upload diagnostics preserve transport identity without consuming bodies or exposing capabilities", async () => {
    const records = []
    const body = new ReadableStream(
        {
            pull() {
                throw Error("Must not read request")
            },
        },
        { highWaterMark: 0 },
    )
    const init = { method: "PUT", headers: { Authorization: "private-token" }, body }
    const response = new Response("private-response")
    const url = "https://uploads.fluxer.app/private-key?signature=private-signature"
    const observed = observeUploads(
        async (...args) => {
            expect(args).toEqual([url, init])
            expect(args[1]).toBe(init)
            return response
        },
        (record) => records.push(record),
    )
    expect(await observed(url, init)).toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(body.locked).toBe(false)
    expect(records.map((item) => [item.phase, item.event])).toEqual([
        ["put", "start"],
        ["put", "headers"],
    ])
    expect(JSON.stringify(records)).not.toContain("private")
})

test("failure diagnostics retain only allowlisted classifications and rethrow the original error", async () => {
    const error = Object.assign(new Error("private-secret"), {
        _tag: "MessageError",
        reason: "timeout",
        outcome: "notDispatched",
        status: 403,
        cause: { code: "ECONNRESET", message: "private-secret" },
    })
    expect(safeFailure(error)).toEqual({
        type: "MessageError",
        reason: "timeout",
        outcome: "notDispatched",
        status: 403,
        code: "ECONNRESET",
    })
    expect(
        safeFailure({ _tag: "private", reason: "private", outcome: "private", status: "private", code: "private" }),
    ).toEqual({ type: "unclassified" })
    expect(safeFailure({ _tag: "CollectorError", reason: "notConnected" })).toEqual({
        type: "CollectorError",
        reason: "notConnected",
    })
    const records = []
    const controller = new AbortController()
    controller.abort()
    const observed = observeUploads(
        async () => {
            throw error
        },
        (value) => records.push(value),
    )
    await expect(
        observed("https://uploads.fluxer.app/private", { method: "PUT", signal: controller.signal }),
    ).rejects.toBe(error)
    expect(records[1]).toMatchObject({ phase: "put", event: "error", aborted: true, code: "ECONNRESET" })
    expect(JSON.stringify(records)).not.toContain("private")
})

test("upload phase records separate planning, completion and message requests and stay bounded", async () => {
    const records = []
    const observed = observeUploads(
        async () => new Response(null),
        (value) => records.push(value),
    )
    for (const path of ["attachments", "attachments/complete", "messages", "messages/10"])
        await observed(`https://fluxer.com/api/v1/channels/20/${path}`, { method: "POST" })
    expect(records.filter((item) => item.event === "start").map((item) => item.phase)).toEqual([
        "plan",
        "complete",
        "message",
        "message",
    ])
    await observed("https://example.invalid/private", { method: "PUT" })
    expect(records).toHaveLength(8)
    for (let i = 0; i < 100; i++) await observed("https://uploads.fluxer.app/private", { method: "PUT" })
    expect(records).toHaveLength(128)
})

test.each([
    [{ _tag: "AuthenticationError" }, { type: "AuthenticationError" }],
    [
        { _tag: "ConnectionTimeoutError", timeoutMs: 165000 },
        { type: "ConnectionTimeoutError", timeoutMs: 165000 },
    ],
    [
        { _tag: "ConnectionError", phase: "gateway", reason: "closed", status: 4008 },
        { type: "ConnectionError", phase: "gateway", reason: "closed", closeCode: 4008 },
    ],
    [
        { _tag: "ConnectionError", phase: "discovery", reason: "network", status: 503 },
        { type: "ConnectionError", phase: "discovery", reason: "network", status: 503, providerFault: true },
    ],
    [
        { _tag: "RateLimitError", source: "gateway", retryAfterMs: null },
        { type: "RateLimitError", source: "gateway", retryAfterMs: null },
    ],
    [
        { _tag: "RateLimitError", source: "http", retryAfterMs: 600000 },
        { type: "RateLimitError", source: "http", retryAfterMs: 600000 },
    ],
])("connection diagnostics keep safe classification for %o", (error, expected) => {
    expect(safeFailure({ ...error, message: "synthetic-secret", details: { token: "synthetic-secret" } })).toEqual(
        expected,
    )
})

test("shard diagnostics keep one bounded underlying failure without private or cyclic data", () => {
    const error = {
        _tag: "ShardConnectionError",
        shardId: 2,
        failure: { _tag: "ConnectionTimeoutError", timeoutMs: 165000, message: "synthetic-secret" },
    }
    expect(safeFailure(error)).toEqual({
        type: "ShardConnectionError",
        shardId: 2,
        failure: { type: "ConnectionTimeoutError", timeoutMs: 165000 },
    })
    error.failure = error
    expect(safeFailure(error)).toEqual({
        type: "ShardConnectionError",
        shardId: 2,
        failure: { type: "ShardConnectionError", shardId: 2 },
    })
})

test("connection diagnostics reject invalid fields and tolerate unreadable errors", () => {
    expect(safeFailure({ _tag: "ConnectionTimeoutError", timeoutMs: Infinity })).toEqual({
        type: "ConnectionTimeoutError",
    })
    expect(safeFailure({ _tag: "RateLimitError", source: "gateway", retryAfterMs: -1 })).toEqual({
        type: "RateLimitError",
        source: "gateway",
    })
    expect(safeFailure({ _tag: "ShardConnectionError", shardId: Number.MAX_SAFE_INTEGER + 1 })).toEqual({
        type: "ShardConnectionError",
        failure: { type: "unclassified" },
    })
    expect(
        safeFailure({
            get _tag() {
                throw Error("synthetic-secret")
            },
        }),
    ).toEqual({ type: "unclassified" })
})
