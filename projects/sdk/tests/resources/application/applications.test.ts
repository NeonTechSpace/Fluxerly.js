import { Cause, Effect, Exit } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import type { BotApplication } from "../../../src/application.js"
import { modes, setup as setupClient, type Mode } from "../../support/both-apis.js"
import { waitUntil } from "../../support/clock.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle, typedResult } from "../../support/settle.js"

afterEach(() => vi.unstubAllGlobals())

const wire = (extra: Record<string, unknown> = {}) => ({
    id: "1750000000000000000",
    name: "Fixture bot",
    icon: null,
    description: null,
    bot_public: true,
    bot_require_code_grant: false,
    owner: { id: "1750000000000000001", username: "owner" },
    ...extra,
})

async function setup(mode: Mode) {
    const client = await setupClient(mode, { token: "fixture" })
    return {
        client,
        fetchApplication: async (options?: {
            timeoutMs?: number
            signal?: AbortSignal
            [key: string]: unknown
        }): Promise<BotApplication> => {
            if (mode === "default") return settle(client.application.fetch(options))
            const { signal, ...request } = options ?? {}
            const result = await Effect.runPromise(
                typedResult(client.application.fetch(request as never) as Effect.Effect<unknown, unknown>),
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
                owner: { id: "1750000000000000002", username: "owner", email: "owner-private@example.test" },
                redirect_uris: ["https://private.example.test/callback"],
                verify_key: "compatibility-placeholder",
                bot: { token: "bot-secret", mfa_enabled: true, authenticator_types: [0] },
            }),
        )
    })
    const api = await setup(mode)

    const application = await api.fetchApplication()
    expect(application).toEqual({
        id: "1750000000000000000",
        name: "Fixture bot",
        icon: "bot-avatar",
        description: "Public bot profile",
        botPublic: true,
        botRequireCodeGrant: false,
        ownerId: "1750000000000000002",
    })
    expect(Object.isFrozen(application)).toBe(true)
    expect(Object.keys(application)).toEqual([
        "id",
        "name",
        "icon",
        "description",
        "botPublic",
        "botRequireCodeGrant",
        "ownerId",
    ])
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

    await expect(api.fetchApplication()).resolves.toMatchObject({ icon: null, description: null })
    for (const malformed of [
        wire({ id: "bad" }),
        wire({ name: 42 }),
        wire({ icon: undefined }),
        wire({ description: undefined }),
        wire({ bot_public: "yes" }),
        wire({ bot_require_code_grant: null }),
        wire({ owner: undefined }),
        wire({ owner: null }),
        wire({ owner: { username: "owner" } }),
        wire({ owner: { id: "owner" } }),
    ]) {
        response = malformed
        await expect(api.fetchApplication()).rejects.toMatchObject({
            _tag: "BotApplicationOperationError",
            operation: "application.fetch",
            reason: "response",
            outcome: "unknown",
        })
    }
    response = wire({
        owner: { id: "1750000000000000001", username: 4 },
        redirect_uris: "not-an-array",
        verify_key: null,
        bot: { token: 4 },
    })
    await expect(api.fetchApplication()).resolves.toMatchObject({
        id: "1750000000000000000",
        ownerId: "1750000000000000001",
    })
})

// Transient read retries are the shared policy covered in client/read-retries.test.ts
test.each(modes)("%s rejects app reads without exposing private provider bodies", async (mode) => {
    const api = await setup(mode)
    stubFetchWithHostedDiscovery(async () => Response.json({ message: "bot-secret response" }, { status: 403 }))
    let failure: unknown
    try {
        await api.fetchApplication()
    } catch (error) {
        failure = error
    }
    expect(failure).toMatchObject({
        _tag: "BotApplicationOperationError",
        operation: "application.fetch",
        reason: "rejected",
        outcome: "rejected",
        status: 403,
    })
    expect(JSON.stringify(failure)).not.toContain("bot-secret")
})

test.each(modes)("%s rejects invalid options before dispatch and waits for request cancellation", async (mode) => {
    const api = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    await expect(api.fetchApplication({ timeoutMs: 0 })).rejects.toMatchObject({
        _tag: "BotApplicationOperationError",
        reason: "input",
        outcome: "notDispatched",
    })
    await expect(api.fetchApplication({ unknown: true } as never)).rejects.toMatchObject({
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
        const pending = api.fetchApplication({ signal: controller.signal })
        await waitUntil(() => started, { message: "The request did not start" })
        controller.abort()
        await expect(pending).rejects.toMatchObject({ _tag: "CancelledError" })
    } else {
        const pending = Effect.runPromiseExit(api.client.application.fetch() as Effect.Effect<unknown, unknown>, {
            signal: controller.signal,
        })
        await waitUntil(() => started, { message: "The request did not start" })
        controller.abort()
        const exit = await pending
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
})
