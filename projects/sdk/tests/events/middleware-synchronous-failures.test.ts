import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { FailureReport, HandlerObservation, Observation } from "../../src/index.js"
import { createTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes } from "../support/both-apis.js"

// A synchronous throw must release both an ordinary handler slot and a partition key
for (const boundary of ["handler", "middleware"] as const) {
    for (const partition of [undefined, "channel"] as const) {
        test.each(modes)(
            `%s synchronous ${boundary} failure releases ${partition ?? "serial"} delivery`,
            async (mode) => {
                const failure = new TypeError("synchronous callback failure")
                const reports: FailureReport[] = []
                const observations: HandlerObservation[] = []
                const handled: string[] = []
                const observe = (observation: Observation) => {
                    if (observation.type === "handler") observations.push(observation)
                }
                const record = (content: string) => {
                    if (boundary === "handler" && content === "bad") throw failure
                    handled.push(content)
                }
                if (mode === "default") {
                    const test = createTestClient({ observe })
                    onTestFinished(() => test.shutdown())
                    const subscription = test.client.on("messageCreate", (message) => record(message.content), {
                        concurrency: 1,
                        ...(partition === undefined ? {} : { partition }),
                        onError: (report) => void reports.push(report),
                    })
                    test.client.use((invocation, next) => {
                        if (
                            boundary === "middleware" &&
                            invocation.event === "messageCreate" &&
                            invocation.payload.content === "bad"
                        )
                            throw failure
                        return next()
                    })
                    await test.ready()
                    test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "bad" }))
                    test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "good" }))
                    await test.idle({ timeoutMs: 500 })
                    expect(observations.map((observation) => observation.subscriptionId)).toEqual([
                        subscription.id,
                        subscription.id,
                    ])
                    expect(test.counters().handlerFailures).toBe(1)
                } else {
                    const scope = Scope.makeUnsafe()
                    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
                    const test = await Effect.runPromise(createNativeTestClient({ observe }).pipe(Scope.provide(scope)))
                    const subscription = await Effect.runPromise(
                        test.client
                            .on(
                                "messageCreate",
                                (message) => {
                                    record(message.content)
                                    return Effect.void
                                },
                                {
                                    concurrency: 1,
                                    ...(partition === undefined ? {} : { partition }),
                                    onError: (report) => Effect.sync(() => void reports.push(report)),
                                },
                            )
                            .pipe(Scope.provide(scope)),
                    )
                    await Effect.runPromise(
                        test.client
                            .use((invocation, next) => {
                                if (
                                    boundary === "middleware" &&
                                    invocation.event === "messageCreate" &&
                                    invocation.payload.content === "bad"
                                )
                                    throw failure
                                return next
                            })
                            .pipe(Scope.provide(scope)),
                    )
                    await Effect.runPromise(test.ready())
                    await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "bad" })))
                    await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "good" })))
                    await Effect.runPromise(test.idle({ timeoutMs: 500 }))
                    expect(observations.map((observation) => observation.subscriptionId)).toEqual([
                        subscription.id,
                        subscription.id,
                    ])
                    expect(test.counters().handlerFailures).toBe(1)
                }
                expect(handled).toEqual(["good"])
                expect(reports).toHaveLength(1)
                expect(reports[0]).toMatchObject({ kind: "handler", event: "messageCreate", error: failure })
                expect(observations.map((observation) => observation.outcome)).toEqual(["failure", "success"])
                expect(observations[0]).toMatchObject({ errorName: "TypeError" })
            },
        )
    }
}
