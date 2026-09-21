import { Deferred, Effect, Exit, Scope } from "effect"
import { expect, test } from "vitest"
import { EventBus } from "../src/internal/events.js"

test("event registration accounting follows actual owners and idempotent cleanup", async () => {
    const bus = new EventBus()
    const sources = await Effect.runPromise(Effect.forEach(Array.from({ length: 80 }), () => bus.open("messageCreate")))
    const messages = Array.from({ length: 12 }, () => bus.listenMessages("20", () => {}))
    const reactions = Array.from({ length: 7 }, () => bus.listenReactions({ channelId: "20", id: "10" }, () => {}))
    expect(bus.diagnostics()).toEqual({
        subscriptions: 80,
        messageCollectors: 12,
        reactionCollectors: 7,
        activeHandlers: 0,
    })
    for (const source of sources) source.stop()
    for (const stop of [...messages, ...reactions]) {
        stop()
        stop()
    }
    expect(bus.diagnostics()).toEqual({
        subscriptions: 0,
        messageCollectors: 0,
        reactionCollectors: 0,
        activeHandlers: 0,
    })
    bus.stop()
    expect(Exit.isFailure(await Effect.runPromiseExit(bus.open("messageCreate")))).toBe(true)
    expect(bus.diagnostics().subscriptions).toBe(0)
})

test("executing handler accounting releases after interruption and failure", async () => {
    for (const fail of [false, true]) {
        const bus = new EventBus()
        const scope = Scope.makeUnsafe()
        const entered = Deferred.makeUnsafe<void>()
        const release = Deferred.makeUnsafe<void>()
        const reported = Deferred.makeUnsafe<void>()
        try {
            await Effect.runPromise(
                bus.on(
                    "messageDelete",
                    () =>
                        Effect.gen(function* () {
                            yield* Deferred.succeed(entered, undefined)
                            yield* Deferred.await(release)
                            if (fail) yield* Effect.fail("fixture")
                        }),
                    undefined,
                    () => Deferred.succeed(reported, undefined),
                    scope,
                ),
            )
            bus.offer("messageDelete", { id: "10", channelId: "20" }, 1)
            await Effect.runPromise(Deferred.await(entered))
            expect(bus.diagnostics()).toMatchObject({ subscriptions: 1, activeHandlers: 1 })
            if (fail) {
                await Effect.runPromise(Deferred.succeed(release, undefined))
                await Effect.runPromise(Deferred.await(reported))
            }
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
        expect(bus.diagnostics()).toEqual({
            subscriptions: 0,
            messageCollectors: 0,
            reactionCollectors: 0,
            activeHandlers: 0,
        })
    }
})
