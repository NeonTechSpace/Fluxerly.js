import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { ConfigurationError, createWebhookClient } from "../../src/index.js"
import { createWebhookClient as createNativeWebhook } from "../../src/effect.js"
import { modes, setup, type Mode } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { expectErr, settle } from "../support/settle.js"

// These follow Fluxer at commit 0098958f. Its string types measure and test the value after normalizeString, which
// removes U+000C and U+202E and trims (packages/schema/src/primitives/SchemaPrimitives.ts:20-22 and :176-183), while
// the SDK sends the caller's raw string. So a name, code, reason, path segment or URL is accepted or refused on that
// normalized view

const notDispatched = { reason: "input", outcome: "notDispatched" }
const image = "aW1hZ2U="
const target = { guildId: "200", id: "100" }
const formFeed = "\u000c"
const rlo = "‮"

type Seen = { path: string; method: string; body: any; reason: string | null }

/** Record every operation request and answer it with the given reply */
function stubRest(reply: (seen: Seen) => Response) {
    const requests: Seen[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const seen = {
            path: new URL(url).pathname,
            method: init.method ?? "GET",
            body: init.body ? JSON.parse(String(init.body)) : undefined,
            reason: new Headers(init.headers).get("X-Audit-Log-Reason"),
        }
        requests.push(seen)
        return reply(seen)
    })
    return requests
}

/** Whether the operation reached the transport, whatever the answer made of it */
async function dispatched(requests: readonly Seen[], start: () => Parameters<typeof settle>[0]): Promise<boolean> {
    const before = requests.length
    try {
        await settle(start() as never)
    } catch {
        // allow-silent: Only the dispatch matters here, and the stub answer need not decode
    }
    return requests.length > before
}

afterEach(() => vi.unstubAllGlobals())

const emoji = { id: "100", name: "build_ok", animated: false }

test.each(modes)("%s checks emoji names on Fluxer's normalized value and sends the raw name", async (mode) => {
    const api = await setup(mode, { token: "fixture_only" })
    const requests = stubRest(({ path }) =>
        Response.json(path.endsWith("/bulk") ? { success: [emoji], failed: [] } : emoji),
    )
    // Fails on the old code: The ASCII pattern ran on the raw name, so surrounding whitespace, U+000C and U+202E failed it
    await settle(api.emojis.create("200", { name: "  build_ok ", image }))
    await settle(api.emojis.create("200", { name: `b${formFeed}u${rlo}ild_ok`, image }))
    await settle(api.emojis.edit(target, { name: ` ${rlo}build_ok\n` }))
    await settle(api.emojis.createMany("200", [{ name: "\tbuild_ok ", image }]))
    expect(requests.map(({ body }) => body.name ?? body.emojis[0].name)).toEqual([
        "  build_ok ",
        `b${formFeed}u${rlo}ild_ok`,
        ` ${rlo}build_ok\n`,
        "\tbuild_ok ",
    ])

    // Still refused: The normalized value is too short or long, or holds other characters
    const sent = requests.length
    for (const name of [" a ", rlo, "a".repeat(33), ` ${"a".repeat(33)} `, "bad name", "emoji!", "é1"]) {
        expect(await expectErr(api.emojis.create("200", { name, image }))).toMatchObject(notDispatched)
        expect(await expectErr(api.emojis.edit(target, { name }))).toMatchObject(notDispatched)
        expect(await expectErr(api.emojis.createMany("200", [{ name, image }]))).toMatchObject(notDispatched)
    }
    expect(requests).toHaveLength(sent)
    // A name of exactly 32 characters between padding is within the limit
    await settle(api.emojis.create("200", { name: ` ${"a".repeat(32)} `, image }))
})

test.each(modes)(
    "%s accepts the vanity codes Fluxer normalizes and compares the answer with that code",
    async (mode) => {
        const api = await setup(mode, { token: "fixture_only" })
        const answers = ["my-code", "a-b", "other"]
        const requests = stubRest(() => Response.json({ code: answers.shift() }))
        // Fails on the old code: The lowercase pattern ran on the raw code, so uppercase and whitespace failed locally
        expect(await settle(api.guilds.editVanityUrl("200", "  My   Code "))).toMatchObject({ code: "my-code" })
        expect(await settle(api.guilds.editVanityUrl("200", `A--B${formFeed}`))).toMatchObject({ code: "a-b" })
        expect(requests.map(({ body }) => body)).toEqual([{ code: "  My   Code " }, { code: `A--B${formFeed}` }])

        // The answer must be Fluxer's normalized code, not the raw input, so an unrelated code still fails
        const mismatch = await expectErr(api.guilds.editVanityUrl("200", "My Code"))
        expect(mismatch).toMatchObject({ outcome: "unknown" })
        expect(requests).toHaveLength(3)

        // Still refused after normalization
        // Fluxer also refuses any code that contains fluxer (GuildVanityService.ts:70)
        for (const code of ["-", " a ", "a_b", "My!", "x".repeat(33), "-ab", "ab-", rlo, "fluxer", "My Fluxer Club"])
            expect(await expectErr(api.guilds.editVanityUrl("200", code))).toMatchObject(notDispatched)
        expect(requests).toHaveLength(3)
    },
)

test.each(modes)("%s measures the audit reason on Fluxer's normalized value", async (mode) => {
    const api = await setup(mode)
    const requests = stubRest(() => new Response(null, { status: 204 }))
    const decode = (header: string | null) => Buffer.from(header ?? "", "latin1").toString("utf8")

    // Fails on the old code: A reason of only U+202E is not blank to trim, but Fluxer reduces it to nothing and drops it
    for (const auditReason of [rlo, `  ${rlo}${rlo} `, `${rlo} `])
        expect(await expectErr(api.members.kick({ guildId: "20", userId: "30" }, { auditReason }))).toMatchObject({
            ...notDispatched,
            inputValidation: { path: "options.auditReason", constraint: "length" },
        })
    expect(requests).toHaveLength(0)

    // Fails on the old code: 515 raw code units were refused, but Fluxer keeps the 512 that remain
    const longest = `${"x".repeat(512)}${rlo.repeat(3)}`
    await settle(api.members.kick({ guildId: "20", userId: "30" }, { auditReason: ` ${longest} ` }))
    expect(decode(requests[0]?.reason ?? null)).toBe(longest)

    // One code unit more after normalization is still refused
    expect(
        await expectErr(api.members.kick({ guildId: "20", userId: "30" }, { auditReason: `${"x".repeat(513)}${rlo}` })),
    ).toMatchObject(notDispatched)
    expect(requests).toHaveLength(1)
})

test.each(modes)("%s limits a reaction emoji path segment to 64 normalized code units", async (mode) => {
    const api = await setup(mode, { token: "fixture_only" })
    const requests = stubRest(() => new Response(null, { status: 204 }))
    const message = { id: "10", channelId: "20" }
    expect(await dispatched(requests, () => api.messages.addReaction(message, "a".repeat(64)))).toBe(true)
    expect(await dispatched(requests, () => api.messages.addReaction(message, `${"a".repeat(64)}${rlo}`))).toBe(true)
    // Fails on the old code: 65 through 128 code units were sent, and so was a name that normalizes to nothing
    for (const emoji of ["a".repeat(65), "a".repeat(128), rlo, `${rlo}${rlo}`])
        expect(await expectErr(api.messages.addReaction(message, emoji))).toMatchObject(notDispatched)
    expect(requests).toHaveLength(2)
})

test.each(modes)("%s limits an invite code path segment to 256 normalized code units", async (mode) => {
    const api = await setup(mode, { token: "fixture_only" })
    const requests = stubRest(() => Response.json({}, { status: 404 }))
    expect(await dispatched(requests, () => api.invites.fetch("a".repeat(256)))).toBe(true)
    expect(await dispatched(requests, () => api.invites.fetch(`${"a".repeat(256)}${rlo}`))).toBe(true)
    // Fails on the old code: Any length was sent, and so was a code that normalizes to nothing
    const refused = { ...notDispatched, inputValidation: { path: "code", constraint: "format" } }
    for (const code of ["a".repeat(257), rlo]) {
        expect(await expectErr(api.invites.fetch(code))).toMatchObject(refused)
        expect(await expectErr(api.invites.delete(code))).toMatchObject(refused)
    }
    expect(requests).toHaveLength(2)
})

test.each(modes)("%s limits a webhook token to 256 characters", async (mode) => {
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const create = async (token: string) => {
        const options = { id: "100", token }
        const webhook =
            mode === "native"
                ? await Effect.runPromise(createNativeWebhook(options).pipe(Effect.provideService(Scope.Scope, scope)))
                : createWebhookClient(options)
        onTestFinished(async () => {
            const stopped = webhook.shutdown()
            await (Effect.isEffect(stopped) ? Effect.runPromise(stopped) : stopped)
        })
        return webhook
    }
    await create("a".repeat(256))
    // Fails on the old code: Tokens up to 512 characters were accepted
    await expect(create("a".repeat(257))).rejects.toBeInstanceOf(ConfigurationError)
    await expect(create("a".repeat(512))).rejects.toBeInstanceOf(ConfigurationError)
})

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

test.each(modes)("%s applies Fluxer's URL rules to a link channel URL", async (mode) => {
    const api = await openTestClient(mode)
    const channel = api.fixtures.channel({ id: "300", guild_id: "200" })
    const create = api.rest.respond("POST /guilds/200/channels", { body: channel })
    const edit = api.rest.respond("PATCH /channels/300", { body: channel })
    const body = (route: typeof create, index: number) =>
        (route.requests()[index]?.body as { url?: string } | undefined)?.url

    // Fails on the old code: A form feed made the host unparsable, although Fluxer removes it before parsing
    await settle(
        api.client.channels.create("200", { type: 0, name: "docs", url: ` https://exam${formFeed}ple.com/a ` }),
    )
    await settle(api.client.channels.edit("300", { url: `${rlo}https://example.com/b` }))
    expect(body(create, 0)).toBe(` https://exam${formFeed}ple.com/a `)
    expect(body(edit, 0)).toBe(`${rlo}https://example.com/b`)

    // Fails on the old code: Each of these parsed as an absolute URL, but Fluxer refuses them
    const refused = [
        "ftp://example.com/file",
        "mailto:someone@example.com",
        "https://user:secret@example.com/",
        "https://user@example.com/",
        // disallow_auth refuses any @ before the path, even with an empty user name
        "https://@example.com/",
        "HTTPS://example.com/",
        `https://example.com/${"a".repeat(2030)}`,
    ]
    for (const url of refused) {
        expect(await expectErr(api.client.channels.create("200", { type: 0, name: "docs", url }))).toMatchObject(
            notDispatched,
        )
        expect(await expectErr(api.client.channels.edit("300", { url }))).toMatchObject(notDispatched)
    }
    // Blank text is not the exact empty string, so it is refused, while the exact empty string still clears the URL
    expect(await expectErr(api.client.channels.edit("300", { url: "   " }))).toMatchObject(notDispatched)
    await settle(api.client.channels.edit("300", { url: "" }))
    expect(body(edit, 1)).toBe("")
    // The longest allowed URL, padded with whitespace that Fluxer trims
    const longest = `https://example.com/${"a".repeat(2028)}`
    await settle(api.client.channels.edit("300", { url: `  ${longest}  ` }))
    expect(body(edit, 2)).toBe(`  ${longest}  `)
    expect(create.requests()).toHaveLength(1)
    expect(edit.requests()).toHaveLength(3)
})
