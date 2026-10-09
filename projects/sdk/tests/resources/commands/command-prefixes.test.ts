import { Effect } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { commands, ConfigurationError, type PrefixCommandUnmatched } from "../../../src/index.js"
import { commands as nativeCommands } from "../../../src/effect.js"
import { modes } from "../../support/both-apis.js"
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

describe.each(modes)("%s prefixes", (mode) => {
    test("an asynchronous prefix resolver selects prefixes per message, and its failure is reported without a command", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const failure = new Error("prefix settings unavailable")
        const executed: string[] = []
        const choose = (message: { guildId?: string }) => {
            if (message.guildId === "41") throw failure
            return message.guildId === "40" ? "?" : "!"
        }
        const prefix =
            mode === "default"
                ? async (message: { guildId?: string }) => {
                      await Promise.resolve()
                      return choose(message)
                  }
                : (message: { guildId?: string }) => Effect.suspend(() => Effect.sync(() => choose(message)))
        const router = createRouter(mode, { prefix }).register({
            name: "ping",
            execute: ({ prefix, message }: { prefix: string; message: { id: string } }) =>
                act(mode, () => void executed.push(`${message.id}:${prefix}`)),
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        remote.deliver("!ping", { guildId: "40" })
        remote.deliver("?ping", { guildId: "41" })
        remote.deliver("?ping", { guildId: "40" })
        remote.deliver("!ping")
        await vi.waitFor(() => expect(executed).toHaveLength(2))
        // One command at a time, so the earlier messages were fully handled before the later ones executed
        expect(executed).toEqual(["103:?", "104:!"])
        expect(reports).toHaveLength(1)
        expect(reports[0]).toMatchObject({ kind: "handler", message: expect.objectContaining({ id: "102" }) })
        expect(reports[0]!.command).toBeUndefined()
        if (mode === "default") expect(reports[0]!.error).toBe(failure)
    })

    test("mentionPrefix accepts both bot mention forms, reading the bot ID once when READY did not supply it", async () => {
        let selfReads = 0
        const remote = await commandFixture((call: RecordedCall) => {
            if (call.path !== "/v1/users/@me") return undefined
            selfReads += 1
            return Response.json(botUser)
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
        remote.deliver("!ping second")
        remote.deliver("<@99> ping third")
        remote.deliver("<@12> ping other")
        remote.deliver("<@!99> ping fourth")
        await vi.waitFor(() => expect(executed).toHaveLength(4))
        expect(executed).toEqual(["<@99>|first", "!|second", "<@99>|third", "<@!99>|fourth"])
        expect(selfReads).toBe(1)
        expect(connected.logs.withCode("commands.mentionPrefixUnavailable")).toEqual([])
        expect(reports).toEqual([])
    })

    test("without mentionPrefix a bot mention is ordinary text and the bot ID is never read", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const executed: string[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "ping",
            execute: ({ message }: { message: { id: string } }) => act(mode, () => void executed.push(message.id)),
        })
        await attach(connected, router, { concurrency: 1 })
        remote.deliver("<@99> ping")
        remote.deliver("!ping")
        await vi.waitFor(() => expect(executed).toEqual(["102"]))
        expect(remote.calls).toEqual([])
    })

    test("a notice Fluxer posts with text of its own, such as a new thread's name, never runs a command as its author", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const executed: string[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "ping",
            execute: ({ message }: { message: { id: string } }) => act(mode, () => void executed.push(message.id)),
        })
        const reports = await attach(connected, router)

        // Thread creation posts type 18 with the thread's name as content, authored by the person who created the thread
        remote.deliver("!ping", { type: 18 })
        // The thread starter notice, and a type Fluxer might add later, must also stay out
        remote.deliver("!ping", { type: 21 })
        remote.deliver("!ping", { type: 200 })
        remote.deliver("!ping", { type: 0 })
        remote.deliver("!ping", { type: 19 })
        await barrier(remote, connected)

        // Handlers run concurrently, and the barrier ends only after every one of them has finished
        expect(executed.toSorted()).toEqual(["104", "105"])
        expect(reports).toEqual([])
    })

    test("a client whose messageFields leave out the type still keeps a thread notice from running a command", async () => {
        const remote = await commandFixture()
        // An empty selection keeps only MessageCore. The fixture's connect accepts no selection type, hence the cast
        const connected = await connect(mode, { messageFields: [] as never })
        const executed: string[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "ping",
            execute: ({ message }: { message: { id: string } }) => act(mode, () => void executed.push(message.id)),
        })
        const reports = await attach(connected, router)

        remote.deliver("!ping", { type: 18 })
        remote.deliver("!ping")
        // A payload without a type, as hand-written tests send, counts as typed instead of being dropped silently
        remote.dispatch("MESSAGE_CREATE", {
            id: "150",
            channel_id: "20",
            content: "!ping",
            author: { id: "30", username: "fixture", bot: false },
        })
        await barrier(remote, connected)

        expect(executed).toEqual(["102", "150"])
        expect(reports).toEqual([])
    })
})

describe.each(modes)("%s unknown command suggestions", (mode) => {
    test("suggest the closest sibling name within the bounded edit distance, and nothing when no name is close", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const unmatched: PrefixCommandUnmatched[] = []
        const execute = () => act(mode, () => undefined)
        const router = createRouter(mode, {
            prefix: "!",
            onUnmatched: (_context: unknown, outcome: PrefixCommandUnmatched) =>
                act(mode, () => void unmatched.push(outcome)),
        })
            .registerMany({ ping: { execute }, status: { aliases: ["st"], execute } })
            .registerGroup({ name: "admin" })
            .register({ name: "inspect", execute }, { group: ["admin"] })
        await attach(connected, router, { concurrency: 1 })

        for (const content of ["!pong", "!pnig", "!statsu", "!sx", "!stat", "!admn", "!admin inspcet", "!admin ping"])
            remote.deliver(content)
        await vi.waitFor(() => expect(unmatched).toHaveLength(8))

        expect(unmatched).toEqual([
            // Names of up to four characters allow one edit, and longer names allow two
            { _tag: "CommandUnknownName", name: "pong", suggestion: "ping" },
            // Swapping two adjacent characters counts as one edit
            { _tag: "CommandUnknownName", name: "pnig", suggestion: "ping" },
            { _tag: "CommandUnknownName", name: "statsu", suggestion: "status" },
            // An alias match suggests the registered name
            { _tag: "CommandUnknownName", name: "sx", suggestion: "status" },
            // Two edits exceed the limit for a four-character name
            { _tag: "CommandUnknownName", name: "stat" },
            { _tag: "CommandUnknownName", name: "admn", suggestion: "admin" },
            { _tag: "CommandUnknownName", name: "inspcet", path: ["admin"], suggestion: "inspect" },
            // Suggestions come only from the same parent group
            { _tag: "CommandUnknownName", name: "ping", path: ["admin"] },
        ])
        const records = connected.logs.withCode("commands.unmatched")
        expect(records.every((record) => record.level === "debug")).toBe(true)
        // Each record carries its outcome's suggestion as a field, and no field when the outcome has none
        expect(records.map((record) => record.fields?.suggestion)).toEqual(
            unmatched.map((outcome) => (outcome._tag === "CommandUnknownName" ? outcome.suggestion : undefined)),
        )
        expect(Object.hasOwn(records[4]!.fields!, "suggestion")).toBe(false)
    })

    test.each([true, false])(
        "the unmatched record mentions onUnmatched only when the router has that callback (callback %s)",
        async (withCallback) => {
            const remote = await commandFixture()
            const connected = await connect(mode)
            const router = createRouter(mode, {
                prefix: "!",
                ...(withCallback ? { onUnmatched: () => act(mode, () => undefined) } : {}),
            }).register({
                name: "ping",
                execute: () => act(mode, () => undefined),
            })
            await attach(connected, router, { concurrency: 1 })

            remote.deliver("!pnig")
            await vi.waitFor(() => expect(connected.logs.withCode("commands.unmatched")).toHaveLength(1))
            const [record] = connected.logs.withCode("commands.unmatched")
            expect(record!.fields?.suggestion).toBe("ping")
            expect(record!.message.includes("onUnmatched")).toBe(withCallback)
        },
    )
})

describe.each(modes)("%s command syntax mistakes", (mode) => {
    test("the quoted parser's syntax reasons reach onUnmatched and the log without the sender's input, and nothing replies on its own", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const unmatched: PrefixCommandUnmatched[] = []
        const greeted: string[] = []
        const router = createRouter(mode, {
            prefix: "!",
            parse: mode === "default" ? commands.parseQuoted : nativeCommands.parseQuoted,
            onUnmatched: (_context: unknown, outcome: PrefixCommandUnmatched) =>
                act(mode, () => void unmatched.push(outcome)),
        }).register({
            name: "greet",
            arguments: { name: { type: "text" } },
            execute: ({ values }: { values: { name: string } }) => act(mode, () => void greeted.push(values.name)),
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        for (const content of ['!greet "Ada Lovelace"', '!greet "Ada Lovelace', "!greet 'Ada", "!greet Ada\\"])
            remote.deliver(content)
        await vi.waitFor(() => expect(unmatched).toHaveLength(3))
        await barrier(remote, connected)

        // The complete quoted name runs, and each of the three mistakes is explained instead of being dropped
        expect(greeted).toEqual(["Ada Lovelace"])
        const reasons = unmatched.map((outcome) => {
            expect(outcome._tag).toBe("CommandParserRejected")
            expect(Object.isFrozen(outcome)).toBe(true)
            return (outcome as { reason?: string }).reason
        })
        for (const reason of reasons) {
            expect(reason).toEqual(expect.any(String))
            expect(reason).not.toContain("Ada")
        }
        expect(new Set(reasons).size).toBe(3)
        const records = connected.logs.withCode("commands.unmatched")
        expect(records).toHaveLength(3)
        records.forEach((record, index) => expect(record.message).toContain(reasons[index]!))
        // The router is silent unless the application replies from its callback
        expect(remote.replies()).toEqual([])
        expect(reports).toEqual([])
    })

    test("a custom parser can decline with a reason, including inside a group, while undefined stays without one", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const unmatched: PrefixCommandUnmatched[] = []
        const execute = () => act(mode, () => undefined)
        const router = createRouter(mode, {
            prefix: "!",
            parse: ({ source }: { source: string }) => {
                const text = source.trim()
                if (text === "") return undefined
                if (text.includes("|")) return { reason: "Separate arguments with spaces" }
                const [name = "", ...args] = text.split(/\s+/)
                return { name, args, rawArgs: args.join(" ") }
            },
            onUnmatched: (_context: unknown, outcome: PrefixCommandUnmatched) =>
                act(mode, () => void unmatched.push(outcome)),
        })
            .register({ name: "ping", execute })
            .registerGroup({ name: "admin" })
            .register({ name: "inspect", execute }, { group: ["admin"] })
        await attach(connected, router, { concurrency: 1 })

        for (const content of ["!", "!ping|1", "!admin inspect|1"]) remote.deliver(content)
        await vi.waitFor(() => expect(unmatched).toHaveLength(3))

        expect(unmatched[0]).toEqual({ _tag: "CommandParserRejected" })
        expect(Object.hasOwn(unmatched[0]!, "reason")).toBe(false)
        expect(unmatched[1]).toEqual({ _tag: "CommandParserRejected", reason: "Separate arguments with spaces" })
        expect(unmatched[2]).toEqual({
            _tag: "CommandParserRejected",
            reason: "Separate arguments with spaces",
            path: ["admin"],
        })
    })

    test.each([
        ["an empty reason", { reason: "" }],
        ["a reason that is not text", { reason: 5 }],
        ["an unsupported key", { reason: "Not valid", extra: true }],
        ["a command name beside the reason", { reason: "Not valid", name: "ping", args: [], rawArgs: "" }],
    ])("a parser result with %s is reported as a failure and never reaches onUnmatched", async (_label, result) => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const unmatched: PrefixCommandUnmatched[] = []
        const router = createRouter(mode, {
            prefix: "!",
            parse: () => result,
            onUnmatched: (_context: unknown, outcome: PrefixCommandUnmatched) =>
                act(mode, () => void unmatched.push(outcome)),
        }).register({ name: "ping", execute: () => act(mode, () => undefined) })
        const reports = await attach(connected, router, { concurrency: 1 })

        remote.deliver("!ping")
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(reports[0]).toMatchObject({ kind: "handler" })
        expect(reports[0]!.command).toBeUndefined()
        if (mode === "default") expect(reports[0]!.error).toBeInstanceOf(ConfigurationError)
        await barrier(remote, connected)
        expect(unmatched).toEqual([])
    })
})
