import { Effect, Exit, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { ResultAsync } from "neverthrow"
import {
    createClient,
    createWebhookClient,
    MessageError,
    MessageOperationError,
    PaginationError,
    compareHierarchy,
    oauth as defaultOAuth,
    type Attachment,
    type Client,
    type InputValidationDetail,
} from "../src/index.js"
import {
    compareHierarchy as compareNativeHierarchy,
    createClient as createNative,
    createWebhookClient as createNativeWebhookClient,
    oauth as nativeOAuth,
    type Client as NativeClient,
} from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function clients(mode: (typeof modes)[number]): Promise<{ defaultApi?: Client; native?: NativeClient }> {
    const scope = Scope.makeUnsafe()
    const created = mode === "default" ? createClient({ token: "fixture-only-not-a-credential" }) : undefined
    if (created?.isErr()) throw created.error
    const defaultApi = created?.isOk() ? created.value : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(scope)),
              )
            : undefined
    onTestFinished(async () => {
        if (defaultApi) await defaultApi.shutdown()
        if (native) await Effect.runPromise(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return { ...(defaultApi === undefined ? {} : { defaultApi }), ...(native === undefined ? {} : { native }) }
}

async function defaultFailure<A, E>(result: ResultAsync<A, E>): Promise<E> {
    const settled = await result
    if (!settled.isErr()) throw new Error("Expected a default failure")
    return settled.error
}

test("operation errors whitelist and freeze validation facts while legacy constructors remain compatible", () => {
    const supplied = {
        path: "field",
        constraint: "type" as const,
        explanation: "Field must be a string",
        privateValue: "must-not-project",
    } satisfies InputValidationDetail & { privateValue: string }
    const send = new MessageError("input", "notSent", null, null, null, supplied)
    const operation = new MessageOperationError("typing", "input", "notDispatched", null, null, null, supplied)
    const pagination = new PaginationError("iterateHistory", "input", supplied)

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
    expect(new MessageError("network", "unknown").inputValidation).toBeNull()
    expect(new PaginationError("iterateHistory", "pageLimit").inputValidation).toBeNull()
})

test.each(modes)("%s reports invalid message and direct-message targets without dispatch", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi, native } = await clients(mode)

    const message = defaultApi
        ? await defaultFailure(defaultApi.messages.send("not-an-id", { content: "fixture" }))
        : await Effect.runPromise(Effect.flip(native!.messages.send("not-an-id", { content: "fixture" })))
    expect(message).toMatchObject({
        _tag: "MessageError",
        reason: "input",
        delivery: "notSent",
        inputValidation: { path: "channelId", constraint: "format" },
    })

    const direct = defaultApi
        ? await defaultFailure(defaultApi.directMessages.send("not-an-id", { content: "fixture" }))
        : await Effect.runPromise(Effect.flip(native!.directMessages.send("not-an-id", { content: "fixture" })))
    expect(direct).toMatchObject({
        _tag: "MessageError",
        reason: "input",
        delivery: "notSent",
        inputValidation: { path: "userId", constraint: "format" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s attributes invalid user and duplicate direct-message reads without dispatch", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi, native } = await clients(mode)

    const user = defaultApi
        ? await defaultFailure(defaultApi.users.fetch("not-an-id"))
        : await Effect.runPromise(Effect.flip(native!.users.fetch("not-an-id")))
    expect(user).toMatchObject({
        _tag: "UserOperationError",
        operation: "users.fetch",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "userId", constraint: "format" },
    })

    const latest = defaultApi
        ? await defaultFailure(defaultApi.directMessages.fetchLatestMessages(["20", "20"]))
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
        ? await defaultFailure(defaultApi.messages.keepTyping("20", null as never))
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

test("message child validators expose fixed paths without projecting caller keys or rejected values", async () => {
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
        const failure = await defaultFailure(defaultApi!.messages.send("20", input as never))
        expect(failure).toMatchObject({
            _tag: "MessageError",
            reason: "input",
            delivery: "notSent",
            inputValidation: expected,
        })
        const serialized = JSON.stringify(failure)
        expect(serialized).not.toContain("callerSecret")
        expect(serialized).not.toContain("private rejected value")
        expect(Object.isFrozen((failure as MessageError).inputValidation)).toBe(true)
    }
    expect(fetch).not.toHaveBeenCalled()
})

test("administrative validators expose their owned leaf without dispatch", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { defaultApi } = await clients("default")
    const channel = await defaultFailure(defaultApi!.channels.create("20", { type: 0, name: "" }))
    const role = await defaultFailure(defaultApi!.roles.create("20", { name: "" }))
    const webhook = await defaultFailure(defaultApi!.webhooks.create("20", { name: "" }))

    expect(channel).toMatchObject({ inputValidation: { path: "name", constraint: "length" } })
    expect(role).toMatchObject({ inputValidation: { path: "name", constraint: "length" } })
    expect(webhook).toMatchObject({ inputValidation: { path: "name", constraint: "length" } })
    expect(fetch).not.toHaveBeenCalled()
})

test("provider rejection preserves its existing outcome without local validation metadata", async () => {
    stubFetchWithHostedDiscovery(async () => new Response("private provider response", { status: 403 }))
    const { defaultApi } = await clients("default")
    const failure = await defaultFailure(
        defaultApi!.messages.send("20", { content: "private message content must not enter the error" }),
    )

    expect(failure).toMatchObject({
        _tag: "MessageError",
        reason: "rejected",
        delivery: "notSent",
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
    if (defaultApi?.isErr()) throw defaultApi.error
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  nativeOAuth.create({ clientId: "1", clientSecret: "fixture" }).pipe(Scope.provide(scope)),
              )
            : undefined
    onTestFinished(async () => {
        if (defaultApi?.isOk()) await defaultApi.value.shutdown()
        if (native) await Effect.runPromise(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const failure = defaultApi?.isOk()
        ? await defaultFailure(defaultApi.value.fetchGuilds("access", { limit: 0 }))
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
    if (defaultApi?.isErr()) throw defaultApi.error
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNativeWebhookClient({ id: "100", token: "fixture" }).pipe(Scope.provide(scope)),
              )
            : undefined
    onTestFinished(async () => {
        if (defaultApi?.isOk()) await defaultApi.value.shutdown()
        if (native) await Effect.runPromise(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const failure = defaultApi?.isOk()
        ? await defaultFailure(defaultApi.value.send({ content: "fixture", username: " " }))
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
        ? await defaultFailure(defaultApi.attachments.download(attachment, { maxBytes: 0 }))
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
    const defaultApi = compareHierarchy(left as never, right as never)
    expect(defaultApi.isErr() && defaultApi.error).toMatchObject({
        _tag: "GuildOperationError",
        operation: "hierarchy.compare",
        reason: "input",
        inputValidation: { path: "roles", constraint: "format" },
    })
    const native = await Effect.runPromise(Effect.flip(compareNativeHierarchy(left as never, right as never)))
    expect(native).toMatchObject({
        _tag: "GuildOperationError",
        operation: "hierarchy.compare",
        reason: "input",
        inputValidation: { path: "roles", constraint: "format" },
    })
})
