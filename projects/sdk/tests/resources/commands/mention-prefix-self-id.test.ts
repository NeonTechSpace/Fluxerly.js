import { Effect, Exit, Scope } from "effect"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { commands } from "../../../src/index.js"
import { commands as nativeCommands } from "../../../src/effect.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { act, attach, barrier, commandFixture, connect, createRouter, type RecordedCall } from "./command-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const botUser = {
    id: "99",
    username: "bot",
    discriminator: "0001",
    global_name: null,
    avatar: null,
    avatar_color: null,
    flags: 0,
    bot: true,
    system: false,
}

/** Move the monotonic time the SDK Clock reads forward, without touching timers */
function monotonicOffset() {
    const read = process.hrtime.bigint.bind(process.hrtime)
    let offsetNs = 0n
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => read() + offsetNs)
    return (ms: number) => {
        offsetNs += BigInt(ms) * 1_000_000n
    }
}

/** A ready test client of one API style, whose READY carries the fixture bot user, with a mention router attached */
async function readyTestClient(mode: Mode, executed: string[]) {
    const options = { prefix: "!", mentionPrefix: true }
    if (mode === "default") {
        const test = createDefaultTestClient()
        onTestFinished(() => test.shutdown())
        await test.ready()
        commands
            .create(options)
            .register({ name: "ping", execute: ({ rawArgs }) => void executed.push(rawArgs) })
            .attach(test.client)
        return { test, emit: async (type: string, payload: unknown) => test.emit(type, payload) }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
    await Effect.runPromise(test.ready())
    await Effect.runPromise(
        nativeCommands
            .create(options)
            .register({ name: "ping", execute: ({ rawArgs }) => Effect.sync(() => void executed.push(rawArgs)) })
            .attach(test.client)
            .pipe(Scope.provide(scope)),
    )
    return { test, emit: (type: string, payload: unknown) => Effect.runPromise(test.emit(type, payload)) }
}

describe.each(modes)("%s mentionPrefix bot ID", (mode) => {
    test("a mention after READY uses the READY user without reading users.fetchSelf", async () => {
        const executed: string[] = []
        const { test, emit } = await readyTestClient(mode, executed)
        const botId = test.fixtures.botUser().id
        await emit("MESSAGE_CREATE", test.fixtures.message({ content: `<@${botId}> ping one` }))
        await emit("MESSAGE_CREATE", test.fixtures.message({ content: `<@!${botId}> ping two` }))
        await vi.waitFor(() => expect(executed).toEqual(["one", "two"]))
        expect(test.requests()).toEqual([])
    })

    test("concurrent first mentions share one users.fetchSelf read", async () => {
        let selfReads = 0
        let answer!: () => void
        const answered = new Promise<void>((resolve) => (answer = resolve))
        const remote = await commandFixture((call: RecordedCall) => {
            if (call.path !== "/v1/users/@me") return undefined
            selfReads += 1
            // Hold the read open until every mention has arrived
            return answered.then(() => Response.json(botUser))
        })
        const connected = await connect(mode)
        const executed: string[] = []
        const router = createRouter(mode, { prefix: "!", mentionPrefix: true }).register({
            name: "ping",
            execute: ({ rawArgs }: { rawArgs: string }) => act(mode, () => void executed.push(rawArgs)),
        })
        await attach(connected, router, { concurrency: 3 })

        remote.deliver("<@99> ping one")
        remote.deliver("<@99> ping two")
        remote.deliver("<@!99> ping three")
        try {
            await vi.waitFor(() => expect(selfReads).toBeGreaterThan(0))
            // The mentions were delivered before the barrier, so each reached the bot ID lookup while the read is open.
            // All three keep running until the read is answered
            await barrier(remote, connected, 3)
            expect(selfReads).toBe(1)
        } finally {
            answer()
        }
        await vi.waitFor(() => expect(executed).toHaveLength(3))
        expect(executed.toSorted()).toEqual(["one", "three", "two"])
        remote.deliver("<@99> ping four")
        await vi.waitFor(() => expect(executed).toHaveLength(4))
        expect(selfReads).toBe(1)
    })

    test("a failed read backs off instead of reading again on every later mention", async () => {
        const advance = monotonicOffset()
        let selfReads = 0
        const remote = await commandFixture((call: RecordedCall) => {
            if (call.path !== "/v1/users/@me") return undefined
            selfReads += 1
            return selfReads === 1
                ? Response.json({ message: "Missing access", code: 50001 }, { status: 403 })
                : Response.json(botUser)
        })
        const connected = await connect(mode)
        const executed: string[] = []
        const router = createRouter(mode, { prefix: "!", mentionPrefix: true }).register({
            name: "ping",
            execute: ({ prefix, rawArgs }: { prefix: string; rawArgs: string }) =>
                act(mode, () => void executed.push(`${prefix}|${rawArgs}`)),
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        remote.deliver("<@99> ping first")
        remote.deliver("<@99> ping second")
        remote.deliver("!ping third")
        await vi.waitFor(() => expect(executed).toEqual(["!|third"]))
        // Mentions during the backoff are ordinary text and start no read
        expect(selfReads).toBe(1)
        expect(connected.logs.withCode("commands.mentionPrefixUnavailable")).toEqual([
            expect.objectContaining({ level: "warn", category: "commands" }),
        ])

        advance(5_000)
        remote.deliver("<@99> ping fourth")
        remote.deliver("<@!99> ping fifth")
        await vi.waitFor(() => expect(executed).toEqual(["!|third", "<@99>|fourth", "<@!99>|fifth"]))
        expect(selfReads).toBe(2)
        expect(reports).toEqual([])
    })
})
