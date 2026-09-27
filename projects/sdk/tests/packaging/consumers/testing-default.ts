import {
    createTestClient,
    fixtures,
    type Fixtures,
    type TestClient,
    type TestClientOptions,
    type TestRequest,
    type TestResponder,
    type WireMessage,
} from "@neontechspace/fluxerly/testing"
import type { Message } from "@neontechspace/fluxerly"

// Compiled with ES2024 and Node.js types only: the default testing declarations must not need Effect or DOM types
const options: TestClientOptions<["attachments"]> = { messageFields: ["attachments"], logging: { level: "warn" } }
export const selected: TestClient<Message> | undefined = undefined
export const shared: Fixtures = fixtures

/** Drive a !ping bot through the in-memory Fluxer and return the requests the respond handler answered */
export async function pingTest(): Promise<readonly TestRequest[]> {
    const test = createTestClient(options)
    try {
        const reply: TestResponder = (request) => ({
            body: test.fixtures.message({ content: String((request.body as { content?: unknown }).content) }),
        })
        const route = test.rest.respond("POST /channels/:id/messages", reply)
        test.client.on("messageCreate", (message) =>
            message.content === "!ping" ? test.client.messages.reply(message, { content: "Pong!" }) : undefined,
        )
        await test.ready()
        const ping: WireMessage = test.fixtures.message({ content: "!ping" })
        test.emit("MESSAGE_CREATE", ping, { shardId: 0 })
        await route.next({ timeoutMs: 5_000 })
        await test.idle()
        return route.requests()
    } finally {
        await test.shutdown()
    }
}
