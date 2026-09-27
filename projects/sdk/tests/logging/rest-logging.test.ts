import { afterEach, expect, test, vi } from "vitest"
import type { Client } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { modes, setup } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs, counters } from "../support/log-capture.js"
import { expectErr, settle } from "../support/settle.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const target = { id: "10", channelId: "20" }
const wire = (content: string) => ({ id: "10", channel_id: "20", content, author: { id: "30", username: "fixture" } })

test.each(modes)("%s unsafe REST logging reads at most 64 KiB of a response copy, then cancels it", async (mode) => {
    const body = JSON.stringify(wire("y".repeat(200_000)))
    let pulled = 0
    let cancelled = false
    // The logging copy is a separate stream, so the bytes it pulls show exactly how much logging read
    vi.spyOn(Response.prototype, "clone").mockImplementation(function (this: Response) {
        let offset = 0
        const bytes = new TextEncoder().encode(body)
        return new Response(
            new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (offset >= bytes.length) return controller.close()
                    const chunk = bytes.subarray(offset, offset + 16_384)
                    offset += chunk.length
                    pulled += chunk.length
                    controller.enqueue(chunk)
                },
                cancel() {
                    cancelled = true
                },
            }),
            { status: this.status, headers: this.headers },
        )
    })
    stubFetchWithHostedDiscovery(async () => new Response(body, { headers: { "content-type": "application/json" } }))
    const logs = captureLogs()
    const client = await setup(mode, { logging: { ...logs.logging, unsafe: { payloads: true, categories: ["rest"] } } })
    const fetched = await settle(
        mode === "default"
            ? (client as Client).messages.fetch(target)
            : (client as NativeClient).messages.fetch(target),
    )
    // Decoding reads its own stream, so the full content still arrives
    expect(fetched.content).toHaveLength(200_000)
    await vi.waitFor(() => expect(logs.withCode("rest.payloadReceived")).toHaveLength(1))
    expect(logs.withCode("rest.payloadReceived")[0]).toMatchObject({ fields: { truncated: true } })
    expect(pulled).toBeLessThanOrEqual(65_536 + 16_384)
    expect(cancelled).toBe(true)
})

test.each(modes)(
    "%s a rate limit that would pass the deadline fails at once and is not counted as a wait",
    async (mode) => {
        stubFetchWithHostedDiscovery(async () => Response.json({ retry_after: 5, global: false }, { status: 429 }))
        const logs = captureLogs()
        const client = await setup(mode, { logging: { ...logs.logging, categories: { ratelimit: "debug" } } })
        const startedAt = Date.now()
        const error = await expectErr(
            mode === "default"
                ? (client as Client).messages.fetch(target, { timeoutMs: 1_000 })
                : (client as NativeClient).messages.fetch(target, { timeoutMs: 1_000 }),
        )
        expect(Date.now() - startedAt).toBeLessThan(1_000)
        expect(error).toMatchObject({ reason: "rateLimit", retryAfterMs: 5_000 })
        expect(counters(client).rateLimitWaits).toBe(0)
        expect(logs.withCode("ratelimit.wait")).toEqual([])
        expect(logs.withCode("ratelimit.deadline")).toEqual([
            expect.objectContaining({ level: "warn", delayMs: 5_000, route: "/channels/:id/messages/:id" }),
        ])
    },
)
