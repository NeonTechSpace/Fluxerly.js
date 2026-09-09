import { Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"

const modes = ["default", "native"] as const
const wire = (group = false) => ({
    code: "FixtureCode",
    type: group ? 1 : 0,
    channel: { id: "100", type: group ? 3 : 0, name: null, recipients: [{ username: "excluded" }] },
    ...(group ? {} : { guild: { id: "200", name: "Guild" }, presence_count: 1, max_age: 86400 }),
    inviter: { id: "300", username: "excluded" },
    member_count: 2,
    temporary: false,
    created_at: "2026-09-09T00:00:00.000Z",
    expires_at: null,
    uses: 0,
    max_uses: 0,
})
afterEach(() => vi.unstubAllGlobals())

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
    const options = { token: "fixture_only" }
    const client =
        mode === "default"
            ? createClient(options)._unsafeUnwrap()
            : await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        const closed = client.shutdown()
        if (Effect.isEffect(closed)) await Effect.runPromise(closed)
        else await closed
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return client
}

test.each(modes)("%s creates separate one-day invites and supports explicit provider settings", async (mode) => {
    const client = await setup(mode)
    const requests: { path: string; method: string; body: unknown; audit: string | null }[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        requests.push({
            path: new URL(url).pathname,
            method: init.method!,
            body: init.body ? JSON.parse(String(init.body)) : null,
            audit: new Headers(init.headers).get("X-Audit-Log-Reason"),
        })
        if (init.method === "DELETE") return new Response(null, { status: 204 })
        return Response.json(init.method === "GET" && String(url).endsWith("/invites") ? [wire()] : wire())
    })
    const created = await settle(client.invites.create("100", undefined, { auditReason: "One day" }))
    expect(requests.at(-1)).toMatchObject({
        method: "POST",
        path: "/v1/channels/100/invites",
        body: { max_age: 86400, max_uses: 0, unique: true, temporary: false },
        audit: "One day",
    })
    expect(created).toMatchObject({
        code: "FixtureCode",
        guild: { id: "200", name: "Guild" },
        inviterId: "300",
        maxAgeSeconds: 86400,
    })
    expect(JSON.stringify(created)).not.toContain("excluded")
    expect(created.url).toBe("https://fluxer.gg/FixtureCode")
    expect(Object.isFrozen(created.channel)).toBe(true)
    expect(Object.isFrozen(created.guild)).toBe(true)
    await settle(client.invites.create("100", { maxAgeSeconds: 0, maxUses: 100, unique: false, temporary: true }))
    expect(requests.at(-1)?.body).toEqual({ max_age: 0, max_uses: 100, unique: false, temporary: true })
    expect(await settle(client.invites.fetch("FixtureCode"))).not.toHaveProperty("uses")
    expect(await settle(client.invites.fetchChannel("100"))).toEqual([created])
    expect(await settle(client.invites.fetchGuild("200"))).toEqual([created])
    await settle(client.invites.delete("FixtureCode"))
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/invites/FixtureCode" })
    expect(requests.some((item) => item.method === "POST" && item.path.startsWith("/v1/invites/"))).toBe(false)
})

test.each(modes)("%s handles existing-group metadata and safely encodes plain codes", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn(async (url: string) => {
        expect(new URL(url).pathname).toBe("/v1/invites/%252e%252e")
        return Response.json({ ...wire(true), code: "%2e%2e" })
    })
    vi.stubGlobal("fetch", fetch)
    const read = await settle(client.invites.fetch("%2e%2e"))
    expect(read.url).toBe("https://fluxer.gg/%252e%252e")
    expect(read.type).toBe("group")
    expect(read).not.toHaveProperty("guild")
    expect(read).not.toHaveProperty("presenceCount")
    vi.stubGlobal("fetch", async () => Response.json(wire(true)))
    const created = await settle(client.invites.create("100"))
    expect(created).not.toHaveProperty("maxAgeSeconds")
})

test.each(modes)("%s rejects malformed invite input without requests or private diagnostics", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    for (const code of ["", ".", "..", "../private", "https://fluxer.gg/private", "a?b", "a\u0000b", "\ud800"]) {
        await expect(settle(client.invites.fetch(code))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    }
    for (const input of [
        { maxAgeSeconds: -1 },
        { maxAgeSeconds: 604801 },
        { maxAgeSeconds: null },
        { maxUses: 101 },
        { maxUses: 0.5 },
        { unique: null },
        { temporary: 1 },
        { extra: "private" },
    ]) {
        await expect(settle(client.invites.create("100", input as never))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    }
    await expect(settle(client.invites.create("../private"))).rejects.toMatchObject({ reason: "input" })
    await expect(settle(client.invites.delete("FixtureCode", { auditReason: "é" }))).rejects.toMatchObject({
        reason: "input",
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s rejects mismatched invite responses and duplicate management entries", async (mode) => {
    const client = await setup(mode)
    let response: unknown = { ...wire(), code: "WrongCode" }
    vi.stubGlobal("fetch", async () => Response.json(response))
    await expect(settle(client.invites.fetch("FixtureCode"))).rejects.toMatchObject({ reason: "response" })
    response = wire()
    await expect(settle(client.invites.create("999"))).rejects.toMatchObject({ reason: "response", outcome: "unknown" })
    response = [wire(), wire()]
    await expect(settle(client.invites.fetchChannel("100"))).rejects.toMatchObject({ reason: "response" })
    response = [wire()]
    await expect(settle(client.invites.fetchGuild("999"))).rejects.toMatchObject({ reason: "response" })
    response = { ...wire(), code: "fixturecode" }
    expect((await settle(client.invites.fetch("FixtureCode"))).code).toBe("fixturecode")
})

test.each(modes)("%s never replays uncertain invite creation and excludes codes from errors", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn(async () => {
        throw Error("FixtureCode private")
    })
    vi.stubGlobal("fetch", fetch)
    await expect(settle(client.invites.create("100"))).rejects.toMatchObject({ reason: "network", outcome: "unknown" })
    expect(fetch).toHaveBeenCalledTimes(1)
    let failure: unknown
    try {
        await settle(client.invites.delete("FixtureCode"))
    } catch (error) {
        failure = error
    }
    expect(failure).toMatchObject({ reason: "network", outcome: "unknown" })
    expect(JSON.stringify(failure)).not.toMatch(/FixtureCode|private/)
    expect(fetch).toHaveBeenCalledTimes(2)
})
