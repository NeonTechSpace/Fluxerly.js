import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createTestClient as createDefaultTestClient, fixtures } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { createWebhookClient } from "../../src/index.js"
import { createWebhookClient as createNativeWebhook } from "../../src/effect.js"
import { fluxerHttpUrl } from "../../src/internal/field-text.js"
import { modes, setup, type Mode } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { expectErr, settle } from "../support/settle.js"

// These follow Fluxer at commit 0098958f. URLType also runs validator.isURL with require_tld, disallow_auth and no
// trailing dot (packages/schema/src/primitives/UrlValidators.ts:8-21, 44-49, 77-80), and hosted Fluxer runs outside
// development mode, so the host must be an IP address or a domain name with a top-level domain. The accepted and
// refused lists below were checked against validator 13.15.35, the version in Fluxer's lockfile. Each refused host
// passed the old SDK check, which left the host to Fluxer

const accepted = [
    "https://example.com",
    "https://EXAMPLE.com/a?b#c",
    "http://127.0.0.1",
    "http://127.0.0.1:8080/x",
    "http://[::1]",
    "http://[::1]:8080/a",
    "https://xn--80ak6aa92e.com",
    "https://пример.рф",
    "https://a-b.example.org:443",
    "https://example.com:",
    // @ after the path is not part of the host
    "https://example.com/@user",
]
const refusedHosts = [
    "http://localhost",
    "http://localhost:3000",
    "http://myservice:8080",
    "https://example.c",
    "https://example.123",
    "https://example.com.",
    "https://a_b.example.com",
    "https://-a.example.com",
    "https://a-.example.com",
    "https://example..com",
    `https://${"a".repeat(64)}.com`,
    "https://256.1.1.1",
    "https://example.com:0",
    "https://example.com:65536",
    "https://example.com:8a",
    "http://[1::2::3]",
    // Whitespace or angle brackets anywhere in the normalized URL
    "https://example.com/a b",
    "https://example.com/<x>",
]

test("fluxerHttpUrl applies Fluxer's host rules", () => {
    for (const url of accepted) expect(fluxerHttpUrl(url), url).toBe(true)
    // Fails on the old code: Each of these parsed as an http URL, and the host was left to Fluxer
    for (const url of refusedHosts) expect(fluxerHttpUrl(url), url).toBe(false)
    // Surrounding whitespace, U+000C and U+202E are removed before the check, as Fluxer does
    expect(fluxerHttpUrl(" \u000chttps://example.com‮ ")).toBe(true)
})

const notDispatched = { reason: "input", outcome: "notDispatched" }

async function openTestClient(mode: Mode) {
    if (mode === "default") {
        const test = createDefaultTestClient()
        onTestFinished(() => test.shutdown())
        return test
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
}

afterEach(() => vi.unstubAllGlobals())

test.each(modes)("%s refuses link channel and embed URLs whose host Fluxer refuses", async (mode) => {
    const api = await openTestClient(mode)
    const channel = api.fixtures.channel({ id: "300", guild_id: "200" })
    const create = api.rest.respond("POST /guilds/200/channels", { body: channel })
    const edit = api.rest.respond("PATCH /channels/300", { body: channel })
    const send = api.rest.respond("POST /channels/300/messages", {
        body: api.fixtures.message({ channel_id: "300" }),
    })
    const embeds = (url: string) => [
        { title: "Build", url },
        { author: { name: "Build", url } },
        { author: { name: "Build", iconUrl: url } },
        { footer: { text: "Build", iconUrl: url } },
        { image: { url } },
        { thumbnail: { url } },
    ]
    for (const url of ["http://localhost:3000/a", "https://intranet/build"]) {
        const error = await expectErr(api.client.channels.create("200", { type: 0, name: "docs", url }))
        expect(error).toMatchObject({ ...notDispatched, inputValidation: { path: "url" } })
        expect((error as { inputValidation?: { explanation: string } }).inputValidation?.explanation).toContain(
            "top-level domain",
        )
        expect(await expectErr(api.client.channels.edit("300", { url }))).toMatchObject(notDispatched)
        for (const embed of embeds(url)) {
            const refused = await expectErr(api.client.messages.send("300", { embeds: [embed] }))
            expect(refused).toMatchObject(notDispatched)
            expect((refused as { inputValidation?: { explanation: string } }).inputValidation?.explanation).toContain(
                "top-level domain",
            )
        }
    }
    expect(create.requests()).toHaveLength(0)
    expect(edit.requests()).toHaveLength(0)
    expect(send.requests()).toHaveLength(0)
    // An IP address host passes, as in Fluxer
    await settle(api.client.channels.edit("300", { url: "http://192.0.2.1/a" }))
    for (const embed of embeds("https://192.0.2.1/a.png"))
        await settle(api.client.messages.send("300", { embeds: [embed] }))
    expect(edit.requests()).toHaveLength(1)
    expect(send.requests()).toHaveLength(6)
})

test.each(modes)("%s refuses a webhook avatarUrl whose host Fluxer refuses", async (mode) => {
    const options = { id: "100", token: "test_only_secret" }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const webhook =
        mode === "native"
            ? await Effect.runPromise(createNativeWebhook(options).pipe(Effect.provideService(Scope.Scope, scope)))
            : createWebhookClient(options)
    onTestFinished(async () => {
        const stopped = webhook.shutdown()
        await (Effect.isEffect(stopped) ? Effect.runPromise(stopped) : stopped)
    })
    const fetch = stubFetchWithHostedDiscovery(async () =>
        Response.json({
            id: "400",
            channel_id: "300",
            webhook_id: "100",
            content: "Hi",
            author: { id: "100", username: "Hook", bot: true },
        }),
    )
    const sent = () => fetch.mock.calls.filter(([url]) => String(url).includes("/webhooks/")).length
    const error = await expectErr(webhook.send({ content: "Hi", avatarUrl: "http://localhost/avatar.png" }))
    expect(error).toMatchObject({ ...notDispatched, inputValidation: { path: "avatarUrl" } })
    expect((error as { inputValidation?: { explanation: string } }).inputValidation?.explanation).toContain(
        "top-level domain",
    )
    expect(sent()).toBe(0)
    await settle(webhook.send({ content: "Hi", avatarUrl: "https://cdn.example.com/avatar.png" }))
    expect(sent()).toBe(1)
})

// A Fluxer server in development mode passes require_tld: false (UrlValidators.ts:22-26, 44-49 and
// fluxer_api/src/api/App.ts:45 at 0098958f), so a client for a custom instance leaves the top-level domain to it.
// validator 13.15.35 isFQDN still refuses a numeric top-level domain without require_tld, because allow_numeric_tld
// stays false
const custom = "https://community.example"
const customDiscovery = {
    api_code_version: 7,
    endpoints: {
        api_public: "https://api.community.example",
        gateway: "wss://gateway.community.example",
        media: "https://media.community.example",
        static_cdn: "https://static.community.example",
        webapp: "https://app.community.example",
        invite: "https://invite.community.example",
    },
    features: { presigned_attachment_uploads: false },
}

/** Stub fetch for the custom instance and record each REST request after discovery */
function stubCustomInstance() {
    const requests: string[] = []
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
            if (url === `${custom}/.well-known/fluxer`) return Response.json(customDiscovery)
            requests.push(`${init.method} ${url.replace("https://api.community.example/v1", "")}`)
            if (url.endsWith("/channels/300/messages")) return Response.json(fixtures.message({ channel_id: "300" }))
            if (url.endsWith("/channels/300") || url.endsWith("/guilds/200/channels"))
                return Response.json(fixtures.channel({ id: "300", guild_id: "200", type: 998 }))
            if (url.includes("/webhooks/"))
                return Response.json({
                    id: "400",
                    channel_id: "300",
                    webhook_id: "100",
                    content: "Hi",
                    author: { id: "100", username: "Hook", bot: true },
                })
            throw Error(`Unexpected request ${init.method} ${url}`)
        }),
    )
    return requests
}

test.each(modes)("%s skips the top-level domain rule locally for a custom instance", async (mode) => {
    const requests = stubCustomInstance()
    const client = await setup(mode, { instance: { url: custom } })
    // Fails on the old code: The SDK refused these hosts locally for every instance
    await settle(client.messages.send("300", { embeds: [{ title: "Build", url: "http://localhost:3000/a" }] }))
    await settle(client.messages.send("300", { embeds: [{ image: { url: "http://intranet/a.png" } }] }))
    await settle(client.channels.edit("300", { url: "http://localhost:3000" }))
    expect(requests).toEqual(["POST /channels/300/messages", "POST /channels/300/messages", "PATCH /channels/300"])
    // A numeric top-level domain and every label rule still apply
    for (const url of ["http://example.123", "http://123", "http://a_b.local", "http://-a"])
        expect(await expectErr(client.messages.send("300", { embeds: [{ title: "Build", url }] })), url).toMatchObject(
            notDispatched,
        )
    expect(await expectErr(client.channels.edit("300", { url: "http://example.123" }))).toMatchObject(notDispatched)
    expect(requests).toHaveLength(3)
})

test.each(modes)("%s keeps the top-level domain rule for an explicitly selected hosted instance", async (mode) => {
    const fetch = stubFetchWithHostedDiscovery(async () => Response.json({}))
    const client = await setup(mode, { instance: { url: "https://fluxer.com" } })
    expect(
        await expectErr(client.messages.send("300", { embeds: [{ title: "Build", url: "http://localhost:3000" }] })),
    ).toMatchObject(notDispatched)
    expect(await expectErr(client.channels.edit("300", { url: "http://localhost:3000" }))).toMatchObject(notDispatched)
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s webhook client skips the top-level domain rule locally for a custom instance", async (mode) => {
    const requests = stubCustomInstance()
    const options = { id: "100", token: "test_only_secret", instance: { url: custom } }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const webhook =
        mode === "native"
            ? await Effect.runPromise(createNativeWebhook(options).pipe(Effect.provideService(Scope.Scope, scope)))
            : createWebhookClient(options)
    onTestFinished(async () => {
        const stopped = webhook.shutdown()
        await (Effect.isEffect(stopped) ? Effect.runPromise(stopped) : stopped)
    })
    // Fails on the old code: The SDK refused this host locally for every instance
    await settle(webhook.send({ content: "Hi", avatarUrl: "http://localhost:3000/avatar.png" }))
    await settle(webhook.send({ content: "Hi", embeds: [{ title: "Build", url: "http://localhost:3000" }] }))
    expect(requests).toHaveLength(2)
    expect(await expectErr(webhook.send({ content: "Hi", avatarUrl: "http://example.123/avatar.png" }))).toMatchObject({
        ...notDispatched,
        inputValidation: { path: "avatarUrl" },
    })
    expect(requests).toHaveLength(2)
})

test("fluxerHttpUrl keeps the hosted rule outside a client operation", () => {
    expect(fluxerHttpUrl("http://localhost:3000")).toBe(false)
})
