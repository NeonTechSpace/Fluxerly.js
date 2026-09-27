import { Effect } from "effect"
import { err } from "neverthrow"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ConfigurationError, type PrefixCommandRejection } from "../../../src/index.js"
import { modes } from "../../support/both-apis.js"
import { act, attach, commandFixture, configurationError, connect, createRouter } from "./command-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const hex = (token: string) => (/^#[0-9a-f]{6}$/i.test(token) ? Number.parseInt(token.slice(1), 16) : undefined)

describe.each(modes)("%s bounded, duration, member and custom arguments", (mode) => {
    test("commands receive converted values, defaults for omitted tokens and rejections for invalid tokens", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const values: unknown[] = []
        const rejected: string[] = []
        const onReject = ({ message }: { message: { id: string } }, rejection: PrefixCommandRejection) =>
            act(mode, () => {
                if (rejection._tag === "CommandArgumentRejected")
                    rejected.push(`${message.id}:${rejection.argument}:${rejection.reason}`)
            })
        const execute = ({ values: converted }: { values: unknown }) => act(mode, () => void values.push(converted))
        const router = createRouter(mode, { prefix: "!" }).registerMany({
            roll: { arguments: { sides: { type: "integer", min: 2, max: 100, default: 6 } }, onReject, execute },
            mute: { arguments: { target: { type: "member" }, length: { type: "duration" } }, onReject, execute },
            paint: {
                arguments: { color: { type: "custom", parse: hex, expected: "a hex color" } },
                onReject,
                execute,
            },
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        remote.deliver("!roll")
        remote.deliver("!roll 20")
        remote.deliver("!roll 1")
        remote.deliver("!mute <@!31> 1h30m", { guildId: "40" })
        remote.deliver("!mute 31 10", { guildId: "40" })
        remote.deliver("!mute <@31> 5m")
        remote.deliver("!paint #FF8800")
        remote.deliver("!paint orange")
        await vi.waitFor(() => expect(values.length + rejected.length).toBe(8))

        expect(values).toEqual([
            { sides: 6 },
            { sides: 20 },
            { target: { guildId: "40", userId: "31" }, length: 5_400_000 },
            { color: 0xff8800 },
        ])
        expect(rejected).toEqual([
            "103:sides:Invalid",
            "105:length:Invalid",
            // A member argument needs the message's guild
            "106:target:Invalid",
            "108:color:Invalid",
        ])
        expect(reports).toEqual([])
    })

    test("a throwing custom parse fails the command and is reported with the command name", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const failure = new Error("parse failed")
        const called: string[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "paint",
            arguments: {
                color: {
                    type: "custom",
                    parse: () => {
                        throw failure
                    },
                },
            },
            onReject: () => act(mode, () => void called.push("onReject")),
            execute: () => act(mode, () => void called.push("execute")),
        })
        const reports = await attach(connected, router)
        remote.deliver("!paint red")
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(reports[0]).toMatchObject({ kind: "handler", command: "paint" })
        expect(reports[0]!.error).toBe(failure)
        expect(called).toEqual([])
    })

    test("a custom parse that returns an Err is reported like a throw of its error", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const failure = new Error("parse failed")
        const called: string[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "paint",
            arguments: { color: { type: "custom", parse: () => err(failure) } },
            onReject: () => act(mode, () => void called.push("onReject")),
            execute: () => act(mode, () => void called.push("execute")),
        })
        const reports = await attach(connected, router)
        remote.deliver("!paint red")
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(reports[0]).toMatchObject({ kind: "handler", command: "paint" })
        expect(reports[0]!.error).toBe(failure)
        expect(called).toEqual([])
    })

    test("a custom parse that returns a Promise or Effect is reported as misuse and never runs the command", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const called: string[] = []
        const onReject = () => act(mode, () => void called.push("onReject"))
        const execute = () => act(mode, () => void called.push("execute"))
        const router = createRouter(mode, { prefix: "!" }).registerMany({
            // The rejection must not become an unhandled rejection, which would fail this test run
            later: {
                arguments: { color: { type: "custom", parse: () => Promise.reject(new Error("late failure")) } },
                onReject,
                execute,
            },
            resolved: { arguments: { color: { type: "custom", parse: async () => 1 } }, onReject, execute },
            effect: { arguments: { color: { type: "custom", parse: () => Effect.succeed(1) } }, onReject, execute },
        })
        const reports = await attach(connected, router, { concurrency: 1 })
        remote.deliver("!later red")
        remote.deliver("!resolved red")
        remote.deliver("!effect red")
        await vi.waitFor(() => expect(reports).toHaveLength(3))
        expect(reports.map((report) => report.command)).toEqual(["later", "resolved", "effect"])
        for (const report of reports) {
            expect(report.kind).toBe("handler")
            expect(report.error).toBeInstanceOf(ConfigurationError)
            expect((report.error as ConfigurationError).field).toBe("command")
        }
        expect(called).toEqual([])
    })

    test("rejection replies answer each rejected message with the caller's expectation, bounds and the command usage", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const execute = () => act(mode, () => undefined)
        const router = createRouter(mode, { prefix: "!", onReject: "reply" }).registerMany({
            paint: { arguments: { color: { type: "custom", parse: hex, expected: "a hex color" } }, execute },
            wait: { arguments: { length: { type: "duration", max: 60_000, wholeSeconds: true } }, execute },
            kick: { arguments: { target: { type: "member" } }, execute },
        })
        await attach(connected, router, { concurrency: 1 })
        remote.deliver("!paint orange")
        remote.deliver("!wait 2m")
        remote.deliver("!kick someone", { guildId: "40" })
        await vi.waitFor(() => expect(remote.replies()).toHaveLength(3))
        expect(
            remote.calls.map(
                (call) => (call.body as { message_reference?: { message_id?: string } }).message_reference?.message_id,
            ),
        ).toEqual(["101", "102", "103"])
        // Reply wording is not a contract. The caller-supplied expectation, the bound and the usage are
        const [color, length, target] = remote.replies()
        expect(color).toContain("a hex color")
        expect(color).toContain("!paint <color>")
        expect(length).toContain("60000")
        expect(length).toContain("whole seconds")
        expect(length).toContain("!wait <length>")
        expect(target).toContain("!kick <target>")
    })

    // The argument conversion tests cover each descriptor rule. This checks that registration surfaces a violation
    test("registration reports an invalid argument descriptor as a command configuration error", () => {
        const execute = () => act(mode, () => undefined)
        const router = createRouter(mode, { prefix: "!" })
        const invalid = { type: "integer", min: 10, max: 1 }
        expect(
            configurationError(() => router.register({ name: "roll", arguments: { value: invalid }, execute })).field,
        ).toBe("command")
        expect(router.commands).toEqual([])
    })

    test("an unsupported argument type suggests the supported type it most likely meant", () => {
        const execute = () => act(mode, () => undefined)
        const router = createRouter(mode, { prefix: "!" })
        const hint = (type: unknown) =>
            configurationError(() =>
                router.register({ name: "greet", arguments: { name: { type } as never }, execute }),
            ).hint
        expect(hint("string")).toMatch(/^Did you mean "text"\? Supported types are text, integer/)
        expect(hint("intger")).toMatch(/^Did you mean "integer"\?/)
        expect(hint("anything")).toMatch(/^Supported types are .*roleChoice/)
        expect(hint(undefined)).toMatch(/^Set type to one of text, /)
        expect(router.commands).toEqual([])
    })
})
