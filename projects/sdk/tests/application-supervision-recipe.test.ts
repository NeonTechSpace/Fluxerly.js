import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"

const fixtureKey = "__fluxerlyApplicationSupervisionFixture"

type Result<A = void> =
    { isErr(): false; isOk(): true; value: A } | { isErr(): true; isOk(): false; error: { _tag: string } }

const ok = <A>(value: A): Result<A> => ({ isErr: () => false, isOk: () => true, value })
const err = (_tag: string): Result => ({ isErr: () => true, isOk: () => false, error: { _tag } })

async function loadRecipe(createClient: () => Result<unknown>) {
    const guide = readFileSync(join(import.meta.dirname, "../../web/content/guides/application-supervision.md"), "utf8")
    const source = guide.match(/```ts\r?\n([\s\S]*?)```/)?.[1]
    if (!source) throw new Error("Application supervision guide has no TypeScript example")
    const injected = source.replace(
        /^import[\s\S]*?from "@neontechspace\/fluxerly";?$/m,
        `const createClient = globalThis.${fixtureKey}`,
    )
    const compiled = stripTypeScriptTypes(injected, { mode: "transform" })
    Object.assign(globalThis, { [fixtureKey]: createClient })
    const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}#${crypto.randomUUID()}`
    return (await import(url)) as {
        runSupervisedBot(
            token: string,
            signal: AbortSignal,
            report: (health: unknown, diagnostics: unknown) => void,
        ): Promise<{ kind: string; failure?: string }>
    }
}

afterEach(() => {
    delete (globalThis as Record<string, unknown>)[fixtureKey]
})

function controlledClient(worker: (signal: AbortSignal) => Promise<Result>) {
    let shutdowns = 0
    let lifetimeSignal: AbortSignal | undefined
    const client = {
        state: "Disconnected" as string,
        diagnostics: () => ({ state: "Disconnected" }),
        messages: { reply: async () => ok(undefined) },
        on: () =>
            ok({
                waitForClose: ({ signal }: { signal: AbortSignal }) => {
                    lifetimeSignal = signal
                    return worker(signal)
                },
            }),
        run: ({ signal }: { signal: AbortSignal }) =>
            new Promise<Result>((resolve) =>
                signal.addEventListener("abort", () => resolve(err("CancelledError")), { once: true }),
            ),
        shutdown: async () => {
            shutdowns += 1
            return ok(undefined)
        },
    }
    return { client, shutdowns: () => shutdowns, lifetimeSignal: () => lifetimeSignal }
}

test("cleans up when the initial health reporter throws", async () => {
    const fixture = controlledClient(() => new Promise(() => undefined))
    const recipe = await loadRecipe(() => ok(fixture.client))
    const failure = new Error("health backend unavailable")

    await expect(
        recipe.runSupervisedBot("fixture", new AbortController().signal, () => {
            throw failure
        }),
    ).rejects.toBe(failure)
    expect(fixture.shutdowns()).toBe(1)
})

test("treats unexpected normal critical-worker closure as an application failure", async () => {
    const fixture = controlledClient(async () => ok(undefined))
    const recipe = await loadRecipe(() => ok(fixture.client))

    await expect(recipe.runSupervisedBot("fixture", new AbortController().signal, () => undefined)).resolves.toEqual({
        kind: "critical-worker-failed",
        failure: "CriticalWorkerStopped",
    })
    expect(fixture.lifetimeSignal()?.aborted).toBe(true)
    expect(fixture.shutdowns()).toBe(1)
})

test("accepts normal worker closure after the client reaches a terminal state", async () => {
    const fixture = controlledClient(async () => {
        fixture.client.state = "Closed"
        return ok(undefined)
    })
    const recipe = await loadRecipe(() => ok(fixture.client))

    await expect(recipe.runSupervisedBot("fixture", new AbortController().signal, () => undefined)).resolves.toEqual({
        kind: "stopped",
    })
    expect(fixture.shutdowns()).toBe(1)
})

test("preserves a rejected client lifetime while completing cleanup", async () => {
    const defect = new Error("fixture SDK defect")
    const fixture = controlledClient(
        (signal) =>
            new Promise((resolve) =>
                signal.addEventListener("abort", () => resolve(err("CancelledError")), { once: true }),
            ),
    )
    fixture.client.run = async () => {
        throw defect
    }
    const recipe = await loadRecipe(() => ok(fixture.client))

    await expect(recipe.runSupervisedBot("fixture", new AbortController().signal, () => undefined)).rejects.toBe(defect)
    expect(fixture.lifetimeSignal()?.aborted).toBe(true)
    expect(fixture.shutdowns()).toBe(1)
})
