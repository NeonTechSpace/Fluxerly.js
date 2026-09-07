import { getEventListeners } from "node:events"
import { Cause, Deferred, Effect, Exit } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { expect, onTestFinished, test } from "vitest"
import { fetchText, runSocket } from "./transport/candidate.js"
import { startServer } from "./transport/server.js"

test("HTTP candidate reads a local response", async () => {
    const server = await startServer()
    onTestFinished(() => server.close())
    try {
        expect(await Effect.runPromise(fetchText(server.httpUrl))).toBe("fixture response")
    } finally {
        await server.close()
    }
})

test.each(["/pending", "/body"])("HTTP interruption aborts %s without a typed failure", async (path) => {
    const server = await startServer()
    const controller = new AbortController()
    const readingBody = Promise.withResolvers<void>()
    const running = Effect.runPromiseExit(
        fetchText(server.httpUrl + path).pipe(
            Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
                const response = await fetch(input, init)
                const arrayBuffer = response.arrayBuffer.bind(response)
                response.arrayBuffer = () => {
                    readingBody.resolve()
                    return arrayBuffer()
                }
                return response
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
        await server.requested
        if (path === "/body") await readingBody.promise
        controller.abort()
        const exit = await running
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        await server.requestClosed
    } finally {
        controller.abort()
        await server.close()
        await running
    }
})

test("WebSocket candidate processes a burst sequentially and waits for peer close during interruption", async () => {
    const server = await startServer({ holdClose: true })
    const firstEntered = Deferred.makeUnsafe<void>()
    const releaseFirst = Deferred.makeUnsafe<void>()
    const processed = Deferred.makeUnsafe<void>()
    const messages: string[] = []
    const controller = new AbortController()
    let closed = false
    let socket: WebSocket | undefined
    const running = Effect.runPromiseExit(
        runSocket(server.socketUrl, (message) =>
            Effect.gen(function* () {
                if (message === "first") {
                    yield* Deferred.succeed(firstEntered, undefined)
                    yield* Deferred.await(releaseFirst)
                }
                messages.push(message)
                if (message === "third") yield* Deferred.succeed(processed, undefined)
            }),
        ).pipe(
            Effect.provideService(Socket.WebSocketConstructor, (url) => {
                socket = new WebSocket(url)
                return socket
            }),
        ),
        { signal: controller.signal },
    ).then((exit) => {
        closed = true
        return exit
    })
    onTestFinished(async () => {
        controller.abort()
        await server.close()
        await running
    })
    try {
        await server.send("first", "second", "third")
        await Effect.runPromise(Deferred.await(firstEntered))
        expect(messages).toEqual([])
        await Effect.runPromise(Deferred.succeed(releaseFirst, undefined))
        await Effect.runPromise(Deferred.await(processed))
        expect(messages).toEqual(["first", "second", "third"])
        controller.abort()
        await server.receivedClose
        expect(closed).toBe(false)
        await server.releaseClose()
        const exit = await running
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        await server.peerClosed
        expect(socket?.readyState).toBe(WebSocket.CLOSED)
        for (const event of ["open", "message", "error", "close"]) {
            expect(getEventListeners(socket!, event)).toHaveLength(0)
        }
    } finally {
        controller.abort()
        await server.close()
        await running
    }
})

test("pending-handshake interruption closes the network request but exposes the adapter's retained open listener", async () => {
    const server = await startServer({ holdHandshake: true })
    let socket: WebSocket | undefined
    const controller = new AbortController()
    const running = Effect.runPromiseExit(
        runSocket(server.socketUrl, () => Effect.void).pipe(
            Effect.provideService(Socket.WebSocketConstructor, (url) => {
                socket = new WebSocket(url)
                return socket
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
        await server.upgraded
        controller.abort()
        const exit = await running
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        await server.peerClosed
        // A passing characterization is evidence against adoption, not a cleanup success
        expect(getEventListeners(socket!, "open")).toHaveLength(1)
        for (const event of ["message", "error", "close"]) {
            expect(getEventListeners(socket!, event)).toHaveLength(0)
        }
    } finally {
        controller.abort()
        await server.close()
        await running
    }
})
