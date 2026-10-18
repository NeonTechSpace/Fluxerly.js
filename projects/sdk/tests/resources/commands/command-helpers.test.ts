import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest"
import { commands, ConfigurationError, SdkDefect, type MemberReference } from "../../../src/index.js"
import { commands as nativeCommands } from "../../../src/effect.js"
import type { CommandArgumentDescriptor, CommandArgumentUser } from "../../../src/command-arguments.js"
import { convertCommandArguments } from "../../../src/internal/command-arguments.js"
import { modes } from "../../support/both-apis.js"
import { act, attach, commandFixture, configurationError, connect, createRouter } from "./command-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const helpers = { default: commands, native: nativeCommands }

const suggestions: readonly (readonly [name: string, candidates: readonly string[], expected: string | undefined])[] = [
    ["pnig", ["ping", "help"], "ping"],
    ["PING", ["ping"], "ping"],
    ["png", ["PING"], "PING"],
    ["hlp", ["ping", "help"], "help"],
    // A name of up to four characters allows one edit, and a longer name allows two
    ["pang", ["pong"], "pong"],
    ["ab", ["xyz"], undefined],
    ["pnng", ["pung"], "pung"],
    ["announc", ["announce"], "announce"],
    ["anoucne", ["announce"], "announce"],
    ["anouncee", ["announce"], "announce"],
    ["anoxxxce", ["announce"], undefined],
    ["ping", [], undefined],
    // The closest candidate wins even when an earlier one is merely near, and the earliest wins a tie
    ["pang", ["pxxg", "pong", "pung"], "pong"],
    ["png", ["pong", "png"], "png"],
    ["png", ["pong", "ping"], "pong"],
]

describe.each(modes)("%s commands.suggest", (mode) => {
    const { suggest } = helpers[mode]

    test.each(suggestions)("suggest(%j, %j) returns %j", (name, candidates, expected) => {
        expect(suggest(name, candidates)).toBe(expected)
    })

    test("reads any iterable once and returns the candidate as written", () => {
        expect(suggest("pnig", new Set(["Ping", "help"]))).toBe("Ping")
        expect(suggest("pnig", new Map([["ping", 1]]).keys())).toBe("ping")
    })

    test("agrees with the suggestion the router gives for an unknown name", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const unmatched: unknown[] = []
        const names = ["pong", "ping", "help", "announce"]
        const execute = () => act(mode, () => undefined)
        const router = createRouter(mode, {
            prefix: "!",
            onUnmatched: (_context: unknown, outcome: unknown) => act(mode, () => void unmatched.push(outcome)),
        }).registerMany(Object.fromEntries(names.map((name) => [name, { execute }])))
        await attach(connected, router, { concurrency: 1 })

        const typed = ["png", "pnig", "PANG", "hlp", "announc", "anounce", "xyzzy", "h", "pingg"]
        for (const content of typed) remote.deliver(`!${content}`)
        await vi.waitFor(() => expect(unmatched).toHaveLength(typed.length))

        const outcomes = unmatched as { name: string; suggestion?: string }[]
        expect(outcomes.map((outcome) => outcome.name)).toEqual(typed)
        for (const outcome of outcomes) expect(outcome.suggestion, outcome.name).toBe(suggest(outcome.name, names))
        // The table must exercise suggestions and their absence, otherwise agreement would prove nothing
        expect(outcomes.some((outcome) => outcome.suggestion !== undefined)).toBe(true)
        expect(outcomes.some((outcome) => outcome.suggestion === undefined)).toBe(true)
    })

    test("misuse throws ConfigurationError", () => {
        const call = suggest as (name: unknown, candidates: unknown) => unknown
        for (const name of [undefined, 5, null, ["ping"]])
            expect(configurationError(() => call(name, ["ping"])).field).toBe("commands")
        // A lone string is almost always a forgotten array, so it is not read as a list of characters
        for (const candidates of [undefined, null, 5, {}, "ping", { length: 1, 0: "ping" }])
            expect(configurationError(() => call("pnig", candidates)).field).toBe("commands")
        for (const candidates of [[1], ["ping", undefined], [["ping"]]])
            expect(configurationError(() => call("pnig", candidates)).field).toBe("commands")
    })

    test("an iterator that throws is the application's defect", () => {
        const thrown = new Error("iterator failed")
        const candidates = {
            [Symbol.iterator]() {
                throw thrown
            },
        }
        try {
            suggest("pnig", candidates)
            expect.fail("Expected suggest to throw")
        } catch (error) {
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).not.toBeInstanceOf(ConfigurationError)
            expect(JSON.stringify((error as SdkDefect).reasons)).toContain("application")
        }
    })

    test("an iterator lookup that throws is the application's defect", () => {
        const candidates = {
            get [Symbol.iterator](): never {
                throw new Error("iterator lookup failed")
            },
        }
        try {
            suggest("pnig", candidates as never)
            expect.fail("Expected suggest to throw")
        } catch (error) {
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).not.toBeInstanceOf(ConfigurationError)
            expect(JSON.stringify((error as SdkDefect).reasons)).toContain("application")
        }
    })

    test("an empty name has no suggestion, even beside one-character candidates", () => {
        expect(suggest("", ["a", "ping"])).toBeUndefined()
        expect(suggest("", [])).toBeUndefined()
        // Candidates are still checked first, so misuse is not hidden by an empty name
        expect(
            configurationError(() => (suggest as (name: string, candidates: unknown) => unknown)("", "ping")).field,
        ).toBe("commands")
    })

    test("is typed to take iterables of strings", () => {
        expectTypeOf(suggest).parameters.toEqualTypeOf<[name: string, candidates: Iterable<string>]>()
        expectTypeOf(suggest).returns.toEqualTypeOf<string | undefined>()
    })
})

type Row = [
    label: string,
    descriptor: CommandArgumentDescriptor,
    token: string | undefined,
    expected: unknown,
    guildId?: string,
]

const users = [
    { id: "2", username: "bob" },
    { id: "3", username: "ann" },
    { id: "4", username: "ann" },
]
const channels = [{ id: "20", name: "general" }]
const roles = [{ id: "30", name: "mods" }]
const member = (userId: string): MemberReference => ({ guildId: "40", userId })

const rows: Row[] = [
    ["text", { type: "text" }, "hello", "hello"],
    ["empty text", { type: "text" }, "", undefined],
    ["rest text", { type: "text", rest: true }, "hello", "hello"],
    ["integer", { type: "integer" }, "42", 42],
    ["negative integer", { type: "integer" }, "-3", -3],
    ["leading zero integer", { type: "integer" }, "042", undefined],
    ["fraction as integer", { type: "integer" }, "1.5", undefined],
    ["integer below min", { type: "integer", min: 10 }, "9", undefined],
    ["integer at max", { type: "integer", max: 10 }, "10", 10],
    ["unsafe integer", { type: "integer" }, "9007199254740993", undefined],
    ["number", { type: "number" }, "1.25", 1.25],
    ["exponent number", { type: "number" }, "3e2", 300],
    ["number without integer part", { type: "number" }, ".5", undefined],
    ["infinite number", { type: "number" }, "Infinity", undefined],
    ["number above max", { type: "number", max: 1 }, "1.5", undefined],
    ["true", { type: "boolean" }, "true", true],
    ["false", { type: "boolean" }, "false", false],
    ["boolean spelling", { type: "boolean" }, "yes", undefined],
    ["boolean case", { type: "boolean" }, "True", undefined],
    ["id", { type: "id" }, "123", "123"],
    ["zero id", { type: "id" }, "0", undefined],
    ["largest id", { type: "id" }, "9223372036854775807", "9223372036854775807"],
    ["too large id", { type: "id" }, "9223372036854775808", undefined],
    ["id with leading zero", { type: "id" }, "012", undefined],
    ["mention without a mention kind", { type: "id" }, "<@123>", undefined],
    ["user mention", { type: "id", mention: "user" }, "<@123>", "123"],
    ["nickname user mention", { type: "id", mention: "user" }, "<@!123>", "123"],
    ["plain id with a mention kind", { type: "id", mention: "user" }, "123", "123"],
    ["channel mention", { type: "id", mention: "channel" }, "<#123>", "123"],
    ["role mention", { type: "id", mention: "role" }, "<@&123>", "123"],
    ["other mention kind", { type: "id", mention: "channel" }, "<@123>", undefined],
    ["zero mention", { type: "id", mention: "user" }, "<@0>", undefined],
    ["surrounded mention", { type: "id", mention: "user" }, "x<@123>", undefined],
    ["choice", { type: "choice", choices: ["red", "green"] }, "green", "green"],
    ["choice case", { type: "choice", choices: ["red", "green"] }, "Green", undefined],
    ["user by name", { type: "userChoice", candidates: users }, "bob", users[0]],
    ["user by id", { type: "userChoice", candidates: users }, "2", users[0]],
    ["user by mention", { type: "userChoice", candidates: users }, "<@!2>", users[0]],
    ["unknown user", { type: "userChoice", candidates: users }, "zed", undefined],
    ["ambiguous user", { type: "userChoice", candidates: users }, "ann", undefined],
    ["channel by name", { type: "channelChoice", candidates: channels }, "general", channels[0]],
    ["channel by mention", { type: "channelChoice", candidates: channels }, "<#20>", channels[0]],
    ["wrong channel mention", { type: "channelChoice", candidates: channels }, "<@20>", undefined],
    ["role by name", { type: "roleChoice", candidates: roles }, "mods", roles[0]],
    ["role by mention", { type: "roleChoice", candidates: roles }, "<@&30>", roles[0]],
    ["member id", { type: "member" }, "77", member("77"), "40"],
    ["member mention", { type: "member" }, "<@77>", member("77"), "40"],
    ["member nickname mention", { type: "member" }, "<@!77>", member("77"), "40"],
    ["member without a community", { type: "member" }, "77", undefined],
    ["invalid member", { type: "member" }, "<@0>", undefined, "40"],
    ["channel mention as member", { type: "member" }, "<#77>", undefined, "40"],
    ["duration", { type: "duration" }, "90s", 90_000],
    ["compound duration", { type: "duration" }, "1h30m", 5_400_000],
    ["milliseconds", { type: "duration" }, "1m500ms", 60_500],
    ["bare number duration", { type: "duration" }, "10", undefined],
    ["whole seconds", { type: "duration", wholeSeconds: true }, "1m500ms", undefined],
    ["duration above max", { type: "duration", max: 60_000 }, "2m", undefined],
    ["duration at min", { type: "duration", min: 60_000 }, "1m", 60_000],
    ["missing integer with default", { type: "integer", default: 6 }, undefined, 6],
    ["missing duration with default", { type: "duration", default: 1_000 }, undefined, 1_000],
    ["missing number with default", { type: "number", default: 0.5 }, undefined, 0.5],
    ["missing optional text", { type: "text", optional: true }, undefined, undefined],
    ["missing required text", { type: "text" }, undefined, undefined],
    ["missing required integer", { type: "integer" }, undefined, undefined],
    ["missing member", { type: "member", optional: true }, undefined, undefined, "40"],
]

describe.each(modes)("%s commands.parseArgument", (mode) => {
    const { parseArgument } = helpers[mode]

    test.each(rows)(
        "%s",
        (
            _label: string,
            descriptor: CommandArgumentDescriptor,
            token: string | undefined,
            expected: unknown,
            guildId?: string,
        ) => {
            const options = guildId === undefined ? undefined : { guildId }
            expect(parseArgument(token, descriptor as never, options)).toEqual(expected)
            // The router's own conversion gives the same value, or a rejection exactly when undefined comes back
            const conversion = convertCommandArguments({ value: descriptor }, token === undefined ? [] : [token], {
                guildId,
            })
            expect(conversion._tag === "Converted" ? conversion.values.value : undefined).toEqual(expected)
        },
    )

    test("converts to the same frozen candidate copies and member references the router gives", () => {
        const user = parseArgument("bob", { type: "userChoice", candidates: users })
        expect(user).toEqual({ id: "2", username: "bob" })
        expect(Object.isFrozen(user)).toBe(true)
        const reference = parseArgument("77", { type: "member" }, { guildId: "40" })
        expect(Object.isFrozen(reference)).toBe(true)
    })

    test("snapshots the descriptor, so later changes to it do not matter", () => {
        const choices = ["red"]
        const descriptor = { type: "choice", choices } as const
        expect(parseArgument("red", descriptor)).toBe("red")
        choices.push("blue")
        expect(parseArgument("blue", descriptor)).toBe("blue")
    })

    test("misuse throws ConfigurationError", () => {
        const call = parseArgument as (token: unknown, descriptor: unknown, options?: unknown) => unknown
        for (const descriptor of [
            undefined,
            null,
            "text",
            {},
            { type: "nope" },
            { type: "user" },
            { type: "integer", min: "1" },
            { type: "text", extra: true },
            { type: "choice", choices: [] },
            { type: "custom", parse: (token: string) => token },
        ])
            expect(configurationError(() => call("x", descriptor)).field, JSON.stringify(descriptor)).toBe("command")
        for (const token of [5, null, ["x"], {}])
            expect(configurationError(() => call(token, { type: "text" })).field).toBe("commands")
        for (const options of [null, 5, "40", [], { guildId: 40 }, { guildId: "abc" }, { guildId: "0" }, { extra: 1 }])
            expect(configurationError(() => call("7", { type: "member" }, options)).field).toMatch(/commands|guildId/)
    })

    test("never runs a custom parse function, even when the type getter changes its answer between reads", () => {
        let reads = 0
        const parse = vi.fn((token: string) => token)
        const descriptor = {
            get type() {
                reads += 1
                return reads === 1 ? "text" : "custom"
            },
            parse,
        }
        const call = parseArgument as (token: unknown, descriptor: unknown, options?: unknown) => unknown
        expect(() => call("x", descriptor)).toThrow(ConfigurationError)
        expect(parse).not.toHaveBeenCalled()
    })

    test("a getter that throws is the application's defect", () => {
        const thrown = new Error("getter failed")
        const descriptor = {
            get type(): string {
                throw thrown
            },
        }
        try {
            parseArgument("x", descriptor as never)
            expect.fail("Expected parseArgument to throw")
        } catch (error) {
            expect(error).toBeInstanceOf(SdkDefect)
            expect(JSON.stringify((error as SdkDefect).reasons)).toContain("application")
        }
    })

    test("a proxy trap that throws while the options are listed is the application's defect", () => {
        const options = new Proxy(
            {},
            {
                ownKeys() {
                    throw new Error("ownKeys failed")
                },
            },
        )
        try {
            parseArgument("7", { type: "member" }, options as never)
            expect.fail("Expected parseArgument to throw")
        } catch (error) {
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).not.toBeInstanceOf(ConfigurationError)
            expect(JSON.stringify((error as SdkDefect).reasons)).toContain("application")
        }
    })

    test("returns the descriptor's value type", () => {
        expectTypeOf(parseArgument("1", { type: "integer" })).toEqualTypeOf<number | undefined>()
        expectTypeOf(parseArgument("1", { type: "boolean", optional: true })).toEqualTypeOf<boolean | undefined>()
        expectTypeOf(parseArgument("1", { type: "id", mention: "user" })).toEqualTypeOf<string | undefined>()
        expectTypeOf(parseArgument("1", { type: "member" }, { guildId: "40" })).toEqualTypeOf<
            MemberReference | undefined
        >()
        expectTypeOf(parseArgument("red", { type: "choice", choices: ["red", "green"] })).toEqualTypeOf<
            "red" | "green" | undefined
        >()
        expectTypeOf(parseArgument("1", { type: "duration", default: 5 })).toEqualTypeOf<number | undefined>()
        expectTypeOf(parseArgument("bob", { type: "userChoice", candidates: users })).toEqualTypeOf<
            CommandArgumentUser | undefined
        >()
        // A custom descriptor has its own parse function, so it is not accepted
        // @ts-expect-error custom descriptors are not accepted
        const rejected = () => parseArgument("1", { type: "custom", parse: (token: string) => token })
        expect(rejected).toBeTypeOf("function")
    })
})
