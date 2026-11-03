import { Context, Effect, type Scope } from "effect"
import { expect, expectTypeOf, test } from "vitest"
import { defineBot, runBot } from "../../src/index.js"
import {
    commands as nativeCommands,
    defineBot as defineNativeBot,
    runBot as runNativeBot,
    type Message,
    type PrefixCommandRouter,
} from "../../src/effect.js"
import { createTestBot } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"

class Greeting extends Context.Service<Greeting, { readonly text: string }>()("Greeting") {}

test("defineBot returns the same options object, and a defined bot answers its typed command in a test", async () => {
    const options = { ignoreBots: false }
    expect(defineBot(options)).toBe(options)

    const bot = defineBot({
        commands: {
            prefix: "!",
            commands: {
                greet: {
                    arguments: { name: { type: "text", rest: true } },
                    execute: ({ values, reply }) => {
                        // An object annotated with BotOptions would give values no name property
                        expectTypeOf(values.name).toEqualTypeOf<string>()
                        return reply(`Hello, ${values.name}!`)
                    },
                },
            },
        },
    })
    // The token is passed to runBot, so defineBot rejects it
    // @ts-expect-error defineBot takes the options without the token
    defineBot({ token: "fixture-only" })
    // runBot accepts the defined options with the token, which compiling this unused function checks
    expectTypeOf(() => runBot({ token: undefined, ...bot })).toBeFunction()

    await using testBot = createTestBot(bot)
    await testBot.ready()
    expect((await testBot.say("!greet Ada Lovelace")).map((message) => message.content)).toEqual([
        "Hello, Ada Lovelace!",
    ])
})

test("the Effect defineBot keeps the services a command requires for runBot and createTestBot", async () => {
    const bot = defineNativeBot({
        commands: {
            prefix: "!",
            commands: {
                greet: {
                    arguments: { name: { type: "text", rest: true } },
                    execute: ({ values, reply }) =>
                        Effect.gen(function* () {
                            const greeting = yield* Greeting
                            expectTypeOf(values.name).toEqualTypeOf<string>()
                            return yield* reply(`${greeting.text}, ${values.name}!`)
                        }),
                },
            },
        },
    })
    type Requirements<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never
    const run = runNativeBot({ token: undefined, ...bot })
    expectTypeOf<Requirements<typeof run>>().toEqualTypeOf<Greeting>()
    const created = createNativeTestBot(bot)
    expectTypeOf<Exclude<Requirements<typeof created>, Scope.Scope>>().toEqualTypeOf<Greeting>()

    const replies = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createNativeTestBot(bot)
                yield* testBot.ready()
                return yield* testBot.say("!greet Ada")
            }),
        ).pipe(Effect.provideService(Greeting, { text: "Hello" })),
    )
    expect(replies.map((message) => message.content)).toEqual(["Hello, Ada!"])
})

class PrefixSource extends Context.Service<PrefixSource, { readonly prefix: string }>()("PrefixSource") {}
class Calls extends Context.Service<Calls, { readonly seen: string[] }>()("Calls") {}
class Feedback extends Context.Service<Feedback, { readonly label: string }>()("Feedback") {}
class Audit extends Context.Service<Audit, { readonly label: string }>()("Audit") {}

/** A bot whose router callbacks each require their own service, and record that they ran with it */
const callbackBot = defineNativeBot({
    commands: {
        prefix: () =>
            Effect.gen(function* () {
                return (yield* PrefixSource).prefix
            }),
        use: [
            (_context, next) =>
                Effect.gen(function* () {
                    ;(yield* Calls).seen.push("use")
                    yield* next
                }),
        ],
        onUnmatched: () =>
            Effect.gen(function* () {
                ;(yield* Calls).seen.push("onUnmatched")
            }),
        onReject: () =>
            Effect.gen(function* () {
                ;(yield* Calls).seen.push(`onReject ${(yield* Feedback).label}`)
            }),
        onError: () =>
            Effect.gen(function* () {
                ;(yield* Calls).seen.push(`onError ${(yield* Audit).label}`)
            }),
        commands: {
            greet: { arguments: { name: { type: "text" } }, execute: ({ reply, values }) => reply(values.name) },
            boom: { execute: () => Effect.fail(new Error("boom")) },
        },
    },
})

test("the Effect runBot, defineBot and createTestBot require the services of router callbacks and prefix resolvers", () => {
    type Requirements<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never
    type Expected = PrefixSource | Calls | Feedback | Audit
    const run = runNativeBot({ token: undefined, ...callbackBot })
    expectTypeOf<Requirements<typeof run>>().toEqualTypeOf<Expected>()
    const inline = runNativeBot({
        token: undefined,
        commands: {
            prefix: () =>
                Effect.gen(function* () {
                    return (yield* PrefixSource).prefix
                }),
            onUnmatched: () =>
                Effect.gen(function* () {
                    yield* Calls
                }),
            commands: { ping: { execute: ({ reply }) => reply("Pong") } },
        },
    })
    expectTypeOf<Requirements<typeof inline>>().toEqualTypeOf<PrefixSource | Calls>()
    const created = createNativeTestBot(callbackBot)
    expectTypeOf<Exclude<Requirements<typeof created>, Scope.Scope>>().toEqualTypeOf<Expected>()
    // Bots without such callbacks keep requiring nothing
    const plain = runNativeBot({ token: undefined, commands: { prefix: "!", commands: {} } })
    expectTypeOf<Requirements<typeof plain>>().toEqualTypeOf<never>()
    // A callback service must be provided before the bot runs
    expectTypeOf<typeof run extends Effect.Effect<unknown, unknown, never> ? true : false>().toEqualTypeOf<false>()
    // A standalone router's prefix resolver adds its services to the router's requirements
    const standalone = nativeCommands.create({
        prefix: () =>
            Effect.gen(function* () {
                return (yield* PrefixSource).prefix
            }),
    })
    expectTypeOf(standalone).toEqualTypeOf<PrefixCommandRouter<PrefixSource, Message>>()
})

test("the Effect createTestBot runs router callbacks and a prefix resolver with the provided services", async () => {
    const seen: string[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createNativeTestBot(callbackBot)
                yield* testBot.ready()
                expect((yield* testBot.say("?greet Ada")).map((message) => message.content)).toEqual(["Ada"])
                yield* testBot.say("?greet")
                yield* testBot.say("?unknown")
                yield* testBot.say("?boom")
                yield* testBot.idle()
                expect(testBot.failures().map((record) => record.code)).toEqual([])
            }),
        ).pipe(
            Effect.provideService(PrefixSource, { prefix: "?" }),
            Effect.provideService(Calls, { seen }),
            Effect.provideService(Feedback, { label: "feedback" }),
            Effect.provideService(Audit, { label: "audit" }),
        ),
    )
    // Middleware runs around a matched command, including one rejected for a missing argument
    expect(seen).toEqual(["use", "use", "onReject feedback", "onUnmatched", "use", "onError audit"])
})
