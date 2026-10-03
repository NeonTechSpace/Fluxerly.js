// cspell:words unstub singlepart
import { Effect, Exit, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createWebhookClient, type MessageSearchChannel, type WebhookMessageInput } from "../../../src/index.js"
import { createWebhookClient as createNativeWebhook } from "../../../src/effect.js"
import { modes, setup, type Mode } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { sendJson, startRestServer, type RecordedRequest } from "../../support/rest-server.js"
import { settle, typedResult } from "../../support/settle.js"

const target = { id: "10", channelId: "20" }
const realFetch = globalThis.fetch
const wire = (webhook = false) => ({
    id: "10",
    channel_id: "20",
    content: "fixture",
    author: { id: "30", username: "fixture", bot: true },
    ...(webhook ? { webhook_id: "100" } : {}),
})

afterEach(() => vi.unstubAllGlobals())

function payload(request: RecordedRequest): Record<string, any> {
    if (request.body !== undefined) return request.body as Record<string, any>
    const part = request.text.match(/name="payload_json"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/)
    if (!part) throw new Error("Expected multipart message payload")
    return JSON.parse(part[1]!)
}

async function fixture() {
    const state = { name: null as unknown }
    const server = await startRestServer({
        fallback: (request, response) => {
            if (request.path === "/v1/search/messages") {
                sendJson(response, {
                    messages: [wire()],
                    channels: [{ id: "20", name: state.name, type: 3 }],
                    total: 1,
                    hits_per_page: payload(request).hits_per_page,
                    page: 1,
                })
            } else if (request.path === "/v1/channels/20/attachments") {
                sendJson(response, {
                    attachments: payload(request).attachments.map((file: Record<string, unknown>) => ({
                        ...file,
                        content_type: "application/octet-stream",
                        upload_filename: `fixture-${String(file.id)}`,
                        upload_mode: "singlepart",
                        upload_url: `https://api.fluxer.app/fixture-upload/${String(file.id)}`,
                    })),
                })
            } else if (
                request.path.startsWith("/fixture-upload/") ||
                request.method === "DELETE" ||
                request.path.includes("/pins/") ||
                request.path.endsWith("/bulk-delete")
            ) {
                response.writeHead(204).end()
            } else {
                sendJson(response, wire(request.path.includes("/webhooks/")))
            }
        },
    })
    const fetch = vi.fn((url: string, init: RequestInit) =>
        realFetch(url.replace("https://api.fluxer.app", server.origin), init),
    )
    stubFetchWithHostedDiscovery(fetch)
    return { ...server, state, fetch }
}

async function webhook(mode: Mode) {
    const options = { id: "100", token: "fixture_only_webhook_token" }
    if (mode === "default") {
        const client = createWebhookClient(options)
        onTestFinished(async () => {
            await settle(client.shutdown())
        })
        return client
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createNativeWebhook(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return client
}

test.each(modes)("%s preserves null group-DM search names and rejects non-string names", async (mode) => {
    const server = await fixture()
    const client = await setup(mode)
    const page = await settle(client.messages.search({ channelId: "20" }))
    if (page.indexing) throw new Error("Expected search results")
    expect(page.channels[0]).toEqual({ id: "20", name: null, type: 3 } satisfies MessageSearchChannel)
    for (const invalid of [42, {}]) {
        server.state.name = invalid
        await expect(settle(client.messages.search({ channelId: "20" }))).rejects.toMatchObject({
            operation: "search",
            reason: "response",
        })
    }
})

test.each(modes)("%s traverses search pages containing an unnamed group DM", async (mode) => {
    const server = await fixture()
    const client = await setup(mode)
    const source = client.messages.iterateSearch({ channelId: "20" }, {}, { maxItems: 1 })
    const ids: string[] = []
    if (Stream.isStream(source)) {
        const result = await Effect.runPromise(typedResult(Stream.runCollect(source)))
        if (result._tag === "Failure") throw result.failure
        ids.push(...result.success.map((message) => message.id))
    } else {
        for await (const result of source) {
            if (result.isErr()) throw result.error
            ids.push(result.value.id)
        }
    }
    expect(ids).toEqual(["10"])
    expect(server.requests).toHaveLength(1)
})

const deliveries = [
    { content: "ordinary" },
    { content: "reply", messageReference: { type: "reply", target } },
    { messageReference: { type: "forward", source: { source: target } } },
] as const

test.each(modes)("%s sends only application-chosen webhook nonces for every delivery kind", async (mode) => {
    const server = await fixture()
    const client = await webhook(mode)
    for (const delivery of deliveries) {
        for (const nonce of ["operation-42", 42]) {
            await settle(client.send({ ...delivery, nonce } as WebhookMessageInput))
            expect(payload(server.requests.at(-1)!).nonce).toBe(String(nonce))
        }
        await settle(client.send(delivery))
        expect(payload(server.requests.at(-1)!)).not.toHaveProperty("nonce")
    }
    await settle(client.send({ messageReference: { type: "forward", source: { source: target, nonce: "source-42" } } }))
    expect(payload(server.requests.at(-1)!).nonce).toBe("source-42")
    expect(server.requests).toHaveLength(10)
})

test.each(modes)("%s rejects invalid and ambiguous webhook nonces before HTTP", async (mode) => {
    const server = await fixture()
    const client = await webhook(mode)
    for (const delivery of deliveries) {
        for (const nonce of ["", "x".repeat(33), -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, {}]) {
            await expect(settle(client.send({ ...delivery, nonce } as never))).rejects.toMatchObject({
                reason: "input",
                outcome: "notDispatched",
                inputValidation: { path: "nonce" },
            })
        }
    }
    for (const nonce of ["top-level", "source"]) {
        await expect(
            settle(
                client.send({
                    nonce,
                    messageReference: { type: "forward", source: { source: target, nonce: "source" } },
                } as never),
            ),
        ).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path: "nonce", constraint: "relationship" },
        })
    }
    await expect(
        settle(client.send({ messageReference: { type: "forward", source: { source: target, nonce: -1 } } })),
    ).rejects.toMatchObject({ reason: "input", outcome: "notDispatched", inputValidation: { path: "nonce" } })
    expect(server.fetch).not.toHaveBeenCalled()
})

test.each(modes)(
    "%s accepts image and video embed uploads while rejecting invalid attachment references on every route",
    async (mode) => {
        const server = await fixture()
        const client = await setup(mode)
        const hook = await webhook(mode)
        for (const filename of ["clip.MP4", "picture.avif", "picture.psd", "clip.m2ts"]) {
            const input = {
                embeds: [
                    { image: { url: `attachment://${filename}` }, thumbnail: { url: `attachment://${filename}` } },
                ],
                attachments: [{ filename, data: new Uint8Array([1, 2, 3]) }],
            }
            await settle(client.messages.send("20", input))
            await settle(client.messages.edit(target, input))
            await settle(hook.send(input))
            const sent = server.requests.filter((request) => /\/messages(?:\/10)?$|\/webhooks\//.test(request.path))
            for (const request of sent.slice(-3)) {
                expect(payload(request).embeds).toEqual(input.embeds)
                expect(payload(request).attachments[0].filename).toBe(filename)
            }
        }
        expect(
            server.requests.filter((request) => /\/messages(?:\/10)?$|\/webhooks\//.test(request.path)),
        ).toHaveLength(12)
        const dispatched = server.fetch.mock.calls.length
        const file = (filename: string) => ({ filename, data: new Uint8Array([1, 2, 3]) })
        for (const [filename, attachments] of [
            ["notes.txt", [file("notes.txt")]],
            ["source.ts", [file("source.ts")]],
            ["sound.mp3", [file("sound.mp3")]],
            ["document.pdf", [file("document.pdf")]],
            ["missing.mp4", [file("other.mp4")]],
            ["clip.mp4", [file("clip.mp4"), file("clip.mp4")]],
            ["clip.mp4", []],
            ["clip.mp4", [file("clip.MP4")]],
            ["bad name.mp4", [file("bad name.mp4")]],
        ] as const) {
            const input = { embeds: [{ image: { url: `attachment://${filename}` } }], attachments }
            for (const operation of [
                () => settle(client.messages.send("20", input)),
                () => settle(client.messages.edit(target, input)),
                () => settle(hook.send(input)),
            ]) {
                await expect(operation()).rejects.toMatchObject({
                    reason: "input",
                    outcome: "notDispatched",
                    inputValidation: { path: "embeds[].image.url" },
                })
            }
        }
        expect(server.fetch).toHaveBeenCalledTimes(dispatched)
    },
)

test.each(modes)("%s sends audit reasons only as headers on the four audited message mutations", async (mode) => {
    const server = await fixture()
    const client = await setup(mode)
    const options = { auditReason: "  Moderation fixture %20  " }
    await settle(client.messages.delete(target, options))
    await settle(client.messages.deleteMany("20", ["10", "11"], options))
    await settle(client.messages.pin(target, options))
    await settle(client.messages.unpin(target, options))
    expect(server.requests.map((request) => [request.method, request.path])).toEqual([
        ["DELETE", "/v1/channels/20/messages/10"],
        ["POST", "/v1/channels/20/messages/bulk-delete"],
        ["PUT", "/v1/channels/20/pins/10"],
        ["DELETE", "/v1/channels/20/pins/10"],
    ])
    for (const request of server.requests) {
        expect(request.headers["x-audit-log-reason"]).toBe("Moderation fixture %20")
        expect(request.query.has("auditReason")).toBe(false)
        expect(request.query.has("audit_reason")).toBe(false)
        expect(request.text).not.toContain("Moderation fixture")
    }
    expect(server.requests[1]!.body).toEqual({ message_ids: ["10", "11"] })
    await settle(client.messages.delete(target))
    expect(server.requests.at(-1)!.headers).not.toHaveProperty("x-audit-log-reason")
})

test.each(modes)(
    "%s rejects invalid mutation audit reasons and reasons on unaudited message operations",
    async (mode) => {
        const server = await fixture()
        const client = await setup(mode)
        for (const auditReason of [" ", "x".repeat(513), "line\nbreak", "non-ASCII é", 42]) {
            const options = { auditReason } as never
            for (const operation of [
                () => settle(client.messages.delete(target, options)),
                () => settle(client.messages.deleteMany("20", ["10", "11"], options)),
                () => settle(client.messages.pin(target, options)),
                () => settle(client.messages.unpin(target, options)),
            ]) {
                await expect(operation()).rejects.toMatchObject({
                    reason: "input",
                    outcome: "notDispatched",
                    inputValidation: { path: "options.auditReason" },
                })
            }
        }
        const options = { auditReason: "Not accepted" } as never
        for (const operation of [
            () => settle(client.messages.fetch(target, options)),
            () => settle(client.messages.addReaction(target, "👍", options)),
            () => settle(client.messages.send("20", "fixture", options)),
        ]) {
            await expect(operation()).rejects.toMatchObject({
                reason: "input",
                outcome: "notDispatched",
                inputValidation: { path: "options", constraint: "allowedFields" },
            })
        }
        expect(server.fetch).not.toHaveBeenCalled()
    },
)
