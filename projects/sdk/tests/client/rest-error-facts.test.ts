import { afterEach, expect, test, vi } from "vitest"
import { Stream } from "effect"
import type { Client } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { modes, setup } from "../support/both-apis.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { expectErr, settle } from "../support/settle.js"

const discoveryUrl = "https://fluxer.app/.well-known/fluxer"
const source = () => Object.assign(new Error("Private transport URL and credential"), { code: "ECONNRESET" })
afterEach(() => vi.unstubAllGlobals())

test.each(modes)("%s preserves a sanitized discovery cause on a resource failure", async (mode) => {
    const client = await setup(mode, {
        transport: {
            fetch: async () => {
                throw source()
            },
        },
    })
    const error = await expectErr(client.rest.request({ method: "POST", path: "/channels/20/messages", body: {} }))
    expect(error).toMatchObject({ reason: "network", outcome: "notDispatched", cause: { code: "ECONNRESET" } })
    expect(JSON.stringify(error)).not.toContain("Private transport")
    expect((error as Error).cause).not.toHaveProperty("cause")
})

test.each(modes)("%s preserves a sanitized discovery cause on an attachment failure", async (mode) => {
    const client = await setup(mode, {
        transport: {
            fetch: async () => {
                throw source()
            },
        },
    })
    const attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 1,
        flags: 0,
        url: "https://fluxerusercontent.com/attachments/20/40/fixture.bin",
    }
    const error = await expectErr(client.attachments.download(attachment, { maxBytes: 100 }))
    expect(error).toMatchObject({ reason: "network", cause: { code: "ECONNRESET" } })
    expect(JSON.stringify(error)).not.toContain("Private transport")
})

test.each(modes)("%s keeps unknown provider codes when a 429 wait exceeds the deadline", async (mode) => {
    const client = await setup(mode, {
        transport: {
            fetch: async (url) =>
                url === discoveryUrl
                    ? Response.json(hostedDiscoveryDocument)
                    : Response.json({ code: "NEW_RATE_LIMIT", retry_after: 60 }, { status: 429 }),
        },
    })
    const error = await expectErr(
        client.rest.request({ method: "POST", path: "/channels/20/messages", body: {}, timeoutMs: 1000 }),
    )
    expect(error).toMatchObject({ reason: "rateLimit", status: 429, details: { providerCode: "NEW_RATE_LIMIT" } })
    expect((error as Error).message).toContain("NEW_RATE_LIMIT")
})

test.each(modes)("%s keeps unknown provider codes when a 429 has no usable delay", async (mode) => {
    const client = await setup(mode, {
        transport: {
            fetch: async (url) =>
                url === discoveryUrl
                    ? Response.json(hostedDiscoveryDocument)
                    : Response.json({ code: "NEW_RATE_LIMIT" }, { status: 429 }),
        },
    })
    const error = await expectErr(client.rest.request({ method: "POST", path: "/channels/20/messages", body: {} }))
    expect(error).toMatchObject({ reason: "rateLimit", status: 429, details: { providerCode: "NEW_RATE_LIMIT" } })
    expect((error as Error).message).toContain("NEW_RATE_LIMIT")
})

test.each(modes)("%s preserves sanitized causes while opening and reading attachment streams", async (mode) => {
    let bodyFailure = false
    const attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 1,
        flags: 0,
        url: "https://fluxerusercontent.com/attachments/20/40/fixture.bin",
    }
    const client = await setup(mode, {
        transport: {
            fetch: async (url) => {
                if (url === discoveryUrl) return Response.json(hostedDiscoveryDocument)
                if (bodyFailure) {
                    const response = new Response(null)
                    vi.spyOn(response, "body", "get").mockReturnValue({
                        getReader: () => ({
                            read: async () => {
                                throw source()
                            },
                            cancel: async () => {},
                            releaseLock: () => {},
                        }),
                    } as unknown as ReadableStream<Uint8Array<ArrayBuffer>>)
                    return response
                }
                throw source()
            },
        },
    })
    for (bodyFailure of [false, true]) {
        let error: unknown
        if (mode === "native")
            error = await expectErr(
                Stream.runCollect((client as NativeClient).attachments.stream(attachment, { maxBytes: 100 })),
            )
        else
            for await (const result of (client as Client).attachments.stream(attachment, { maxBytes: 100 })) {
                if (result.isErr()) error = result.error
                else expect.fail("Expected a stream transport failure")
            }
        expect(error).toMatchObject({ reason: "network", cause: { code: "ECONNRESET" } })
        expect(JSON.stringify(error)).not.toContain("Private transport")
    }
})

test.each(modes)("%s preserves only the sanitized attachment download transport cause", async (mode) => {
    const client = await setup(mode, {
        transport: {
            fetch: async (url) => {
                if (url === discoveryUrl) return Response.json(hostedDiscoveryDocument)
                if (url.includes("/messages/"))
                    return Response.json({
                        id: "10",
                        channel_id: "20",
                        content: "",
                        author: { id: "30", username: "fixture" },
                        attachments: [
                            {
                                id: "40",
                                filename: "fixture.bin",
                                size: 4,
                                flags: 0,
                                url: "https://fluxerusercontent.com/attachments/20/40/fixture.bin",
                                proxy_url: "https://fluxerusercontent.com/attachments/20/40/fixture.bin",
                            },
                        ],
                    })
                throw source()
            },
        },
    })
    const message = await settle(client.messages.fetch({ channelId: "20", id: "10" }))
    const error = await expectErr(client.attachments.download(message.attachments![0]!, { maxBytes: 100 }))
    expect(error).toMatchObject({ reason: "network", cause: { code: "ECONNRESET" } })
    expect(JSON.stringify(error)).not.toContain("Private transport")
    expect((error as Error).cause).not.toHaveProperty("cause")
})
