import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { Effect, Logger, References } from "effect"
import { createClient } from "@neontechspace/fluxerly/effect"

globalThis.fetch = () => {
    throw new Error("Creation must not make HTTP requests")
}
globalThis.WebSocket = class {
    constructor() {
        throw new Error("Creation must not open a WebSocket")
    }
}

const messages = []
const client = await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({ token: "fixture-only-not-a-credential" })
            assert.equal(client.state, "Disconnected")
            yield* Effect.yieldNow
            assert.equal((yield* Effect.currentSpan).name, "Packed consumer")
            assert.equal((yield* References.CurrentLogAnnotations).requestId, "package-check")
            yield* Effect.log("Consumer message")
            return client
        }),
    ).pipe(
        Effect.withSpan("Packed consumer"),
        Effect.annotateLogs("requestId", "package-check"),
        Effect.provide(
            Logger.layer([
                Logger.make((entry) => {
                    messages.push(entry.message)
                }),
            ]),
        ),
    ),
)

assert.equal(client.state, "Closed")
assert.deepEqual(messages, [["Consumer message"]])
assert.equal(
    Effect.runSync(
        createClient({ token: "" }).pipe(
            Effect.catchTag("ConfigurationError", (error) => Effect.succeed(error.field)),
            Effect.scoped,
        ),
    ),
    "token",
)

const fromSdk = createRequire(import.meta.resolve("@neontechspace/fluxerly/effect"))
assert.equal(realpathSync(fromSdk.resolve("effect")), realpathSync(fileURLToPath(import.meta.resolve("effect"))))
console.log("Effect JavaScript packed consumer passed")
