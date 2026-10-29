import { Context, Effect, type Scope } from "effect"
import { expect, expectTypeOf, test } from "vitest"
import { defineBot, runBot } from "../../src/index.js"
import { defineBot as defineNativeBot, runBot as runNativeBot } from "../../src/effect.js"
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
