import { afterEach, expect, test, vi } from "vitest"
import { modes, setup as setupClient, type Mode } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle } from "../../support/settle.js"

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

const setup = (mode: Mode) => setupClient(mode, { token: "fixture_only" })

test.each(modes)("%s creates separate one-day invites and supports explicit provider settings", async (mode) => {
    const client = await setup(mode)
    const requests: { path: string; method: string; body: unknown; audit: string | null }[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
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
    expect(await settle(client.invites.fetchForChannel("100"))).toEqual([created])
    expect(await settle(client.invites.fetchForGuild("200"))).toEqual([created])
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
    stubFetchWithHostedDiscovery(fetch)
    const read = await settle(client.invites.fetch("%2e%2e"))
    expect(read.url).toBe("https://fluxer.gg/%252e%252e")
    expect(read.type).toBe("group")
    expect(read).not.toHaveProperty("guild")
    expect(read).not.toHaveProperty("presenceCount")
    stubFetchWithHostedDiscovery(async () => Response.json(wire(true)))
    const created = await settle(client.invites.create("100"))
    expect(created).not.toHaveProperty("maxAgeSeconds")
})

test.each(modes)("%s rejects malformed invite input without requests or private diagnostics", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    for (const code of ["", ".", "..", "../private", "https://fluxer.gg/private", "a?b", "a\u0000b", "\ud800"]) {
        const failure = await settle(client.invites.fetch(code)).catch((error) => error)
        expect(failure).toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path: "code", constraint: "format" },
        })
        expect(JSON.stringify(failure)).not.toContain("private")
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

test.each(modes)("%s accepts plain invite codes beyond 128 characters without an invented local cap", async (mode) => {
    const client = await setup(mode)
    const code = "x".repeat(129)
    const fetch = vi.fn(async (url: string) => {
        expect(new URL(url).pathname).toBe(`/v1/invites/${code}`)
        return Response.json({ ...wire(), code })
    })
    stubFetchWithHostedDiscovery(fetch)
    expect((await settle(client.invites.fetch(code))).code).toBe(code)
    expect(fetch).toHaveBeenCalledTimes(1)
})

test.each(modes)("%s rejects mismatched invite responses and duplicate management entries", async (mode) => {
    const client = await setup(mode)
    let response: unknown = { ...wire(), code: "WrongCode" }
    stubFetchWithHostedDiscovery(async () => Response.json(response))
    await expect(settle(client.invites.fetch("FixtureCode"))).rejects.toMatchObject({ reason: "response" })
    response = { ...wire(), expires_at: "2025-02-29T00:00:00Z" }
    await expect(settle(client.invites.fetch("FixtureCode"))).rejects.toMatchObject({ reason: "response" })
    response = { ...wire(), created_at: "2025-04-31T00:00:00Z" }
    await expect(settle(client.invites.create("100"))).rejects.toMatchObject({ reason: "response", outcome: "unknown" })
    response = wire()
    await expect(settle(client.invites.create("999"))).rejects.toMatchObject({ reason: "response", outcome: "unknown" })
    response = [wire(), wire()]
    await expect(settle(client.invites.fetchForChannel("100"))).rejects.toMatchObject({ reason: "response" })
    response = [wire()]
    await expect(settle(client.invites.fetchForGuild("999"))).rejects.toMatchObject({ reason: "response" })
    response = { ...wire(), code: "fixturecode" }
    expect((await settle(client.invites.fetch("FixtureCode"))).code).toBe("fixturecode")
})

test.each(modes)("%s never replays uncertain invite creation and excludes codes from errors", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn(async () => {
        throw Error("FixtureCode private")
    })
    stubFetchWithHostedDiscovery(fetch)
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
