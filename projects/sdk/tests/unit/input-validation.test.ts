import { Effect, Exit, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    createWebhookClient,
    MessageError,
    MessageOperationError,
    PaginationError,
    hierarchy,
    oauth as defaultOAuth,
    type Attachment,
    type Client,
    type InputValidationDetail,
} from "../../src/index.js"
import {
    hierarchy as nativeHierarchy,
    createWebhookClient as createNativeWebhookClient,
    oauth as nativeOAuth,
    type Client as NativeClient,
} from "../../src/effect.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { defaultApi, modes, nativeApi, type Mode } from "../support/both-apis.js"
import { expectErr } from "../support/settle.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function clients(mode: Mode): Promise<{ defaultApi?: Client; native?: NativeClient }> {
    return mode === "default" ? { defaultApi: defaultApi() } : { native: await nativeApi() }
}

test("operation errors whitelist and freeze validation facts and errors without validation facts report null", () => {
    const supplied = {
        path: "field",
        constraint: "type" as const,
        explanation: "Field must be a string",
        privateValue: "must-not-project",
    } satisfies InputValidationDetail & { privateValue: string }
    const send = new MessageError({ reason: "input", outcome: "notDispatched", inputValidation: supplied })
    const operation = new MessageOperationError({
        operation: "typing",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: supplied,
    })
    const pagination = new PaginationError({ operation: "iterateHistory", reason: "input", inputValidation: supplied })

    for (const error of [send, operation, pagination]) {
        expect(error.inputValidation).toEqual({
            path: "field",
            constraint: "type",
            explanation: "Field must be a string",
        })
        expect(error.inputValidation).not.toHaveProperty("privateValue")
        expect(Object.isFrozen(error.inputValidation)).toBe(true)
    }
    supplied.path = "changed"
    expect(send.inputValidation?.path).toBe("field")
    expect(new MessageError({ reason: "network", outcome: "unknown" }).inputValidation).toBeNull()
    expect(new PaginationError({ operation: "iterateHistory", reason: "pageLimit" }).inputValidation).toBeNull()
})

test.each(modes)("%s reports invalid message and direct-message targets without dispatch", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi, native } = await clients(mode)

    const message = defaultApi
        ? await expectErr(defaultApi.messages.send("not-an-id", { content: "fixture" }))
        : await Effect.runPromise(Effect.flip(native!.messages.send("not-an-id", { content: "fixture" })))
    expect(message).toMatchObject({
        _tag: "MessageError",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "channelId", constraint: "format" },
    })

    const direct = defaultApi
        ? await expectErr(defaultApi.directMessages.send("not-an-id", { content: "fixture" }))
        : await Effect.runPromise(Effect.flip(native!.directMessages.send("not-an-id", { content: "fixture" })))
    expect(direct).toMatchObject({
        _tag: "MessageError",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "userId", constraint: "format" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s attributes invalid user and duplicate direct-message reads without dispatch", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi, native } = await clients(mode)

    const user = defaultApi
        ? await expectErr(defaultApi.users.fetch("not-an-id"))
        : await Effect.runPromise(Effect.flip(native!.users.fetch("not-an-id")))
    expect(user).toMatchObject({
        _tag: "UserOperationError",
        operation: "users.fetch",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "userId", constraint: "format" },
    })

    const latest = defaultApi
        ? await expectErr(defaultApi.directMessages.fetchLatestMessages(["20", "20"]))
        : await Effect.runPromise(Effect.flip(native!.directMessages.fetchLatestMessages(["20", "20"])))
    expect(latest).toMatchObject({
        _tag: "UserOperationError",
        operation: "directMessages.fetchLatestMessages",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "channelIds", constraint: "unique" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s reports an invalid keepTyping task before its initial typing request", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi, native } = await clients(mode)
    const failure = defaultApi
        ? await expectErr(defaultApi.messages.keepTyping("20", null as never))
        : await Effect.runPromise(Effect.flip(native!.messages.keepTyping("20", null as never)))

    expect(failure).toMatchObject({
        _tag: "MessageOperationError",
        operation: "typing",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "task", constraint: "type" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s preserves PaginationError and preflight timing for invalid traversal input", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi, native } = await clients(mode)
    let failure: unknown
    if (defaultApi) {
        for await (const result of defaultApi.messages.iterateHistory("not-an-id", { maxItems: 1 })) {
            if (result.isErr()) failure = result.error
        }
    } else {
        failure = await Effect.runPromise(
            Effect.flip(Stream.runCollect(native!.messages.iterateHistory("not-an-id", { maxItems: 1 }))),
        )
    }
    expect(failure).toMatchObject({
        _tag: "PaginationError",
        operation: "iterateHistory",
        reason: "input",
        inputValidation: { path: "channelId", constraint: "format" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test("message child validators expose fixed paths and name an unsupported key without projecting rejected values", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi } = await clients("default")
    const cases = [
        [
            { content: "fixture", callerSecret: "private rejected value" },
            { path: "input", constraint: "allowedFields" },
        ],
        [{ embeds: [{ title: 42 }] }, { path: "embeds[].title", constraint: "length" }],
        [
            { attachments: [{ filename: "bad/name.png", data: new Uint8Array([1]) }] },
            { path: "attachments[].filename", constraint: "format" },
        ],
    ] as const
    for (const [input, expected] of cases) {
        const failure = await expectErr(defaultApi!.messages.send("20", input as never))
        expect(failure).toMatchObject({
            _tag: "MessageError",
            reason: "input",
            outcome: "notDispatched",
            inputValidation: expected,
        })
        const serialized = JSON.stringify(failure)
        // An unsupported key is named so a misspelling can be found, but its value is never copied
        if (expected.constraint === "allowedFields")
            expect((failure as MessageError).inputValidation?.explanation).toContain('"callerSecret"')
        expect(serialized).not.toContain("private rejected value")
        expect(Object.isFrozen((failure as MessageError).inputValidation)).toBe(true)
    }
    expect(fetch).not.toHaveBeenCalled()
})

test("administrative validators expose their owned leaf without dispatch", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi } = await clients("default")
    const channel = await expectErr(defaultApi!.channels.create("20", { type: 0, name: "" }))
    const role = await expectErr(defaultApi!.roles.create("20", { name: "" }))
    const webhook = await expectErr(defaultApi!.webhooks.create("20", { name: "" }))

    expect(channel).toMatchObject({ inputValidation: { path: "name", constraint: "length" } })
    expect(role).toMatchObject({ inputValidation: { path: "name", constraint: "length" } })
    expect(webhook).toMatchObject({ inputValidation: { path: "name", constraint: "length" } })
    expect(fetch).not.toHaveBeenCalled()
})

test("provider rejection preserves its existing outcome without local validation metadata", async () => {
    stubFetchWithHostedDiscovery(async () => new Response("private provider response", { status: 403 }))
    const { defaultApi } = await clients("default")
    const failure = await expectErr(
        defaultApi!.messages.send("20", { content: "private message content must not enter the error" }),
    )

    expect(failure).toMatchObject({
        _tag: "MessageError",
        reason: "rejected",
        outcome: "rejected",
        status: 403,
        inputValidation: null,
    })
    expect(JSON.stringify(failure)).not.toContain("private message content")
    expect(JSON.stringify(failure)).not.toContain("private provider response")
})

test.each(modes)("%s standalone OAuth owner attributes an invalid guild query before dispatch", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const scope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? defaultOAuth.create({ clientId: "1", clientSecret: "fixture" }) : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  nativeOAuth.create({ clientId: "1", clientSecret: "fixture" }).pipe(Scope.provide(scope)),
              )
            : undefined
    onTestFinished(async () => {
        if (defaultApi) await defaultApi.shutdown()
        if (native) await Effect.runPromise(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const failure = defaultApi
        ? await expectErr(defaultApi.fetchGuilds("access", { limit: 0 }))
        : await Effect.runPromise(Effect.flip(native!.fetchGuilds("access", { limit: 0 })))

    expect(failure).toMatchObject({
        _tag: "OAuthOperationError",
        operation: "oauth.fetchGuilds",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "query.limit", constraint: "range" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s token webhook owner attributes message input before dispatch", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const scope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? createWebhookClient({ id: "100", token: "fixture" }) : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNativeWebhookClient({ id: "100", token: "fixture" }).pipe(Scope.provide(scope)),
              )
            : undefined
    onTestFinished(async () => {
        if (defaultApi) await defaultApi.shutdown()
        if (native) await Effect.runPromise(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const failure = defaultApi
        ? await expectErr(defaultApi.send({ content: "fixture", username: " " }))
        : await Effect.runPromise(Effect.flip(native!.send({ content: "fixture", username: " " })))

    expect(failure).toMatchObject({
        _tag: "WebhookOperationError",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "username", constraint: "length" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s attachment download owner attributes an invalid byte bound before dispatch", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi, native } = await clients(mode)
    const attachment: Attachment = {
        id: "30",
        filename: "fixture.bin",
        size: 1,
        flags: 0,
        url: "https://media.fluxer.app/attachments/20/30/fixture.bin",
    }
    const failure = defaultApi
        ? await expectErr(defaultApi.attachments.download(attachment, { maxBytes: 0 }))
        : await Effect.runPromise(Effect.flip(native!.attachments.download(attachment, { maxBytes: 0 })))

    expect(failure).toMatchObject({
        _tag: "AttachmentDownloadError",
        reason: "input",
        inputValidation: { path: "options.maxBytes", constraint: "range" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s search iterator preserves PaginationError with source validation detail", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi, native } = await clients(mode)
    let failure: unknown
    if (defaultApi) {
        for await (const result of defaultApi.messages.iterateSearch({ channelId: "not-an-id" }, {}, { maxItems: 1 })) {
            if (result.isErr()) failure = result.error
        }
    } else {
        failure = await Effect.runPromise(
            Effect.flip(
                Stream.runCollect(native!.messages.iterateSearch({ channelId: "not-an-id" }, {}, { maxItems: 1 })),
            ),
        )
    }
    expect(failure).toMatchObject({
        _tag: "PaginationError",
        operation: "messages.iterateSearch",
        reason: "input",
        inputValidation: { path: "context.channelId", constraint: "format" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test("default and native hierarchy helpers attach safe grouped snapshot facts", async () => {
    const left = { guildId: "20", id: "30", position: 1 }
    const right = { guildId: "21", id: "31", position: 1 }
    for (const compare of [hierarchy.compare, nativeHierarchy.compare]) {
        let thrown: unknown
        try {
            compare(left as never, right as never)
        } catch (error) {
            thrown = error
        }
        expect(thrown).toMatchObject({
            _tag: "GuildOperationError",
            operation: "hierarchy.compare",
            reason: "input",
            inputValidation: { path: "roles", constraint: "format" },
        })
    }
})
