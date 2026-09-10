import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { registerHooks } from "node:module"
import { setTimeout as sleep, setImmediate as turn } from "node:timers/promises"
import { withHostedDiscovery } from "./hosted-discovery.mjs"

// Compare only the queue-byte ceiling in isolated processes; never edit generated or production files
const child = process.argv.includes("--child")
const workloads = ["text-burst", "mixed-burst", "embed-burst", "slow-embeds", "rate-limited", "sustained-mixed"]
const variants = [4, 1, 8]
const repetitions = 3
const mode = process.argv[2] ?? "default"
assert.ok(mode === "default" || mode === "effect")
assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc")

if (!child) {
    const started = performance.now()
    const rows = []
    for (let sample = 0; sample < repetitions; sample++) {
        // Rotate order to avoid always measuring one candidate first
        const order = variants.slice(sample).concat(variants.slice(0, sample))
        for (const mib of order)
            for (const workload of workloads) {
                assert.ok(performance.now() - started < 600_000, "Search budget exceeded ten minutes")
                const result = spawnSync(
                    process.execPath,
                    [...process.execArgv, process.argv[1], mode, "--child", String(mib), workload, String(sample + 1)],
                    { encoding: "utf8", timeout: 20_000, windowsHide: true },
                )
                assert.equal(result.error, undefined)
                assert.equal(result.status, 0, result.stderr)
                const row = JSON.parse(result.stdout)
                rows.push(row)
                console.log(JSON.stringify(row))
            }
    }
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    for (const workload of workloads)
        for (const mib of variants) {
            const group = rows.filter((row) => row.workload === workload && row.mib === mib)
            assert.equal(group.length, repetitions)
            console.log(
                JSON.stringify({
                    summary: true,
                    mode,
                    mib,
                    workload,
                    success: median(group.map((row) => row.success)),
                    busy: median(group.map((row) => row.busy)),
                    timeout: median(group.map((row) => row.timeout)),
                    p95Ms: median(group.map((row) => row.p95Ms)),
                    queueP95Ms: median(group.map((row) => row.queueP95Ms)),
                    peakHeapMiB: median(group.map((row) => row.peakHeapMiB)),
                    elapsedMs: median(group.map((row) => row.elapsedMs)),
                }),
            )
        }
} else {
    const mib = Number(process.argv[4])
    const workload = process.argv[5]
    const sample = Number(process.argv[6])
    assert.ok(variants.includes(mib) && workloads.includes(workload))
    const restUrl = new URL("../dist/internal/rest.js", import.meta.url).href
    let loaded = 0
    const hooks = registerHooks({
        load(url, context, nextLoad) {
            const result = nextLoad(url, context)
            if (url !== restUrl) return result
            loaded++
            const source = String(result.source)
            assert.equal(source.split("const queuedJsonMaxBytes = 4_194_304").length, 2)
            return mib === 4
                ? result
                : {
                      ...result,
                      source: source.replace(
                          "const queuedJsonMaxBytes = 4_194_304",
                          `const queuedJsonMaxBytes = ${mib * 1024 * 1024}`,
                      ),
                  }
        },
    })
    const channelId = "20"
    let active = 0
    let maximumActive = 0
    let calls = 0
    let totalBodyBytes = 0
    let rateRejected = false
    const arrivals = new Map()
    const firstDispatch = new Set()
    const queueTimes = []
    const nonces = new Map()
    const rawFetch = globalThis.fetch
    globalThis.fetch = withHostedDiscovery(async (url, init) => {
        assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages")
        assert.equal(init.method, "POST")
        const body = JSON.parse(init.body)
        const ordinal = Number(body.content.slice(0, 6))
        assert.ok(arrivals.has(ordinal))
        assert.ok(init.signal instanceof AbortSignal)
        if (nonces.has(ordinal)) assert.equal(body.nonce, nonces.get(ordinal))
        nonces.set(ordinal, body.nonce)
        if (!firstDispatch.has(ordinal)) {
            firstDispatch.add(ordinal)
            queueTimes.push(performance.now() - arrivals.get(ordinal))
        }
        calls++
        totalBodyBytes += Buffer.byteLength(init.body)
        maximumActive = Math.max(maximumActive, ++active)
        assert.ok(active <= 4)
        try {
            await sleep(workload === "slow-embeds" ? 35 : 8, undefined, { signal: init.signal })
            if (workload === "rate-limited" && !rateRejected) {
                rateRejected = true
                return Response.json({ retry_after: 0.15, global: true }, { status: 429 })
            }
            return Response.json({
                id: String(1000 + ordinal),
                channel_id: channelId,
                content: body.content,
                author: { id: "30", username: "fixture", bot: true },
            })
        } finally {
            active--
        }
    })
    const effect = await import("effect")
    const scope = effect.Scope.makeUnsafe()
    const client =
        mode === "default"
            ? (await import("@neontechspace/fluxerly"))
                  .createClient({ token: "fixture-only-not-a-credential" })
                  ._unsafeUnwrap()
            : await effect.Effect.runPromise(
                  (await import("@neontechspace/fluxerly/effect"))
                      .createClient({ token: "fixture-only-not-a-credential" })
                      .pipe(effect.Scope.provide(scope)),
              )
    assert.equal(loaded, 1)
    globalThis.gc()
    const baseline = process.memoryUsage()
    let peakHeap = baseline.heapUsed
    let peakRss = baseline.rss
    const measure = () => {
        const usage = process.memoryUsage()
        peakHeap = Math.max(peakHeap, usage.heapUsed)
        peakRss = Math.max(peakRss, usage.rss)
    }
    const sampler = setInterval(measure, 5)
    const started = performance.now()
    const results = []
    const durations = []
    const count =
        workload === "sustained-mixed" ? 640 : workload.includes("embeds") || workload === "embed-burst" ? 192 : 320
    const timeoutMs = workload === "slow-embeds" ? 500 : 2500
    try {
        const operations = []
        for (let ordinal = 0; ordinal < count; ordinal++) {
            const big = workload.includes("embed") || (workload !== "text-burst" && ordinal % 10 === 0)
            const input = {
                content: `${String(ordinal).padStart(6, "0")}${"x".repeat(250)}`,
                ...(big
                    ? {
                          embeds: Array.from({ length: 8 }, (_, index) => ({
                              title: `Fixture ${index}`,
                              description: "e".repeat(4000),
                              fields: [
                                  { name: "One", value: "v".repeat(1000) },
                                  { name: "Two", value: "w".repeat(1000) },
                              ],
                          })),
                      }
                    : {}),
            }
            arrivals.set(ordinal, performance.now())
            const operation =
                mode === "default"
                    ? Promise.resolve(client.messages.send(channelId, input, { timeoutMs })).then((result) =>
                          result.isOk() ? "success" : result.error.reason,
                      )
                    : effect.Effect.runPromise(
                          effect.Effect.result(client.messages.send(channelId, input, { timeoutMs })),
                      ).then((result) => (result._tag === "Success" ? "success" : result.failure.reason))
            operations.push(
                operation.then((outcome) => {
                    assert.ok(["success", "busy", "timeout"].includes(outcome))
                    results.push(outcome)
                    if (outcome === "success") durations.push(performance.now() - arrivals.get(ordinal))
                }),
            )
            if (workload === "sustained-mixed" && ordinal % 16 === 15) await sleep(10)
        }
        await turn()
        measure()
        await Promise.all(operations)
        measure()
        assert.equal(results.length, count)
        assert.equal(active, 0)
        assert.ok(maximumActive > 0 && maximumActive <= 4)
        // A retry can itself be rejected by full admission; only the one confirmed 429 may replay
        assert.ok(calls >= firstDispatch.size && calls <= firstDispatch.size + Number(rateRejected))
        const quantile = (values) =>
            [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0
        console.log(
            JSON.stringify({
                mode,
                mib,
                workload,
                sample,
                count,
                calls,
                maximumActive,
                success: results.filter((x) => x === "success").length,
                busy: results.filter((x) => x === "busy").length,
                timeout: results.filter((x) => x === "timeout").length,
                rateReplays: calls - firstDispatch.size,
                p95Ms: Math.round(quantile(durations)),
                queueP95Ms: Math.round(quantile(queueTimes)),
                elapsedMs: Math.round(performance.now() - started),
                peakHeapMiB: +(Math.max(0, peakHeap - baseline.heapUsed) / 1024 / 1024).toFixed(2),
                peakRssMiB: +(Math.max(0, peakRss - baseline.rss) / 1024 / 1024).toFixed(2),
                totalBodyBytes,
            }),
        )
    } finally {
        clearInterval(sampler)
        if (mode === "default") assert.ok((await client.shutdown()).isOk())
        await effect.Effect.runPromise(effect.Scope.close(scope, effect.Exit.void))
        assert.equal(active, 0)
        globalThis.fetch = rawFetch
        hooks.deregister()
    }
}
