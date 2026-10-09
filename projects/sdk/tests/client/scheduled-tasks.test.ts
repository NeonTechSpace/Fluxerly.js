import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { runBot, type FailureReport, type LogRecord, type ScheduleOptions } from "../../src/index.js"
import { runBot as runNativeBot } from "../../src/effect.js"
import { createTestBot as createDefaultTestBot, type TestRequest, type TestResponse } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"
import { TestHarness } from "../../src/internal/testing/harness.js"
import { modes, type Mode } from "../support/both-apis.js"
import { sdkClock, type SdkClock } from "../support/client-clock.js"

afterEach(() => {
    vi.restoreAllMocks()
})

const codes = (logs: readonly LogRecord[]) => logs.map((record) => record.code)

/** Contents of the messages sent, in send order */
const sent = (requests: readonly TestRequest[]) =>
    requests
        .filter((request) => request.method === "POST" && /^\/channels\/\d+\/messages$/.test(request.path))
        .map((request) => (request.body as { readonly content?: unknown }).content)

/** Wait until no REST request deadline is pending, so advancing SDK time cannot expire an answered request */
const requestsSettled = (clock: SdkClock) =>
    vi.waitFor(() => expect([...clock.pending].some((item) => item.delay === 30_000)).toBe(false), { interval: 5 })

/** One test bot in either API, driven the same way. Its remind command schedules its reply instead of waiting for it */
interface Bot {
    say(content: string): Promise<readonly unknown[]>
    idle(): Promise<void>
    sent(): readonly unknown[]
    logs(): readonly LogRecord[]
    failures(): readonly LogRecord[]
    /** Schedule work through client.schedule. The signal aborts when shutdown cancels the run, and a rejection fails it */
    schedule(work: (signal: AbortSignal) => Promise<unknown>, options?: ScheduleOptions): { close(): void }
    /** What client.schedule throws or dies with for this task and these options */
    misuse(task: unknown, options?: unknown): unknown
    /** Send a message to the fixture channel, rejecting when the send fails */
    send(content: string, signal: AbortSignal): Promise<void>
    /** Answer later REST requests matching a route with this test response */
    respond(route: string, response: TestResponse): void
    shutdown(drainMs?: number): Promise<void>
}

async function openBot(mode: Mode, onError?: (report: FailureReport) => void): Promise<Bot> {
    const remind = {
        delay: { type: "duration", min: 1_000, max: 3_600_000 },
        note: { type: "text", rest: true },
    } as const
    if (mode === "default") {
        const bot = createDefaultTestBot({
            ...(onError ? { onError } : {}),
            commands: {
                prefix: "!",
                concurrency: 1,
                commands: {
                    ping: { execute: ({ reply }) => reply("Pong!") },
                    remind: {
                        arguments: remind,
                        execute: ({ client, message, values, reply }) => {
                            client.schedule((signal) => client.messages.reply(message, values.note, { signal }), {
                                delayMs: values.delay,
                            })
                            return reply("Reminder set")
                        },
                    },
                },
            },
        })
        onTestFinished(() => bot.shutdown())
        await bot.ready()
        const channelId = bot.fixtures.ids.channel
        return {
            say: async (content) => (await bot.say(content)).map((message) => message.content),
            idle: () => bot.idle(),
            sent: () => sent(bot.requests()),
            logs: () => bot.logs(),
            failures: () => bot.failures(),
            schedule: (work, options) => bot.client.schedule(work, options),
            misuse: (task, options) => {
                try {
                    bot.client.schedule(task as never, options as never)
                } catch (error) {
                    return error
                }
                throw new Error("client.schedule accepted misuse")
            },
            send: async (content, signal) => {
                const result = await bot.client.messages.send(channelId, content, { signal })
                if (result.isErr()) throw result.error
            },
            respond: (route, response) => void bot.rest.respond(route, response),
            shutdown: async (drainMs) => {
                await bot.client.shutdown(drainMs === undefined ? undefined : { drainMs })
            },
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const bot = await Effect.runPromise(
        createNativeTestBot({
            ...(onError ? { onError: (report: FailureReport) => Effect.sync(() => onError(report)) } : {}),
            commands: {
                prefix: "!",
                concurrency: 1,
                commands: {
                    ping: { execute: ({ reply }) => reply("Pong!") },
                    remind: {
                        arguments: remind,
                        execute: ({ client, message, values, reply }) =>
                            client
                                .schedule(client.messages.reply(message, values.note), { delayMs: values.delay })
                                .pipe(Effect.andThen(reply("Reminder set"))),
                    },
                },
            },
        }).pipe(Scope.provide(scope)),
    )
    await Effect.runPromise(bot.ready())
    const channelId = bot.fixtures.ids.channel
    return {
        say: async (content) => (await Effect.runPromise(bot.say(content))).map((message) => message.content),
        idle: () => Effect.runPromise(bot.idle()),
        sent: () => sent(bot.requests()),
        logs: () => bot.logs(),
        failures: () => bot.failures(),
        schedule: (work, options) => {
            const task = Effect.runSync(
                bot.client.schedule(
                    Effect.tryPromise({ try: (signal) => work(signal), catch: (error) => error }),
                    options,
                ),
            )
            return { close: () => Effect.runSync(task.close()) }
        },
        misuse: (task, options) => {
            const exit = Effect.runSyncExit(bot.client.schedule(task as never, options as never))
            if (Exit.isSuccess(exit)) throw new Error("client.schedule accepted misuse")
            return Cause.squash(exit.cause)
        },
        send: (content) => Effect.runPromise(bot.client.messages.send(channelId, content).pipe(Effect.asVoid)),
        respond: (route, response) => void bot.rest.respond(route, response),
        shutdown: (drainMs) => Effect.runPromise(bot.client.shutdown(drainMs === undefined ? undefined : { drainMs })),
    }
}

describe.each(modes)("%s scheduled tasks", (mode) => {
    // The commands guide once waited inside the command, which held the only command slot until the reminder was due
    test("a command schedules a reminder that replies after its delay without holding the command slot", async () => {
        const clock = sdkClock()
        const bot = await openBot(mode)
        expect(await bot.say("!remind 60s Stretch")).toEqual(["Reminder set"])
        expect(await bot.say("!ping")).toEqual(["Pong!"])
        await requestsSettled(clock)
        await clock.advance(59_999)
        await bot.idle()
        expect(bot.sent()).toEqual(["Reminder set", "Pong!"])
        await clock.advance(1)
        await vi.waitFor(() => expect(bot.sent()).toEqual(["Reminder set", "Pong!", "Stretch"]))
    })

    // A repeating task that stopped at its first failure would end a periodic job silently after one network error
    test("a repeating task keeps its schedule after failed runs, reports each one and can close itself", async () => {
        const clock = sdkClock()
        const reports: FailureReport[] = []
        const bot = await openBot(mode, (report) => void reports.push(report))
        const failure = new Error("Fluxer was unreachable")
        const runs: number[] = []
        const task = bot.schedule(
            async () => {
                runs.push(runs.length + 1)
                if (runs.length <= 2) throw failure
                task.close()
            },
            { intervalMs: 1_000 },
        )
        for (let run = 1; run <= 3; run++) {
            // Each wait starts when the previous run ends, so the next run is exactly one interval away
            await clock.waiting(1_000)
            await clock.advance(1_000)
            await vi.waitFor(() => expect(runs).toHaveLength(run))
        }
        await bot.idle()
        await clock.advance(1_000)
        await bot.idle()
        expect(runs).toEqual([1, 2, 3])
        await vi.waitFor(() => expect(reports).toHaveLength(2))
        expect(reports.map(({ kind, error }) => ({ kind, error }))).toEqual([
            { kind: "task", error: failure },
            { kind: "task", error: failure },
        ])
    })

    // Without a hook, a failed run must still be visible rather than disappearing with its fiber
    test("a failed run without an onError hook is logged at Error with its error", async () => {
        const bot = await openBot(mode)
        bot.schedule(async () => {
            throw new Error("The daily report could not be built")
        })
        await vi.waitFor(() => expect(bot.failures()).toHaveLength(1))
        expect(bot.failures()[0]).toMatchObject({
            level: "error",
            category: "lifecycle",
            code: "lifecycle.taskFailed",
            error: expect.objectContaining({ message: "The daily report could not be built" }),
        })
    })

    // Catches: The test kit counted a task failure as unhandled only for an application-made error, so a run that failed
    // because Fluxer rejected its request was missing from failures() and from the shutdown check
    test("a run failed by a Fluxer rejection without an onError hook is an unhandled failure", async () => {
        const bot = await openBot(mode)
        bot.respond("POST /channels/:id/messages", {
            status: 403,
            body: { code: "MISSING_PERMISSIONS", message: "Missing Permissions" },
        })
        bot.schedule((signal) => bot.send("Daily report", signal))
        await vi.waitFor(() => expect(codes(bot.logs())).toContain("lifecycle.taskFailed"))
        expect(bot.failures()).toEqual([
            expect.objectContaining({
                level: "error",
                code: "lifecycle.taskFailed",
                error: expect.objectContaining({ origin: "provider" }),
            }),
        ])
    })

    // A drain that ignored tasks would cancel a run half way, and a pending task must never fire after shutdown
    test("a draining shutdown lets a running task finish and cancels a task that has not run", async () => {
        const clock = sdkClock()
        const bot = await openBot(mode)
        const gate = Promise.withResolvers<void>()
        const started = Promise.withResolvers<void>()
        bot.schedule(async (signal) => {
            started.resolve()
            await gate.promise
            await bot.send("Saved", signal)
        })
        bot.schedule((signal) => bot.send("Too late", signal), { delayMs: 10_000 })
        await started.promise
        const stopping = bot.shutdown(30_000)
        await vi.waitFor(() => expect(codes(bot.logs())).toContain("lifecycle.draining"))
        expect(bot.logs().find((record) => record.code === "lifecycle.draining")).toMatchObject({
            fields: { tasks: 1 },
        })
        gate.resolve()
        await stopping
        expect(codes(bot.logs())).toContain("lifecycle.drained")
        // A task still waiting would run now and fail against the closed client
        await clock.advance(10_000)
        expect(bot.sent()).toEqual(["Saved"])
        expect(bot.failures()).toEqual([])
    })

    // A shutdown that waited for a task without a deadline could never finish
    test("the drain deadline cancels a task run that is still in progress", async () => {
        const clock = sdkClock()
        const bot = await openBot(mode)
        const started = Promise.withResolvers<void>()
        let cancelled = false
        bot.schedule(
            (signal) =>
                new Promise((resolve) => {
                    started.resolve()
                    signal.addEventListener("abort", () => {
                        cancelled = true
                        resolve(undefined)
                    })
                }),
        )
        await started.promise
        const stopping = bot.shutdown(50)
        await clock.waiting(50)
        await clock.advance(50)
        await stopping
        expect(cancelled).toBe(true)
        expect(bot.logs().find((record) => record.code === "lifecycle.drainTimedOut")).toMatchObject({
            level: "warn",
            fields: { tasks: 1, drainMs: 50 },
        })
    })

    // Without a record, reminders that a stop cancelled would vanish from the logs
    test("shutdown counts the tasks it cut short in one Info record", async () => {
        sdkClock()
        const bot = await openBot(mode)
        // A task whose only run finished and a task the application closed have nothing left to cancel
        bot.schedule(async () => undefined)
        bot.schedule(async () => undefined, { delayMs: 60_000 }).close()
        await bot.idle()
        bot.schedule(async () => undefined, { delayMs: 60_000 })
        bot.schedule(async () => undefined, { intervalMs: 1_000 })
        const started = Promise.withResolvers<void>()
        bot.schedule(
            (signal) =>
                new Promise((resolve) => {
                    started.resolve()
                    signal.addEventListener("abort", () => resolve(undefined))
                }),
        )
        await started.promise
        await bot.shutdown()
        expect(bot.logs().filter((record) => record.code === "lifecycle.tasksCancelled")).toEqual([
            expect.objectContaining({ level: "info", category: "lifecycle", fields: { cancelled: 3, running: 1 } }),
        ])
    })

    // A test that scheduled work and called idle would otherwise inspect results before the run finished
    test("idle waits for a task run in progress but not for a task still waiting for its time", async () => {
        sdkClock()
        const bot = await openBot(mode)
        const steps: string[] = []
        const started = Promise.withResolvers<void>()
        // Work outside the SDK, such as a database write, that no handler or REST request covers
        const write = Promise.withResolvers<void>()
        bot.schedule(async () => {
            steps.push("started")
            started.resolve()
            await write.promise
            steps.push("finished")
        })
        bot.schedule(async () => void steps.push("later"), { delayMs: 60_000 })
        await started.promise
        let settled = false
        const idle = bot.idle().then(() => {
            settled = true
        })
        // Idle settles after a few quiet timer turns, so a wait that ignored the running task would have settled by now
        for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
        expect(settled).toBe(false)
        write.resolve()
        await idle
        expect(steps).toEqual(["started", "finished"])
    })

    // A zero interval would spin, and a task accepted by a closed client would silently never run
    test("invalid tasks and options are misuse, and scheduling after shutdown is refused", async () => {
        const bot = await openBot(mode)
        const valid = mode === "default" ? () => undefined : Effect.void
        const field = (error: unknown) => {
            expect(error).toMatchObject({ _tag: "ConfigurationError" })
            return (error as { readonly field: string }).field
        }
        expect(field(bot.misuse("later"))).toBe("task")
        expect(field(bot.misuse(valid, { delayMs: -1 }))).toBe("delayMs")
        expect(field(bot.misuse(valid, { delayMs: 1.5 }))).toBe("delayMs")
        expect(field(bot.misuse(valid, { intervalMs: 0 }))).toBe("intervalMs")
        expect(field(bot.misuse(valid, { every: 1_000 }))).toBe("configuration")
        expect(field(bot.misuse(valid, "hourly"))).toBe("configuration")
        await bot.shutdown()
        expect(bot.misuse(valid)).toMatchObject({ _tag: "ClientClosedError" })
    })
})

// Shutdown waits for every task fiber, so a native task that shuts its own client down would wait for itself forever
test("a native task that shuts its client down ends at once and the shutdown completes", async () => {
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const bot = await Effect.runPromise(createNativeTestBot({}).pipe(Scope.provide(scope)))
    await Effect.runPromise(bot.ready())
    await Effect.runPromise(bot.client.schedule(bot.client.shutdown()))
    await Effect.runPromise(bot.client.waitForClose())
    expect(bot.client.state).toBe("Closed")
})

describe("runBot", () => {
    // The default setup once documented background work as untracked, so a stop cut it off without a drain
    test.each(modes)("%s lets a task started in setup finish when its signal stops the bot", async (mode) => {
        const harness = new TestHarness({})
        onTestFinished(() => void harness.close())
        harness.http.respond("POST /channels/:id/messages", { body: harness.fixtures.message({ content: "Saved" }) })
        const channelId = harness.fixtures.ids.channel
        const controller = new AbortController()
        const gate = Promise.withResolvers<void>()
        const started = Promise.withResolvers<void>()
        const run =
            mode === "default"
                ? Promise.resolve(
                      runBot({
                          ...harness.clientOptions({}),
                          signal: controller.signal,
                          setup: (client) => {
                              client.schedule(async (signal) => {
                                  started.resolve()
                                  await gate.promise
                                  return client.messages.send(channelId, "Saved", { signal })
                              })
                          },
                      }),
                  ).then((result) => result.isOk())
                : Effect.runPromiseExit(
                      runNativeBot({
                          ...harness.clientOptions({}),
                          signal: controller.signal,
                          setup: (client) =>
                              client.schedule(
                                  Effect.sync(() => started.resolve()).pipe(
                                      Effect.andThen(Effect.promise(() => gate.promise)),
                                      Effect.andThen(client.messages.send(channelId, "Saved")),
                                  ),
                              ),
                      }),
                  ).then(Exit.isSuccess)
        await started.promise
        await vi.waitFor(() => expect(codes(harness.logs())).toContain("lifecycle.connected"))
        controller.abort()
        await vi.waitFor(() => expect(codes(harness.logs())).toContain("lifecycle.draining"))
        gate.resolve()
        expect(await run).toBe(true)
        expect(sent(harness.http.requests())).toEqual(["Saved"])
    })
})
