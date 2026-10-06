import { Cause, Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test, vi } from "vitest"
import { createTestClient as createDefaultTestClient, TestTimeoutError, type TestRequest } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"
import { settle } from "../support/settle.js"

// Test waits import their timers from node:timers so that faking the global timers leaves them real. Routing those
// imports through the global timers here lets fake timers advance a wait's deadline without real waiting
vi.mock("node:timers", async (original) => ({
    ...(await original<typeof import("node:timers")>()),
    setTimeout: (handler: () => void, delay: number) => globalThis.setTimeout(handler, delay),
    clearTimeout: (handle: ReturnType<typeof setTimeout> | undefined) => globalThis.clearTimeout(handle),
}))

/** The error a native Effect failed or died with, instead of the FiberFailure wrapper */
async function unwrap<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
}

/** A test client with a route answering message sends, whose next waits run as promises in either API style */
async function open(mode: Mode) {
    if (mode === "default") {
        const test = createDefaultTestClient()
        onTestFinished(() => test.shutdown())
        const route = test.rest.respond("POST /channels/:id/messages", { body: test.fixtures.message() })
        return {
            next: (timeoutMs?: number) => route.next(timeoutMs === undefined ? undefined : { timeoutMs }),
            send: () => settle(test.client.messages.send(test.fixtures.ids.channel, "hello")),
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => unwrap(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
    const route = test.rest.respond("POST /channels/:id/messages", { body: test.fixtures.message() })
    return {
        next: (timeoutMs?: number) => unwrap(route.next(timeoutMs === undefined ? undefined : { timeoutMs })),
        send: () => unwrap(test.client.messages.send(test.fixtures.ids.channel, "hello")),
    }
}

test.each(modes)("%s test waits have no SDK deadline unless timeoutMs is set", async (mode) => {
    const driver = await open(mode)
    let unboundedOutcome: string | undefined
    let unbounded: Promise<TestRequest>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
        unbounded = driver.next()
        unbounded.then(
            () => (unboundedOutcome = "resolved"),
            () => (unboundedOutcome = "rejected"),
        )
        const bounded = driver.next(5_000).then(
            () => expect.fail("The bounded wait has no request to return"),
            (error: unknown) => error,
        )
        // Far beyond the former 2,000 ms default, so a hidden deadline would have failed the first wait
        await vi.advanceTimersByTimeAsync(600_000)
        expect(await bounded).toBeInstanceOf(TestTimeoutError)
        expect(unboundedOutcome).toBeUndefined()
    } finally {
        vi.useRealTimers()
    }
    await driver.send()
    expect(await unbounded).toMatchObject({ method: "POST", body: { content: "hello" } })
})
