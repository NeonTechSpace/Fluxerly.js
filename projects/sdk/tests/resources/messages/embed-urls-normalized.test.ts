import { afterEach, expect, test, vi } from "vitest"
import { modes, setup } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { sendJson, startRestServer, type RecordedRequest } from "../../support/rest-server.js"
import { settle } from "../../support/settle.js"

// Fluxer reads embed URLs after its string normalization (UrlValidators.ts:28-31, 77-95 at 0098958f) and compares
// attachment:// names with the names it stores for uploads (FileValidators.ts:50-66)
const realFetch = globalThis.fetch
afterEach(() => vi.unstubAllGlobals())

const payload = (request: RecordedRequest): Record<string, any> => {
    if (request.body !== undefined) return request.body as Record<string, any>
    const part = request.text.match(/name="payload_json"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/)
    return JSON.parse(part![1]!)
}

async function fixture() {
    const server = await startRestServer({
        fallback: (request, response) => {
            if (request.path === "/v1/channels/20/attachments") {
                sendJson(response, {
                    attachments: payload(request).attachments.map((file: Record<string, unknown>) => ({
                        ...file,
                        content_type: "application/octet-stream",
                        upload_filename: `fixture-${String(file.id)}`,
                        upload_mode: "singlepart",
                        upload_url: `https://fluxer.com/api/fixture-upload/${String(file.id)}`,
                    })),
                })
            } else if (request.path.startsWith("/fixture-upload/")) {
                response.writeHead(204).end()
            } else {
                sendJson(response, {
                    id: "10",
                    channel_id: "20",
                    content: "fixture",
                    author: { id: "30", username: "fixture", bot: true },
                })
            }
        },
    })
    stubFetchWithHostedDiscovery(
        vi.fn((url: string, init: RequestInit) =>
            realFetch(url.replace("https://fluxer.com/api", server.origin), init),
        ),
    )
    return {
        requests: server.requests,
        messages: () => server.requests.filter((request) => request.path.endsWith("/messages")),
    }
}
const file = (filename: string) => ({ filename, data: new Uint8Array([1, 2, 3]) })
const rejected = { reason: "input", outcome: "notDispatched" }

test.each(modes)("%s checks embed URLs on Fluxer's normalized value and sends the raw value", async (mode) => {
    const server = await fixture()
    const client = await setup(mode)
    // Raw length 2,049 plus whitespace, normalized length 2,048
    const long = `  https://example.com/${"a".repeat(2048 - "https://example.com/".length)}  `
    expect(long.length).toBeGreaterThan(2048)
    await settle(client.messages.send("20", { embeds: [{ url: long, author: { name: "n", iconUrl: long } }] }))
    expect(payload(server.requests[0]!).embeds[0]).toMatchObject({ url: long, author: { icon_url: long } })
    for (const url of [
        "   ",
        "https://user:pass@example.com/",
        "https://user@example.com/",
        "https://@example.com/",
        ` ${"x".repeat(2049)} `,
    ]) {
        await expect(settle(client.messages.send("20", { embeds: [{ url }] }))).rejects.toMatchObject(rejected)
        await expect(
            settle(client.messages.send("20", { embeds: [{ footer: { text: "t", iconUrl: url } }] })),
        ).rejects.toMatchObject(rejected)
    }
    expect(server.requests).toHaveLength(1)
})

test.each(modes)("%s matches attachment references to the filename Fluxer stores", async (mode) => {
    const server = await fixture()
    const client = await setup(mode)
    const send = (url: string, name: string) =>
        settle(client.messages.send("20", { embeds: [{ image: { url } }], attachments: [file(name)] }))
    await send(" attachment://a.png ", "a.png")
    await send("attachment://my_photo.png", "my photo.png")
    expect(payload(server.messages()[0]!).embeds[0].image.url).toBe(" attachment://a.png ")
    expect(payload(server.messages()[1]!).embeds[0].image.url).toBe("attachment://my_photo.png")
    await expect(send("attachment://my photo.png", "my photo.png")).rejects.toMatchObject(rejected)
    await expect(send("attachment://", "a.png")).rejects.toMatchObject(rejected)
    expect(server.messages()).toHaveLength(2)
})
