import { afterEach, expect, test, vi } from "vitest"
import { modes, setup as setupClient, type Mode } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle } from "../../support/settle.js"

afterEach(() => vi.unstubAllGlobals())
const setup = (mode: Mode) => setupClient(mode, { token: "fixture_only", cache: { guilds: true } })

test.each(modes)("%s preserves remote rejection details without retrying or retaining private data", async (mode) => {
    const client = await setup(mode)
    let status = 400
    const fetch = vi.fn(async () =>
        Response.json({ code: "INPUT_VALIDATION_ERROR", message: "private-code details" }, { status }),
    )
    stubFetchWithHostedDiscovery(fetch)
    for (status of [400, 403, 404]) {
        let failure: unknown
        try {
            await settle(client.guilds.editVanityUrl("200", "private-code"))
        } catch (error) {
            failure = error
        }
        expect(failure).toMatchObject({ _tag: "GuildOperationError", status, outcome: "rejected" })
        expect(JSON.stringify(failure)).not.toContain("private-code")
    }
    expect(fetch).toHaveBeenCalledTimes(3)
})

test.each(modes)("%s aborts the transport at the vanity deadline and remains usable", async (mode) => {
    const client = await setup(mode)
    let aborted = false
    stubFetchWithHostedDiscovery(
        (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
                const abort = () => {
                    aborted = true
                    reject(init.signal?.reason)
                }
                if (init.signal?.aborted) abort()
                else init.signal?.addEventListener("abort", abort, { once: true })
            }),
    )
    await expect(settle(client.guilds.editVanityUrl("200", "fixture-code", { timeoutMs: 20 }))).rejects.toMatchObject({
        reason: "timeout",
        outcome: "unknown",
    })
    expect(aborted).toBe(true)
    stubFetchWithHostedDiscovery(async () => Response.json({ code: null, uses: 0 }))
    expect((await settle(client.guilds.fetchVanityUrl("200"))).code).toBeNull()
})

test.each(modes)("%s reads remote vanity state and edits without fetching counts", async (mode) => {
    const client = await setup(mode)
    let code: string | null = null
    const requests: { url: string; method: string; body: unknown; reason: string | null }[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        requests.push({
            url,
            method: init.method!,
            body: init.body ? JSON.parse(init.body as string) : undefined,
            reason: new Headers(init.headers).get("X-Audit-Log-Reason"),
        })
        if (init.method === "GET") return Response.json({ code, uses: code ? 3 : 0, private_field: "dropped" })
        code = JSON.parse(init.body as string).code
        return Response.json({ code, uses: 999, private_field: "dropped" })
    })
    expect(await settle(client.guilds.fetchVanityUrl("200"))).toEqual({ code: null, url: null, uses: 0 })
    for (const next of ["ab", "a".repeat(32), "test-community", null]) {
        const result = await settle(client.guilds.editVanityUrl("200", next, { auditReason: "Fixture change" }))
        expect(result).toEqual({ code: next, url: next === null ? null : `https://fluxer.gg/${next}` })
        expect(Object.isFrozen(result)).toBe(true)
    }
    expect(requests.map((request) => request.method)).toEqual(["GET", "PATCH", "PATCH", "PATCH", "PATCH"])
    expect(requests.every((request) => request.url === "https://api.fluxer.app/v1/guilds/200/vanity-url")).toBe(true)
    expect(requests.map((request) => request.reason)).toEqual([null, ...Array(4).fill("Fixture change")])
    code = "remote-change"
    const read = await settle(client.guilds.fetchVanityUrl("200"))
    expect(read).toEqual({ code, url: `https://fluxer.gg/${code}`, uses: 3 })
    expect(Object.isFrozen(read)).toBe(true)
    code = null
    expect((await settle(client.guilds.fetchVanityUrl("200"))).code).toBeNull()
})

test.each(modes)("%s rejects invalid codes and omitted removal before dispatch", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    for (const code of [
        undefined,
        "",
        "a",
        "a".repeat(33),
        "HasCaps",
        "has space",
        "ab--cd",
        "-ab",
        "ab-",
        "../ab",
        "ab?",
        "éé",
        42,
    ]) {
        await expect(settle(client.guilds.editVanityUrl("200", code as never))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    }
    await expect(settle(client.guilds.fetchVanityUrl("../private"))).rejects.toMatchObject({ reason: "input" })
    await expect(settle(client.guilds.editVanityUrl("200", "valid-code", { auditReason: "é" }))).rejects.toMatchObject({
        reason: "input",
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s rejects malformed or mismatched observations without leaking code or body", async (mode) => {
    const client = await setup(mode)
    let response: unknown
    const fetch = vi.fn(async () => Response.json(response))
    stubFetchWithHostedDiscovery(fetch)
    for (response of [
        { code: null },
        { code: 42, uses: 0 },
        { code: null, uses: -1 },
        { code: null, uses: 0.5 },
        { code: null, uses: 2_147_483_648 },
    ]) {
        await expect(settle(client.guilds.fetchVanityUrl("200"))).rejects.toMatchObject({ reason: "response" })
    }
    response = { code: "wrong-private-code" }
    let failure: unknown
    try {
        await settle(client.guilds.editVanityUrl("200", "expected-private-code"))
    } catch (error) {
        failure = error
    }
    expect(failure).toMatchObject({ reason: "response", outcome: "unknown", operation: "guilds.editVanityUrl" })
    expect(JSON.stringify(failure)).not.toMatch(/wrong-private|expected-private/)
    expect(fetch).toHaveBeenCalledTimes(6)
})

test.each(modes)("%s invalidates cached guilds and pending reads after a vanity write", async (mode) => {
    const client = await setup(mode)
    const guild = { id: "200", owner_id: "300", name: "Fixture", features: [] }
    let hold = false,
        release!: () => void,
        entered!: () => void
    const ready = new Promise<void>((resolve) => {
        entered = resolve
    })
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        if (init.method === "GET") {
            if (hold) {
                entered()
                await held
            }
            return Response.json(guild)
        }
        throw Error("Lost response")
    })
    await settle(client.guilds.fetch("200"))
    hold = true
    const pending = settle(client.guilds.fetch("200"))
    await ready
    try {
        await expect(settle(client.guilds.editVanityUrl("200", "fixture-code"))).rejects.toMatchObject({
            outcome: "unknown",
        })
    } finally {
        release()
    }
    await pending
    const local = client.guilds.get("200")
    expect(await settle(local)).toBeUndefined()
})
