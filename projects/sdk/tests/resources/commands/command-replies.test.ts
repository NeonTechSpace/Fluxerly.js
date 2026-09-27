import { Effect, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { PrefixCommandRejection } from "../../../src/index.js"
import { commands as nativeCommands } from "../../../src/effect.js"
import { modes } from "../../support/both-apis.js"
import { act, attach, commandFixture, configurationError, connect, createRouter } from "./command-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe.each(modes)("%s rejection replies", (mode) => {
    test('router onReject "reply" explains argument, guard and cooldown rejections with the command usage', async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const executed: string[] = []
        const execute = ({ name }: { name: string }) => act(mode, () => void executed.push(name))
        const router = createRouter(mode, { prefix: "!", onReject: "reply" }).registerMany({
            repeat: {
                arguments: {
                    text: { type: "text" },
                    count: { type: "integer", min: 1, max: 10 },
                    note: { type: "text", optional: true },
                },
                execute,
            },
            blocked: { guard: () => act(mode, () => ({ deny: "Only moderators can use this" })), execute },
            closed: { guard: () => act(mode, () => false), execute },
            slow: { cooldown: { durationMs: 60_000 }, execute },
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        remote.deliver("!repeat")
        remote.deliver("!repeat hello many")
        remote.deliver("!repeat hello 11")
        remote.deliver("!repeat hello 3 note extra")
        remote.deliver("!blocked")
        remote.deliver("!closed")
        remote.deliver("!slow")
        remote.deliver("!slow")
        await vi.waitFor(() => expect(remote.replies()).toHaveLength(7))
        const [missing, invalid, outOfRange, extra, denied, closed, cooldown] = remote.replies() as string[]
        // Argument replies state the reason and the command's usage. Their wording is not a contract, so only the
        // usage, the argument name and the caller's bounds are checked, outside the usage text
        const usage = "!repeat <text> <count> [note]"
        const reasons = [missing, invalid, outOfRange, extra].map((reply) => {
            expect(reply).toContain(usage)
            return reply!.replace(usage, "")
        })
        expect(reasons[0]).toContain("text")
        for (const reason of [reasons[1], reasons[2]]) expect(reason).toMatch(/count[\s\S]*\b1\b[\s\S]*\b10\b/)
        // Missing, invalid and extra arguments each get their own explanation
        expect(new Set([reasons[0], reasons[1], reasons[3]]).size).toBe(3)
        expect(denied).toBe("Only moderators can use this")
        expect(closed).toEqual(expect.any(String))
        expect(closed!.length).toBeGreaterThan(0)
        expect(cooldown).toMatch(/\b60\b/)
        expect(executed).toEqual(["slow"])
        expect(reports).toEqual([])

        // Each rejection reply answers the rejected message
        const replyCalls = remote.calls.filter((call) => call.method === "POST")
        expect(
            replyCalls.map(
                (call) => (call.body as { message_reference?: { message_id?: string } }).message_reference?.message_id,
            ),
        ).toEqual(["101", "102", "103", "104", "105", "106", "108"])
    })

    test('onReject "reply" answers an active cooldown once and a guard denial once per user and command every 5 seconds', async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const realNow = Date.now.bind(Date)
        let offsetMs = 0
        vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs)
        const executed: string[] = []
        const execute = ({ name }: { name: string }) => act(mode, () => void executed.push(name))
        const router = createRouter(mode, { prefix: "!", onReject: "reply" }).registerMany({
            slow: { cooldown: { durationMs: 60_000 }, execute },
            blocked: { guard: () => act(mode, () => ({ deny: "Only moderators can use this" })), execute },
        })
        const reports = await attach(connected, router, { concurrency: 1 })
        const rejected = () => connected.logs.withCode("commands.rejected")

        for (let attempt = 0; attempt < 4; attempt += 1) remote.deliver("!slow")
        for (let attempt = 0; attempt < 3; attempt += 1) remote.deliver("!blocked")
        remote.deliver("!blocked", { authorId: "31" })
        await vi.waitFor(() => expect(rejected()).toHaveLength(7))
        await vi.waitFor(() => expect(remote.replies()).toHaveLength(3))
        // Later guard denials are answered again after the window, while the cooldown stays answered until it expires
        offsetMs = 6_000
        remote.deliver("!blocked")
        remote.deliver("!slow")
        await vi.waitFor(() => expect(rejected()).toHaveLength(9))
        await vi.waitFor(() => expect(remote.replies()).toHaveLength(4))

        const denied = remote.replies().slice(1)
        expect(denied).toEqual(Array(3).fill("Only moderators can use this"))
        expect(executed).toEqual(["slow"])
        expect(
            remote.calls
                .filter((call) => call.method === "POST")
                .map(
                    (call) =>
                        (call.body as { message_reference?: { message_id?: string } }).message_reference?.message_id,
                ),
        ).toEqual(["102", "105", "108", "109"])
        // Skipped replies stay observable at Debug with the rejection count
        const skipped = rejected().filter((record) => record.fields?.feedbackSuppressed === true)
        expect(skipped).toHaveLength(5)
        expect(skipped.every((record) => record.level === "debug")).toBe(true)
        expect(reports).toEqual([])
    })

    test("an onReject callback receives every rejection, without the reply limit", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const handled: string[] = []
        const router = createRouter(mode, {
            prefix: "!",
            onReject: ({ message }: { message: { id: string } }, rejection: PrefixCommandRejection) =>
                act(mode, () => void handled.push(`${message.id}:${rejection._tag}`)),
        }).registerMany({
            slow: { cooldown: { durationMs: 60_000 }, execute: () => act(mode, () => undefined) },
            blocked: { guard: () => act(mode, () => false), execute: () => act(mode, () => undefined) },
        })
        await attach(connected, router, { concurrency: 1 })
        for (const content of ["!slow", "!slow", "!slow", "!blocked", "!blocked"]) remote.deliver(content)
        await vi.waitFor(() => expect(handled).toHaveLength(4))
        expect(handled).toEqual([
            "102:CommandCooldownActive",
            "103:CommandCooldownActive",
            "104:CommandGuardRejected",
            "105:CommandGuardRejected",
        ])
        expect(remote.replies()).toEqual([])
    })

    test("a command's own onReject overrides the router's, in either direction", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const handled: string[] = []
        const record = (source: string) => (context: { name: string }, rejection: PrefixCommandRejection) =>
            act(mode, () => void handled.push(`${source}:${context.name}:${rejection._tag}`))
        const deny = () => act(mode, () => ({ deny: "Denied here" }))
        const execute = () => act(mode, () => undefined)
        const replying = createRouter(mode, { prefix: "!", onReject: "reply" }).registerMany({
            quiet: { guard: deny, onReject: record("command"), execute },
            loud: { guard: deny, execute },
        })
        const recording = createRouter(mode, { prefix: "?", onReject: record("router") }).registerMany({
            loud: { guard: deny, onReject: "reply", execute },
            quiet: { guard: deny, execute },
        })
        await attach(connected, replying, { concurrency: 1 })
        await attach(connected, recording, { concurrency: 1 })

        remote.deliver("!quiet")
        remote.deliver("!loud")
        remote.deliver("?loud")
        remote.deliver("?quiet")
        await vi.waitFor(() => expect(handled.length + remote.replies().length).toBe(4))
        expect(handled.sort()).toEqual(["command:quiet:CommandGuardRejected", "router:quiet:CommandGuardRejected"])
        expect(remote.replies()).toEqual(["Denied here", "Denied here"])
    })

    test("command and unmatched contexts send a string reply as its content", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const router = createRouter(mode, {
            prefix: "!",
            onUnmatched: ({ reply }: { reply: (input: string) => unknown }) => reply("Unknown command"),
        }).register({ name: "ping", execute: ({ reply }: { reply: (input: string) => unknown }) => reply("Pong") })
        const reports = await attach(connected, router, { concurrency: 1 })
        remote.deliver("!ping")
        remote.deliver("!missing")
        await vi.waitFor(() => expect(remote.replies()).toHaveLength(2))
        expect(remote.replies()).toEqual(["Pong", "Unknown command"])
        expect(remote.calls.map((call) => call.body)).toEqual([
            expect.objectContaining({ message_reference: expect.objectContaining({ message_id: "101" }) }),
            expect.objectContaining({ message_reference: expect.objectContaining({ message_id: "102" }) }),
        ])
        expect(reports).toEqual([])
    })

    test("command contexts build help from the dispatching router with the matched prefix", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        type HelpContext = { help: (options?: object) => readonly string[]; reply: (input: string) => unknown }
        const router = createRouter(mode, { prefix: ["!", "?"] })
            .registerMany({
                ping: { description: "Check the bot", execute: () => act(mode, () => undefined) },
                secret: { hidden: true, execute: () => act(mode, () => undefined) },
                help: { execute: ({ help, reply }: HelpContext) => reply(help().join("\n")) },
                short: { execute: ({ help, reply }: HelpContext) => reply(String(help({ maxLength: 40 }).length)) },
            })
            .registerGroup({ name: "admin", description: "Moderation" })
            .register(
                {
                    name: "ban",
                    execute: ({ help, reply }: HelpContext) => reply(help({ group: ["admin"] }).join("\n")),
                },
                { group: ["admin"] },
            )
        const reports = await attach(connected, router, { concurrency: 1 })
        remote.deliver("?help")
        remote.deliver("!short")
        remote.deliver("!admin ban")
        await vi.waitFor(() => expect(remote.replies()).toHaveLength(3))
        const [root, pageCount, group] = remote.replies() as string[]
        // The display prefix is the one the invoking message used, and hidden commands stay out of the pages
        expect(root).toContain("?ping")
        expect(root).toContain("Check the bot")
        expect(root).toContain("?admin")
        expect(root).not.toContain("secret")
        expect(root).not.toContain("!")
        // A smaller page length splits the same entries across more pages
        expect(Number(pageCount)).toBeGreaterThan(1)
        expect(group).toContain("!admin ban")
        expect(reports).toEqual([])
    })

    test("onReject accepts only reply or a function", () => {
        const execute = () => act(mode, () => undefined)
        for (const onReject of ["send", true, {}]) {
            expect(configurationError(() => createRouter(mode, { prefix: "!", onReject })).field).toBe("commands")
            expect(
                configurationError(() =>
                    createRouter(mode, { prefix: "!" }).register({ name: "ping", onReject, execute }),
                ).field,
            ).toBe("command")
        }
    })
})

test("native cooldown replies measure the remaining time with the handler's Effect Clock", async () => {
    const remote = await commandFixture()
    const connected = await connect("native")
    if (connected.mode !== "native") return expect.fail("Expected a native client")
    const clock = await Effect.runPromise(
        Layer.buildWithScope(TestClock.layer({ warningDelay: "10 seconds" }), connected.registration),
    )
    const router = nativeCommands.create({ prefix: "!", onReject: "reply" }).register({
        name: "slow",
        cooldown: { durationMs: 60_000 },
        execute: () => Effect.void,
    })
    await Effect.runPromise(
        router.attach(connected.client).pipe(Effect.provideContext(clock), Scope.provide(connected.registration)),
    )
    remote.deliver("!slow")
    await vi.waitFor(() => expect(connected.logs.withCode("commands.executed")).toHaveLength(1))
    await Effect.runPromise(TestClock.adjust("15 seconds").pipe(Effect.provideContext(clock)))
    remote.deliver("!slow")
    await vi.waitFor(() => expect(remote.replies()).toHaveLength(1))
    // The claim and the reply both read the TestClock, so 45 of the 60 seconds remain
    expect(remote.replies()[0]).toMatch(/\b45\b/)
})
