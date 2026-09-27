import assert from "node:assert/strict"
import { Recorder, readJson, sendJson, startLoopback, wireMessage } from "./loopback.js"
import { installPing } from "./out/optional-tools-example.js"
import { commandGroupExample } from "./out/commandGroupExample.js"

// The packed build connects over its real ws and fetch transports to an owned loopback instance and runs compiled
// documentation examples against it
const kind = process.argv[2]
assert.ok(kind === "default" || kind === "effect", "Select default or effect workflow")

async function fixture() {
    let completeCancellationRequest
    const cancellationRequest = new Promise((resolve) => {
        completeCancellationRequest = resolve
    })
    const requests = []
    const gatewayPaths = []
    const replies = new Recorder()
    const remote = await startLoopback({
        async route(request, response, target) {
            const path = `${request.method} ${target.pathname}`
            requests.push({ path, authorization: request.headers.authorization })
            if (path === "POST /api/v1/channels/20/messages") {
                const body = await readJson(request)
                const stored = {
                    ...wireMessage(String(200 + replies.items.length), body.content, {
                        id: "90",
                        username: "fixture-bot",
                        bot: true,
                    }),
                    message_reference: body.message_reference,
                }
                replies.record({ body, stored })
                return sendJson(response, stored)
            }
            const reply = replies.items.find(({ stored }) => path === `GET /api/v1/channels/20/messages/${stored.id}`)
            if (reply) return sendJson(response, reply.stored)
            if (path === "GET /api/v1/channels/20/messages") {
                const page = target.searchParams.get("before") === "20" ? ["19", "second page"] : ["20", "first page"]
                return sendJson(response, [wireMessage(...page)])
            }
            if (path === "GET /api/v1/channels/20/messages/40") {
                completeCancellationRequest()
                request.once("close", () => response.destroy())
                return
            }
            // A destroyed socket after dispatch leaves the delete outcome unknown
            if (path === "DELETE /api/v1/channels/20/messages/50") return response.destroy()
            return false
        },
        command(command, connection) {
            if (command.op !== 2) return
            gatewayPaths.push(connection.url)
            remote.dispatch(connection, "READY", { session_id: "fixture" })
        },
    })
    return {
        ...remote,
        requests,
        gatewayPaths,
        replies,
        cancellationRequest,
        deliver: (content, id) => remote.broadcast("MESSAGE_CREATE", wireMessage(id, content)),
    }
}

async function verifyReplies(remote, run, client) {
    const incoming = [remote.deliver("!ping", "101"), remote.deliver("!unknown", "102")]
    await remote.replies.reach(2)
    // Attached routers run commands concurrently, so match each reply to the message it answers
    for (const [index, content] of ["Pong", "Unknown command: unknown"].entries()) {
        const { body, stored } = remote.replies.items.find(
            (reply) => reply.body.message_reference?.message_id === incoming[index].id,
        )
        assert.equal(body.content, content)
        const fetched = await run(client.messages.fetch({ id: stored.id, channelId: "20" }))
        assert.equal(fetched.content, content)
        assert.equal(fetched.author.isBot, true)
        assert.deepEqual(fetched.messageReference, { id: incoming[index].id, channelId: "20", type: 0 })
    }
}

async function groupedReply(remote) {
    const before = remote.replies.items.length
    const incoming = remote.deliver("!t ping", "103")
    await remote.replies.reach(before + 1)
    const reply = remote.replies.items[before]
    assert.equal(reply.body.content, "Pong")
    assert.equal(reply.body.message_reference.message_id, incoming.id)
}

async function defaultWorkflow(remote) {
    const { createClient } = await import("@neontechspace/fluxerly")
    const client = createClient({ token: "fixture-only", instance: { url: remote.origin, allowInsecure: true } })
    const run = async (operation) => (await operation)._unsafeUnwrap()
    try {
        const ping = installPing(client)
        await run(client.connect())
        await verifyReplies(remote, run, client)
        ping.close()
        await run(ping.waitForClose())
        const group = commandGroupExample(client)
        await groupedReply(remote)
        group.close()
        await run(group.waitForClose())

        const pages = []
        for await (const result of client.messages.iterateHistory("20", { maxItems: 2, pageSize: 1 }))
            pages.push(result._unsafeUnwrap().id)
        assert.deepEqual(pages, ["20", "19"])

        const controller = new AbortController()
        const cancelling = client.messages.fetch({ channelId: "20", id: "40" }, { signal: controller.signal })
        await remote.cancellationRequest
        controller.abort()
        assert.equal((await cancelling)._unsafeUnwrapErr()._tag, "CancelledError")

        const unknown = (await client.messages.delete({ channelId: "20", id: "50" }))._unsafeUnwrapErr()
        assert.equal(unknown._tag, "MessageOperationError")
        assert.equal(unknown.outcome, "unknown")
    } finally {
        await run(client.shutdown())
    }
    assert.equal(client.state, "Closed")
}

async function effectWorkflow(remote) {
    const { Cause, Effect, Exit, Fiber, Scope, Stream } = await import("effect")
    const { createClient } = await import("@neontechspace/fluxerly/effect")
    const run = (operation) => Effect.runPromise(operation)
    const scope = Scope.makeUnsafe()
    try {
        const client = await run(
            createClient({ token: "fixture-only", instance: { url: remote.origin, allowInsecure: true } }).pipe(
                Scope.provide(scope),
            ),
        )
        const ping = await run(installPing(client).pipe(Scope.provide(scope)))
        await run(client.connect())
        await verifyReplies(remote, run, client)
        await run(ping.close())
        await run(ping.waitForClose())
        const group = await run(commandGroupExample(client).pipe(Scope.provide(scope)))
        await groupedReply(remote)
        await run(group.close())
        await run(group.waitForClose())

        const pages = await run(
            client.messages.iterateHistory("20", { maxItems: 2, pageSize: 1 }).pipe(
                Stream.map((item) => item.id),
                Stream.runCollect,
            ),
        )
        assert.deepEqual([...pages], ["20", "19"])

        const cancelling = Effect.runFork(client.messages.fetch({ channelId: "20", id: "40" }))
        await remote.cancellationRequest
        await run(Fiber.interrupt(cancelling))
        const cancelled = await Effect.runPromiseExit(Fiber.join(cancelling))
        assert.ok(Exit.isFailure(cancelled) && Cause.hasInterruptsOnly(cancelled.cause))

        const unknown = await run(Effect.flip(client.messages.delete({ channelId: "20", id: "50" })))
        assert.equal(unknown._tag, "MessageOperationError")
        assert.equal(unknown.outcome, "unknown")
        await run(client.shutdown())
        assert.equal(client.state, "Closed")
    } finally {
        await run(Scope.close(scope, Exit.void))
    }
}

const remote = await fixture()
try {
    if (kind === "default") await defaultWorkflow(remote)
    else await effectWorkflow(remote)
    await remote.closed()
    assert.deepEqual(remote.gatewayPaths, ["/gateway?v=1&encoding=json"])
    assert.deepEqual(
        [...new Set(remote.requests.map(({ authorization }) => authorization))],
        ["Bot fixture-only"],
        "Every REST request carries the bot credential",
    )
    assert.equal(remote.requests.filter(({ path }) => path.endsWith("/messages/50")).length, 1)
} finally {
    await remote.close()
}
console.log(`${kind} packed workflow passed`)
