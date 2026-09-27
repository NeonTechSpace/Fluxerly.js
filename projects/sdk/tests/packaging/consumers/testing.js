import assert from "node:assert/strict"

// A packed application test: the bot replies to !ping, and the test drives it through the in-memory Fluxer only
const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")

function assertCommonControls(test, handled, replies, fixtureToken) {
    assert.equal(handled.length, 1, "The rest.respond handler must run exactly once")
    assert.equal(handled[0].body.content, "Pong!")
    assert.equal(handled[0].path, `/channels/${test.fixtures.ids.channel}/messages`)
    assert.equal(replies.requests().length, 1)
    assert.equal(test.requests().length, 1)
    assert.ok(!("authorization" in handled[0].headers), "Recorded requests must not carry the Authorization header")
    assert.ok(!JSON.stringify(test.requests()).includes(fixtureToken))
    assert.ok(!JSON.stringify(test.commands()).includes(fixtureToken))
    assert.ok(test.logs().some((record) => record.code === "lifecycle.ready"))
    assert.equal(test.counters().handlerFailures, 0)
    assert.deepEqual(test.failures(), [])
}

if (mode === "default") {
    const { createTestClient, fixtures, fixtureToken, createFixtures } = await import("@neontechspace/fluxerly/testing")
    assert.equal(typeof fixtures.message, "function")
    assert.deepEqual(createFixtures().ids, createFixtures().ids)
    const test = createTestClient()
    const handled = []
    try {
        const replies = test.rest.respond("POST /channels/:channelId/messages", (request) => {
            handled.push(request)
            return { body: test.fixtures.message({ content: request.body.content }) }
        })
        test.client.on("messageCreate", (message) =>
            message.content === "!ping" ? test.client.messages.reply(message, { content: "Pong!" }) : undefined,
        )
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ping" }))
        assert.equal((await replies.next()).body.content, "Pong!")
        await test.idle()
        assertCommonControls(test, handled, replies, fixtureToken)
        assert.throws(() => test.emit("READY", {}), { _tag: "ConfigurationError" })
    } finally {
        await test.shutdown()
    }
    assert.equal(test.client.state, "Closed")
    assert.throws(() => test.emit("MESSAGE_CREATE", test.fixtures.message()), { _tag: "ClientClosedError" })
} else {
    const { Effect } = await import("effect")
    const { createTestClient, fixtures, fixtureToken } = await import("@neontechspace/fluxerly/effect/testing")
    const shared = await import("@neontechspace/fluxerly/testing")
    assert.equal(fixtures, shared.fixtures, "Both testing entry points share one fixture module")
    const handled = []
    const test = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const test = yield* createTestClient()
                const replies = test.rest.respond("POST /channels/:channelId/messages", (request) => {
                    handled.push(request)
                    return { body: test.fixtures.message({ content: request.body.content }) }
                })
                yield* test.client.on("messageCreate", (message) =>
                    message.content === "!ping"
                        ? test.client.messages.reply(message, { content: "Pong!" })
                        : Effect.void,
                )
                yield* test.ready()
                yield* test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ping" }))
                assert.equal((yield* replies.next()).body.content, "Pong!")
                yield* test.idle()
                assertCommonControls(test, handled, replies, fixtureToken)
                return test
            }),
        ),
    )
    assert.equal(test.client.state, "Closed", "Closing the scope must shut the test client down")
    const emitted = await Effect.runPromiseExit(test.emit("MESSAGE_CREATE", test.fixtures.message()))
    assert.equal(emitted._tag, "Failure")
}
console.log(`Packed ${mode} testing entry point drove a bot through emit and rest.respond`)
