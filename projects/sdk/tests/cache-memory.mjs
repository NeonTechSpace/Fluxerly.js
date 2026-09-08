import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

const child = process.argv.includes("--child")
const samples = 5
const channelId = "1000000000000000000"
const maxEntries = 1_000
const maxBytes = 8 * 1024 * 1024
const shapes = [
    { name: "medium-ascii", codeUnits: 2_000, glyph: "a" },
    { name: "long-cjk", codeUnits: 10_000, glyph: "漢" },
]

if (typeof globalThis.gc !== "function") {
    throw new Error("Run with node --expose-gc --max-old-space-size=512 tests/cache-memory.mjs")
}

if (!child) {
    for (let sample = 1; sample <= samples; sample++) {
        const result = spawnSync(
            process.execPath,
            [...process.execArgv, process.argv[1], "--child", `--sample=${sample}`],
            {
                encoding: "utf8",
                timeout: 120_000,
            },
        )
        assert.equal(result.error, undefined)
        assert.equal(result.status, 0, result.stderr)
        process.stdout.write(result.stdout)
    }
} else {
    const rawFetch = globalThis.fetch
    const sample = Number(process.argv.find((argument) => argument.startsWith("--sample="))?.slice("--sample=".length))
    assert.ok(Number.isSafeInteger(sample) && sample >= 1 && sample <= samples)

    let shape = shapes[0]
    let offset = 0
    let requests = 0
    globalThis.fetch = async (input, init) => {
        const url = new URL(input)
        assert.equal(url.origin, "https://api.fluxer.app")
        assert.equal(url.pathname, `/v1/channels/${channelId}/messages`)
        assert.equal(init?.method, "GET")
        const limit = Number(url.searchParams.get("limit"))
        assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100)
        requests++
        const rows = Array.from({ length: limit }, (_, index) => {
            const ordinal = maxEntries - offset - index - 1
            const prefix = String(ordinal).padStart(8, "0")
            return {
                id: (2_000_000_000_000_000_000n + BigInt(ordinal)).toString(),
                channel_id: channelId,
                content: prefix + shape.glyph.repeat((shape.codeUnits - prefix.length) / shape.glyph.length),
                author: {
                    id: (3_000_000_000_000_000_000n + BigInt(ordinal % 100)).toString(),
                    username: "SyntheticUser00000000000000000000",
                    bot: false,
                },
            }
        })
        offset += limit
        return Response.json(rows)
    }

    try {
        const { createClient } = await import("@neontechspace/fluxerly")

        async function gc() {
            await new Promise((resolve) => setImmediate(resolve))
            for (let round = 0; round < 3; round++) globalThis.gc()
        }

        function create(cache) {
            const result = createClient(
                cache
                    ? { token: "synthetic-not-a-credential", cache: { messages: { maxEntries, maxBytes } } }
                    : { token: "synthetic-not-a-credential" },
            )
            assert.ok(result.isOk())
            return result.value
        }

        async function fill(client, count = maxEntries) {
            offset = 0
            const ids = []
            for (let loaded = 0; loaded < count; loaded += 100) {
                const result = await client.messages.fetchHistory(channelId, { limit: Math.min(100, count - loaded) })
                assert.ok(result.isOk())
                for (const message of result.value) {
                    assert.ok(Object.isFrozen(message) && Object.isFrozen(message.author))
                    assert.equal(message.content.length, shape.codeUnits)
                    ids.push(message.id)
                }
            }
            assert.equal(ids.length, count)
            return ids
        }

        async function measure(cache) {
            const client = create(cache)
            await gc()
            const before = process.memoryUsage().heapUsed
            const ids = await fill(client)
            await gc()
            const heapBytes = process.memoryUsage().heapUsed - before
            const retained = cache
                ? ids.filter((id) => {
                      const cached = client.messages.get({ id, channelId })
                      return cached.isOk() && cached.value !== undefined
                  }).length
                : 0
            assert.ok((await client.shutdown()).isOk())
            assert.equal(client.state, "Closed")
            return { heapBytes, retained, ids }
        }

        async function weakReferenceFor(client) {
            const result = await client.messages.fetchHistory(channelId, { limit: 1 })
            assert.ok(result.isOk())
            const target = result.value[0]
            const reference = { id: target.id, channelId }
            const cached = client.messages.get(reference)
            assert.ok(cached.isOk() && cached.value !== undefined)
            return { reference, weak: new WeakRef(cached.value) }
        }

        async function shutdownWeakReference() {
            const client = create(true)
            const retained = await weakReferenceFor(client)
            assert.ok((await client.shutdown()).isOk())
            assert.equal(client.state, "Closed")
            return retained.weak
        }

        async function released(weak) {
            for (let attempt = 0; attempt < 25; attempt++) {
                await gc()
                if (weak.deref() === undefined) return true
                await sleep(20)
            }
            return false
        }

        for (const current of shapes) {
            shape = current
            // Warm the built public path without retaining a cache before measuring either variant
            const warm = create(false)
            await fill(warm)
            assert.ok((await warm.shutdown()).isOk())

            const baseline = await measure(false)
            const cached = await measure(true)
            const bytesPerMessage = Buffer.byteLength(
                JSON.stringify({
                    id: cached.ids[0],
                    channelId,
                    content: `${"0".repeat(8)}${current.glyph.repeat((current.codeUnits - 8) / current.glyph.length)}`,
                    embeds: [],
                    attachments: [],
                    author: { id: "3000000000000000000", username: "SyntheticUser00000000000000000000", isBot: false },
                }),
                "utf8",
            )
            const expectedRetained = Math.min(maxEntries, Math.floor(maxBytes / bytesPerMessage))
            assert.equal(cached.retained, expectedRetained)
            console.log(
                JSON.stringify({
                    sample,
                    check: "actual_cache_memory_overhead",
                    shape: current.name,
                    count: maxEntries,
                    utf8JsonBytesPerMessage: bytesPerMessage,
                    expectedRetained,
                    retained: cached.retained,
                    baselineHeapBytes: baseline.heapBytes,
                    cacheHeapBytes: cached.heapBytes,
                    cacheOverheadBytes: cached.heapBytes - baseline.heapBytes,
                    requests,
                }),
            )
        }

        shape = { name: "expiry", codeUnits: 200, glyph: "a" }
        const expiryResult = createClient({
            token: "synthetic-not-a-credential",
            cache: { messages: { maxAgeMs: 25 } },
        })
        assert.ok(expiryResult.isOk())
        const expiryClient = expiryResult.value
        const expiring = await weakReferenceFor(expiryClient)
        await sleep(100)
        const expired = expiryClient.messages.get(expiring.reference)
        assert.ok(expired.isOk() && expired.value === undefined)
        assert.ok(await released(expiring.weak))
        assert.ok((await expiryClient.shutdown()).isOk())
        assert.equal(expiryClient.state, "Closed")

        const shutdownWeak = await shutdownWeakReference()
        assert.ok(await released(shutdownWeak))
        console.log(JSON.stringify({ sample, check: "expiry_and_shutdown_release", passed: true, requests }))
    } finally {
        globalThis.fetch = rawFetch
    }
}
