import { Effect } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { PrefixCommandUnmatched } from "../../../src/index.js"
import { modes } from "../../support/both-apis.js"
import { act, attach, commandFixture, connect, createRouter, type RecordedCall } from "./command-fixture.js"

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
