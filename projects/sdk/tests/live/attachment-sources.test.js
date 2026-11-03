import { afterEach, expect, test, vi } from "vitest"
import { createClient } from "../../src/index.js"
import { hostedDiscoveryDocument, hostedDiscoveryUrl } from "../../src/internal/testing/discovery.js"
import { fixtures } from "../../src/internal/testing/fixtures.js"
import { recordMessageBucket, verifySustainedEmptyTimeout } from "./attachment-sources.mjs"

afterEach(() => {
    vi.unstubAllGlobals()
})

// The live stage runs against hosted Fluxer, so the fixture serves its API origin
const discovery = {
    ...hostedDiscoveryDocument,
    endpoints: { ...hostedDiscoveryDocument.endpoints, api_public: "https://fluxer.com/api" },
}
const channelId = "500"
const messagesUrl = `https://fluxer.com/api/v1/channels/${channelId}/messages`

// Fluxer reads an inline upload body until the request ends, as the real network transport does
async function readUntilAborted(body, signal) {
    const reader = body.getReader()
    const aborted = new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    )
    try {
        for (;;) if ((await Promise.race([reader.read(), aborted])).done) break
    } catch (error) {
        await reader.cancel(error).catch(() => {})
        throw error
    }
    return Response.json(null, { status: 400 })
}

test.each(["stream", "file"])(
    "the sustained empty %s stage times out after dispatch although the message route first needs a longer wait",
    async (kind) => {
        vi.stubGlobal("fetch", async (input, init = {}) => {
            const url = String(input)
            if (url === hostedDiscoveryUrl) return Response.json(discovery)
            expect(url).toBe(messagesUrl)
            if (init.body instanceof ReadableStream) return readUntilAborted(init.body, init.signal)
            // An earlier upload in the run used the route's last request until a window longer than the deadline ends
            return Response.json(fixtures.message({ id: "600", channel_id: channelId }), {
                headers: {
                    "x-ratelimit-bucket": "fixture-message-bucket",
                    "x-ratelimit-limit": "1",
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset-after": "1.5",
                },
            })
        })
        const getFetch = () => globalThis.fetch
        const setFetch = (value) => {
            globalThis.fetch = value
        }
        const client = createClient({ token: "200.fixture-only-not-a-credential" })
        const messageBucket = recordMessageBucket(getFetch, setFetch, channelId)
        try {
            expect((await client.instance.resolve()).isOk()).toBe(true)
            expect((await client.messages.send(channelId, { content: "earlier upload" })).isOk()).toBe(true)
            const reports = []
            await verifySustainedEmptyTimeout({
                ops: {
                    async sendFailure(input, options) {
                        const result = await client.messages.send(channelId, input, options)
                        expect(result.isErr()).toBe(true)
                        return result.isErr() ? result.error : undefined
                    },
                },
                getFetch,
                setFetch,
                channelId,
                messageBucket,
                setStage: () => {},
                report: (check) => reports.push(check),
                kind,
            })
            expect(reports).toEqual([`attachment_sources_${kind}_sustained_empty_timeout`])
        } finally {
            messageBucket.stop()
            await client.shutdown()
        }
    },
)
