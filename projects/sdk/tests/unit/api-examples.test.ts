// Runs the @example blocks of the command, guard and runBot interfaces, so an example whose registration throws, such as
// a required argument after an optional one, fails here rather than in an application that copied it.
// Each example is type-stripped, its package imports are bound to the current source, and every exported function runs
// against a test client. The runBot binding adds an already aborted signal, which keeps the full synchronous option and
// registration checks but creates no client and opens no connection
import { readFileSync, readdirSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { fileURLToPath } from "node:url"
import * as effect from "effect"
import { Cause, Effect, Exit } from "effect"
import { describe, expect, test } from "vitest"
import * as defaultApi from "../../src/index.js"
import * as nativeApi from "../../src/effect.js"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { fixtureToken } from "../../src/internal/testing/fixtures.js"

const apiRoot = fileURLToPath(new URL("../../src/api/", import.meta.url))
const directories = ["default", "effect"] as const
const exampleFiles = ["commands.ts", "guards.ts", "bot.ts"]

/**
 * Exported example functions that cannot run meaningfully, keyed like `default/bot.ts#pingBot`, with the reason.
 * Every other exported function must run, so a new example either runs or is listed here explicitly
 */
const notExecutable: Readonly<Record<string, string>> = {}

interface Example {
    readonly directory: (typeof directories)[number]
    readonly file: string
    readonly index: number
    readonly source: string
}

function extractExamples(): Example[] {
    const examples: Example[] = []
    for (const directory of directories) {
        const available = new Set(readdirSync(`${apiRoot}${directory}`))
        for (const name of exampleFiles) {
            if (!available.has(name)) continue
            const text = readFileSync(`${apiRoot}${directory}/${name}`, "utf8")
            let index = 0
            for (const match of text.matchAll(/@example\s*\n\s*\*\s*```ts\n([\s\S]*?)\n\s*\*\s*```/g)) {
                const source = match[1]!
                    .split("\n")
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n")
                examples.push({ directory, file: `${directory}/${name}`, index: index++, source })
            }
        }
    }
    return examples
}

/** Package entry points bound to current source, with runBot limited to its synchronous checks and registration */
const packages: Readonly<Record<string, unknown>> = {
    effect,
    "@neontechspace/fluxerly": {
        ...defaultApi,
        runBot: (options: object) =>
            defaultApi.runBot({ ...(options as Parameters<typeof defaultApi.runBot>[0]), signal: AbortSignal.abort() }),
    },
    "@neontechspace/fluxerly/effect": {
        ...nativeApi,
        runBot: (options: object) =>
            nativeApi.runBot({ ...(options as Parameters<typeof nativeApi.runBot>[0]), signal: AbortSignal.abort() }),
    },
}

/** Evaluate a type-stripped ES module example as a function body that reads its imports and returns its exports */
function evaluate(example: Example): Promise<Record<string, unknown>> {
    const exported: string[] = []
    const body = stripTypeScriptTypes(example.source)
        .replace(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)"\s*;?$/gm, (_, names: string, specifier: string) => {
            const bindings = names
                .split(",")
                .map((name) => name.trim())
                .filter((name) => name !== "")
                .map((name) => name.replace(/\s+as\s+/, ": "))
            return `const { ${bindings.join(", ")} } = __package(${JSON.stringify(specifier)})`
        })
        .replace(/^export\s+(async\s+function|function|const)\s+([A-Za-z_$][\w$]*)/gm, (_, kind: string, name) => {
            exported.push(name)
            return `${kind} ${name}`
        })
    if (/^\s*(import|export)\b/m.test(body))
        throw new Error(`Unsupported import or export form in ${example.file} example ${example.index}`)
    const load = (specifier: string) => {
        if (!(specifier in packages)) throw new Error(`Unbound import ${JSON.stringify(specifier)}`)
        return packages[specifier]
    }
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
        ...args: string[]
    ) => (load: (specifier: string) => unknown) => Promise<Record<string, unknown>>
    return new AsyncFunction("__package", `${body}\nreturn { ${exported.join(", ")} }`)(load)
}

/** Arguments for an exported example function, chosen by its parameter names in the type-stripped source */
function argumentsFor(name: string, fn: (...args: unknown[]) => unknown, values: Readonly<Record<string, unknown>>) {
    const text = fn.toString()
    const list = /^[^(=]*\(([^)]*)\)/.exec(text)?.[1] ?? /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(text)?.[1]
    return (list ?? "")
        .split(",")
        .map((parameter) => parameter.trim())
        .filter((parameter) => parameter !== "")
        .map((parameter) => {
            if (!(parameter in values))
                throw new Error(
                    `No test value for parameter ${parameter} of ${name}. Add one or list it in notExecutable`,
                )
            return values[parameter]
        })
}

async function runDefault(name: string, fn: (...args: unknown[]) => unknown) {
    await using test = createDefaultTestClient()
    test.rest.respond("POST /channels/:id/messages", { body: test.fixtures.message() })
    const router = defaultApi.commands.create({ prefix: "!" }).register({ name: "ping", execute: () => undefined })
    const returned = await fn(
        ...argumentsFor(name, fn, {
            token: fixtureToken,
            client: test.client,
            router,
            channelId: test.fixtures.message().channel_id,
        }),
    )
    // A returned ResultAsync resolves to a Result above
    if (typeof (returned as { isOk?: unknown } | undefined)?.isOk === "function")
        expect((returned as { isOk(): boolean }).isOk(), `${name} returned Err`).toBe(true)
    if (typeof (returned as { close?: unknown } | undefined)?.close === "function")
        (returned as { close(): void }).close()
}

async function runNative(name: string, fn: (...args: unknown[]) => unknown) {
    const exit = await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const test = yield* createNativeTestClient()
                test.rest.respond("POST /channels/:id/messages", { body: test.fixtures.message() })
                const router = nativeApi.commands
                    .create({ prefix: "!" })
                    .register({ name: "ping", execute: () => Effect.void })
                const returned = fn(
                    ...argumentsFor(name, fn, {
                        token: fixtureToken,
                        client: test.client,
                        router,
                        channelId: test.fixtures.message().channel_id,
                    }),
                )
                if (Effect.isEffect(returned)) yield* returned as Effect.Effect<unknown, unknown>
                else if (returned instanceof Promise) yield* Effect.promise(() => returned)
            }),
        ),
    )
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
}

const examples = extractExamples()

test("every command, guard and runBot interface in both entry points has examples to run", () => {
    const files = new Set(examples.map((example) => example.file))
    for (const directory of directories)
        for (const name of exampleFiles) expect(files).toContain(`${directory}/${name}`)
})

describe.each(examples)("$file example $index", (example) => {
    test("runs its registration without throwing", async () => {
        const exports = await evaluate(example)
        const names = Object.keys(exports)
        expect(names.length, "An example must export the function it demonstrates").toBeGreaterThan(0)
        for (const name of names) {
            if (notExecutable[`${example.file}#${name}`] !== undefined) continue
            const fn = exports[name]
            expect(typeof fn, `${name} must be an exported function`).toBe("function")
            if (example.directory === "default") await runDefault(name, fn as (...args: unknown[]) => unknown)
            else await runNative(name, fn as (...args: unknown[]) => unknown)
        }
    })
})
