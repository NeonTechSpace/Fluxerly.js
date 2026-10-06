import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import { expect, onTestFinished, test, vi } from "vitest"
import type { PaginateResult } from "../../../src/index.js"
import {
    createTestBot as createDefaultTestBot,
    type Fixtures,
    type TestRequest,
    type TestRequestMatcher,
    type TestResponder,
    type TestResponse,
} from "../../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { sdkClock, type SdkClock } from "../../support/client-clock.js"

/** How one pages call ended: Its result, its typed failure, or native interruption */
type Outcome = { readonly value: PaginateResult } | { readonly error: { readonly _tag: string } } | "interrupted"

/** What the bot's commands read when they run, set by each test before emitting the command */
interface State {
    pages: readonly string[]
    options: Record<string, unknown> | undefined
    help: Record<string, unknown> | undefined
    ended: (outcome: Outcome) => void
}

interface Driver {
    readonly fixtures: Fixtures
    respond(matcher: TestRequestMatcher, response: TestResponse | TestResponder): { next(): Promise<TestRequest> }
    emit(type: string, payload: unknown): Promise<void>
    requests(): readonly TestRequest[]
    /** Start client.messages.paginate, with stop aborting its signal or interrupting its fiber */
    paginate(
        channelId: string,
        pages: readonly string[],
        options: Record<string, unknown>,
    ): { readonly outcome: Promise<Outcome>; stop(): void }
}

const native = <A>(exit: Exit.Exit<A, unknown>): Outcome => {
    if (Exit.isSuccess(exit)) return { value: exit.value as PaginateResult }
    if (Cause.hasInterruptsOnly(exit.cause)) return "interrupted"
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (failure?._tag !== "Fail") throw Cause.squash(exit.cause)
    return { error: failure.error as { _tag: string } }
}

async function unwrap<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
}

/** Two described commands, so help with a short page length needs several pages */
const described = <A>(execute: () => A) => ({
    alpha: { description: "First command with a long description", execute },
    beta: { description: "Second command with a long description", execute },
})

/** Open a test bot whose pages command runs ctx.paginate and whose help command runs ctx.sendHelp */
async function open(mode: Mode, state: State): Promise<Driver> {
    if (mode === "default") {
        const bot = createDefaultTestBot({
            commands: {
                prefix: "!",
                commands: {
                    ...described(() => undefined),
                    pages: {
                        execute: async ({ paginate }) => {
                            const result = await paginate(state.pages, state.options as never)
                            state.ended(result.isOk() ? { value: result.value } : { error: result.error })
                        },
                    },
                    help: {
                        execute: async ({ sendHelp }) => {
                            const result = await sendHelp(state.help as never)
                            state.ended(result.isOk() ? { value: result.value } : { error: result.error })
                        },
                    },
                },
            },
        })
        onTestFinished(() => bot.shutdown())
        await bot.ready()
        return {
            fixtures: bot.fixtures,
            respond: (matcher, response) => bot.rest.respond(matcher, response),
            emit: async (type, payload) => bot.emit(type, payload),
            requests: () => bot.requests(),
            paginate: (channelId, pages, options) => {
                const controller = new AbortController()
                const outcome = Promise.resolve(
                    bot.client.messages.paginate(channelId, pages, { ...options, signal: controller.signal } as never),
                ).then((result): Outcome => (result.isOk() ? { value: result.value } : { error: result.error }))
                return { outcome, stop: () => controller.abort() }
            },
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => unwrap(Scope.close(scope, Exit.void)))
    const bot = await unwrap(
        createNativeTestBot({
            commands: {
                prefix: "!",
                commands: {
                    ...described(() => Effect.void),
                    pages: {
                        execute: ({ paginate }) =>
                            Effect.exit(paginate(state.pages, state.options as never)).pipe(
                                Effect.map((exit) => state.ended(native(exit))),
                            ),
                    },
                    help: {
                        execute: ({ sendHelp }) =>
                            Effect.exit(sendHelp(state.help as never)).pipe(
                                Effect.map((exit) => state.ended(native(exit))),
                            ),
                    },
                },
            },
        }).pipe(Scope.provide(scope)),
    )
    await unwrap(bot.ready())
    return {
        fixtures: bot.fixtures,
        respond: (matcher, response) => {
            const route = bot.rest.respond(matcher, response)
            return { next: () => unwrap(route.next()) }
        },
        emit: (type, payload) => unwrap(bot.emit(type, payload)),
        requests: () => bot.requests(),
        paginate: (channelId, pages, options) => {
            const fiber = Effect.runFork(bot.client.messages.paginate(channelId, pages, options as never))
            return {
                outcome: Effect.runPromise(Fiber.await(fiber)).then(native),
                stop: () => void Effect.runFork(Fiber.interrupt(fiber)),
            }
        },
    }
}

/** A deferred outcome for the next command run, settled by the command itself */
function nextOutcome(state: State) {
    let settled: Outcome | undefined
    const promise = new Promise<Outcome>((resolve) => {
        state.ended = (outcome) => {
            settled = outcome
            resolve(outcome)
        }
    })
    return { promise, settled: () => settled }
}

/**
 * Answer the page message's send, edit and reaction requests. The sent message is authored by the bot, so its own
 * arrows are never clicks, and every edit returns the requested content
 */
function pageServer(driver: Driver) {
    const { fixtures } = driver
    const id = fixtures.nextId()
    const message = (content: string) => fixtures.message({ id, content, author: fixtures.botUser() })
    const sends = driver.respond("POST /channels/:id/messages", (request) => ({
        body: message(String((request.body as { content?: unknown }).content ?? "")),
    }))
    const edits = driver.respond(`PATCH /channels/:id/messages/${id}`, (request) => ({
        body: message(String((request.body as { content?: unknown }).content)),
    }))
    const reactions = driver.respond(new RegExp(`^/channels/\\d+/messages/${id}/reactions/`), { status: 204 })
    const reaction = (
        type: "MESSAGE_REACTION_ADD" | "MESSAGE_REACTION_REMOVE",
        name: string,
        userId = fixtures.ids.user,
    ) => driver.emit(type, { channel_id: fixtures.ids.channel, message_id: id, user_id: userId, emoji: { name } })
    return { id, sends, edits, reactions, reaction }
}

/** Reaction requests on the page message as "METHOD emoji target", in order */
function reactionRequests(driver: Driver, id: string) {
    return driver
        .requests()
        .filter((request) => request.path.includes(`/messages/${id}/reactions/`))
        .map((request) => {
            const [emoji, target] = request.path.split("/reactions/")[1]!.split("/")
            return `${request.method} ${decodeURIComponent(emoji!)} ${target}`
        })
}

/** Wait until no REST request deadline is pending, so advancing SDK time cannot expire an answered request */
const requestsSettled = (clock: SdkClock) =>
    vi.waitFor(() => expect([...clock.pending].some((item) => item.delay === 30_000)).toBe(false), { interval: 5 })

/** Wait for the next edit's content and for its response to be processed */
async function edited(clock: SdkClock, edits: { next(): Promise<TestRequest> }) {
    const request = await edits.next()
    await requestsSettled(clock)
    return (request.body as { content: string }).content
}

function newState(): State {
    return { pages: [], options: undefined, help: undefined, ended: () => undefined }
}

test.each(modes)(
    "%s ctx.paginate flips forward and back for the author only, counting removals, and cleans up when idle",
    async (mode) => {
        const clock = sdkClock()
        const state = newState()
        const driver = await open(mode, state)
        const server = pageServer(driver)
        state.pages = ["Page 1", "Page 2", "Page 3"]
        const outcome = nextOutcome(state)
        await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "!pages" }))
        expect((await server.sends.next()).body).toMatchObject({ content: "Page 1" })
        await server.reactions.next()
        await server.reactions.next()
        await requestsSettled(clock)
        expect(reactionRequests(driver, server.id)).toEqual(["PUT ◀️ @me", "PUT ▶️ @me"])

        // Another user's click and the bot's own reaction come first, so counting either would show Page 3 first
        await server.reaction("MESSAGE_REACTION_ADD", "▶️", driver.fixtures.nextId())
        await server.reaction("MESSAGE_REACTION_ADD", "▶️", driver.fixtures.ids.bot)
        await server.reaction("MESSAGE_REACTION_ADD", "▶️")
        expect(await edited(clock, server.edits)).toBe("Page 2")
        // Removing the arrow is another click, and the text-presentation arrow matches too
        await server.reaction("MESSAGE_REACTION_REMOVE", "▶")
        expect(await edited(clock, server.edits)).toBe("Page 3")
        await server.reaction("MESSAGE_REACTION_ADD", "◀️")
        expect(await edited(clock, server.edits)).toBe("Page 2")
        await server.reaction("MESSAGE_REACTION_ADD", "👍")
        await server.reaction("MESSAGE_REACTION_REMOVE", "◀️")
        expect(await edited(clock, server.edits)).toBe("Page 1")
        // Previous on the first page wraps to the last
        await server.reaction("MESSAGE_REACTION_ADD", "◀️")
        expect(await edited(clock, server.edits)).toBe("Page 3")

        // The default idle time is 60,000 ms from the last click
        await clock.advance(59_999)
        expect(outcome.settled()).toBeUndefined()
        await clock.advance(1)
        const ended = await outcome.promise
        expect(ended).toEqual({
            value: { reason: "idle", page: 2, message: expect.objectContaining({ id: server.id, content: "Page 3" }) },
        })
        // Only the bot's own arrows are removed, and the last page stays
        expect(reactionRequests(driver, server.id)).toEqual([
            "PUT ◀️ @me",
            "PUT ▶️ @me",
            "DELETE ◀️ @me",
            "DELETE ▶️ @me",
        ])
    },
)

test.each(modes)(
    "%s removeClicks counts only additions, removes each click and stops at the total timeout",
    async (mode) => {
        const clock = sdkClock()
        const state = newState()
        const driver = await open(mode, state)
        const server = pageServer(driver)
        state.pages = ["Page 1", "Page 2", "Page 3"]
        state.options = { removeClicks: true, idleMs: 100, timeoutMs: 250 }
        const outcome = nextOutcome(state)
        await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "!pages" }))
        await server.sends.next()
        await server.reactions.next()
        await server.reactions.next()
        await requestsSettled(clock)

        await clock.advance(99)
        await server.reaction("MESSAGE_REACTION_ADD", "▶️")
        expect(await edited(clock, server.edits)).toBe("Page 2")
        await server.reactions.next()
        await requestsSettled(clock)
        // The removal the bot caused is not a click, so the next change goes back to Page 1 rather than on to Page 3
        await server.reaction("MESSAGE_REACTION_REMOVE", "▶️")
        await clock.advance(99)
        expect(outcome.settled()).toBeUndefined()
        await server.reaction("MESSAGE_REACTION_ADD", "◀️")
        expect(await edited(clock, server.edits)).toBe("Page 1")
        await server.reactions.next()
        await requestsSettled(clock)

        // Clicks renewed the idle time past 250 ms, so the total timeout ends listening
        await clock.advance(52)
        expect(await outcome.promise).toEqual({ value: expect.objectContaining({ reason: "timeout", page: 0 }) })
        expect(reactionRequests(driver, server.id)).toEqual([
            "PUT ◀️ @me",
            "PUT ▶️ @me",
            `DELETE ▶️ ${driver.fixtures.ids.user}`,
            `DELETE ◀️ ${driver.fixtures.ids.user}`,
            "DELETE ◀️ @me",
            "DELETE ▶️ @me",
        ])
    },
)

test.each(modes)(
    "%s messages.paginate requires users, accepts a check for anyone and cleans up when stopped",
    async (mode) => {
        const clock = sdkClock()
        const driver = await open(mode, newState())
        const server = pageServer(driver)
        const channelId = driver.fixtures.ids.channel

        const missing = driver.paginate(channelId, ["Page 1", "Page 2"], {})
        expect(await missing.outcome).toEqual({
            error: expect.objectContaining({ _tag: "ConfigurationError", field: "users" }),
        })
        expect(driver.requests()).toEqual([])

        const single = await driver.paginate(channelId, ["Only page"], { users: () => true }).outcome
        expect(single).toEqual({ value: expect.objectContaining({ reason: "singlePage", page: 0 }) })
        expect(reactionRequests(driver, server.id)).toEqual([])

        const pages = driver.paginate(channelId, ["Page 1", "Page 2"], { users: () => true })
        await server.reactions.next()
        await server.reactions.next()
        await requestsSettled(clock)
        await server.reaction("MESSAGE_REACTION_ADD", "▶️", driver.fixtures.nextId())
        expect(await edited(clock, server.edits)).toBe("Page 2")
        pages.stop()
        // Cancellation follows each API's convention, after the bot's arrows are removed
        expect(await pages.outcome).toEqual(
            mode === "default" ? { error: expect.objectContaining({ _tag: "CancelledError" }) } : "interrupted",
        )
        expect(reactionRequests(driver, server.id).slice(-2)).toEqual(["DELETE ◀️ @me", "DELETE ▶️ @me"])
    },
)

test.each(modes)("%s a failed page change ends with its error and still removes the arrows", async (mode) => {
    const clock = sdkClock()
    const state = newState()
    const driver = await open(mode, state)
    const server = pageServer(driver)
    driver.respond(`PATCH /channels/:id/messages/${server.id}`, {
        status: 403,
        body: { code: "MISSING_PERMISSIONS", message: "Missing permissions" },
    })
    state.pages = ["Page 1", "Page 2"]
    const outcome = nextOutcome(state)
    await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "!pages" }))
    await server.reactions.next()
    await server.reactions.next()
    await requestsSettled(clock)
    await server.reaction("MESSAGE_REACTION_ADD", "▶️")
    expect(await outcome.promise).toEqual({
        error: expect.objectContaining({ _tag: "MessageOperationError", operation: "edit" }),
    })
    expect(reactionRequests(driver, server.id).slice(-2)).toEqual(["DELETE ◀️ @me", "DELETE ▶️ @me"])
})

test.each(modes)("%s sendHelp pages long help with reactions and sends short help as one message", async (mode) => {
    const clock = sdkClock()
    const state = newState()
    const driver = await open(mode, state)
    const server = pageServer(driver)

    state.help = { maxLength: 2_000 }
    const short = nextOutcome(state)
    await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "!help" }))
    expect(await short.promise).toEqual({ value: expect.objectContaining({ reason: "singlePage" }) })
    expect(reactionRequests(driver, server.id)).toEqual([])

    state.help = { maxLength: 60 }
    const long = nextOutcome(state)
    await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "!help" }))
    await server.sends.next()
    const first = (await server.sends.next()).body as { content: string }
    expect(first.content).toContain("!alpha")
    await server.reactions.next()
    await server.reactions.next()
    await requestsSettled(clock)
    await server.reaction("MESSAGE_REACTION_ADD", "▶️")
    expect(await edited(clock, server.edits)).toContain("Second command")
    await clock.advance(60_000)
    expect(await long.promise).toEqual({ value: expect.objectContaining({ reason: "idle", page: 1 }) })
    expect(reactionRequests(driver, server.id).slice(-2)).toEqual(["DELETE ◀️ @me", "DELETE ▶️ @me"])

    state.help = { maxLength: 0 }
    const invalid = nextOutcome(state)
    await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "!help" }))
    expect(await invalid.promise).toEqual({ error: expect.objectContaining({ _tag: "ConfigurationError" }) })
})
