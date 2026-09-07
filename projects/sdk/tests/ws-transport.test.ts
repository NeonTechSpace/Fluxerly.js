import { once } from "node:events"
import { Cause, Effect, Exit } from "effect"
import { expect, onTestFinished, test } from "vitest"
import WebSocket from "ws"
import { startServer } from "./transport/server.js"
import { acquireWs, awaitWsOpen } from "./transport/ws-candidate.js"

test("ws receives text frames in order and completes cooperative closure", async () => {
    const server = await startServer()
    const controller = new AbortController()
    let socket: WebSocket | undefined
    const running = Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                socket = yield* acquireWs(server.socketUrl)
                yield* awaitWsOpen(socket)
                const messages: string[] = []
                const received = Promise.withResolvers<void>()
                const onMessage = (data: WebSocket.RawData) => {
                    messages.push(data.toString())
                    if (messages.length === 3) received.resolve()
                }
                socket.on("message", onMessage)
                yield* Effect.addFinalizer(() => Effect.sync(() => socket!.off("message", onMessage)))
                yield* Effect.promise(() => server.send("first", "second", "third"))
                yield* Effect.promise(() => received.promise)
                expect(messages).toEqual(["first", "second", "third"])
                const closed = once(socket, "close")
                socket.close(1000)
                const [code] = yield* Effect.promise(() => closed)
                expect(code).toBe(1000)
            }),
        ),
        { signal: controller.signal },
    )
    onTestFinished(async () => {
        controller.abort()
        await server.close()
        await running
    })
    expect(Exit.isSuccess(await running)).toBe(true)
    await server.peerClosed
    expect(socket?.readyState).toBe(WebSocket.CLOSED)
    for (const event of ["open", "message", "error", "close"]) {
        expect(socket?.listenerCount(event)).toBe(0)
    }
})

test.each(["pending handshake", "uncooperative close"])(
    "ws interruption releases %s and its listeners",
    async (mode) => {
        const pending = mode === "pending handshake"
        const server = await startServer({ holdHandshake: pending, holdClose: !pending })
        const controller = new AbortController()
        let socket: WebSocket | undefined
        const running = Effect.runPromiseExit(
            Effect.scoped(
                Effect.gen(function* () {
                    socket = yield* acquireWs(server.socketUrl)
                    yield* awaitWsOpen(socket)
                    socket.close(1000)
                    yield* Effect.never
                }),
            ),
            { signal: controller.signal },
        )
        onTestFinished(async () => {
            controller.abort()
            await server.close()
            await running
        })
        try {
            if (pending) await server.upgraded
            else await server.receivedClose
            expect(socket?.readyState).toBe(pending ? WebSocket.CONNECTING : WebSocket.CLOSING)
            controller.abort()
            const exit = await running
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
            await server.peerClosed
            expect(socket?.readyState).toBe(WebSocket.CLOSED)
            for (const event of ["open", "message", "error", "close"]) {
                expect(socket?.listenerCount(event)).toBe(0)
            }
        } finally {
            controller.abort()
            await server.close()
            await running
        }
    },
)
