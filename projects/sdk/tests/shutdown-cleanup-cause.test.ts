import { once } from "node:events"
import { createServer } from "node:http"
import { inspect } from "node:util"
import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { createClient, SdkDefect } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"

type Fixture = {
    readonly server: ReturnType<typeof createServer>
    readonly gateway: WebSocketServer
    readonly sockets: WebSocket[]
    readonly options: {
        readonly token: string
        readonly instance: { readonly url: string; readonly allowInsecure: true }
    }
}

async function fixture(): Promise<Fixture> {
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    const sockets: WebSocket[] = []
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const command = JSON.parse(data.toString()) as {
                readonly op?: number
                readonly d?: { readonly seq?: number }
            }
            if (command.op === 2 || command.op === 6)
                socket.send(
                    JSON.stringify({
                        op: 0,
                        s: command.op === 6 ? (command.d?.seq ?? 1) : 1,
                        t: command.op === 6 ? "RESUMED" : "READY",
                        d: { session_id: "fixture-session" },
                    }),
                )
        })
    })
    server.on("request", (request, response) => {
        if (request.url !== "/.well-known/fluxer") {
            response.writeHead(404).end()
            return
        }
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("Expected loopback fixture address")
        const origin = `http://127.0.0.1:${address.port}`
        response.setHeader("content-type", "application/json")
        response.end(
            JSON.stringify({
                api_code_version: 1,
                endpoints: {
                    api_public: origin,
                    gateway: origin.replace("http", "ws"),
                    media: origin,
                    static_cdn: origin,
                    webapp: origin,
                    invite: origin,
                },
                features: { presigned_attachment_uploads: true },
            }),
        )
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected loopback fixture address")
    return {
        server,
        gateway,
        sockets,
        options: {
            token: "fixture-only-token",
            instance: { url: `http://127.0.0.1:${address.port}`, allowInsecure: true },
        },
    }
}

async function closeFixture(fixture: Fixture) {
    for (const socket of fixture.sockets) socket.terminate()
    await new Promise<void>((resolve) => fixture.gateway.close(() => resolve()))
    fixture.server.closeAllConnections()
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
}

function expectShutdownCause(exit: Exit.Exit<void, never>, cleanup: Error) {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(Cause.hasDies(exit.cause)).toBe(true)
    expect(exit.cause.reasons.some((reason) => reason._tag === "Fail")).toBe(false)
    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
    expect(defect?._tag).toBe("Die")
    if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
}

function expectConnectionAndCleanup(exit: Exit.Exit<void, unknown>, cleanup: Error) {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    expect(failure?._tag).toBe("Fail")
    if (failure?._tag === "Fail") expect(failure.error).toMatchObject({ _tag: "ConnectionError" })
    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
    expect(defect?._tag).toBe("Die")
    if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
}

afterEach(() => vi.restoreAllMocks())

test("shutdown keeps interrupted cleanup causes structural across native, default, concurrent and late callers", async () => {
    const server = await fixture()
    const scope = Scope.makeUnsafe()
    const cleanup = new Error("private-shutdown-cleanup-sentinel")
    try {
        const native = await Effect.runPromise(createNative(server.options).pipe(Scope.provide(scope)))
        await Effect.runPromise(native.connect())
        const close = vi.spyOn(WebSocket.prototype, "close").mockImplementation(() => {
            throw cleanup
        })
        const [first, second] = await Promise.all([
            Effect.runPromiseExit(native.shutdown()),
            Effect.runPromiseExit(native.shutdown()),
        ])
        const late = await Effect.runPromiseExit(native.shutdown())
        for (const exit of [first, second, late]) expectShutdownCause(exit, cleanup)
        close.mockRestore()

        const defaultClient = createClient(server.options)._unsafeUnwrap()
        await defaultClient.connect()
        const defaultClose = vi.spyOn(WebSocket.prototype, "close").mockImplementation(() => {
            throw cleanup
        })
        const error = await Promise.resolve(defaultClient.shutdown()).then(
            () => undefined,
            (error: unknown) => error,
        )
        defaultClose.mockRestore()
        expect(error).toBeInstanceOf(SdkDefect)
        if (error instanceof SdkDefect) {
            expect(error.reasons).toEqual(expect.arrayContaining([{ kind: "Interruption" }, { kind: "Defect" }]))
            expect(inspect(error)).not.toContain(cleanup.message)
            expect(JSON.stringify(error)).not.toContain(cleanup.message)
        }
    } finally {
        await Effect.runPromiseExit(Scope.close(scope, Exit.void))
        await closeFixture(server)
    }
})

test("waitForClose and run retain a permanent connection failure beside its cleanup defect", async () => {
    const server = await fixture()
    const cleanup = new Error("private-mixed-cleanup-sentinel")
    const waitScope = Scope.makeUnsafe()
    const runScope = Scope.makeUnsafe()
    try {
        const waiting = await Effect.runPromise(createNative(server.options).pipe(Scope.provide(waitScope)))
        await Effect.runPromise(waiting.connect())
        const waitClose = vi.spyOn(WebSocket.prototype, "close").mockImplementation(() => {
            throw cleanup
        })
        server.sockets.at(-1)!.send("not JSON")
        expectConnectionAndCleanup(await Effect.runPromiseExit(waiting.waitForClose()), cleanup)
        waitClose.mockRestore()

        const running = await Effect.runPromise(createNative(server.options).pipe(Scope.provide(runScope)))
        const run = Effect.runPromiseExit(running.run())
        await vi.waitFor(() => expect(running.state).toBe("Connected"))
        const runClose = vi.spyOn(WebSocket.prototype, "close").mockImplementation(() => {
            throw cleanup
        })
        server.sockets.at(-1)!.send("not JSON")
        expectConnectionAndCleanup(await run, cleanup)
        runClose.mockRestore()
    } finally {
        await Effect.runPromiseExit(Scope.close(waitScope, Exit.void))
        await Effect.runPromiseExit(Scope.close(runScope, Exit.void))
        await closeFixture(server)
    }
})
