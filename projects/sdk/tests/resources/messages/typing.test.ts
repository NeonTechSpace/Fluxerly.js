import { Context, Deferred, Effect, Exit, Fiber } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
    ClientClosedError,
    SdkDefect,
    type Client,
    type MessageOperationFailure,
    type TypingStart,
} from "../../../src/index.js"
import { createClient as createNative, type Client as NativeClient } from "../../../src/effect.js"
import { defaultApi, modes, setup, type Mode } from "../../support/both-apis.js"
import { captureLogs } from "../../support/log-capture.js"
import { startGatewayServer } from "../../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

type Request = { readonly url: string; readonly method: string; readonly body: BodyInit | null | undefined }
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

function typingFetch(statuses: readonly number[] = [204]) {
    const requests: Request[] = []
    let index = 0
    stubFetchWithHostedDiscovery(async (url: string | URL, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body })
        return new Response(null, { status: statuses[Math.min(index++, statuses.length - 1)]! })
    })
    return requests
}

async function settled() {
    for (let index = 0; index < 64; index++) await Promise.resolve()
}

test("default typing uses Fluxer's one-shot channel route without a body or local state", async () => {
    const requests = typingFetch()
    const client = defaultApi()

    expect((await client.messages.typing("20")).isOk()).toBe(true)
    const invalid = await client.messages.typing("invalid")
    expect(invalid.isErr() && invalid.error).toMatchObject({
        _tag: "MessageOperationError",
        operation: "typing",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(requests).toEqual([{ url: "https://api.fluxer.app/v1/channels/20/typing", method: "POST", body: undefined }])

    await client.shutdown()
    const closed = await client.messages.typing("20")
    expect(closed.isErr() && closed.error).toBeInstanceOf(ClientClosedError)
})

test("native typing is lazy and repeatable with the same one-shot request", async () => {
    const requests = typingFetch()
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const typing = client.messages.typing("20")
                expect(requests).toHaveLength(0)
                yield* typing
                yield* typing
                expect(requests).toEqual([
                    { url: "https://api.fluxer.app/v1/channels/20/typing", method: "POST", body: undefined },
                    { url: "https://api.fluxer.app/v1/channels/20/typing", method: "POST", body: undefined },
                ])
            }),
        ),
    )
})

test("native keepTyping preserves its caller context", async () => {
    const requests = typingFetch()
    const Label = Context.Service<string>("typing-caller-label")

    const value = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                return yield* client.messages.keepTyping(
                    "20",
                    Effect.gen(function* () {
                        return yield* Label
                    }),
                )
            }).pipe(Effect.provideService(Label, "caller context")),
        ),
    )

    expect(value).toBe("caller context")
    expect(requests).toEqual([{ url: "https://api.fluxer.app/v1/channels/20/typing", method: "POST", body: undefined }])
})

test("default keepTyping refreshes at a bounded rate, never overlaps a held refresh, and stops after work", async () => {
    vi.useFakeTimers()
    const requests: Request[] = []
    let held: (() => void) | undefined
    stubFetchWithHostedDiscovery((url: string | URL, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body })
        if (requests.length === 2)
            return new Promise<Response>((resolve) => {
                held = () => resolve(new Response(null, { status: 204 }))
            })
        return Promise.resolve(new Response(null, { status: 204 }))
    })
    const client = defaultApi()
    let finish: ((value: string) => void) | undefined
    const result = client.messages.keepTyping(
        "20",
        () =>
            new Promise<string>((resolve) => {
                finish = resolve
            }),
    )

    await settled()
    await vi.advanceTimersByTimeAsync(100)
    await settled()
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(7_900)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await settled()
    expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(requests).toHaveLength(2)
    held!()
    await settled()
    finish!("prepared")
    const completed = await result
    expect(completed.isOk()).toBe(true)
    if (completed.isOk()) expect(completed.value).toBe("prepared")
    await vi.advanceTimersByTimeAsync(32_000)
    expect(requests).toHaveLength(2)
})

test("default cancellation aborts application work and waits for its cooperative settlement", async () => {
    vi.useFakeTimers()
    const requests = typingFetch()
    const client = defaultApi()
    const controller = new AbortController()
    let aborted = false
    let finish: (() => void) | undefined
    const result = client.messages.keepTyping(
        "20",
        (signal) =>
            new Promise<void>((resolve) => {
                finish = resolve
                signal.addEventListener("abort", () => {
                    aborted = true
                })
            }),
        { signal: controller.signal },
    )
    await settled()
    await vi.advanceTimersByTimeAsync(100)
    await settled()
    expect(finish).toBeTypeOf("function")
    controller.abort()
    await settled()
    expect(aborted).toBe(true)
    let completed = false
    void result.then(() => {
        completed = true
    })
    await settled()
    expect(completed).toBe(false)
    finish!()
    const cancelled = await result
    expect(cancelled.isErr() && cancelled.error._tag).toBe("CancelledError")
    await vi.advanceTimersByTimeAsync(16_000)
    expect(requests).toHaveLength(1)
})

test("default cancellation retains a task defect that arrives during cleanup", async () => {
    const requests = typingFetch()
    const client = defaultApi()
    const controller = new AbortController()
    let rejectTask: ((error: Error) => void) | undefined
    const result = client.messages.keepTyping(
        "20",
        () =>
            new Promise<never>((_resolve, reject) => {
                rejectTask = reject
            }),
        { signal: controller.signal },
    )

    await settled()
    await vi.waitFor(() => expect(rejectTask).toBeTypeOf("function"))
    controller.abort()
    await settled()
    rejectTask!(new Error("late task failure"))

    await expect(result).rejects.toMatchObject({
        name: "SdkDefect",
        operation: "keepTyping",
        reasons: expect.arrayContaining([{ kind: "Interruption" }, expect.objectContaining({ kind: "Defect" })]),
    } satisfies Partial<SdkDefect>)
    expect(requests).toHaveLength(1)
})

test("default normal task rejection retains one application defect", async () => {
    const requests = typingFetch()
    const client = defaultApi()

    await expect(
        client.messages.keepTyping("20", () => Promise.reject(new Error("task failed"))),
    ).rejects.toMatchObject({
        name: "SdkDefect",
        operation: "keepTyping",
        reasons: [expect.objectContaining({ kind: "Defect" })],
    } satisfies Partial<SdkDefect>)
    expect(requests).toHaveLength(1)
})

test("native interruption stops refresh work before the caller scope continues", async () => {
    vi.useFakeTimers()
    const requests = typingFetch()
    const ready = Deferred.makeUnsafe<Fiber.Fiber<never, MessageOperationFailure>>()
    const release = Deferred.makeUnsafe<void>()
    const running = Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const fiber = yield* Effect.forkChild(client.messages.keepTyping("20", Effect.never))
                Deferred.doneUnsafe(ready, Effect.succeed(fiber))
                yield* Deferred.await(release)
            }),
        ),
    )
    const fiber = await Effect.runPromise(Deferred.await(ready))
    await vi.advanceTimersByTimeAsync(100)
    await settled()
    expect(requests).toHaveLength(1)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await vi.advanceTimersByTimeAsync(16_000)
    expect(requests).toHaveLength(1)
    Deferred.doneUnsafe(release, Effect.void)
    await running
})

type TaskFailure = { readonly _tag: "TaskFailure" }

/**
 * Run keepTyping on a task that the test settles, in either API, and report the outcome as its value or its failures.
 * The default API reports a task failure as a rejected SdkDefect, so both styles list their failure reasons
 */
async function keepTypingScenario(mode: Mode, statuses: readonly number[], options?: { readonly timeoutMs?: number }) {
    vi.useFakeTimers()
    const requests = typingFetch(statuses)
    const logs = captureLogs()
    const client = await setup(mode, { logging: logs.logging })
    const task = Deferred.makeUnsafe<string, TaskFailure>()
    let started = false
    const outcome: PromiseLike<{ readonly value: string } | { readonly failures: readonly unknown[] }> =
        mode === "default"
            ? (client as Client).messages
                  .keepTyping(
                      "20",
                      async () => {
                          started = true
                          return await Effect.runPromise(Deferred.await(task))
                      },
                      options,
                  )
                  .then(
                      (result) => (result.isOk() ? { value: result.value } : { failures: [result.error] }),
                      (error: unknown) => {
                          if (!(error instanceof SdkDefect)) throw error
                          return {
                              failures: error.reasons.map((reason) =>
                                  reason.kind === "Failure" ? reason.failure : reason,
                              ),
                          }
                      },
                  )
            : Effect.runPromiseExit(
                  (client as NativeClient).messages.keepTyping(
                      "20",
                      Effect.suspend(() => {
                          started = true
                          return Deferred.await(task)
                      }),
                      options,
                  ),
              ).then((exit) =>
                  Exit.isSuccess(exit)
                      ? { value: exit.value }
                      : {
                            failures: exit.cause.reasons.map((reason) =>
                                reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : reason,
                            ),
                        },
              )
    await settled()
    await vi.advanceTimersByTimeAsync(100)
    await settled()
    return {
        requests,
        logs,
        client,
        outcome,
        started: () => started,
        refresh: async () => {
            await vi.advanceTimersByTimeAsync(8_000)
            await settled()
        },
        succeed: (value: string) => Deferred.doneUnsafe(task, Effect.succeed(value)),
        fail: () => Deferred.doneUnsafe(task, Effect.fail({ _tag: "TaskFailure" as const })),
    }
}

const stoppedRefresh = "rest.typingRefreshStopped"

describe.each(modes)("%s keepTyping after a typing refresh failure", (mode) => {
    test("returns the task's value and logs the stopped refresh once at Warn", async () => {
        const scenario = await keepTypingScenario(mode, [204, 500])
        let settled = false
        void Promise.resolve(scenario.outcome).then(() => {
            settled = true
        })
        await scenario.refresh()
        expect(scenario.requests).toHaveLength(2)
        // The stop is logged when the refresh fails, before the task settles
        expect(settled).toBe(false)
        expect(scenario.logs.withCode(stoppedRefresh)).toHaveLength(1)

        // Refreshing stopped for good while the task still runs, so no further request follows the failed one
        await vi.advanceTimersByTimeAsync(32_000)
        expect(scenario.requests).toHaveLength(2)
        scenario.succeed("prepared")

        expect(await scenario.outcome).toEqual({ value: "prepared" })
        const records = scenario.logs.withCode(stoppedRefresh)
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({
            level: "warn",
            category: "rest",
            fields: { channelId: "20" },
            error: { name: "MessageOperationError" },
        })
    })

    test("returns only the task's failure and still logs the stopped refresh", async () => {
        const scenario = await keepTypingScenario(mode, [204, 500])
        await scenario.refresh()

        scenario.fail()

        const outcome = await scenario.outcome
        const failures = "failures" in outcome ? outcome.failures : []
        expect(failures).toEqual([
            mode === "default" ? expect.objectContaining({ kind: "Defect" }) : { _tag: "TaskFailure" },
        ])
        expect(scenario.logs.withCode(stoppedRefresh)).toHaveLength(1)
    })
})

describe.each(modes)("%s keepTyping after a defect in the refresh work", (mode) => {
    test("surfaces the defect without a stopped-refresh record", async () => {
        let reads = 0
        // The first typing request reads the budget once and succeeds, and the refresh's read throws
        const options = {
            get timeoutMs(): number {
                if (++reads > 1) throw new Error("refresh options defect")
                return 30_000
            },
        }
        const scenario = await keepTypingScenario(mode, [204], options)
        await scenario.refresh()
        scenario.succeed("prepared")

        const outcome = await scenario.outcome
        const failures = "failures" in outcome ? outcome.failures : []
        expect(failures).toEqual([
            mode === "default"
                ? expect.objectContaining({ kind: "Defect" })
                : expect.objectContaining({ message: "refresh options defect" }),
        ])
        expect(scenario.logs.withCode(stoppedRefresh)).toEqual([])
    })
})

describe.each(modes)("%s keepTyping when the client closes during the task", (mode) => {
    test("stops refreshing without a Warn and keeps the task's own result", async () => {
        const scenario = await keepTypingScenario(mode, [204])
        expect(scenario.started()).toBe(true)

        const shutdown =
            mode === "default"
                ? (scenario.client as Client).shutdown()
                : Effect.runPromise((scenario.client as NativeClient).shutdown())
        await vi.advanceTimersByTimeAsync(0)
        await settled()
        await shutdown
        await vi.advanceTimersByTimeAsync(16_000)
        expect(scenario.requests).toHaveLength(1)
        scenario.succeed("completed after shutdown")

        expect(await scenario.outcome).toEqual({ value: "completed after shutdown" })
        expect(scenario.logs.records.filter((record) => record.level === "warn")).toEqual([])
    })
})

describe.each(modes)("%s keepTyping after a failed first typing request", (mode) => {
    test("fails without starting the task or logging a stopped refresh", async () => {
        const scenario = await keepTypingScenario(mode, [500])
        const outcome = await scenario.outcome

        expect(scenario.started()).toBe(false)
        expect(scenario.requests).toHaveLength(1)
        const failures = "failures" in outcome ? outcome.failures : []
        expect(failures).toEqual([expect.objectContaining({ _tag: "MessageOperationError", operation: "typing" })])
        expect(scenario.logs.withCode(stoppedRefresh)).toEqual([])
    })
})

async function gatewayFixture() {
    const gateway = await startGatewayServer({ sessionId: "typing-session" })
    const discoveryRequests: Request[] = []
    stubFetchWithHostedDiscovery(async (url: string | URL, init?: RequestInit) => {
        discoveryRequests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body })
        return new Response(JSON.stringify({ url: "wss://gateway.fluxer.app" }), { status: 200 })
    })
    return {
        discoveryRequests,
        dispatch: (body: unknown) => gateway.dispatch("TYPING_START", body),
    }
}

test("typingStart is frozen delivery-only gateway data, including valid partial provider variants", async () => {
    const gateway = await gatewayFixture()
    const client = defaultApi()
    const received = Deferred.makeUnsafe<TypingStart>()
    client.on("typingStart", (event) => {
        Deferred.doneUnsafe(received, Effect.succeed(event))
    })
    expect((await client.connect()).isOk()).toBe(true)
    gateway.dispatch({
        channel_id: "20",
        user_id: "30",
        timestamp: 1_700_000_000,
        guild_id: "40",
        member: { deliberately: "ignored without hydration" },
    })
    const full = await Effect.runPromise(Deferred.await(received))
    expect(full).toEqual({ channelId: "20", userId: "30", timestamp: 1_700_000_000, guildId: "40" })
    expect(Object.isFrozen(full)).toBe(true)
    expect(gateway.discoveryRequests).toEqual([])

    const partial = Deferred.makeUnsafe<TypingStart>()
    client.on("typingStart", (event) => {
        Deferred.doneUnsafe(partial, Effect.succeed(event))
    })
    gateway.dispatch({ channel_id: "20", user_id: "31", timestamp: 1_700_000_001, member: [] })
    expect(await Effect.runPromise(Deferred.await(partial))).toEqual({
        channelId: "20",
        userId: "31",
        timestamp: 1_700_000_001,
    })

    const nativeReceived = Deferred.makeUnsafe<TypingStart>()
    const nativeReady = Deferred.makeUnsafe<void>()
    const nativeDelivery = Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* createNative({ token: "fixture-only-not-a-credential" })
                yield* native.on("typingStart", (event) =>
                    Effect.sync(() => {
                        Deferred.doneUnsafe(nativeReceived, Effect.succeed(event))
                    }),
                )
                yield* native.connect()
                Deferred.doneUnsafe(nativeReady, Effect.void)
                return yield* Deferred.await(nativeReceived)
            }),
        ),
    )
    await Effect.runPromise(Deferred.await(nativeReady))
    gateway.dispatch({ channel_id: "20", user_id: "32", timestamp: 1_700_000_002 })
    expect(await nativeDelivery).toEqual({ channelId: "20", userId: "32", timestamp: 1_700_000_002 })
})
