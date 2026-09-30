import { Effect, Exit, Metric, Scope, Tracer } from "effect"
import { expect, onTestFinished, test, vi } from "vitest"
import {
    commands,
    type FailureReport,
    type HandlerObservation,
    type Observation,
    type PrefixCommandRejection,
} from "../../src/index.js"
import { commands as nativeCommands } from "../../src/effect.js"
import { createTestBot, createTestClient } from "../../src/testing.js"
import {
    createTestBot as createNativeTestBot,
    createTestClient as createNativeTestClient,
} from "../../src/effect-testing.js"
import { modes } from "../support/both-apis.js"

// A false guard remains visible in diagnostics without making runBot's default feedback send a reply
test.each(modes)("%s runBot keeps false guard denials silent and replies to explicit deny reasons", async (mode) => {
    let executed = 0
    const observations: HandlerObservation[] = []
    const observe = (observation: Observation) => {
        if (observation.type === "handler") observations.push(observation)
    }
    const reasons = [false, { deny: "An explicit guard denial" }] as const
    if (mode === "default") {
        const bot = createTestBot({
            observe,
            logging: { debug: ["commands"] },
            commands: {
                prefix: "!",
                commands: {
                    denied: {
                        guard: () => reasons[0],
                        execute: () => void executed++,
                    },
                    explained: {
                        guard: () => reasons[1],
                        execute: () => void executed++,
                    },
                },
            },
        })
        onTestFinished(() => bot.shutdown())
        const replies = bot.rest.respond("POST /channels/:id/messages", { body: bot.fixtures.message() })
        await bot.ready()
        bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content: "!denied" }))
        await bot.idle()
        expect(replies.requests()).toHaveLength(0)
        bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content: "!explained" }))
        await bot.idle()
        expect(replies.requests().map((request) => (request.body as { content: string }).content)).toEqual([
            reasons[1].deny,
        ])
        expect(bot.counters().commandRejections).toBe(2)
        expect(bot.logs().filter((record) => record.code === "commands.rejected")).toHaveLength(2)
    } else {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const bot = await Effect.runPromise(
            createNativeTestBot({
                observe,
                logging: { debug: ["commands"] },
                commands: {
                    prefix: "!",
                    commands: {
                        denied: {
                            guard: () => Effect.succeed(reasons[0]),
                            execute: () => Effect.sync(() => void executed++),
                        },
                        explained: {
                            guard: () => Effect.succeed(reasons[1]),
                            execute: () => Effect.sync(() => void executed++),
                        },
                    },
                },
            }).pipe(Scope.provide(scope)),
        )
        const replies = bot.rest.respond("POST /channels/:id/messages", { body: bot.fixtures.message() })
        await Effect.runPromise(bot.ready())
        await Effect.runPromise(bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content: "!denied" })))
        await Effect.runPromise(bot.idle())
        expect(replies.requests()).toHaveLength(0)
        await Effect.runPromise(bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content: "!explained" })))
        await Effect.runPromise(bot.idle())
        expect(replies.requests().map((request) => (request.body as { content: string }).content)).toEqual([
            reasons[1].deny,
        ])
        expect(bot.counters().commandRejections).toBe(2)
        expect(bot.logs().filter((record) => record.code === "commands.rejected")).toHaveLength(2)
    }
    expect(executed).toBe(0)
    expect(observations.map(({ command, outcome }) => ({ command, outcome }))).toEqual([
        { command: "denied", outcome: "success" },
        { command: "explained", outcome: "success" },
    ])
})

for (const reportToHook of [false, true]) {
    test.each(modes)(
        `%s router observations retain command identity and failure after ${reportToHook ? "onError" : "logging"}`,
        async (mode) => {
            let now = 0
            const clock = vi.spyOn(performance, "now").mockImplementation(() => now)
            onTestFinished(() => clock.mockRestore())
            const observations: HandlerObservation[] = []
            const reports: FailureReport[] = []
            const failure = new TypeError("command failed")
            const observe = (observation: Observation) => {
                if (observation.type === "handler") observations.push(observation)
            }
            let subscriptionId: string
            if (mode === "default") {
                const test = createTestClient({ observe })
                onTestFinished(() => test.shutdown())
                test.client.use(async (_invocation, next) => {
                    now += 10
                    await next()
                    now += 20
                })
                const router = commands
                    .create({
                        prefix: "!",
                        use: [
                            async (context, next) => {
                                now += 15
                                if (context.name !== "stopped") await next().catch(() => undefined)
                                now += 30
                            },
                        ],
                    })
                    .registerMany({
                        broken: {
                            aliases: ["alias"],
                            execute: () => {
                                throw failure
                            },
                        },
                        good: { execute: () => undefined },
                        stopped: { execute: () => expect.fail("Middleware-stopped command executed") },
                    })
                const subscription = router.attach(test.client, {
                    concurrency: 1,
                    ...(reportToHook ? { onError: (report: FailureReport) => void reports.push(report) } : {}),
                })
                subscriptionId = subscription.id
                await test.ready()
                for (const content of ["hello", "!unknown", "!ALIAS", "!good", "!stopped"]) {
                    test.emit("MESSAGE_CREATE", test.fixtures.message({ content }))
                    await test.idle()
                }
                expect(test.counters().handlerFailures).toBe(1)
                if (!reportToHook)
                    expect(test.failures()).toMatchObject([{ code: "commands.failed", command: "broken" }])
            } else {
                const scope = Scope.makeUnsafe()
                onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
                const test = await Effect.runPromise(createNativeTestClient({ observe }).pipe(Scope.provide(scope)))
                await Effect.runPromise(
                    test.client
                        .use((_invocation, next) =>
                            Effect.gen(function* () {
                                now += 10
                                yield* next
                                now += 20
                            }),
                        )
                        .pipe(Scope.provide(scope)),
                )
                const router = nativeCommands
                    .create({
                        prefix: "!",
                        use: [
                            (context, next) =>
                                Effect.gen(function* () {
                                    now += 15
                                    if (context.name !== "stopped")
                                        yield* next.pipe(Effect.catchCause(() => Effect.void))
                                    now += 30
                                }),
                        ],
                    })
                    .registerMany({
                        broken: { aliases: ["alias"], execute: () => Effect.fail(failure) },
                        good: { execute: () => Effect.void },
                        stopped: { execute: () => Effect.die("Middleware-stopped command executed") },
                    })
                const subscription = await Effect.runPromise(
                    router
                        .attach(test.client, {
                            concurrency: 1,
                            ...(reportToHook
                                ? { onError: (report: FailureReport) => Effect.sync(() => void reports.push(report)) }
                                : {}),
                        })
                        .pipe(Scope.provide(scope)),
                )
                subscriptionId = subscription.id
                await Effect.runPromise(test.ready())
                for (const content of ["hello", "!unknown", "!ALIAS", "!good", "!stopped"]) {
                    await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content })))
                    await Effect.runPromise(test.idle())
                }
                expect(test.counters().handlerFailures).toBe(1)
                if (!reportToHook)
                    expect(test.failures()).toMatchObject([{ code: "commands.failed", command: "broken" }])
            }
            expect(observations.map(({ command, outcome }) => ({ command, outcome }))).toEqual([
                { command: undefined, outcome: "success" },
                { command: undefined, outcome: "success" },
                { command: "broken", outcome: "failure" },
                { command: "good", outcome: "success" },
                { command: "stopped", outcome: "success" },
            ])
            expect(observations[2]).toMatchObject({
                subscriptionId,
                event: "messageCreate",
                errorName: "TypeError",
                durationMs: 75,
            })
            expect(reports).toHaveLength(reportToHook ? 1 : 0)
        },
    )
}

test.each(modes)(
    "%s interruption takes precedence over an earlier command failure in one named observation",
    async (mode) => {
        const observations: HandlerObservation[] = []
        const failure = new TypeError("command failed before interruption")
        const started = Promise.withResolvers<void>()
        const observe = (observation: Observation) => {
            if (observation.type === "handler") observations.push(observation)
        }
        if (mode === "default") {
            const test = createTestClient({ observe })
            onTestFinished(() => test.shutdown())
            const subscription = commands
                .create({
                    prefix: "!",
                    use: [
                        async (_context, next) => {
                            await next().catch(() => undefined)
                            started.resolve()
                            await new Promise<void>(() => undefined)
                        },
                    ],
                })
                .register({
                    name: "hold",
                    execute: () => {
                        throw failure
                    },
                })
                .attach(test.client)
            await test.ready()
            test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!hold" }))
            await started.promise
            subscription.close()
            await subscription.waitForClose()
            expect(test.counters().handlerFailures).toBe(1)
            expect(test.failures()).toMatchObject([{ code: "commands.failed", command: "hold" }])
        } else {
            const scope = Scope.makeUnsafe()
            onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
            const test = await Effect.runPromise(createNativeTestClient({ observe }).pipe(Scope.provide(scope)))
            const subscription = await Effect.runPromise(
                nativeCommands
                    .create({
                        prefix: "!",
                        use: [
                            (_context, next) =>
                                next.pipe(
                                    Effect.catchCause(() => Effect.void),
                                    Effect.andThen(Effect.sync(() => started.resolve())),
                                    Effect.andThen(Effect.never),
                                ),
                        ],
                    })
                    .register({ name: "hold", execute: () => Effect.fail(failure) })
                    .attach(test.client)
                    .pipe(Scope.provide(scope)),
            )
            await Effect.runPromise(test.ready())
            await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!hold" })))
            await started.promise
            await Effect.runPromise(subscription.close())
            await Effect.runPromise(subscription.waitForClose())
            expect(test.counters().handlerFailures).toBe(1)
            expect(test.failures()).toMatchObject([{ code: "commands.failed", command: "hold" }])
        }
        expect(observations).toHaveLength(1)
        expect(observations[0]).toMatchObject({ command: "hold", outcome: "cancelled" })
        expect(observations[0]?.errorName).toBeUndefined()
    },
)

for (const boundary of ["middleware", "guard", "execute"] as const) {
    test.each(modes)(`%s command ${boundary} failures retain the canonical metric and span identity`, async (mode) => {
        const failure = new TypeError("command boundary failed")
        const reports: FailureReport[] = []
        const spans: Tracer.Span[] = []
        const activeSpans: Tracer.Span[] = []
        const tracer = Tracer.make({
            span: (options) => {
                const span = Tracer.nativeTracer.span(options)
                spans.push(span)
                return span
            },
        })
        const registry: Metric.MetricRegistry = new Map()
        const snapshot = () =>
            Effect.runPromise(
                mode === "default"
                    ? Metric.snapshot
                    : Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)),
            )
        const failureCount = (snapshots: readonly Metric.Metric.Snapshot[]) => {
            const metric = snapshots.find(
                ({ id, attributes }) => id === "fluxerly_handler_failures_total" && attributes?.event === "canonical",
            )
            return metric?.type === "Counter" ? Number(metric.state.count) : 0
        }
        const before = failureCount(await snapshot())
        if (mode === "default") {
            const test = createTestClient()
            onTestFinished(() => test.shutdown())
            commands
                .create({
                    prefix: "!",
                    use: [
                        async (_context, next) => {
                            if (boundary === "middleware") throw failure
                            await next()
                        },
                    ],
                })
                .register({
                    name: "canonical",
                    aliases: ["alias"],
                    guard: () => {
                        if (boundary === "guard") throw failure
                        return true
                    },
                    execute: () => {
                        throw failure
                    },
                })
                .attach(test.client, { onError: (report) => void reports.push(report) })
            await test.ready()
            test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ALIAS" }))
            await test.idle()
            expect(test.counters().handlerFailures).toBe(1)
        } else {
            const recordSpan = Effect.gen(function* () {
                const span = yield* Effect.currentSpan
                activeSpans.push(span)
            })
            await Effect.runPromise(
                Effect.gen(function* () {
                    const test = yield* createNativeTestClient()
                    yield* nativeCommands
                        .create({
                            prefix: "!",
                            use: [
                                (_context, next) =>
                                    Effect.gen(function* () {
                                        yield* recordSpan
                                        if (boundary === "middleware") return yield* Effect.fail(failure)
                                        yield* next
                                    }),
                            ],
                        })
                        .register({
                            name: "canonical",
                            aliases: ["alias"],
                            guard: () =>
                                recordSpan.pipe(
                                    Effect.andThen(boundary === "guard" ? Effect.fail(failure) : Effect.succeed(true)),
                                ),
                            execute: () => recordSpan.pipe(Effect.andThen(Effect.fail(failure))),
                        })
                        .attach(test.client, {
                            onError: (report) => Effect.sync(() => void reports.push(report)),
                        })
                    yield* test.ready()
                    yield* test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ALIAS" }))
                    yield* test.idle()
                    expect(test.counters().handlerFailures).toBe(1)
                }).pipe(
                    Effect.scoped,
                    Effect.provideService(Metric.MetricRegistry, registry),
                    Effect.provideService(Tracer.Tracer, tracer),
                ),
            )
            const commandSpans = spans.filter(({ name }) => name === "fluxerly.command.execute")
            expect(commandSpans).toHaveLength(1)
            const commandSpan = commandSpans[0]!
            expect(commandSpan.attributes.get("fluxerly.command")).toBe("canonical")
            expect(activeSpans).toHaveLength(["middleware", "guard", "execute"].indexOf(boundary) + 1)
            for (const span of activeSpans) expect(span).toBe(commandSpan)
            expect(commandSpan.status._tag).toBe("Ended")
            if (commandSpan.status._tag === "Ended") expect(Exit.isFailure(commandSpan.status.exit)).toBe(true)
        }
        expect(failureCount(await snapshot()) - before).toBe(1)
        expect(reports).toHaveLength(1)
        expect(reports[0]).toMatchObject({ command: "canonical", error: failure })
    })
}

// Custom rejection callbacks still see a false verdict even though automatic replies remain silent
test.each(modes)("%s a false guard still reaches custom rejection feedback", async (mode) => {
    const rejected: PrefixCommandRejection[] = []
    if (mode === "default") {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        commands
            .create({ prefix: "!", onReject: (_context, rejection) => void rejected.push(rejection) })
            .register({ name: "deny", guard: () => false, execute: () => expect.fail("Denied command executed") })
            .attach(test.client)
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!deny" }))
        await test.idle()
    } else {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const test = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
        await Effect.runPromise(
            nativeCommands
                .create({
                    prefix: "!",
                    onReject: (_context, rejection) => Effect.sync(() => void rejected.push(rejection)),
                })
                .register({
                    name: "deny",
                    guard: () => Effect.succeed(false),
                    execute: () => Effect.die("Denied command executed"),
                })
                .attach(test.client)
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!deny" })))
        await Effect.runPromise(test.idle())
    }
    expect(rejected).toEqual([{ _tag: "CommandGuardRejected" }])
})

// Event middleware wraps the whole router invocation, so its failure stays an event failure even after a command ran
test.each(modes)("%s event middleware failures around a command are not reported as command failures", async (mode) => {
    const observations: HandlerObservation[] = []
    const observe = (observation: Observation) => {
        if (observation.type === "handler") observations.push(observation)
    }
    const failure = new TypeError("event middleware broke")
    let executed = 0
    if (mode === "default") {
        const test = createTestClient({ observe })
        onTestFinished(() => test.shutdown())
        test.client.use(async (_invocation, next) => {
            await next()
            throw failure
        })
        commands
            .create({ prefix: "!" })
            .registerMany({ ping: { execute: () => void executed++ } })
            .attach(test.client)
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ping" }))
        await test.idle()
        expect(test.failures()).toMatchObject([{ code: "events.handlerFailed" }])
        expect(test.failures()[0]).not.toHaveProperty("command")
    } else {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const test = await Effect.runPromise(createNativeTestClient({ observe }).pipe(Scope.provide(scope)))
        await Effect.runPromise(
            test.client
                .use((_invocation, next) => next.pipe(Effect.andThen(Effect.fail(failure))))
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(
            nativeCommands
                .create({ prefix: "!" })
                .registerMany({ ping: { execute: () => Effect.sync(() => void executed++) } })
                .attach(test.client)
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ping" })))
        await Effect.runPromise(test.idle())
        expect(test.failures()).toMatchObject([{ code: "events.handlerFailed" }])
        expect(test.failures()[0]).not.toHaveProperty("command")
    }
    expect(executed).toBe(1)
    expect(observations).toMatchObject([{ command: "ping", outcome: "failure", errorName: "TypeError" }])
})
