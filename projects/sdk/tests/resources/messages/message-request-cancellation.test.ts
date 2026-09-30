import { Cause, Effect, Exit } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import type { Client } from "../../../src/index.js"
import type { Client as NativeClient } from "../../../src/effect.js"
import { defaultApi, modes, nativeApi } from "../../support/both-apis.js"
import { sdkClock } from "../../support/client-clock.js"
import { waitUntil } from "../../support/clock.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { expectErr, type Operation } from "../../support/settle.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const target = { id: "10", channelId: "20" }
type Options = { readonly signal?: AbortSignal; readonly timeoutMs?: number }
type AnyClient = Client | NativeClient
type Call = (client: any, options: Options) => Operation<unknown, unknown>

/** Message REST operations. Reads receive a response whose body never finishes, so cleanup must end the body */
const operations: Record<string, { readonly read: boolean; readonly call: Call }> = {
    fetch: { read: true, call: (client, options) => client.messages.fetch(target, options) },
    fetchHistory: { read: true, call: (client, options) => client.messages.fetchHistory("20", undefined, options) },
    fetchPins: { read: true, call: (client, options) => client.messages.fetchPins("20", undefined, options) },
    fetchReactionUsers: {
        read: true,
        call: (client, options) => client.messages.fetchReactionUsers(target, "👍", undefined, options),
    },
    edit: { read: false, call: (client, options) => client.messages.edit(target, { content: "x" }, options) },
    delete: { read: false, call: (client, options) => client.messages.delete(target, options) },
    pin: { read: false, call: (client, options) => client.messages.pin(target, options) },
    unpin: { read: false, call: (client, options) => client.messages.unpin(target, options) },
    addReaction: { read: false, call: (client, options) => client.messages.addReaction(target, "👍", options) },
    removeReaction: { read: false, call: (client, options) => client.messages.removeReaction(target, "👍", options) },
    removeUserReaction: {
        read: false,
        call: (client, options) => client.messages.removeUserReaction(target, "👍", "31", options),
    },
    clearReaction: { read: false, call: (client, options) => client.messages.clearReaction(target, "👍", options) },
    clearReactions: { read: false, call: (client, options) => client.messages.clearReactions(target, options) },
}

/** Count requests and the ones still holding a pending response or an unfinished body */
function hangingTransport(read: boolean) {
    const state = { requests: 0, active: 0 }
    stubFetchWithHostedDiscovery((_url: string, init: RequestInit) => {
        state.requests++
        state.active++
        let released = false
        const release = () => {
            if (released) return
            released = true
            state.active--
        }
        // Like a real fetch, aborting the request signal errors a body that is still streaming
        if (read)
            return new Response(
                new ReadableStream<Uint8Array>({
                    start: (controller) => {
                        controller.enqueue(new TextEncoder().encode("["))
                        init.signal!.addEventListener(
                            "abort",
                            () => {
                                release()
                                controller.error(init.signal!.reason)
                            },
                            { once: true },
                        )
                    },
                    cancel: release,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            )
        return new Promise<Response>((_resolve, reject) =>
            init.signal!.addEventListener(
                "abort",
                () => {
                    release()
                    reject(new Error("fixture abort"))
                },
                { once: true },
            ),
        )
    })
    return state
}

test.each(modes.flatMap((mode) => Object.keys(operations).map((operation) => ({ mode, operation }))))(
    "$mode $operation releases its active request before a cancellation, timeout or shutdown settles",
    async ({ mode, operation }) => {
        const clock = sdkClock()
        const { read, call } = operations[operation]!
        const transport = hangingTransport(read)
        const client: AnyClient = mode === "default" ? defaultApi() : await nativeApi()

        const controller = new AbortController()
        if (mode === "default") {
            const cancelled = expectErr(call(client, { signal: controller.signal }))
            await waitUntil(() => transport.active === 1)
            controller.abort()
            expect(await cancelled).toMatchObject({ _tag: "CancelledError" })
        } else {
            const cancelled = Effect.runPromiseExit(call(client, {}) as Effect.Effect<unknown, unknown>, {
                signal: controller.signal,
            })
            await waitUntil(() => transport.active === 1)
            controller.abort()
            const exit = await cancelled
            expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        }
        expect(transport).toEqual({ requests: 1, active: 0 })

        // Expire only after the request owns the hanging response and its deadline sleep is registered
        const timingOut = expectErr(call(client, { timeoutMs: 50 }))
        await waitUntil(() => transport.active === 1)
        await clock.waiting(50)
        await clock.advance(50)
        expect(await timingOut).toMatchObject({ reason: "timeout" })
        expect(transport).toEqual({ requests: 2, active: 0 })

        const pending = expectErr(call(client, {}))
        await waitUntil(() => transport.active === 1)
        await expectShutdown(client)
        expect(await pending).toMatchObject({ _tag: "ClientClosedError" })
        expect(transport).toEqual({ requests: 3, active: 0 })

        expect(await expectErr(call(client, {}))).toMatchObject({ _tag: "ClientClosedError" })
        expect(transport.requests).toBe(3)
    },
)

async function expectShutdown(client: AnyClient) {
    const shutdown = client.shutdown()
    if (Effect.isEffect(shutdown)) await Effect.runPromise(shutdown)
    else expect((await shutdown).isOk()).toBe(true)
}
