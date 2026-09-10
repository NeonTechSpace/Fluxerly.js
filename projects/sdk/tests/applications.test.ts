import { Cause, Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import type { BotApplication } from "../src/application.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const

afterEach(() => vi.unstubAllGlobals())

const wire = (extra: Record<string, unknown> = {}) => ({
    id: "1750000000000000000",
    name: "Fixture bot",
    icon: null,
    description: null,
    bot_public: true,
    bot_require_code_grant: false,
    ...extra,
})

async function settle<A>(value: ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) {
        const result = await Effect.runPromise(Effect.result(value))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await value
    if (result.isErr()) throw result.error
    return result.value
}

async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const client =
        mode === "default"
            ? createClient({ token: "fixture" })._unsafeUnwrap()
            : await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        const closed = client.shutdown()
        if (Effect.isEffect(closed)) await Effect.runPromise(closed)
        else await closed
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        client,
        fetchCurrent: async (options?: {
            timeoutMs?: number
            signal?: AbortSignal
            [key: string]: unknown
        }): Promise<BotApplication> => {
            if (mode === "default") return settle(client.application.fetchCurrent(options))
            const { signal, ...request } = options ?? {}
            const result = await Effect.runPromise(
                Effect.result(client.application.fetchCurrent(request as never) as Effect.Effect<unknown, unknown>),
                signal ? { signal } : undefined,
            )
            if (result._tag === "Failure") throw result.failure
            return result.success as BotApplication
        },
    }
}

test.each(modes)("%s projects a frozen current-bot application allowlist without cache hydration", async (mode) => {
    const calls: { path: string; method: string; authorization: string | null }[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        calls.push({
            path: new URL(url).pathname,
            method: init.method ?? "GET",
            authorization: new Headers(init.headers).get("authorization"),
        })
        return Response.json(
            wire({
                icon: "bot-avatar",
                description: "Public bot profile",
                owner: { id: "owner", email: "owner-private@example.test" },
                redirect_uris: ["https://private.example.test/callback"],
                verify_key: "compatibility-placeholder",
                bot: { token: "bot-secret", mfa_enabled: true, authenticator_types: [0] },
            }),
        )
    })
    const api = await setup(mode)

    const application = await api.fetchCurrent()
    expect(application).toEqual({
        id: "1750000000000000000",
        name: "Fixture bot",
        icon: "bot-avatar",
        description: "Public bot profile",
        botPublic: true,
        botRequireCodeGrant: false,
    })
    expect(Object.isFrozen(application)).toBe(true)
    expect(Object.keys(application)).toEqual(["id", "name", "icon", "description", "botPublic", "botRequireCodeGrant"])
    expect(Object.hasOwn(api.client.application, "get")).toBe(false)
    expect(calls).toEqual([
        {
            path: "/v1/oauth2/applications/@me",
            method: "GET",
            authorization: "Bot fixture",
        },
    ])
    expect(JSON.stringify(application)).not.toContain("private")
    expect(JSON.stringify(application)).not.toContain("secret")
})

test.each(modes)("%s validates current-app fields and ignores excluded response fields", async (mode) => {
    const api = await setup(mode)
    let response: unknown = wire()
    stubFetchWithHostedDiscovery(async () => Response.json(response))

    await expect(api.fetchCurrent()).resolves.toMatchObject({ icon: null, description: null })
    for (const malformed of [
        wire({ id: "bad" }),
        wire({ name: 42 }),
        wire({ icon: undefined }),
        wire({ description: undefined }),
        wire({ bot_public: "yes" }),
        wire({ bot_require_code_grant: null }),
    ]) {
        response = malformed
        await expect(api.fetchCurrent()).rejects.toMatchObject({
            _tag: "BotApplicationOperationError",
            operation: "application.fetchCurrent",
            reason: "response",
            outcome: "unknown",
        })
    }
    response = wire({ owner: null, redirect_uris: "not-an-array", verify_key: null, bot: { token: 4 } })
    await expect(api.fetchCurrent()).resolves.toMatchObject({ id: "1750000000000000000" })
})

test.each(modes)("%s retries transient app reads without exposing private provider bodies", async (mode) => {
    const api = await setup(mode)
    let calls = 0
    stubFetchWithHostedDiscovery(async () => {
        calls += 1
        return calls === 1 ? Response.json({ message: "bot-secret response" }, { status: 503 }) : Response.json(wire())
    })

    await expect(api.fetchCurrent()).resolves.toMatchObject({ id: "1750000000000000000" })
    expect(calls).toBe(2)

    calls = 0
    stubFetchWithHostedDiscovery(async () => {
        calls += 1
        return Response.json({ message: "bot-secret response" }, { status: 403 })
    })
    let failure: unknown
    try {
        await api.fetchCurrent()
    } catch (error) {
        failure = error
    }
    expect(failure).toMatchObject({ reason: "rejected", outcome: "rejected", status: 403 })
    expect(JSON.stringify(failure)).not.toContain("bot-secret")
    expect(calls).toBe(1)
})

test.each(modes)("%s rejects invalid options before dispatch and waits for request cancellation", async (mode) => {
    const api = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    await expect(api.fetchCurrent({ timeoutMs: 0 })).rejects.toMatchObject({
        _tag: "BotApplicationOperationError",
        reason: "input",
        outcome: "notDispatched",
    })
    await expect(api.fetchCurrent({ unknown: true } as never)).rejects.toMatchObject({
        _tag: "BotApplicationOperationError",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(fetch).not.toHaveBeenCalled()

    let started = false
    stubFetchWithHostedDiscovery(
        (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                started = true
                init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
            }),
    )
    const controller = new AbortController()
    if (mode === "default") {
        const pending = api.fetchCurrent({ signal: controller.signal })
        while (!started) await new Promise((resolve) => setTimeout(resolve, 0))
        controller.abort()
        await expect(pending).rejects.toMatchObject({ _tag: "CancelledError" })
    } else {
        const pending = Effect.runPromiseExit(
            api.client.application.fetchCurrent() as Effect.Effect<unknown, unknown>,
            {
                signal: controller.signal,
            },
        )
        while (!started) await new Promise((resolve) => setTimeout(resolve, 0))
        controller.abort()
        const exit = await pending
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
})
