import { Effect, Exit, Scope } from "effect"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { createWebhookClient, oauth, type FluxerlyError, type LoggingOptions } from "../../src/index.js"
import { createWebhookClient as createNativeWebhook, oauth as nativeOAuth } from "../../src/effect.js"
import { modes, setup, type Mode } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs } from "../support/log-capture.js"
import { expectErr } from "../support/settle.js"

// What a REST failure tells the reader: a suggested fix, unrecognized Fluxer codes, the failing response field, and
// the Warn records that surface configuration problems even when the application handles the Result

afterEach(() => {
    vi.unstubAllGlobals()
})

const message = { id: "10", channel_id: "20", content: "x", author: { id: "30", username: "fixture" } }

/** A webhook client for one API style, closed when the current test finishes */
async function webhookClient(mode: Mode, logging?: LoggingOptions) {
    const options = { id: "100", token: "fixture-webhook-token", ...(logging === undefined ? {} : { logging }) }
    if (mode === "default") {
        const client = createWebhookClient(options)
        onTestFinished(async () => void (await client.shutdown()))
        return client
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createNativeWebhook(options).pipe(Scope.provide(scope)))
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return client
}

/** An OAuth client for one API style, closed when the current test finishes */
async function oauthClient(mode: Mode, logging?: LoggingOptions) {
    const config = {
        clientId: "1",
        clientSecret: "fixture-client-secret",
        ...(logging === undefined ? {} : { logging }),
    }
    if (mode === "default") {
        const client = oauth.create(config)
        onTestFinished(async () => void (await client.shutdown()))
        return client
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(nativeOAuth.create(config).pipe(Scope.provide(scope)))
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return client
}

const exchange = { code: "fixture-code", redirectUri: "https://example.com/callback", codeVerifier: "a".repeat(43) }

describe.each(modes)("%s REST rejection guidance", (mode) => {
    async function sendHint(status: number, body: object): Promise<string | undefined> {
        stubFetchWithHostedDiscovery(async () => Response.json(body, { status }))
        const client = await setup(mode)
        return ((await expectErr(client.messages.send("20", { content: "x" }))) as FluxerlyError).hint
    }

    test.each([401, 403, 404])(
        "a send rejected with HTTP %i and no Fluxer code carries a suggested fix",
        async (status) => {
            expect(await sendHint(status, {})).toEqual(expect.any(String))
        },
    )

    test.each([
        { status: 403, body: { code: "MISSING_PERMISSIONS" } },
        { status: 403, body: { code: "MISSING_ACCESS" } },
        { status: 403, body: { code: "TWO_FACTOR_REQUIRED" } },
        {
            status: 400,
            body: { code: "INVALID_FORM_BODY", errors: [{ path: "content", code: "BASE_TYPE_MAX_LENGTH" }] },
        },
    ])("a send rejected with HTTP $status $body.code carries a fix specific to that code", async ({ status, body }) => {
        const specific = await sendHint(status, body)
        expect(specific).toEqual(expect.any(String))
        expect(specific).not.toBe(await sendHint(status, {}))
    })

    test("an unrecognized Fluxer code is kept in details and the message instead of being dropped", async () => {
        stubFetchWithHostedDiscovery(async () =>
            Response.json({ code: "SOMETHING_NEW", message: "private" }, { status: 403 }),
        )
        const client = await setup(mode)
        const error = await expectErr(client.messages.send("20", { content: "x" }))
        expect(error).toMatchObject({ apiError: null, details: { providerCode: "SOMETHING_NEW" } })
        expect((error as FluxerlyError).message).toContain("SOMETHING_NEW")
        expect((error as FluxerlyError).message).not.toContain("private")
    })

    test("a rejected credential gets the fix for the credential the request sent", async () => {
        let body: unknown = {}
        stubFetchWithHostedDiscovery(async () => Response.json(body, { status: 401 }))
        const bot = (await expectErr((await setup(mode)).messages.send("20", "x"))) as FluxerlyError
        expect(bot.hint).toMatch(/bot token/)
        const webhook = (await expectErr((await webhookClient(mode)).send("x"))) as FluxerlyError
        expect(webhook.hint).toMatch(/webhook ID and token/)
        const client = await oauthClient(mode)
        const user = (await expectErr(client.fetchIdentity("fixture-access-token"))) as FluxerlyError
        expect(user.hint).toMatch(/user's access token/)
        const exchanged = (await expectErr(client.exchangeCode(exchange))) as FluxerlyError
        expect(exchanged.hint).toMatch(/client ID and client secret/)
        // An RFC invalid_client answer names the client credentials even on a call that sent the user's token
        body = { error: "invalid_client" }
        const invalidClient = (await expectErr(client.fetchIdentity("fixture-access-token"))) as FluxerlyError
        expect(invalidClient.hint).toMatch(/client ID and client secret/)
        for (const error of [webhook, user, exchanged, invalidClient]) expect(error.hint).not.toMatch(/bot/)
    })

    test("OAuth and cleanup errors keep an unrecognized Fluxer code and the failing response field", async () => {
        stubFetchWithHostedDiscovery(async () =>
            Response.json({ code: "SOMETHING_NEW", message: "private" }, { status: 400 }),
        )
        const identity = (await expectErr(
            (await oauthClient(mode)).fetchIdentity("fixture-access-token"),
        )) as FluxerlyError
        expect(identity).toMatchObject({ apiError: null, details: { providerCode: "SOMETHING_NEW" } })
        expect(identity.message).toContain("SOMETHING_NEW")
        expect(identity.message).not.toContain("private")
        const client = await setup(mode)
        const selection = { authorId: "30", maxScanned: 10, maxSelected: 1 }
        const rejected = (await expectErr(client.messages.previewCleanup("20", selection))) as FluxerlyError
        expect(rejected).toMatchObject({
            reason: "rejected",
            details: { providerCode: "SOMETHING_NEW" },
            cause: { details: { providerCode: "SOMETHING_NEW" } },
        })
        expect(rejected.message).toContain("SOMETHING_NEW")
        stubFetchWithHostedDiscovery(async () => Response.json([{ ...message, channel_id: "21" }]))
        const unusable = (await expectErr(client.messages.previewCleanup("20", selection))) as FluxerlyError
        expect(unusable).toMatchObject({ reason: "response", details: { responseField: expect.any(String) } })
        expect((unusable.cause as FluxerlyError).details.responseField).toBe(unusable.details.responseField)
    })

    test("an unrecognized validation code keeps its field path, and an empty validation list adds no empty text", async () => {
        stubFetchWithHostedDiscovery(async (url) =>
            Response.json(
                String(url).includes("/messages/10")
                    ? { code: "INVALID_FORM_BODY", errors: [] }
                    : { code: "INVALID_FORM_BODY", errors: [{ path: "content", code: "BASE_TYPE_MAX_LENGTH" }] },
                { status: 400 },
            ),
        )
        const client = await setup(mode)
        const sent = (await expectErr(client.messages.send("20", { content: "x" }))) as FluxerlyError & {
            apiError: { validationErrors: readonly { providerCode: string; path?: string }[] }
        }
        expect(sent.apiError.validationErrors).toEqual([
            expect.objectContaining({ providerCode: "BASE_TYPE_MAX_LENGTH", path: "content" }),
        ])
        expect(sent.message).toContain("content")
        const edited = (await expectErr(
            client.messages.edit({ id: "10", channelId: "20" }, { content: "x" }),
        )) as FluxerlyError
        // No separator is left without text between it and the next separator
        expect(edited.message).not.toMatch(/[.;,:]\s*[.;,]/)
    })

    test("a response with an unexpected shape names the failing field and logs one Warn", async () => {
        stubFetchWithHostedDiscovery(async (url) =>
            Response.json(
                String(url).includes("/messages/10") ? { ...message, channel_id: "21" } : { id: "20", type: "weird" },
            ),
        )
        const logs = captureLogs()
        const client = await setup(mode, { logging: logs.logging })
        const channel = await expectErr(client.channels.fetch("20"))
        expect(channel).toMatchObject({ reason: "response", details: { responseField: expect.any(String) } })
        // A failing field path is named in the message, not only in details
        expect((channel as FluxerlyError).message).toContain(String((channel as FluxerlyError).details.responseField))
        const fetched = await expectErr(client.messages.fetch({ id: "10", channelId: "20" }))
        expect(fetched).toMatchObject({ reason: "response", details: { responseField: "channelMismatch" } })
        const warnings = logs.withCode("rest.responseRejected")
        expect(warnings.map((record) => [record.level, record.fields?.field])).toEqual([
            ["warn", (channel as FluxerlyError).details.responseField],
            ["warn", "channelMismatch"],
        ])
    })

    test("a hierarchy check keeps the failing step's unrecognized code, response field and error", async () => {
        let body: unknown = { code: "SOMETHING_NEW" }
        let status = 403
        stubFetchWithHostedDiscovery(async () => Response.json(body, { status }))
        const client = await setup(mode)
        const member = { guildId: "20", userId: "30" }
        const rejected = (await expectErr(client.members.fetchCanManage(member))) as FluxerlyError
        expect(rejected).toMatchObject({
            operation: "members.fetchCanManage",
            reason: "rejected",
            details: { providerCode: "SOMETHING_NEW", read: true },
            cause: { details: { providerCode: "SOMETHING_NEW" } },
        })
        expect(rejected.message).toContain("SOMETHING_NEW")
        body = { id: "20", type: "weird" }
        status = 200
        const unusable = (await expectErr(client.members.fetchCanManage(member))) as FluxerlyError
        expect(unusable).toMatchObject({ reason: "response", details: { responseField: expect.any(String) } })
        expect((unusable.cause as FluxerlyError).details.responseField).toBe(unusable.details.responseField)
    })

    test("401 and 403 rejections log one deduplicated Warn with the Fluxer code even when the Result is handled", async () => {
        stubFetchWithHostedDiscovery(async () => Response.json({ code: "MISSING_PERMISSIONS" }, { status: 403 }))
        const logs = captureLogs()
        const client = await setup(mode, { logging: { ...logs.logging, categories: { rest: "debug" } } })
        for (let attempt = 0; attempt < 3; attempt++) await expectErr(client.messages.send("20", { content: "x" }))
        const warnings = logs.withCode("rest.rejected")
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toMatchObject({
            level: "warn",
            status: 403,
            route: "/channels/:id/messages",
            fields: { apiError: "MISSING_PERMISSIONS", hint: expect.any(String) },
        })
        // Debug request records carry the Fluxer code too
        expect(logs.withCode("rest.request").map((record) => record.fields?.apiError)).toEqual([
            "MISSING_PERMISSIONS",
            "MISSING_PERMISSIONS",
            "MISSING_PERMISSIONS",
        ])
    })

    test("webhook and OAuth clients log a rejected credential once through their logging option", async () => {
        let body: unknown = {}
        stubFetchWithHostedDiscovery(async () => Response.json(body, { status: 401 }))
        const webhookLogs = captureLogs()
        const webhook = await webhookClient(mode, webhookLogs.logging)
        for (let attempt = 0; attempt < 2; attempt++) await expectErr(webhook.send("x"))
        expect(webhookLogs.withCode("rest.rejected")).toEqual([
            expect.objectContaining({
                level: "warn",
                status: 401,
                fields: expect.objectContaining({ hint: expect.stringMatching(/webhook ID and token/) }),
            }),
        ])
        const oauthLogs = captureLogs()
        const client = await oauthClient(mode, oauthLogs.logging)
        // A rejected user access token concerns one user, so it is only returned
        await expectErr(client.fetchIdentity("fixture-access-token"))
        expect(oauthLogs.withCode("rest.rejected")).toEqual([])
        for (let attempt = 0; attempt < 2; attempt++) await expectErr(client.exchangeCode(exchange))
        body = { error: "invalid_client" }
        await expectErr(client.fetchIdentity("fixture-access-token"))
        expect(oauthLogs.withCode("rest.rejected")).toEqual(
            ["oauth.exchangeCode", "oauth.fetchIdentity"].map((operation) =>
                expect.objectContaining({
                    level: "warn",
                    status: 401,
                    fields: expect.objectContaining({
                        operation,
                        hint: expect.stringMatching(/client ID and client secret/),
                    }),
                }),
            ),
        )
        // The client secret never appears in a record
        expect(JSON.stringify(oauthLogs.records)).not.toContain("fixture-client-secret")
    })

    test("other client rejections stay at Debug", async () => {
        stubFetchWithHostedDiscovery(async () => Response.json({ code: "UNKNOWN_CHANNEL" }, { status: 404 }))
        const logs = captureLogs()
        const client = await setup(mode, { logging: logs.logging })
        await expectErr(client.messages.send("20", { content: "x" }))
        expect(logs.records.filter((record) => record.category === "rest")).toEqual([])
    })
})
