import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { Config, Context, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { FluxerClient } from "../../src/effect.js"
import { createTestBot, FluxerTestClient } from "../../src/effect-testing.js"

/** Import one TypeScript block of the Effect application guide, supplying its imports from the given modules */
async function loadGuideBlock<T>(index: number, modules: Record<string, Record<string, unknown>>): Promise<T> {
    const guide = readFileSync(
        join(import.meta.dirname, "../../../web/content/guides/effect-application-testing.md"),
        "utf8",
    )
    const source = [...guide.matchAll(/```ts\r?\n([\s\S]*?)```/g)][index]?.[1]
    if (!source) throw new Error(`Effect application guide has no TypeScript block ${index}`)
    const key = `__fluxerlyEffectRecipe${crypto.randomUUID().replaceAll("-", "")}`
    Object.assign(globalThis, { [key]: modules })
    const injected = source.replace(/^import \{([^}]+)\} from "([^"]+)";?$/gm, (_line, names: string, from: string) => {
        if (!(from in modules)) throw new Error(`The test supplies no module for ${from}`)
        const values = names
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name !== "" && !name.startsWith("type "))
        return `const { ${values.join(", ")} } = globalThis.${key}[${JSON.stringify(from)}]`
    })
    const compiled = stripTypeScriptTypes(injected, { mode: "transform" })
    try {
        const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}#${crypto.randomUUID()}`
        return (await import(url)) as T
    } finally {
        delete (globalThis as Record<string, unknown>)[key]
    }
}

/** A node:test stand-in that keeps the tests a guide block registers, so this suite can run them too */
function guideTests() {
    const registered: Array<() => Promise<unknown>> = []
    return {
        module: { test: (_name: string, body: () => Promise<unknown>) => void registered.push(body) },
        run: async () => {
            expect(registered.length).toBeGreaterThan(0)
            for (const body of registered) await body()
        },
    }
}

type Ping = { readonly content: string; readonly author: { readonly id: string; readonly isBot: boolean } }

describe("Effect application recipe", () => {
    test("the guide's test replaces application services and advances only application-owned time", async () => {
        const tests = guideTests()
        // The test imports the guide's own bot file, so it checks the handler readers keep, not a copy
        const bot = await loadGuideBlock<Record<string, unknown>>(0, {
            effect: { Config, Context, Effect, Layer },
            "@neontechspace/fluxerly/effect": { FluxerClient },
        })
        const recipe = await loadGuideBlock<{
            testPing(message: Ping, replies: Array<string>): Effect.Effect<void>
        }>(2, {
            effect: { Effect, Fiber, Layer },
            "effect/testing": { TestClock },
            "node:test": tests.module,
            "./bot.ts": bot,
        })
        const replies: string[] = []
        // The handler sleeps 100 ms on the TestClock, so the test completes only when it adjusts that time itself
        await Effect.runPromise(
            recipe.testPing({ content: "!ping", author: { id: "42", isBot: false } }, replies).pipe(
                Effect.timeoutOrElse({
                    duration: "2 seconds",
                    orElse: () => Effect.die(new Error("The guide's testPing did not advance TestClock")),
                }),
            ),
        )
        expect(replies).toEqual(["Hello 42"])
        const ignored: string[] = []
        await Effect.runPromise(recipe.testPing({ content: "!ping", author: { id: "43", isBot: true } }, ignored))
        expect(ignored).toEqual([])
        // The test the guide registers asserts the same reply, so it passes here too
        await tests.run()
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
        const recipe = await loadGuideBlock<{
            liveApplication(token: string): Effect.Effect<void, { readonly _tag: string }>
        }>(1, {
            effect: { Context, Effect, Layer },
            "@neontechspace/fluxerly/effect": { createClient: createClientFixture },
        })

        await expect(Effect.runPromise(Effect.flip(recipe.liveApplication("fixture")))).resolves.toEqual({
            _tag: "CriticalWorkerStopped",
        })
        expect(releases).toBe(1)
    })

    test("the guide's service test runs application code that reads FluxerClient against the test client", async () => {
        const tests = guideTests()
        const recipe = await loadGuideBlock<{
            serviceTest: Effect.Effect<{ readonly body: unknown }, unknown>
        }>(5, {
            effect: { Effect },
            "@neontechspace/fluxerly/effect": { FluxerClient },
            "@neontechspace/fluxerly/effect/testing": { FluxerTestClient },
            "node:test": tests.module,
        })
        const reply = await Effect.runPromise(recipe.serviceTest)
        expect(reply.body).toMatchObject({ content: "Pong!" })
        await tests.run()
    })

    // Catches: The guide's conversation recipe stops working, such as say waiting for a command that waits for its
    // answer, so readers following it get a test that never finishes
    test("the guide's conversation test answers a command that waits for a reply", async () => {
        const tests = guideTests()
        const recipe = await loadGuideBlock<{
            conversationTest: Effect.Effect<{ readonly question: unknown; readonly replies: readonly unknown[] }>
        }>(4, {
            effect: { Effect },
            "@neontechspace/fluxerly/effect/testing": { createTestBot },
            "node:test": tests.module,
        })
        const result = await Effect.runPromise(
            recipe.conversationTest.pipe(
                Effect.timeoutOrElse({
                    duration: "5 seconds",
                    orElse: () => Effect.die(new Error("The guide's conversation test did not finish")),
                }),
            ),
        )
        expect(result).toEqual({ question: "What name should the bot use?", replies: ["Hello, Ada!"] })
        await tests.run()
    })
})
