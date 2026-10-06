import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { User } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient, type WireUser } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

/** One test client driven through either API style, reading users.getSelf as a plain value */
async function open(mode: Mode, user?: WireUser) {
    const settings = user === undefined ? {} : { user }
    if (mode === "default") {
        const test = createDefaultTestClient(settings)
        onTestFinished(() => test.shutdown())
        return {
            fixtures: test.fixtures,
            getSelf: (): User | undefined => test.client.users.getSelf(),
            ready: () => test.ready(),
            requests: () => test.requests(),
            shutdown: () => test.shutdown(),
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient(settings).pipe(Scope.provide(scope)))
    return {
        fixtures: test.fixtures,
        // The native lookup is an Effect that never fails
        getSelf: () => Effect.runSync(test.client.users.getSelf()),
        ready: () => settle(test.ready()),
        requests: () => test.requests(),
        shutdown: () => settle(test.shutdown()),
    }
}

test.each(modes)("%s users.getSelf reads the bot's account from READY without a request", async (mode) => {
    const client = await open(mode)
    expect(client.getSelf()).toBeUndefined()
    await client.ready()
    const bot = client.fixtures.botUser()
    // The same public User shape as users.fetchSelf, so handlers can compare IDs or show the bot's name
    expect(client.getSelf()).toMatchObject({ id: bot.id, username: bot.username, isBot: true })
    expect(client.requests()).toEqual([])
    // The account stays available after the client stops
    await client.shutdown()
    expect(client.getSelf()?.id).toBe(bot.id)
})

test.each(modes)("%s users.getSelf stays undefined when READY carries no complete account", async (mode) => {
    const client = await open(mode, { id: "4242", username: "partial-bot" } as WireUser)
    await client.ready()
    expect(client.getSelf()).toBeUndefined()
    expect(client.requests()).toEqual([])
})
