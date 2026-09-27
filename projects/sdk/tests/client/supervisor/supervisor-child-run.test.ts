import { Deferred, Effect, Exit, Stream } from "effect"
import { err, ok } from "neverthrow"
import { expect, test, vi } from "vitest"
import { ConnectionError, ShardConnectionError, type ApplicationError, type SdkDefect } from "../../../src/errors.js"
import { SupervisorChildError, type SupervisorAssignment } from "../../../src/supervisor.js"

function controlledBridge() {
    const assignment = Deferred.makeUnsafe<SupervisorAssignment, SupervisorChildError>()
    const stop = Deferred.makeUnsafe<void, SupervisorChildError>()
    Deferred.doneUnsafe(assignment, Effect.succeed({ totalShards: 1, shardIds: Object.freeze([0]) }))
    return {
        identifyGate: { permit: () => Effect.void },
        signal: new AbortController().signal,
        waitForAssignment: () => Deferred.await(assignment),
        waitForStop: () => Deferred.await(stop),
        ready: vi.fn(),
        state: vi.fn(),
        failed: vi.fn(),
        close: vi.fn(),
        reportDiagnostics: vi.fn(),
        stop: () => Deferred.doneUnsafe(stop, Effect.void),
    }
}

function mockBridge(bridge: ReturnType<typeof controlledBridge>) {
    vi.resetModules()
    vi.doMock("#sdk/internal/supervisor", async (importOriginal) => ({
        ...(await importOriginal<object>()),
        ChildBridge: { open: () => Effect.succeed(bridge) },
        createSupervisor: () => Effect.die("create is outside this child-run boundary"),
    }))
}

/** Diagnostics the fake child clients return, so a test can check what the helper reports */
const clientDiagnostics = Object.freeze({ state: "Connected", marker: "fake client diagnostics" })

async function defaultChild(bridge: ReturnType<typeof controlledBridge>, created: unknown[]) {
    mockBridge(bridge)
    const { makeDefaultSupervisor } = await import("../../../src/default-supervisor.js")
    return makeDefaultSupervisor((options) => {
        created.push(options)
        // Like a real client, run settles once shutdown has finished
        const stopped = Promise.withResolvers<void>()
        return {
            observeState: () => ({ close: () => undefined }),
            run: () => stopped.promise.then(() => ok(undefined)),
            shutdown: vi.fn(async () => stopped.resolve()),
            diagnostics: () => clientDiagnostics,
            state: "Disconnected",
        } as never
    }).child
}

async function nativeChild(bridge: ReturnType<typeof controlledBridge>, created: unknown[]) {
    mockBridge(bridge)
    const { makeNativeSupervisor } = await import("../../../src/native-supervisor.js")
    return makeNativeSupervisor((options) => {
        created.push(options)
        return Effect.succeed({
            observeState: () => Stream.empty,
            run: () => Effect.never,
            shutdown: () => Effect.void,
            diagnostics: () => clientDiagnostics,
            state: "Disconnected",
        } as never)
    }).child
}

const sessions = { load: async () => undefined, save: async () => undefined }

test.each(["default", "native"] as const)(
    "%s child.run adds clientOptions.sharding.sessions to the assigned shards and reports client diagnostics",
    async (mode) => {
        const bridge = controlledBridge()
        const created: Record<string, unknown>[] = []
        const options = { token: "fixture-only-not-a-credential", clientOptions: { sharding: { sessions } } }
        let running: Promise<unknown>
        if (mode === "default") {
            const child = await defaultChild(bridge, created)
            running = Promise.resolve(child.run({ ...options, configure: () => undefined }))
        } else {
            const child = await nativeChild(bridge, created)
            running = Effect.runPromiseExit(child.run({ ...options, configure: () => Effect.void }))
        }
        await vi.waitFor(() => expect(bridge.reportDiagnostics).toHaveBeenCalledTimes(1))
        expect(created[0]).toMatchObject({ sharding: { totalShards: 1, shardIds: [0], sessions } })
        const read = bridge.reportDiagnostics.mock.calls[0]![0] as () => unknown
        expect(read()).toBe(clientDiagnostics)
        bridge.stop()
        await running
    },
)

const forwarded = {
    rest: { maxQueued: 7 },
    transport: { userAgent: "SupervisorChildTest (https://example.invalid, 1)" },
    gateway: { ignoredEvents: ["TYPING_START"] },
    onError: () => undefined,
}

test("default child.run forwards every client setting except token and sharding to the child client", async () => {
    const created: Record<string, unknown>[] = []
    const child = await defaultChild(controlledBridge(), created)
    const failure = new Error("stop after client creation")
    const result = await child
        .run({
            token: "fixture-only-not-a-credential",
            clientOptions: forwarded as never,
            configure: () => {
                throw failure
            },
        })
        .then(
            () => undefined,
            (error: unknown) => error,
        )
    expect(result).toMatchObject({ _tag: "SdkDefect" })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject(forwarded)
})

test("native child.run forwards every client setting except token and sharding to the child client", async () => {
    const created: Record<string, unknown>[] = []
    const child = await nativeChild(controlledBridge(), created)
    const failure = new Error("stop after client creation")
    const exit = await Effect.runPromiseExit(
        child.run({
            token: "fixture-only-not-a-credential",
            clientOptions: forwarded as never,
            configure: () => Effect.fail(failure),
        }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject(forwarded)
})

test.each([
    [
        "throw",
        (value: Error) => () => {
            throw value
        },
    ],
    ["rejection", (value: Error) => () => Promise.reject(value)],
    ["Err result", (value: Error) => () => err(value)],
] as const)("default child.run reports a configure %s as an application defect", async (_kind, configure) => {
    const bridge = controlledBridge()
    const child = await defaultChild(bridge, [])
    const failure = new Error("application configure failure")
    const rejection = await child.run({ token: "fixture-only-not-a-credential", configure: configure(failure) }).then(
        () => undefined,
        (error: unknown) => error,
    )
    expect(rejection).toMatchObject({ _tag: "SdkDefect" })
    const defect = rejection as SdkDefect
    expect(defect.code).toBe("application.defect")
    expect(defect.reasons).toEqual([expect.objectContaining({ kind: "Defect", origin: "application" })])
    expect(defect.cause).toMatchObject({ _tag: "ApplicationError", source: "supervisor child configure" })
    expect((defect.cause as ApplicationError).cause).toBe(failure)
    expect(bridge.failed).toHaveBeenCalledWith("configure")
    expect(bridge.close).toHaveBeenCalledTimes(1)
})

/** A child client whose run ends with the given failure, or runs until shutdown, recording the shutdown options */
function scriptedClient(mode: "default" | "native", failure: unknown, shutdowns: unknown[]) {
    if (mode === "default") {
        const stopped = Promise.withResolvers<void>()
        return {
            observeState: () => ({ close: () => undefined }),
            run: () =>
                failure === undefined ? stopped.promise.then(() => ok(undefined)) : Promise.resolve(err(failure)),
            shutdown: async (options?: unknown) => {
                shutdowns.push(options)
                stopped.resolve()
            },
            diagnostics: () => clientDiagnostics,
            state: "Disconnected",
        }
    }
    return {
        observeState: () => Stream.empty,
        run: () => (failure === undefined ? Effect.never : Effect.fail(failure)),
        shutdown: (options?: unknown) => Effect.sync(() => void shutdowns.push(options)),
        diagnostics: () => clientDiagnostics,
        state: "Disconnected",
    }
}

async function runScriptedChild(
    mode: "default" | "native",
    bridge: ReturnType<typeof controlledBridge>,
    client: object,
) {
    mockBridge(bridge)
    const options = { token: "fixture-only-not-a-credential" }
    if (mode === "default") {
        const { makeDefaultSupervisor } = await import("../../../src/default-supervisor.js")
        const child = makeDefaultSupervisor(() => client as never).child
        return () => Promise.resolve(child.run({ ...options, configure: () => undefined }))
    }
    const { makeNativeSupervisor } = await import("../../../src/native-supervisor.js")
    const child = makeNativeSupervisor(() => Effect.succeed(client as never)).child
    return () => Effect.runPromiseExit(child.run({ ...options, configure: () => Effect.void }))
}

test.each(["default", "native"] as const)(
    "%s child.run drains running work for the parent's drainMs when the parent stops it",
    async (mode) => {
        const bridge = Object.assign(controlledBridge(), { drainMs: 1_500 })
        const shutdowns: unknown[] = []
        const run = await runScriptedChild(mode, bridge, scriptedClient(mode, undefined, shutdowns))
        const running = run()
        await vi.waitFor(() => expect(bridge.ready).toHaveBeenCalled())
        bridge.stop()
        await running
        expect(shutdowns[0]).toEqual({ drainMs: 1_500 })
    },
)

test.each(["default", "native"] as const)(
    "%s child.run reports a 4011 closure as sharding so an automatic supervisor can reshard",
    async (mode) => {
        for (const [status, reason] of [
            [4011, "sharding"],
            [4004, "client"],
        ] as const) {
            const bridge = Object.assign(controlledBridge(), { drainMs: 1_500 })
            const shutdowns: unknown[] = []
            const failure = new ShardConnectionError(0, new ConnectionError("gateway", "closed", status))
            const run = await runScriptedChild(mode, bridge, scriptedClient(mode, failure, shutdowns))
            await run()
            expect(bridge.failed).toHaveBeenCalledWith(reason)
            // A client that ended on its own is not drained
            expect(shutdowns.every((options) => options === undefined)).toBe(true)
        }
    },
)
