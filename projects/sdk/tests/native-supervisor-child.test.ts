import { Deferred, Effect, Exit, Stream } from "effect"
import { expect, test, vi } from "vitest"
import { SupervisorChildError, type SupervisorAssignment } from "../src/supervisor.js"

function controlledBridge() {
    const assignment = Deferred.makeUnsafe<SupervisorAssignment, SupervisorChildError>()
    const stop = Deferred.makeUnsafe<void, SupervisorChildError>()
    const bridge = {
        identifyGate: { permit: () => Effect.void },
        waitForAssignment: () => Deferred.await(assignment),
        waitForStop: () => Deferred.await(stop),
        ready: vi.fn(),
        state: vi.fn(),
        failed: vi.fn(),
        close: vi.fn(),
    }
    Deferred.doneUnsafe(assignment, Effect.succeed({ totalShards: 1, shardIds: Object.freeze([0]) }))
    return {
        bridge,
        stop: () => Deferred.doneUnsafe(stop, Effect.void),
        disconnect: () => Deferred.doneUnsafe(stop, Effect.fail(new SupervisorChildError("disconnected"))),
    }
}

function controlledClient() {
    return {
        observeState: () => Stream.empty,
        run: vi.fn(() => Effect.never),
        shutdown: vi.fn(() => Effect.void),
        state: "Disconnected",
    }
}

async function childTools(control: ReturnType<typeof controlledBridge>, client: ReturnType<typeof controlledClient>) {
    vi.resetModules()
    vi.doMock("#sdk/internal/supervisor", () => ({
        ChildBridge: { open: () => Effect.succeed(control.bridge) },
        createSupervisor: () => Effect.die("create is outside this child-run boundary"),
    }))
    const { makeNativeSupervisor } = await import("../src/native-supervisor.js")
    return makeNativeSupervisor(() => Effect.succeed(client as never))
}

function heldConfigure(entered: Deferred.Deferred<void>, cleanup: Effect.Effect<void>) {
    return Effect.acquireRelease(
        Effect.sync(() => Deferred.doneUnsafe(entered, Effect.void)),
        () => cleanup,
    ).pipe(Effect.andThen(Effect.never))
}

test("native child stop interrupts configuration, awaits cleanup and does not start the client", async () => {
    const control = controlledBridge()
    const client = controlledClient()
    const tools = await childTools(control, client)
    const entered = Deferred.makeUnsafe<void>()
    const running = Effect.runPromiseExit(
        tools.child.run({
            token: "fixture-only-not-a-credential",
            configure: () => heldConfigure(entered, Effect.void),
        }),
    )
    await Effect.runPromise(Deferred.await(entered))
    control.stop()
    const exit = await running
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(client.run).not.toHaveBeenCalled()
    expect(control.bridge.failed).not.toHaveBeenCalled()
    expect(control.bridge.close).toHaveBeenCalledTimes(1)
})

test("native child configuration retains its primary failure and cleanup defect", async () => {
    const control = controlledBridge()
    const client = controlledClient()
    const tools = await childTools(control, client)
    const primary = new Error("configuration failure")
    const cleanup = new Error("configuration cleanup defect")
    const exit = await Effect.runPromiseExit(
        tools.child.run({
            token: "fixture-only-not-a-credential",
            configure: () =>
                Effect.acquireRelease(Effect.void, () => Effect.die(cleanup)).pipe(
                    Effect.andThen(Effect.fail(primary)),
                ),
        }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ _tag: "Fail", error: primary }),
                expect.objectContaining({ _tag: "Die", defect: cleanup }),
            ]),
        )
    }
    expect(control.bridge.failed).toHaveBeenCalledWith("configure")
})

test("native child stop retains a losing configuration cleanup defect without a configure failure message", async () => {
    const control = controlledBridge()
    const client = controlledClient()
    const tools = await childTools(control, client)
    const entered = Deferred.makeUnsafe<void>()
    const cleanup = new Error("interrupted configuration cleanup defect")
    const running = Effect.runPromiseExit(
        tools.child.run({
            token: "fixture-only-not-a-credential",
            configure: () => heldConfigure(entered, Effect.die(cleanup)),
        }),
    )
    await Effect.runPromise(Deferred.await(entered))
    control.stop()
    const exit = await running
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: "Die", defect: cleanup }))
    expect(client.run).not.toHaveBeenCalled()
    expect(control.bridge.failed).not.toHaveBeenCalled()
})

test("native child disconnect retains both the terminal failure and losing configuration cleanup defect", async () => {
    const control = controlledBridge()
    const client = controlledClient()
    const tools = await childTools(control, client)
    const entered = Deferred.makeUnsafe<void>()
    const cleanup = new Error("disconnected configuration cleanup defect")
    const running = Effect.runPromiseExit(
        tools.child.run({
            token: "fixture-only-not-a-credential",
            configure: () => heldConfigure(entered, Effect.die(cleanup)),
        }),
    )
    await Effect.runPromise(Deferred.await(entered))
    control.disconnect()
    const exit = await running
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ _tag: "Fail", error: expect.objectContaining({ reason: "disconnected" }) }),
                expect.objectContaining({ _tag: "Die", defect: cleanup }),
            ]),
        )
    }
    expect(client.run).not.toHaveBeenCalled()
    expect(control.bridge.failed).toHaveBeenCalledWith("configure")
})

test.each(["stop", "disconnect"] as const)(
    "native child %s awaits branch-owned cleanup and retains its defect",
    async (terminal) => {
        const control = controlledBridge()
        const client = controlledClient()
        const tools = await childTools(control, client)
        const entered = Deferred.makeUnsafe<void>()
        const cleanupEntered = Deferred.makeUnsafe<void>()
        const releaseCleanup = Deferred.makeUnsafe<void>()
        const cleanup = new Error("branch-owned configuration cleanup defect")
        const running = Effect.runPromiseExit(
            tools.child.run({
                token: "fixture-only-not-a-credential",
                configure: () =>
                    Effect.sync(() => Deferred.doneUnsafe(entered, Effect.void)).pipe(
                        Effect.andThen(Effect.never),
                        Effect.ensuring(
                            Effect.sync(() => Deferred.doneUnsafe(cleanupEntered, Effect.void)).pipe(
                                Effect.andThen(Deferred.await(releaseCleanup)),
                                Effect.andThen(Effect.die(cleanup)),
                            ),
                        ),
                    ),
            }),
        )
        try {
            await Effect.runPromise(Deferred.await(entered))
            control[terminal]()
            await Effect.runPromise(Deferred.await(cleanupEntered))
            expect(control.bridge.close).not.toHaveBeenCalled()
            expect(client.run).not.toHaveBeenCalled()
        } finally {
            Deferred.doneUnsafe(releaseCleanup, Effect.void)
            await running
        }
        const exit = await running
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: "Die", defect: cleanup }))
            if (terminal === "disconnect")
                expect(exit.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({ reason: "disconnected" }),
                    }),
                )
        }
        if (terminal === "stop") expect(control.bridge.failed).not.toHaveBeenCalled()
        else expect(control.bridge.failed).toHaveBeenCalledWith("configure")
        expect(control.bridge.close).toHaveBeenCalledTimes(1)
    },
)
