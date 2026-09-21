import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"
import * as attachmentEncoding from "../src/internal/attachments.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})
const target = { id: "10", channelId: "20" }
async function driver(mode) {
    const scope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? createClient({ token: "fixture" })._unsafeUnwrap() : undefined
    const native = defaultApi
        ? undefined
        : await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
    const run = async (effect) => {
        const result = await Effect.runPromise(Effect.result(effect))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const close = async () => {
        if (defaultApi) (await defaultApi.shutdown())._unsafeUnwrap()
        else await run(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
    onTestFinished(close)
    return {
        close,
        reply: async (reference, input) => {
            if (!defaultApi) return run(native.messages.reply(reference, input))
            const result = await defaultApi.messages.reply(reference, input)
            if (result.isErr()) throw result.error
            return result.value
        },
    }
}
test.each(["default", "native"])("%s validates reply bodies once and preserves structural inputs", async (mode) => {
    const encode = vi.spyOn(attachmentEncoding, "encodeAttachments")
    const bodies = []
    stubFetchWithHostedDiscovery(async (_url, init) => {
        const body = JSON.parse(init.body)
        bodies.push(body)
        return Response.json({
            id: "11",
            channel_id: "20",
            content: body.content,
            author: { id: "30", username: "fixture" },
            message_reference: body.message_reference,
        })
    })
    const client = await driver(mode)
    for (const enumerable of [false, true]) {
        let reads = 0
        const prototype = Object.defineProperty({}, "content", {
            get() {
                reads++
                return "fixture"
            },
            enumerable,
        })
        const input = enumerable ? Object.create(prototype) : prototype
        encode.mockClear()
        expect(await client.reply(target, input)).toMatchObject({ content: "fixture" })
        expect(reads).toBeGreaterThan(0)
        expect(encode).toHaveBeenCalledTimes(1)
    }
    expect(bodies).toHaveLength(2)
    for (const body of bodies)
        expect(body.message_reference).toMatchObject({ message_id: "10", channel_id: "20", type: 0 })
})
test.each(["default", "native"])(
    "%s preserves reply guards and uses send body-error precedence without dispatch",
    async (mode) => {
        const fetch = vi.fn()
        stubFetchWithHostedDiscovery(fetch)
        const client = await driver(mode)
        await expect(client.reply({ id: "bad", channelId: "20" }, { content: 1 })).rejects.toMatchObject({
            _tag: "MessageError",
            inputValidation: { path: "target" },
        })
        await expect(client.reply(target, { content: 1, messageReference: target })).rejects.toMatchObject({
            _tag: "MessageError",
            inputValidation: { path: "messageReference" },
        })
        await expect(client.reply(target, { content: 1, extra: true })).rejects.toMatchObject({
            _tag: "MessageError",
            inputValidation: { path: "input", constraint: "allowedFields" },
        })
        await expect(client.reply(target, { content: 1 })).rejects.toMatchObject({
            _tag: "MessageError",
            inputValidation: { path: "content" },
        })
        let bodyReads = 0
        const invalidNonce = Object.defineProperty({ nonce: {} }, "content", {
            get() {
                bodyReads++
                throw new Error("fixture body getter")
            },
        })
        await expect(client.reply(target, invalidNonce)).rejects.toMatchObject({
            _tag: "MessageError",
            inputValidation: { path: "nonce" },
        })
        expect(bodyReads).toBe(0)
        await client.close()
        await expect(client.reply(target, { content: 1 })).rejects.toMatchObject({ _tag: "ClientClosedError" })
        let reads = 0
        const getterInput = Object.defineProperty({}, "nonce", {
            get() {
                reads++
                throw new Error("fixture getter")
            },
        })
        await expect(client.reply(target, getterInput)).rejects.toMatchObject({ _tag: "ClientClosedError" })
        expect(reads).toBe(0)
        await expect(client.reply({ id: "bad", channelId: "20" }, { content: 1 })).rejects.toMatchObject({
            _tag: "MessageError",
            inputValidation: { path: "target" },
        })
        expect(fetch).not.toHaveBeenCalled()
    },
)
