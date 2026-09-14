import { Effect, Exit, Scope } from "effect"
import { createServer } from "node:http"
import { once } from "node:events"
import { setImmediate as turn } from "node:timers/promises"
import type { Result } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, SdkDefect, type MessageInput } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
test.each(modes)(
    "%s treats cancellation during real partial JSON as interruption, not a cleanup defect",
    async (mode) => {
        const server = createServer((_request, response) => {
            response.writeHead(200)
            response.write('{"id":')
        })
        server.listen(0, "127.0.0.1")
        await once(server, "listening")
        onTestFinished(async () => {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        })
        const address = server.address()
        if (address === null || typeof address === "string") throw new Error("Missing fixture address")
        const originalFetch = globalThis.fetch
        let response: Response | undefined
        stubFetchWithHostedDiscovery(async (_url, options) => {
            response = await originalFetch(`http://127.0.0.1:${address.port}/fixture`, options)
            return response
        })
        const client = await driver(mode)
        const abort = new AbortController()
        const pending = client.fetch(abort.signal).catch((error) => error)
        try {
            await vi.waitFor(() => expect(response?.bodyUsed).toBe(true))
        } finally {
            abort.abort()
        }
        const error = await pending
        if (mode === "default") expect(error).toMatchObject({ _tag: "CancelledError" })
        else {
            expect(error.reasons.some((reason: { _tag: string }) => reason._tag === "Interrupt")).toBe(true)
            expect(error.reasons.some((reason: { _tag: string }) => reason._tag === "Die")).toBe(false)
        }
        expect(response!.body!.locked).toBe(false)
    },
)
const target = { id: "10", channelId: "20" }
const limit = 16_777_216
const wire = { id: "10", channel_id: "20", content: "fixture", author: { id: "30", username: "fixture" } }
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function driver(mode: (typeof modes)[number]) {
    const unwrap = <A, E>(result: Result<A, E>): A => {
        if (result.isErr()) throw result.error
        return result.value
    }
    const scope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? createClient({ token: "fixture" })._unsafeUnwrap() : undefined
    const native = defaultApi
        ? undefined
        : await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        if (defaultApi) (await defaultApi.shutdown())._unsafeUnwrap()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const run = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) => {
        const exit = await Effect.runPromiseExit(effect, signal ? { signal } : undefined)
        if (Exit.isSuccess(exit)) return exit.value
        const defects = exit.cause.reasons.filter((reason) => reason._tag === "Die")
        if (defects.length) throw exit.cause
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") throw failure.error
        throw exit.cause
    }
    return {
        fetch: (signal?: AbortSignal) =>
            defaultApi
                ? Promise.resolve(defaultApi.messages.fetch(target, signal ? { signal } : undefined)).then(unwrap)
                : run(native!.messages.fetch(target), signal),
        send: (input: MessageInput) =>
            defaultApi
                ? Promise.resolve(defaultApi.messages.send("20", input)).then(unwrap)
                : run(native!.messages.send("20", input)),
        guild: () =>
            defaultApi ? Promise.resolve(defaultApi.guilds.fetch("40")).then(unwrap) : run(native!.guilds.fetch("40")),
    }
}

test.each(modes)("%s accepts a success JSON body at the byte ceiling and drops unknown fields", async (mode) => {
    const prefix = JSON.stringify(wire).slice(0, -1) + ',"unused":"'
    const body = prefix + "x".repeat(limit - Buffer.byteLength(prefix) - 2) + '"}'
    expect(Buffer.byteLength(body)).toBe(limit)
    const response = new Response(body)
    const fetch = vi.fn(async () => response)
    stubFetchWithHostedDiscovery(fetch)
    const client = await driver(mode)
    expect(await client.fetch()).toMatchObject({ id: "10", channelId: "20", content: "fixture" })
    expect(await response.body!.locked).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
})

test.each(modes)("%s rejects oversized message and resource responses without replay", async (mode) => {
    const client = await driver(mode)
    for (const operation of [() => client.fetch(), () => client.send({ content: "fixture" }), () => client.guild()]) {
        let cancelled = 0
        const response = new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array(limit + 1))
                },
                cancel() {
                    cancelled++
                },
            }),
        )
        const fetch = vi.fn(async () => response)
        stubFetchWithHostedDiscovery(fetch)
        await expect(operation()).rejects.toMatchObject({ reason: "response", status: 200 })
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(cancelled).toBe(1)
        expect(response.body!.locked).toBe(false)
    }
})

test.each(modes)("%s awaits oversized reader cleanup and preserves its failure alongside defects", async (mode) => {
    let begin!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
        begin = resolve
    })
    const allowed = new Promise<void>((resolve) => {
        release = resolve
    })
    const privateError = new Error("fixture-only cleanup detail")
    const response = new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(limit + 1))
            },
            async cancel() {
                begin()
                await allowed
                throw privateError
            },
        }),
    )
    const fetch = vi.fn(async () => response)
    stubFetchWithHostedDiscovery(fetch)
    const client = await driver(mode)
    let settled = false
    const pending = client
        .fetch()
        .catch((error) => error)
        .finally(() => {
            settled = true
        })
    try {
        await entered
        await turn()
        expect(settled).toBe(false)
    } finally {
        release()
    }
    const error = await pending
    if (mode === "default") {
        expect(error).toBeInstanceOf(SdkDefect)
        expect(error).toMatchObject({
            reasons: [
                {
                    kind: "Failure",
                    failure: { _tag: "MessageOperationError", reason: "response", outcome: "unknown", status: 200 },
                },
                { kind: "Defect" },
            ],
        })
        expect(JSON.stringify(error)).not.toContain(privateError.message)
    } else {
        expect(error.reasons).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    _tag: "Fail",
                    error: expect.objectContaining({ reason: "response", outcome: "unknown" }),
                }),
                expect.objectContaining({ _tag: "Die", defect: privateError }),
            ]),
        )
    }
    expect(response.body!.locked).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
})
