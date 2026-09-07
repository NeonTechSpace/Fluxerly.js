import assert from "node:assert/strict"

globalThis.fetch = () => {
    throw new Error("Creation must not make HTTP requests")
}
globalThis.WebSocket = class {
    constructor() {
        throw new Error("Creation must not open a WebSocket")
    }
}

const { createClient, ConfigurationError, MessageOperationError } = await import("@neontechspace/fluxerly")
const result = createClient({ token: "fixture-only-not-a-credential" })
assert.equal(result.isOk(), true)
assert.equal(result.value.state, "Disconnected")
assert.equal(Reflect.set(result.value, "state", "Connected"), false)

const invalid = createClient({ token: "" })
assert.equal(invalid.isErr(), true)
assert.ok(invalid.error instanceof ConfigurationError)
assert.equal(invalid.error._tag, "ConfigurationError")
const registered = result.value.on(
    "messageCreate",
    async (message, signal) => {
        const sent = await result.value.messages.reply(message, { content: "packed reply" }, { signal })
        assert.ok(sent.isOk())
    },
    { concurrency: 2 },
)
assert.ok(registered.isOk())
registered.value.unsubscribe()
assert.ok((await registered.value.waitForClose()).isOk())
const events = result.value.events("messageCreate")
assert.ok(events.isOk())
events.value.unsubscribe()
assert.equal((await events.value.next()).value, null)
const invalidSend = await result.value.messages.send("20", { content: "" })
assert.equal(invalidSend.error._tag, "MessageError")
for (const event of ["messageUpdate", "messageDelete", "messageDeleteBulk"]) {
    const subscribed = result.value.on(event, () => {})
    assert.ok(subscribed.isOk())
    subscribed.value.unsubscribe()
    assert.ok((await subscribed.value.waitForClose()).isOk())
    const pull = result.value.events(event)
    assert.ok(pull.isOk())
    pull.value.unsubscribe()
    assert.equal((await pull.value.next()).value, null)
}
const invalidEdit = await result.value.messages.edit({ channelId: "20", id: "10" }, {})
assert.ok(invalidEdit.error instanceof MessageOperationError)
assert.equal(invalidEdit.error.outcome, "notDispatched")
const requests = []
globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages/10")
    requests.push(init.method)
    return init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({
              id: "10",
              channel_id: "20",
              content: init.body ? JSON.parse(init.body).content : "Original",
              author: { id: "30", username: "fixture" },
          })
}
const fetched = await result.value.messages.fetch({ channelId: "20", id: "10" })
assert.ok(fetched.isOk())
const edited = await result.value.messages.edit(fetched.value, { content: "Updated" })
assert.equal(edited.value.content, "Updated")
assert.ok(Object.isFrozen(edited.value.author))
const deleted = await result.value.messages.delete(edited.value)
assert.ok(deleted.isOk())
assert.equal(deleted.value, undefined)
assert.deepEqual(requests, ["GET", "PATCH", "DELETE"])
globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages?limit=2&before=11")
    assert.equal(init.method, "GET")
    return Response.json([
        { id: "10", channel_id: "20", content: "History", author: { id: "30", username: "fixture" } },
    ])
}
const history = await result.value.messages.fetchHistory("20", { limit: 2, before: "11" })
assert.ok(history.isOk())
assert.equal(history.value[0].content, "History")
assert.ok(Object.isFrozen(history.value) && Object.isFrozen(history.value[0].author))
const invalidHistory = await result.value.messages.fetchHistory("20", { limit: 101 })
assert.ok(invalidHistory.error instanceof MessageOperationError)
assert.equal(invalidHistory.error.operation, "fetchHistory")
assert.equal((await result.value.shutdown()).isOk(), true)
assert.equal(result.value.state, "Closed")
assert.equal((await result.value.waitForClose()).isOk(), true)
assert.equal((await result.value.connect()).error._tag, "ClientClosedError")

for (const path of ["dist/internal/client.js", "src/internal/configuration.ts"]) {
    await assert.rejects(import(`@neontechspace/fluxerly/${path}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
}
console.log("Default JavaScript packed consumer passed")
