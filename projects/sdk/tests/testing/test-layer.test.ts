import { Cause, Effect, Exit } from "effect"
import { expect, test } from "vitest"
import { FluxerClient } from "../../src/effect.js"
import { FluxerTestClient, UnhandledTestFailuresError } from "../../src/effect-testing.js"

/** Application code under test, which only knows the FluxerClient service */
const registerPing = Effect.gen(function* () {
    const client = yield* FluxerClient
    yield* client.on("messageCreate", (message) =>
        message.content === "!ping" ? client.messages.reply(message, "Pong!") : Effect.void,
    )
})

test("FluxerTestClient.layer provides the test client as FluxerClient, so application code runs unchanged", async () => {
    const reply = await Effect.runPromise(
        Effect.gen(function* () {
            yield* registerPing
            const test = yield* FluxerTestClient
            expect(yield* FluxerClient).toBe(test.client)
            const replies = test.rest.respond("POST /channels/:id/messages", {
                body: test.fixtures.message({ content: "Pong!" }),
            })
            yield* test.ready()
            yield* test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ping" }))
            return yield* replies.next()
        }).pipe(Effect.scoped, Effect.provide(FluxerTestClient.layer())),
    )
    expect(reply.body).toMatchObject({ content: "Pong!" })
})

test("closing the layer shuts the client down and fails for a handler failure the test did not read", async () => {
    let client: FluxerClient["Service"] | undefined
    const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
            const test = yield* FluxerTestClient
            client = test.client
            yield* test.client.on("typingStart", () => Effect.fail(new Error("handler failed")))
            yield* test.ready()
            yield* test.emit("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 })
            yield* test.idle()
        }).pipe(Effect.scoped, Effect.provide(FluxerTestClient.layer())),
    )
    expect(client?.state).toBe("Closed")
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(UnhandledTestFailuresError)
})
