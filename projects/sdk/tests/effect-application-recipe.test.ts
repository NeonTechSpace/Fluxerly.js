import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { Context, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { createClient, type Client } from "../src/effect.js"

class BotClient extends Context.Service<BotClient, Client>()("recipe-test/BotClient") {}

class GreetingStore extends Context.Service<
    GreetingStore,
    { readonly greetingFor: (userId: string) => Effect.Effect<string> }
>()("recipe-test/GreetingStore") {}

class BotReplies extends Context.Service<BotReplies, { readonly reply: (content: string) => Effect.Effect<void> }>()(
    "recipe-test/BotReplies",
) {}

const handlePing = (message: {
    readonly content: string
    readonly author: { readonly id: string; readonly isBot: boolean }
}) =>
    Effect.gen(function* () {
        if (message.author.isBot || message.content !== "!ping") return
        const store = yield* GreetingStore
        const replies = yield* BotReplies
        yield* Effect.sleep("100 millis")
        yield* replies.reply(yield* store.greetingFor(message.author.id))
    })

async function loadLiveRecipe(createClientFixture: unknown) {
    const guide = readFileSync(
        join(import.meta.dirname, "../../web/content/guides/effect-application-testing.md"),
        "utf8",
    )
    const blocks = [...guide.matchAll(/```ts\r?\n([\s\S]*?)```/g)]
    const source = blocks[1]?.[1]
    if (!source) throw new Error("Effect application guide has no live TypeScript example")
    const key = `__fluxerlyEffectRecipe${crypto.randomUUID().replaceAll("-", "")}`
    Object.assign(globalThis, {
        [key]: { Context, Effect, Layer, createClient: createClientFixture },
    })
    const injected = source
        .replace(
            /^import \{ Context, Effect, Layer \} from "effect";?$/m,
            `const { Context, Effect, Layer } = globalThis.${key}`,
        )
        .replace(
            /^import \{ createClient, type Client \} from "@neontechspace\/fluxerly\/effect";?$/m,
            `const { createClient } = globalThis.${key}`,
        )
    const compiled = stripTypeScriptTypes(injected, { mode: "transform" })
    try {
        const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}#${crypto.randomUUID()}`
        return (await import(url)) as { liveApplication(token: string): Effect.Effect<void, { readonly _tag: string }> }
    } finally {
        delete (globalThis as Record<string, unknown>)[key]
    }
}

describe("Effect application recipe", () => {
    test("replaces application services and advances only application-owned time", async () => {
        const replies: string[] = []
        const fakes = Layer.mergeAll(
            Layer.succeed(GreetingStore, {
                greetingFor: (userId) => Effect.succeed(`Hello ${userId}`),
            }),
            Layer.succeed(BotReplies, {
                reply: (content) => Effect.sync(() => replies.push(content)),
            }),
        )

        const testProgram = Effect.gen(function* () {
            const fiber = yield* handlePing({ content: "!ping", author: { id: "42", isBot: false } }).pipe(
                Effect.provide(fakes),
                Effect.forkChild,
            )
            yield* TestClock.adjust("99 millis")
            expect(replies).toEqual([])
            yield* TestClock.adjust("1 millis")
            yield* Fiber.join(fiber)
            expect(replies).toEqual(["Hello 42"])
        }).pipe(Effect.provide(TestClock.layer()))

        await Effect.runPromise(testProgram)
    })

    test("closes a client acquired by an application Layer with its scope", async () => {
        let observed: Client | undefined
        const clients = Layer.effect(BotClient, createClient({ token: "fixture-only" }))
        await Effect.runPromise(
            Effect.scoped(
                BotClient.use((client) =>
                    Effect.sync(() => {
                        observed = client
                        expect(client.state).toBe("Disconnected")
                    }),
                ).pipe(Effect.provide(clients)),
            ),
        )

        expect(observed?.state).toBe("Closed")
    })

    test("the live guide fails on unexpected normal critical-worker closure and releases its client", async () => {
        let releases = 0
        const client = {
            on: () => Effect.succeed({ waitForClose: () => Effect.void }),
            run: () => Effect.never,
            messages: { reply: () => Effect.void },
        }
        const createClientFixture = () =>
            Effect.acquireRelease(Effect.succeed(client), () =>
                Effect.sync(() => {
                    releases += 1
                }),
            )
        const recipe = await loadLiveRecipe(createClientFixture)

        await expect(Effect.runPromise(Effect.flip(recipe.liveApplication("fixture")))).resolves.toEqual({
            _tag: "CriticalWorkerStopped",
        })
        expect(releases).toBe(1)
    })
})
