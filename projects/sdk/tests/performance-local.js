import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { setImmediate as turn, setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { withHostedDiscovery } from "./hosted-discovery.mjs"

const script = fileURLToPath(import.meta.url)
const sdkRoot = fileURLToPath(new URL("..", import.meta.url))
const child = process.argv.includes("--child")
const smoke = process.argv.includes("--smoke")
const modes = ["default", "effect"]
const scenarios = ["cold-import-client-lifecycle", "workload"]
const samples = smoke ? 1 : 7
const pageSize = smoke ? 25 : 100
const pages = smoke ? 1 : 5
const lookupRounds = smoke ? 3 : 200
const maximumRelativeMad = 0.15
const cleanupDeadlineMs = 2_000
const messageCodeUnits = 512
const minimumEventLoopSamples = 5
const memorySamplingIntervalMs = 2

function sha256File(file) {
    return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function sha256Tree(directory) {
    const files = []
    const visit = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const target = path.join(current, entry.name)
            if (entry.isDirectory()) visit(target)
            else if (entry.isFile()) files.push(target)
        }
    }
    visit(directory)
    files.sort((left, right) => left.localeCompare(right))
    const hash = createHash("sha256")
    for (const file of files) {
        hash.update(path.relative(directory, file).replaceAll("\\", "/"))
        hash.update("\0")
        hash.update(readFileSync(file))
        hash.update("\0")
    }
    return { sha256: hash.digest("hex"), files: files.length }
}

function environmentProvenance(commit) {
    const manifest = JSON.parse(readFileSync(path.join(sdkRoot, "package.json"), "utf8"))
    const effectManifest = JSON.parse(
        readFileSync(path.join(sdkRoot, "node_modules", "effect", "package.json"), "utf8"),
    )
    const neverthrowManifest = JSON.parse(
        readFileSync(path.join(sdkRoot, "node_modules", "neverthrow", "package.json"), "utf8"),
    )
    const wsManifest = JSON.parse(readFileSync(path.join(sdkRoot, "node_modules", "ws", "package.json"), "utf8"))
    return {
        commit,
        inputs: {
            harness: sha256File(script),
            hostedDiscoveryFixture: sha256File(path.join(sdkRoot, "tests", "hosted-discovery.mjs")),
            sdkSourceTree: sha256Tree(path.join(sdkRoot, "src")),
            sdkBuiltTree: sha256Tree(path.join(sdkRoot, "dist")),
            sdkManifest: sha256File(path.join(sdkRoot, "package.json")),
            workspaceLock: sha256File(path.join(sdkRoot, "..", "pnpm-lock.yaml")),
        },
        dependencies: {
            package: { name: manifest.name, version: manifest.version },
            declared: manifest.dependencies ?? {},
            peers: manifest.peerDependencies ?? {},
            resolvedRuntime: {
                effect: effectManifest.version,
                neverthrow: neverthrowManifest.version,
                ws: wsManifest.version,
            },
        },
        runtime: {
            node: process.version,
            v8: process.versions.v8,
            execPath: process.execPath,
            execArgv: process.execArgv,
            nodeOptions: process.env.NODE_OPTIONS ?? "",
        },
        operatingSystem: {
            platform: process.platform,
            type: os.type(),
            release: os.release(),
            version: os.version(),
            arch: process.arch,
            cpuModel: os.cpus()[0]?.model ?? "unknown",
            logicalCpuCount: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
        },
    }
}

function median(values) {
    assert.ok(values.length > 0)
    const sorted = [...values].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function percentile(values, fraction) {
    assert.ok(values.length > 0)
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function summarize(rows, field) {
    const values = rows.map((row) => row[field])
    const center = median(values)
    const relativeMad = center === 0 ? null : median(values.map((value) => Math.abs(value - center))) / Math.abs(center)
    return {
        median: center,
        p95: percentile(values, 0.95),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        relativeMad,
        quality: smoke
            ? "smoke-only"
            : relativeMad !== null && relativeMad <= maximumRelativeMad
              ? "stable"
              : "descriptive-only",
        raw: values,
    }
}

if (!child) {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true })
    assert.equal(commit.status, 0, commit.stderr)
    console.log(
        JSON.stringify({
            kind: "provenance",
            benchmark: "local-runtime",
            schemaVersion: 1,
            smoke,
            ...environmentProvenance(commit.stdout.trim()),
            samples,
            workload: {
                pages,
                pageSize,
                retainedMessages: pages * pageSize,
                messageCodeUnits,
                lookupRounds,
                lookupOperations: pages * pageSize * lookupRounds,
            },
            acceptance: {
                correctness: "exact requests, projections, observations, closed lifecycle, and collected WeakRef",
                cleanupDeadlineMs,
                maximumRelativeMad,
                minimumEventLoopSamples,
                memorySamplingIntervalMs,
                coldMeasurement: "module import, client construction, and shutdown inside an already running process",
                eventLoopWindow:
                    "monitor readiness occurs before reset; delay samples cover only cache-lookup work and stop immediately after it",
                note: "Heap/RSS residuals and timings are descriptive; allocator RSS retention is not a cleanup failure",
            },
        }),
    )

    const rows = []
    for (let sample = 1; sample <= samples; sample++)
        for (const scenario of scenarios) {
            const orderedModes = sample % 2 === 0 ? [...modes].reverse() : modes
            for (const mode of orderedModes) {
                const result = spawnSync(
                    process.execPath,
                    [
                        "--expose-gc",
                        "--max-old-space-size=512",
                        script,
                        "--child",
                        scenario,
                        mode,
                        String(sample),
                        ...(smoke ? ["--smoke"] : []),
                    ],
                    { encoding: "utf8", timeout: 120_000, windowsHide: true },
                )
                assert.equal(result.error, undefined)
                assert.equal(result.status, 0, result.stderr)
                const row = JSON.parse(result.stdout)
                rows.push(row)
                console.log(JSON.stringify({ kind: "sample", ...row }))
            }
        }

    for (const mode of modes)
        for (const scenario of scenarios) {
            const group = rows.filter((row) => row.mode === mode && row.scenario === scenario)
            assert.equal(group.length, samples)
            const fields =
                scenario === "cold-import-client-lifecycle"
                    ? ["wallMs", "cpuTotalMs", "heapDeltaBytes", "rssDeltaBytes"]
                    : [
                          "fillWallMs",
                          "lookupWallMs",
                          "lookupCpuTotalMs",
                          "operationsPerSecond",
                          "eventLoopDelayP50Ms",
                          "eventLoopDelayP99Ms",
                          "eventLoopDelayMaxMs",
                          "eventLoopDelaySamples",
                          "retainedHeapBytes",
                          "retainedRssBytes",
                          "sampledPeakHeapBytes",
                          "sampledPeakRssBytes",
                          "postShutdownHeapDeltaBytes",
                          "postShutdownRssDeltaBytes",
                          "cleanupMs",
                      ]
            console.log(
                JSON.stringify({
                    kind: "summary",
                    benchmark: "local-runtime",
                    mode,
                    scenario,
                    metrics: Object.fromEntries(fields.map((field) => [field, summarize(group, field)])),
                }),
            )
        }
} else {
    assert.equal(typeof globalThis.gc, "function", "The local performance child requires --expose-gc")
    const childIndex = process.argv.indexOf("--child")
    const scenario = process.argv[childIndex + 1]
    const mode = process.argv[childIndex + 2]
    const sample = Number(process.argv[childIndex + 3])
    assert.ok(scenarios.includes(scenario))
    assert.ok(modes.includes(mode))
    assert.ok(Number.isSafeInteger(sample) && sample >= 1 && sample <= samples)

    async function gc() {
        await turn()
        for (let round = 0; round < 3; round++) globalThis.gc()
    }

    if (scenario === "cold-import-client-lifecycle") {
        await gc()
        const before = process.memoryUsage()
        const cpuStarted = process.cpuUsage()
        const started = performance.now()
        let state
        if (mode === "default") {
            const { createClient } = await import("@neontechspace/fluxerly")
            const created = createClient({ token: "synthetic-not-a-credential" })
            assert.ok(created.isOk())
            const client = created.value
            assert.ok((await client.shutdown()).isOk())
            state = client.state
        } else {
            const { Effect } = await import("effect")
            const { createClient } = await import("@neontechspace/fluxerly/effect")
            state = await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const client = yield* createClient({ token: "synthetic-not-a-credential" })
                        yield* client.shutdown()
                        return client.state
                    }),
                ),
            )
        }
        const wallMs = performance.now() - started
        const cpu = process.cpuUsage(cpuStarted)
        assert.equal(state, "Closed")
        await gc()
        const after = process.memoryUsage()
        const cpuUserMs = cpu.user / 1_000
        const cpuSystemMs = cpu.system / 1_000
        console.log(
            JSON.stringify({
                benchmark: "local-runtime",
                scenario,
                mode,
                sample,
                wallMs,
                cpuUserMs,
                cpuSystemMs,
                cpuTotalMs: cpuUserMs + cpuSystemMs,
                heapDeltaBytes: after.heapUsed - before.heapUsed,
                rssDeltaBytes: after.rss - before.rss,
                correctness: true,
            }),
        )
    } else {
        const channelId = "1000000000000000000"
        const retainedMessages = pages * pageSize
        const maxBytes = 8 * 1024 * 1024
        let offset = 0
        let requests = 0
        const originalFetch = globalThis.fetch
        globalThis.fetch = withHostedDiscovery(async (input, init) => {
            const url = new URL(input)
            assert.equal(url.origin, "https://api.fluxer.app")
            assert.equal(url.pathname, `/v1/channels/${channelId}/messages`)
            assert.equal(url.searchParams.get("limit"), String(pageSize))
            assert.equal(init?.method, "GET")
            requests++
            const rows = Array.from({ length: pageSize }, (_, index) => {
                const ordinal = retainedMessages - offset - index - 1
                const prefix = String(ordinal).padStart(8, "0")
                return {
                    id: (2_000_000_000_000_000_000n + BigInt(ordinal)).toString(),
                    channel_id: channelId,
                    content: prefix + "x".repeat(messageCodeUnits - prefix.length),
                    author: {
                        id: (3_000_000_000_000_000_000n + BigInt(ordinal % 50)).toString(),
                        username: "SyntheticUser",
                        bot: false,
                    },
                }
            })
            offset += pageSize
            return Response.json(rows)
        })

        let scope
        let scopeClosed = false
        let effect
        let client
        let sampler
        let histogram
        let primaryError
        const configuration = {
            token: "synthetic-not-a-credential",
            cache: { messages: { maxEntries: retainedMessages, maxBytes } },
        }
        try {
            if (mode === "default") {
                const { createClient } = await import("@neontechspace/fluxerly")
                const created = createClient(configuration)
                assert.ok(created.isOk())
                client = created.value
            } else {
                effect = await import("effect")
                const { createClient } = await import("@neontechspace/fluxerly/effect")
                scope = effect.Scope.makeUnsafe()
                client = await effect.Effect.runPromise(createClient(configuration).pipe(effect.Scope.provide(scope)))
            }

            await gc()
            const baseline = process.memoryUsage()
            let peakHeap = baseline.heapUsed
            let peakRss = baseline.rss
            const sampleMemory = () => {
                const usage = process.memoryUsage()
                peakHeap = Math.max(peakHeap, usage.heapUsed)
                peakRss = Math.max(peakRss, usage.rss)
            }
            sampler = setInterval(sampleMemory, memorySamplingIntervalMs)
            sampler.unref()
            const run = (operation) =>
                mode === "default"
                    ? Promise.resolve(operation).then((result) => {
                          assert.ok(result.isOk())
                          return result.value
                      })
                    : effect.Effect.runPromise(operation)
            async function fill() {
                const references = []
                for (let page = 0; page < pages; page++) {
                    const messages = await run(client.messages.fetchHistory(channelId, { limit: pageSize }))
                    assert.equal(messages.length, pageSize)
                    for (const message of messages) {
                        assert.equal(message.content.length, messageCodeUnits)
                        assert.ok(Object.isFrozen(message) && Object.isFrozen(message.author))
                        references.push({ id: message.id, channelId })
                    }
                }
                return references
            }
            async function weakReference(reference) {
                const message = await run(client.messages.get(reference))
                assert.ok(message !== undefined && Object.isFrozen(message))
                return new WeakRef(message)
            }
            async function defaultLookups(references) {
                let total = 0
                for (let round = 0; round < lookupRounds; round++) {
                    for (const reference of references) {
                        const result = client.messages.get(reference)
                        assert.ok(result.isOk() && result.value !== undefined)
                        total += result.value.content.length
                    }
                    await turn()
                }
                return total
            }
            async function effectLookups(references) {
                return effect.Effect.runPromise(
                    effect.Effect.gen(function* () {
                        let total = 0
                        for (let round = 0; round < lookupRounds; round++) {
                            for (const reference of references) {
                                const message = yield* client.messages.get(reference)
                                assert.ok(message !== undefined)
                                total += message.content.length
                            }
                            yield* effect.Effect.promise(() => turn())
                        }
                        return total
                    }),
                )
            }
            const fillStarted = performance.now()
            const references = await fill()
            const fillWallMs = performance.now() - fillStarted
            assert.equal(references.length, retainedMessages)
            assert.equal(requests, pages)
            await gc()
            const retained = process.memoryUsage()
            sampleMemory()

            const weak = await weakReference(references[Math.floor(references.length / 2)])

            histogram = monitorEventLoopDelay({ resolution: 1 })
            histogram.enable()
            await sleep(25)
            histogram.reset()
            const lookupCpuStarted = process.cpuUsage()
            const lookupStarted = performance.now()
            const observedCodeUnits =
                mode === "default" ? await defaultLookups(references) : await effectLookups(references)
            const lookupWallMs = performance.now() - lookupStarted
            const lookupCpu = process.cpuUsage(lookupCpuStarted)
            histogram.disable()
            clearInterval(sampler)
            sampler = undefined
            sampleMemory()
            const lookupOperations = retainedMessages * lookupRounds
            assert.equal(observedCodeUnits, lookupOperations * messageCodeUnits)
            assert.equal(requests, pages)
            if (!smoke)
                assert.ok(
                    histogram.count >= minimumEventLoopSamples,
                    `Expected at least ${minimumEventLoopSamples} event-loop delay samples, received ${histogram.count}`,
                )
            const eventLoopDelaySamples = histogram.count
            const eventLoopDelayP50Ms = eventLoopDelaySamples === 0 ? 0 : histogram.percentile(50) / 1_000_000
            const eventLoopDelayP99Ms = eventLoopDelaySamples === 0 ? 0 : histogram.percentile(99) / 1_000_000
            const eventLoopDelayMaxMs = eventLoopDelaySamples === 0 ? 0 : histogram.max / 1_000_000

            if (mode === "default") assert.ok((await client.shutdown()).isOk())
            else {
                await effect.Effect.runPromise(client.shutdown())
                await effect.Effect.runPromise(effect.Scope.close(scope, effect.Exit.void))
                scopeClosed = true
            }
            assert.equal(client.state, "Closed")
            const cleanupStarted = performance.now()
            let released = false
            while (performance.now() - cleanupStarted < cleanupDeadlineMs) {
                await gc()
                if (weak.deref() === undefined) {
                    released = true
                    break
                }
                await sleep(10)
            }
            const cleanupMs = performance.now() - cleanupStarted
            assert.ok(released, "A cached public message remained strongly retained after client shutdown")
            const afterShutdown = process.memoryUsage()
            const lookupCpuUserMs = lookupCpu.user / 1_000
            const lookupCpuSystemMs = lookupCpu.system / 1_000
            console.log(
                JSON.stringify({
                    benchmark: "local-runtime",
                    scenario,
                    mode,
                    sample,
                    pages,
                    pageSize,
                    requests,
                    retainedMessages,
                    messageCodeUnits,
                    lookupRounds,
                    lookupOperations,
                    fillWallMs,
                    lookupWallMs,
                    lookupCpuUserMs,
                    lookupCpuSystemMs,
                    lookupCpuTotalMs: lookupCpuUserMs + lookupCpuSystemMs,
                    operationsPerSecond: (lookupOperations * 1_000) / lookupWallMs,
                    eventLoopDelayP50Ms,
                    eventLoopDelayP99Ms,
                    eventLoopDelayMaxMs,
                    eventLoopDelaySamples,
                    retainedHeapBytes: retained.heapUsed - baseline.heapUsed,
                    retainedRssBytes: retained.rss - baseline.rss,
                    sampledPeakHeapBytes: peakHeap - baseline.heapUsed,
                    sampledPeakRssBytes: peakRss - baseline.rss,
                    postShutdownHeapDeltaBytes: afterShutdown.heapUsed - baseline.heapUsed,
                    postShutdownRssDeltaBytes: afterShutdown.rss - baseline.rss,
                    cleanupMs,
                    weakReferenceReleased: released,
                    correctness: true,
                }),
            )
        } catch (error) {
            primaryError = error
            throw error
        } finally {
            if (sampler !== undefined) clearInterval(sampler)
            histogram?.disable()
            let cleanupFailure
            if (client?.state !== undefined && client.state !== "Closed") {
                try {
                    if (mode === "default") {
                        const shutdown = await client.shutdown()
                        assert.ok(shutdown.isOk(), "Default client cleanup failed")
                        assert.equal(client.state, "Closed")
                    } else await effect.Effect.runPromise(client.shutdown())
                } catch (cleanupError) {
                    cleanupFailure = cleanupError
                }
            }
            if (mode === "effect" && scope !== undefined && !scopeClosed) {
                try {
                    await effect.Effect.runPromise(effect.Scope.close(scope, effect.Exit.void))
                    scopeClosed = true
                } catch (cleanupError) {
                    cleanupFailure ??= cleanupError
                }
            }
            globalThis.fetch = originalFetch
            if (primaryError === undefined && cleanupFailure !== undefined) throw cleanupFailure
        }
    }
}
