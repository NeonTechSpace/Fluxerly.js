import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { Client } from "../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"
import { expectErr, settle, type Operation } from "../support/settle.js"

async function open(mode: Mode) {
    if (mode === "default") {
        const test = createDefaultTestClient()
        onTestFinished(() => test.shutdown())
        return test
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
}

const broken = "Hello 😀 world".slice(0, 7)
const target = { id: "3", channelId: "2" }

test.each(modes)("%s fails locally when request text holds a lone surrogate", async (mode) => {
    const api = await open(mode)
    const message = api.fixtures.message({ channel_id: "2", id: "3" })
    const routes = [
        api.rest.respond("POST /channels/2/messages", { body: message }),
        api.rest.respond("PATCH /channels/2/messages/3", { body: message }),
        api.rest.respond("PATCH /channels/2", { body: api.fixtures.channel() }),
    ]
    const client = api.client as Client
    const operations: Operation<unknown, unknown>[] = [
        client.messages.send("2", broken),
        client.messages.send("2", { embeds: [{ description: broken }] }),
        client.messages.send("2", { embeds: [{ description: "ok", fields: [{ name: "a\\", value: `\\${broken}` }] }] }),
        client.messages.edit(target, { content: `a\udc00b` }),
        client.channels.edit("2", { topic: broken }),
    ]
    for (const operation of operations)
        expect(await expectErr(operation)).toMatchObject({ reason: "input", outcome: "notDispatched" })
    for (const route of routes) expect(route.requests()).toHaveLength(0)
})

test.each(modes)("%s still sends well-formed text that only looks like an escape", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("POST /channels/2/messages", { body: api.fixtures.message({ channel_id: "2" }) })
    const client = api.client as Client
    // The first is a whole emoji, the second is the six typed characters of an escape, and the third is a replacement
    for (const content of ["😀 fine", "\\ud83d", "Hello \ufffd"]) await settle(client.messages.send("2", content))
    expect(route.requests().map((request) => (request.body as { content: string }).content)).toEqual([
        "😀 fine",
        "\\ud83d",
        "Hello \ufffd",
    ])
})

test.each(modes)("%s sends a caller-described body as given", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("POST /channels/2/messages", { body: api.fixtures.message({ channel_id: "2" }) })
    const client = api.client as Client
    await settle(client.rest.request({ method: "POST", path: "/channels/2/messages", body: { content: broken } }))
    expect(route.requests()).toHaveLength(1)
})
