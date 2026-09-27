import { afterEach, expect, test, vi } from "vitest"
import type { ClientOptions, DefaultRestRequest, RestOptions } from "../../src/index.js"
import { captureLogs } from "../support/log-capture.js"
import { describeBothApis, modes, setup, type Mode } from "../support/both-apis.js"
import { creationField } from "../support/client-creation.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { expectErr, settle } from "../support/settle.js"
import { fakeHostTime, hostTurnsUntil } from "../support/client-clock.js"

const discoveryUrl = "https://fluxer.app/.well-known/fluxer"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

test.each(modes)("%s validates every REST option against its documented bounds", async (mode) => {
    const cases: [unknown, string | undefined][] = [
        [null, "rest"],
        [[], "rest"],
        [{ unknown: 1 }, "rest"],
        [{ concurrency: 0 }, "concurrency"],
        [{ concurrency: 65 }, "concurrency"],
        [{ concurrency: 1.5 }, "concurrency"],
        [{ concurrency: "4" }, "concurrency"],
        [{ mediaConcurrency: 0 }, "mediaConcurrency"],
        [{ mediaConcurrency: 65 }, "mediaConcurrency"],
        [{ maxQueued: 0 }, "maxQueued"],
        [{ maxQueued: 65_537 }, "maxQueued"],
        [{ queuedJsonMaxBytes: 65_535 }, "queuedJsonMaxBytes"],
        [{ queuedJsonMaxBytes: 268_435_457 }, "queuedJsonMaxBytes"],
        [{ defaultTimeoutMs: 0 }, "defaultTimeoutMs"],
        [{ defaultTimeoutMs: 2_147_483_648 }, "defaultTimeoutMs"],
        [{ defaultTimeoutMs: Number.POSITIVE_INFINITY }, "defaultTimeoutMs"],
        [{}, undefined],
        [
            {
                concurrency: 64,
                mediaConcurrency: 1,
                maxQueued: 65_536,
                queuedJsonMaxBytes: 65_536,
                defaultTimeoutMs: 2_147_483_647,
            },
            undefined,
        ],
        [{ concurrency: 1, queuedJsonMaxBytes: 268_435_456, defaultTimeoutMs: 1, maxQueued: 1 }, undefined],
    ]
    for (const [rest, field] of cases) expect([rest, await creationField(mode, { rest })]).toEqual([rest, field])
})

/** A client whose transport answers discovery and hands every REST request to the handler */
async function scheduled(
    mode: Mode,
    rest: RestOptions | undefined,
    handler: (url: string, init: RequestInit) => Promise<Response>,
    options: Pick<ClientOptions, "sharding" | "logging"> = {},
) {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("The platform fetch must not be used")))
    const client = await setup(mode, {
        ...options,
        ...(rest === undefined ? {} : { rest }),
        transport: {
            fetch: (url, init) =>
                url === discoveryUrl ? Promise.resolve(Response.json(hostedDiscoveryDocument)) : handler(url, init),
        },
    })
    const request = (input: DefaultRestRequest) =>
        mode === "default"
            ? (client as import("../../src/index.js").Client).rest.request(input)
            : (client as import("../../src/effect.js").Client).rest.request(input)
    // Resolve the instance first so discovery does not hold a request slot in the scenarios below
    await settle(client.instance.resolve())
    return { client, request }
}

/** A handler that holds each request until release() and counts how many run at once */
function gate() {
    let active = 0
    let peak = 0
    let completed = 0
    const waiting: (() => void)[] = []
    return {
        get peak() {
            return peak
        },
        get active() {
            return active
        },
        get completed() {
            return completed
        },
        release: () => waiting.splice(0).forEach((resume) => resume()),
        handler: async (_url: string, init: RequestInit) => {
            active++
            peak = Math.max(peak, active)
            try {
                await new Promise<void>((resolve, reject) => {
                    waiting.push(resolve)
                    init.signal?.addEventListener("abort", () => reject(init.signal!.reason))
                })
                completed++
                return Response.json({})
            } finally {
                active--
            }
        },
    }
}

describeBothApis("REST scheduling options", (mode) => {
    test("concurrency bounds the requests running at once and diagnostics report the configured capacities", async () => {
        const held = gate()
        const { client, request } = await scheduled(
            mode,
            { concurrency: 2, mediaConcurrency: 3, maxQueued: 7, queuedJsonMaxBytes: 70_000 },
            held.handler,
        )
        const pending = [1, 2, 3, 4].map((index) => settle(request({ method: "GET", path: `/channels/${index}/x` })))
        await vi.waitFor(() => expect(held.active).toBe(2))
        expect(client.diagnostics().rest).toEqual({
            activeRequests: 2,
            activeCapacity: 5,
            queuedRequests: 2,
            queuedCapacity: 7,
            queuedJsonBytes: 0,
            queuedJsonByteCapacity: 70_000,
        })
        await vi.waitFor(() => {
            held.release()
            expect(held.completed).toBe(4)
        })
        await Promise.all(pending)
        expect(held.peak).toBe(2)
    })

    test("maxQueued fails a request that finds the queue full without sending it", async () => {
        const held = gate()
        const { request } = await scheduled(mode, { concurrency: 1, maxQueued: 1 }, held.handler)
        const running = settle(request({ method: "GET", path: "/channels/1/x" }))
        await vi.waitFor(() => expect(held.active).toBe(1))
        const queued = settle(request({ method: "GET", path: "/channels/2/x" }))
        expect(await expectErr(request({ method: "GET", path: "/channels/3/x" }))).toMatchObject({
            reason: "busy",
            outcome: "notDispatched",
        })
        held.release()
        await vi.waitFor(() => expect([held.completed, held.active]).toEqual([1, 1]))
        held.release()
        await Promise.all([running, queued])
    })

    test("the default concurrency runs four requests per local shard at once, up to 64", async () => {
        const held = gate()
        // Two local shards of an eight-shard plan
        const { client, request } = await scheduled(mode, undefined, held.handler, {
            sharding: { totalShards: 8, shardIds: [3, 5] },
        })
        const pending = Array.from({ length: 10 }, (_, index) =>
            settle(request({ method: "GET", path: `/channels/${index + 1}/x` })),
        )
        await vi.waitFor(() => expect(held.active).toBe(8))
        expect(client.diagnostics().rest).toMatchObject({ activeCapacity: 8 + 4, queuedRequests: 2 })
        await vi.waitFor(() => {
            held.release()
            expect(held.completed).toBe(10)
        })
        await Promise.all(pending)
        expect(held.peak).toBe(8)

        const unsharded = await scheduled(mode, undefined, held.handler)
        expect(unsharded.client.diagnostics().rest.activeCapacity).toBe(4 + 4)
        const large = await scheduled(mode, undefined, held.handler, { sharding: { totalShards: 40 } })
        expect(large.client.diagnostics().rest.activeCapacity).toBe(64 + 4)
        // An explicit value is used as given, whatever the shard count
        const explicit = await scheduled(mode, { concurrency: 2 }, held.handler, { sharding: { totalShards: 8 } })
        expect(explicit.client.diagnostics().rest.activeCapacity).toBe(2 + 4)
    })

    test("a full queue logs one rest.busy Warn a minute and counts every busy failure", async () => {
        const held = gate()
        const logs = captureLogs()
        const { client, request } = await scheduled(mode, { concurrency: 1, maxQueued: 1 }, held.handler, {
            logging: logs.logging,
        })
        const running = settle(request({ method: "GET", path: "/channels/1/x" }))
        await vi.waitFor(() => expect(held.active).toBe(1))
        const queued = settle(request({ method: "GET", path: "/channels/2/x" }))
        for (const index of [3, 4, 5])
            expect(await expectErr(request({ method: "GET", path: `/channels/${index}/x` }))).toMatchObject({
                reason: "busy",
            })
        expect(client.diagnostics().counters.restBusy).toBe(3)
        expect(logs.withCode("rest.busy")).toEqual([
            expect.objectContaining({
                level: "warn",
                category: "rest",
                message: expect.stringContaining("rest.maxQueued"),
                fields: expect.objectContaining({ budget: "queue", queuedRequests: 1, queuedCapacity: 1 }),
            }),
        ])
        await vi.waitFor(() => {
            held.release()
            expect(held.completed).toBe(2)
        })
        await Promise.all([running, queued])
    })

    test("queuedJsonMaxBytes fails a JSON body larger than the queue budget", async () => {
        const calls: string[] = []
        const { request } = await scheduled(mode, { queuedJsonMaxBytes: 65_536 }, async (url) => {
            calls.push(url)
            return Response.json({})
        })
        await settle(request({ method: "POST", path: "/channels/1/x", body: { text: "x".repeat(60_000) } }))
        expect(
            await expectErr(request({ method: "POST", path: "/channels/1/x", body: { text: "x".repeat(70_000) } })),
        ).toMatchObject({ reason: "busy", outcome: "notDispatched" })
        expect(calls).toHaveLength(1)
    })

    test("defaultTimeoutMs is the deadline of a request without timeoutMs", async () => {
        fakeHostTime()
        const held = gate()
        const { request } = await scheduled(mode, { defaultTimeoutMs: 40 }, held.handler)
        let settled = false
        const defaulted = expectErr(request({ method: "GET", path: "/channels/1/x" })).finally(() => {
            settled = true
        })
        await hostTurnsUntil(() => held.active === 1)
        await vi.advanceTimersByTimeAsync(39)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(await defaulted).toMatchObject({ reason: "timeout", outcome: "unknown" })
        await hostTurnsUntil(() => held.active === 0)
        // An explicit timeoutMs still overrides the configured default
        let explicitSettled = false
        const explicit = settle(request({ method: "GET", path: "/channels/1/x", timeoutMs: 10_000 })).finally(() => {
            explicitSettled = true
        })
        await hostTurnsUntil(() => held.active === 1)
        await vi.advanceTimersByTimeAsync(80)
        expect(explicitSettled).toBe(false)
        held.release()
        await explicit
    })
})
