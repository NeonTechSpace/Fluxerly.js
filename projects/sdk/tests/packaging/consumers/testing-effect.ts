import { Effect } from "effect"
import {
    createTestClient,
    type TestClient,
    type TestClientOptions,
    type TestRequest,
    type WireMessage,
} from "@neontechspace/fluxerly/effect/testing"
import type { Message } from "@neontechspace/fluxerly/effect"

const options: TestClientOptions = { logging: { level: "warn" } }
export const selected: TestClient<Message> | undefined = undefined

/** Drive a !ping bot through the in-memory Fluxer and return the requests the respond handler answered */
export const pingTest: Effect.Effect<readonly TestRequest[]> = Effect.scoped(
    Effect.gen(function* () {
        const test = yield* createTestClient(options)
        const route = test.rest.respond("POST /channels/:id/messages", (request) => ({
            body: test.fixtures.message({ content: String((request.body as { content?: unknown }).content) }),
        }))
        yield* test.client.on("messageCreate", (message) =>
            message.content === "!ping" ? test.client.messages.reply(message, { content: "Pong!" }) : Effect.void,
        )
        yield* test.ready()
        const ping: WireMessage = test.fixtures.message({ content: "!ping" })
        yield* test.emit("MESSAGE_CREATE", ping)
        yield* route.next({ timeoutMs: 5_000 })
        yield* test.idle()
        return route.requests()
    }).pipe(Effect.orDie),
)
