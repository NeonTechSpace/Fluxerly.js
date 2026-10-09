import { type Cause, Deferred, Effect, Exit, Stream } from "effect"
import { err, ok } from "neverthrow"
import { expect, test, vi } from "vitest"
import { ConnectionError, ShardConnectionError, type ApplicationError, type SdkDefect } from "../../../src/errors.js"
import { SupervisorChildError, type SupervisorAssignment } from "../../../src/supervisor.js"

/** A child bridge the test drives. Without assigned, the assignment waits until the test stops or disconnects it */
function controlledBridge({ assigned = true } = {}) {
    const assignment = Deferred.makeUnsafe<SupervisorAssignment, SupervisorChildError>()
    const stop = Deferred.makeUnsafe<void, SupervisorChildError>()
    if (assigned) Deferred.doneUnsafe(assignment, Effect.succeed({ totalShards: 1, shardIds: Object.freeze([0]) }))
    return {
        identifyGate: { permit: () => Effect.void },
        signal: new AbortController().signal,
        waitForAssignment: () => Deferred.await(assignment),
        waitForStop: () => Deferred.await(stop),
        opened: vi.fn(),
        ready: vi.fn(),
        state: vi.fn(),
        failed: vi.fn(),
        close: vi.fn(),
        reportDiagnostics: vi.fn(),
        stop: () => Deferred.doneUnsafe(stop, Effect.void),
        /** Lose the parent's message channel, which fails both waits as the real bridge does */
        disconnect: () => {
            Deferred.doneUnsafe(assignment, Effect.fail(new SupervisorChildError("disconnected")))
            Deferred.doneUnsafe(stop, Effect.fail(new SupervisorChildError("disconnected")))
        },
    }
}

function mockBridge(bridge: ReturnType<typeof controlledBridge>) {
    vi.resetModules()
    vi.doMock("#sdk/internal/supervisor", async (importOriginal) => ({
        ...(await importOriginal<object>()),
        ChildBridge: {
            open: () =>
                Effect.sync(() => {
                    bridge.opened()
                    return bridge
                }),
        },
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
    messageFields: ["content"],
    instance: { url: "https://fluxer.example.invalid" },
    rest: { maxQueued: 7 },
    transport: { userAgent: "SupervisorChildTest (https://example.invalid, 1)" },
    uploads: { maxBytes: 1_048_576 },
    gateway: { ignoredEvents: ["TYPING_START"] },
    cache: { guilds: true },
    connection: { startupTimeoutMs: 5_000 },
    observe: () => undefined,
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

type Outcome =
    | { readonly kind: "ok" }
    | { readonly kind: "error"; readonly error: unknown }
    | { readonly kind: "defect"; readonly defect: unknown }

/**
 * A child client in either API style that records its calls. Its run follows the given behavior, or lasts until
 * shutdown in the default API and forever in the native one
 */
function recordingClient(mode: "default" | "native", run?: () => unknown) {
    const stopped = Promise.withResolvers<void>()
    const calls = {
        run: vi.fn(run ?? (() => (mode === "default" ? stopped.promise.then(() => ok(undefined)) : Effect.never))),
        shutdown: vi.fn((): unknown => (mode === "default" ? Promise.resolve(stopped.resolve()) : Effect.void)),
    }
    return {
        calls,
        client: {
            observeState: () => (mode === "default" ? { close: () => undefined } : Stream.empty),
            run: () => calls.run(),
            shutdown: () => calls.shutdown(),
            diagnostics: () => clientDiagnostics,
            state: "Disconnected",
        },
    }
}

/**
 * Start child.run in either API style behind the controlled bridge and settle it into success, its expected error or
 * a defect. The configure step defaults to finishing at once, and extend can add option properties without reading them
 */
async function startChild(
    mode: "default" | "native",
    bridge: ReturnType<typeof controlledBridge>,
    client: object,
    {
        configure,
        extend = (options) => options,
    }: { configure?: () => unknown; extend?: (options: object) => object } = {},
): Promise<{ created: unknown[]; outcome: PromiseLike<Outcome> }> {
    mockBridge(bridge)
    const created: unknown[] = []
    const settings = (finish: () => unknown) =>
        extend({ token: "fixture-only-not-a-credential", configure: configure ?? finish })
    if (mode === "default") {
        const { makeDefaultSupervisor } = await import("../../../src/default-supervisor.js")
        const child = makeDefaultSupervisor((clientOptions) => {
            created.push(clientOptions)
            return client as never
        }).child
        const outcome = child.run(settings(() => undefined) as never).then(
            (result): Outcome => (result.isErr() ? { kind: "error", error: result.error } : { kind: "ok" }),
            (defect: unknown): Outcome => ({ kind: "defect", defect }),
        )
        return { created, outcome }
    }
    const { makeNativeSupervisor } = await import("../../../src/native-supervisor.js")
    const child = makeNativeSupervisor((clientOptions) => {
        created.push(clientOptions)
        return Effect.succeed(client as never)
    }).child
    const outcome = Effect.runPromiseExit(child.run(settings(() => Effect.void) as never)).then((exit): Outcome => {
        if (Exit.isSuccess(exit)) return { kind: "ok" }
        const [reason, ...others] = exit.cause.reasons
        return reason?._tag === "Fail" && others.length === 0
            ? { kind: "error", error: reason.error }
            : { kind: "defect", defect: exit.cause }
    })
    return { created, outcome }
}

test.each(["default", "native"] as const)(
    "%s child.run returns without creating a client when the parent stops it before the assignment",
    async (mode) => {
        // Catches: A stop that arrived before the assignment was missed, so the child waited for an assignment that never
        // came or still created and ran a client
        const bridge = controlledBridge({ assigned: false })
        const { created, outcome } = await startChild(mode, bridge, recordingClient(mode).client)
        bridge.stop()
        expect(await outcome).toEqual({ kind: "ok" })
        expect(created).toEqual([])
        expect(bridge.ready).not.toHaveBeenCalled()
        expect(bridge.close).toHaveBeenCalledTimes(1)
    },
)

test.each(["default", "native"] as const)(
    "%s child.run returns SupervisorChildError without creating a client when the channel closes before the assignment",
    async (mode) => {
        // Catches: Losing the parent before the assignment hung child.run or was reported as success
        const bridge = controlledBridge({ assigned: false })
        const { created, outcome } = await startChild(mode, bridge, recordingClient(mode).client)
        bridge.disconnect()
        const settled = await outcome
        expect(settled).toMatchObject({
            kind: "error",
            error: { _tag: "SupervisorChildError", reason: "disconnected" },
        })
        expect(created).toEqual([])
        expect(bridge.close).toHaveBeenCalledTimes(1)
    },
)

// native-supervisor-child.test.ts covers a stop and a channel loss during the native configure step

test("default a stop during configure ends child.run without starting the client", async () => {
    // Catches: A stop requested while configure was still running let the helper start the client afterwards
    const bridge = controlledBridge()
    const { client, calls } = recordingClient("default")
    const configuring = Promise.withResolvers<void>()
    const { outcome } = await startChild("default", bridge, client, {
        // Configure never finishes, as setup that ignores the stop signal would not
        configure: () => {
            configuring.resolve()
            return new Promise(() => {})
        },
    })
    await configuring.promise
    bridge.stop()
    expect(await outcome).toEqual({ kind: "ok" })
    expect(calls.run).not.toHaveBeenCalled()
    expect(bridge.ready).not.toHaveBeenCalled()
    expect(bridge.failed).not.toHaveBeenCalled()
    expect(calls.shutdown).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledTimes(1)
})

test("default losing the channel during configure returns SupervisorChildError without starting the client", async () => {
    // Catches: A channel loss during configure was treated as a stop and reported success, or the client still started
    const bridge = controlledBridge()
    const { client, calls } = recordingClient("default")
    const configuring = Promise.withResolvers<void>()
    const { outcome } = await startChild("default", bridge, client, {
        configure: () => {
            configuring.resolve()
            return new Promise(() => {})
        },
    })
    await configuring.promise
    bridge.disconnect()
    expect(await outcome).toMatchObject({
        kind: "error",
        error: { _tag: "SupervisorChildError", reason: "disconnected" },
    })
    expect(calls.run).not.toHaveBeenCalled()
    expect(bridge.ready).not.toHaveBeenCalled()
})

test.each(["default", "native"] as const)(
    "%s a child client defect fails child.run as a defect and reports a client failure to the parent",
    async (mode) => {
        // Catches: A defect from the child client's run was not reported to the parent, so the parent could not restart
        // the child, or it was turned into an expected failure or success
        const bridge = controlledBridge()
        const fault = new Error("child client defect")
        const { client } = recordingClient(mode, () => (mode === "default" ? Promise.reject(fault) : Effect.die(fault)))
        const { outcome } = await startChild(mode, bridge, client)
        const settled = await outcome
        expect(settled.kind).toBe("defect")
        if (mode === "default") {
            const defect = (settled as { defect: SdkDefect }).defect
            expect(defect).toMatchObject({ _tag: "SdkDefect", code: "sdk.defect" })
            expect(defect.reasons).toEqual([expect.objectContaining({ kind: "Defect", defect: fault })])
        } else {
            const cause = (settled as { defect: Cause.Cause<unknown> }).defect
            expect(cause.reasons).toContainEqual(expect.objectContaining({ _tag: "Die", defect: fault }))
        }
        expect(bridge.failed).toHaveBeenCalledWith("client")
        expect(bridge.close).toHaveBeenCalledTimes(1)
    },
)

test.each(["configure", "client run"] as const)(
    "default child.run keeps the reasons of an SdkDefect that %s raises",
    async (source) => {
        // Catches: The helper wrapped an SDK fault raised during configure or the client's run as one new reason, so the
        // original fault and its origin were lost from the defect
        const bridge = controlledBridge()
        const reasons = [{ kind: "Defect", defect: new Error("nested SDK fault"), origin: "sdk" }] as const
        // The helper's module graph is loaded fresh behind the mocked bridge, so the defect comes from that graph too
        const raise = async () => {
            const errors = await import("../../../src/errors.js")
            throw new errors.SdkDefect("presence.set", reasons)
        }
        const { client } = recordingClient("default", source === "client run" ? raise : undefined)
        const { outcome } = await startChild("default", bridge, client, {
            ...(source === "configure" ? { configure: raise } : {}),
        })
        const settled = await outcome
        expect(settled.kind).toBe("defect")
        expect((settled as { defect: SdkDefect }).defect.reasons).toEqual(reasons)
        expect(bridge.failed).toHaveBeenCalledWith(source === "configure" ? "configure" : "client")
    },
)

test("default child.run keeps the client's failure in the defect when its shutdown also fails", async () => {
    // Catches: A cleanup defect replaced the client's own typed failure, so the reason the child stopped was lost
    const bridge = controlledBridge()
    const failure = new ConnectionError("gateway", "closed", 4004)
    const fault = new Error("child client shutdown defect")
    const { client, calls } = recordingClient("default", () => Promise.resolve(err(failure)))
    calls.shutdown.mockImplementation(() => Promise.reject(fault))
    const { outcome } = await startChild("default", bridge, client)
    const settled = await outcome
    expect(settled.kind).toBe("defect")
    expect((settled as { defect: SdkDefect }).defect.reasons).toEqual([
        { kind: "Failure", failure },
        expect.objectContaining({ kind: "Defect", defect: fault }),
    ])
    expect(bridge.failed).toHaveBeenCalledWith("client")
})

test.each(["default", "native"] as const)(
    "%s a throwing child option getter fails child.run as an application defect before opening the channel",
    async (mode) => {
        // Catches: A throw from reading the application's options was reported as an SDK defect, or the helper opened
        // the parent channel first
        const bridge = controlledBridge()
        const fault = new Error("options getter failure")
        const { created, outcome } = await startChild(mode, bridge, recordingClient(mode).client, {
            extend: (options) =>
                Object.defineProperty(options, "clientOptions", {
                    enumerable: true,
                    get() {
                        throw fault
                    },
                }),
        })
        const settled = await outcome
        expect(settled.kind).toBe("defect")
        if (mode === "default") {
            const defect = (settled as { defect: SdkDefect }).defect
            expect(defect).toMatchObject({ _tag: "SdkDefect", code: "application.defect" })
            expect(defect.cause).toBe(fault)
        } else {
            const cause = (settled as { defect: Cause.Cause<unknown> }).defect
            expect(cause.reasons).toEqual([expect.objectContaining({ _tag: "Die", defect: fault })])
        }
        expect(bridge.opened).not.toHaveBeenCalled()
        expect(created).toEqual([])
    },
)
