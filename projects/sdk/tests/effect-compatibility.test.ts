import { Cause, Deferred, Effect, Exit, Fiber, Logger, References } from "effect"
import { describe, expect, test } from "vitest"

describe("Effect 4 dependency compatibility", () => {
    test("interruption waits for scoped cleanup without becoming a typed failure", async () => {
        const events: string[] = []
        const exit = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const started = yield* Deferred.make<void>()
                    const worker = yield* Effect.forkScoped(
                        Effect.scoped(
                            Effect.gen(function* () {
                                yield* Effect.acquireRelease(
                                    Effect.sync(() => events.push("acquired")),
                                    () =>
                                        Effect.sync(() => {
                                            events.push("released")
                                        }),
                                )
                                yield* Deferred.succeed(started, undefined)
                                yield* Effect.never
                            }),
                        ),
                    )
                    yield* Deferred.await(started)
                    yield* Fiber.interrupt(worker)
                    events.push("interrupted")
                    return yield* Effect.exit(Fiber.join(worker))
                }),
            ),
        )

        expect(events).toEqual(["acquired", "released", "interrupted"])
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    })

    test("preserves an expected failure alongside a finalizer defect", async () => {
        const failure = { _tag: "OperationFailure" }
        const defect = new Error("Cleanup failed")
        const exit = await Effect.runPromiseExit(
            Effect.scoped(
                Effect.gen(function* () {
                    yield* Effect.acquireRelease(Effect.void, () => Effect.die(defect))
                    return yield* Effect.fail(failure)
                }),
            ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ _tag: "Fail", error: failure }),
                    expect.objectContaining({ _tag: "Die", defect }),
                ]),
            )
        }
    })

    test("preserves interruption alongside a finalizer defect", async () => {
        const exit = await Effect.runPromiseExit(
            Effect.scoped(
                Effect.gen(function* () {
                    yield* Effect.acquireRelease(Effect.void, () => Effect.die("Cleanup failed"))
                    return yield* Effect.interrupt
                }),
            ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            expect(Cause.hasInterrupts(exit.cause)).toBe(true)
            expect(Cause.hasDies(exit.cause)).toBe(true)
            expect(Cause.hasFails(exit.cause)).toBe(false)
        }
    })

    test("retains caller logging annotations and tracing across suspension and cleanup", async () => {
        const messages: unknown[] = []
        const contexts: Array<{ requestId: unknown; spanName: string }> = []
        const logger = Logger.make((entry) => {
            messages.push(entry.message)
        })
        const observeContext = Effect.gen(function* () {
            const annotations = yield* References.CurrentLogAnnotations
            const span = yield* Effect.currentSpan
            contexts.push({ requestId: annotations.requestId, spanName: span.name })
        })

        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    yield* Effect.addFinalizer(() =>
                        Effect.gen(function* () {
                            yield* observeContext.pipe(Effect.orDie)
                            yield* Effect.log("Released")
                        }),
                    )
                    yield* Effect.yieldNow
                    yield* observeContext
                    yield* Effect.log("Created")
                }),
            ).pipe(
                Effect.withSpan("Consumer operation"),
                Effect.annotateLogs("requestId", "compatibility-check"),
                Effect.withLogger(logger),
            ),
        )

        expect(contexts).toEqual([
            { requestId: "compatibility-check", spanName: "Consumer operation" },
            { requestId: "compatibility-check", spanName: "Consumer operation" },
        ])
        expect(messages).toEqual([["Created"], ["Released"]])
    })
})
