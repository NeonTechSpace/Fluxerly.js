import { expect, test } from "vitest"
import { observeUploads, safeFailure } from "./live/upload-diagnostics.mjs"

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
        delivery: "notSent",
        status: 403,
        cause: { code: "ECONNRESET", message: "private-secret" },
    })
    expect(safeFailure(error)).toEqual({
        type: "MessageError",
        reason: "timeout",
        outcome: "notSent",
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
        await observed(`https://api.fluxer.app/v1/channels/20/${path}`, { method: "POST" })
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
