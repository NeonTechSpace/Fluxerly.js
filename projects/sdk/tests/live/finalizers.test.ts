import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { acquireLock, finalizeOwned, shutdownDefaultClient } from "./support/harness.js"
import { closeScenarioScope } from "./support/scenario-scope.js"

const parent = realpathSync(tmpdir())
const roots: string[] = []
const timers: ReturnType<typeof setTimeout>[] = []

afterEach(() => {
    vi.restoreAllMocks()
    for (const timer of timers.splice(0)) clearTimeout(timer)
    for (const root of roots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(parent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

function fixture() {
    const root = mkdtempSync(join(parent, "fluxerly-live-finalizers-"))
    roots.push(root)
    const lockPath = join(root, ".env.test.local.lock")
    const watchdog = setTimeout(() => undefined, 60_000)
    timers.push(watchdog)
    const cleared = vi.spyOn(globalThis, "clearTimeout")
    const events: string[] = []
    const failures: string[] = []
    const step =
        (name: string, fails = false) =>
        async () => {
            events.push(name)
            if (fails) throw Error("fixture-private-finalizer-detail")
        }
    return {
        lock: acquireLock({ path: lockPath, check: { lockClass: "shared-state", key: "fixture" } }),
        lockPath,
        watchdog,
        events,
        failures,
        step,
        onFailure: (finalizer: string) => failures.push(finalizer),
        watchdogCleared: () => cleared.mock.calls.some(([timer]) => timer === watchdog),
    }
}

test("every owned writer closes after another fails, and an unproven run keeps its lock, journal and deadline", async () => {
    const run = fixture()
    const quiescent = await finalizeOwned({
        writers: [
            ["webhook_client_shutdown", run.step("webhook_client_shutdown", true)],
            ["client_shutdown", run.step("client_shutdown")],
            ["scope_close", run.step("scope_close")],
        ],
        checks: [["client_state", run.step("client_state")]],
        cleanup: run.step("remote_cleanup"),
        lock: run.lock,
        watchdog: run.watchdog,
        onFailure: run.onFailure,
    })
    expect(quiescent).toBe(false)
    expect(run.events).toEqual(["webhook_client_shutdown", "client_shutdown", "scope_close"])
    expect(run.failures).toEqual(["webhook_client_shutdown"])
    expect(run.lock.held).toBe(true)
    expect(readFileSync(run.lockPath, "utf8")).toBe(String(process.pid))
    expect(run.watchdogCleared()).toBe(false)
    expect(run.lock.release()).toBe(true)
})

test("a quiescent run checks, cleans up, then releases the lock and clears its deadline", async () => {
    const run = fixture()
    const quiescent = await finalizeOwned({
        writers: [
            ["client_shutdown", run.step("client_shutdown")],
            ["scope_close", run.step("scope_close")],
        ],
        checks: [["client_state", run.step("client_state")]],
        cleanup: async () => {
            expect(run.lock.held).toBe(true)
            await run.step("remote_cleanup")()
        },
        lock: run.lock,
        watchdog: run.watchdog,
        onFailure: run.onFailure,
    })
    expect(quiescent).toBe(true)
    expect(run.events).toEqual(["client_shutdown", "scope_close", "client_state", "remote_cleanup"])
    expect(run.failures).toEqual([])
    expect(existsSync(run.lockPath)).toBe(false)
    expect(run.watchdogCleared()).toBe(true)
})

test("a failed post-close check stops later checks and keeps the lock", async () => {
    const run = fixture()
    const quiescent = await finalizeOwned({
        writers: [["client_shutdown", run.step("client_shutdown")]],
        checks: [
            ["socket_verification", run.step("socket_verification", true)],
            ["client_state", run.step("client_state")],
        ],
        cleanup: run.step("remote_cleanup"),
        lock: run.lock,
        watchdog: run.watchdog,
        onFailure: run.onFailure,
    })
    expect(quiescent).toBe(false)
    expect(run.events).toEqual(["client_shutdown", "socket_verification"])
    expect(run.failures).toEqual(["socket_verification"])
    expect(run.lock.held).toBe(true)
    expect(run.watchdogCleared()).toBe(false)
    expect(run.lock.release()).toBe(true)
})

test("a failed remote cleanup keeps its journal but releases the lock once no writer remains", async () => {
    const run = fixture()
    const quiescent = await finalizeOwned({
        writers: [["client_shutdown", run.step("client_shutdown")]],
        cleanup: run.step("remote_cleanup", true),
        lock: run.lock,
        watchdog: run.watchdog,
        onFailure: run.onFailure,
    })
    expect(quiescent).toBe(true)
    expect(run.failures).toEqual(["cleanup"])
    expect(existsSync(run.lockPath)).toBe(false)
    expect(run.watchdogCleared()).toBe(true)
})

test("preflight finalization with no acquired owners releases the lock", async () => {
    const run = fixture()
    const supervisor = undefined
    expect(
        await finalizeOwned({
            writers: [supervisor && ["supervisor_shutdown", run.step("supervisor_shutdown")], false, null],
            lock: run.lock,
            watchdog: run.watchdog,
            onFailure: run.onFailure,
        }),
    ).toBe(true)
    expect(run.events).toEqual([])
    expect(existsSync(run.lockPath)).toBe(false)
})

test("a lock that another run replaced is reported and kept", async () => {
    const run = fixture()
    writeFileSync(run.lockPath, "another-run")
    await finalizeOwned({ writers: [], lock: run.lock, onFailure: run.onFailure })
    expect(run.failures).toEqual(["sandbox_lock"])
    expect(readFileSync(run.lockPath, "utf8")).toBe("another-run")
})

test.each([
    ["an Err result", async () => ({ isOk: () => false })],
    ["a rejection", async () => Promise.reject(Error("fixture-private-finalizer-detail"))],
])("default client shutdown with %s is unproven but still closes the state observer", async (_name, shutdown) => {
    let observerClosed = false
    expect(await shutdownDefaultClient({ shutdown }, () => (observerClosed = true))).toBe(false)
    expect(observerClosed).toBe(true)
})

test("a successful default client shutdown is proven", async () => {
    expect(await shutdownDefaultClient({ shutdown: async () => ({ isOk: () => true }) })).toBe(true)
})

async function scopeClosingWith(failure: boolean) {
    const scope = Scope.makeUnsafe()
    const closedWith: Exit.Exit<unknown, unknown>[] = []
    await Effect.runPromise(
        Effect.addFinalizer((exit) =>
            Effect.suspend(() => {
                closedWith.push(exit)
                return failure ? Effect.die("fixture scope defect") : Effect.void
            }),
        ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    return { scope, closedWith }
}

test("a native scope-close failure replaces a successful scenario exit", async () => {
    const { scope, closedWith } = await scopeClosingWith(true)
    const closed = await closeScenarioScope(scope, Exit.void)
    expect(closedWith).toEqual([Exit.void])
    expect(closed.closed).toBe(false)
    expect(Exit.isFailure(closed.exit) && Cause.hasDies(closed.exit.cause)).toBe(true)
})

test("a native scenario failure is kept after a successful scope close", async () => {
    const { scope, closedWith } = await scopeClosingWith(false)
    const scenario = Exit.fail("fixture scenario failure")
    const closed = await closeScenarioScope(scope, scenario)
    expect(closedWith).toEqual([scenario])
    expect(closed).toEqual({ exit: scenario, closed: true })
})

test("a native scope-close failure preserves the scenario failure alongside it", async () => {
    const { scope } = await scopeClosingWith(true)
    const closed = await closeScenarioScope(scope, Exit.fail("fixture scenario failure"))
    expect(closed.closed).toBe(false)
    expect(Exit.isFailure(closed.exit)).toBe(true)
    if (Exit.isFailure(closed.exit)) {
        expect(Cause.hasFails(closed.exit.cause)).toBe(true)
        expect(Cause.hasDies(closed.exit.cause)).toBe(true)
    }
})
