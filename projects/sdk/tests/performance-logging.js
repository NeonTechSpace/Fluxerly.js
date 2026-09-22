import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { withHostedDiscovery } from "./hosted-discovery.mjs"

const script = fileURLToPath(import.meta.url)
const sdkRoot = fileURLToPath(new URL("..", import.meta.url))
const child = process.argv.includes("--child")
const smoke = process.argv.includes("--smoke")
const modes = ["default", "effect"]
const variants = ["omitted", "configured-disabled", "measurements-enabled"]
const samples = smoke ? 1 : 7
const warmupOperations = smoke ? 3 : 1_000
const measuredOperations = smoke ? 12 : 12_000
const maximumRelativeMad = 0.1
const minimumMedianCpuMs = 100
const minimumNoiseBand = 0.01
// A successful JSON REST exchange emits each of these stages once in src/internal/rest.ts
const expectedMeasurementStages = ["queue", "network", "decode"]

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

function relativeMad(values) {
    const center = median(values)
    if (center === 0) return null
    return median(values.map((value) => Math.abs(value - center))) / Math.abs(center)
}

function summary(rows, field) {
    const values = rows.map((row) => row[field])
    return {
        median: median(values),
        p95: percentile(values, 0.95),
        relativeMad: relativeMad(values),
        raw: values,
    }
}

function comparison(rows, baseline, candidate, field) {
    const baselineRows = rows.filter((row) => row.variant === baseline)
    const candidateRows = rows.filter((row) => row.variant === candidate)
    assert.equal(baselineRows.length, samples)
    assert.equal(candidateRows.length, samples)
    const baselineSummary = summary(baselineRows, field)
    const candidateSummary = summary(candidateRows, field)
    const ratios = Array.from({ length: samples }, (_, index) => {
        const left = baselineRows.find((row) => row.sample === index + 1)
        const right = candidateRows.find((row) => row.sample === index + 1)
        assert.ok(left && right)
        return left[field] === 0 ? null : right[field] / left[field]
    })
    const numericRatios = ratios.filter((ratio) => ratio !== null)
    const ratio = numericRatios.length === samples ? median(numericRatios) : null
    const stabilityAvailable = baselineSummary.relativeMad !== null && candidateSummary.relativeMad !== null
    const noiseBand = stabilityAvailable
        ? Math.max(minimumNoiseBand, 3 * Math.max(baselineSummary.relativeMad, candidateSummary.relativeMad))
        : null
    const quality = smoke
        ? "smoke-only"
        : !stabilityAvailable || ratio === null
          ? "inconclusive-resolution"
          : baselineSummary.relativeMad > maximumRelativeMad || candidateSummary.relativeMad > maximumRelativeMad
            ? "inconclusive-noise"
            : field === "cpuTotalMs" && Math.min(baselineSummary.median, candidateSummary.median) < minimumMedianCpuMs
              ? "inconclusive-duration"
              : Math.abs(ratio - 1) <= noiseBand
                ? "within-noise"
                : ratio > 1
                  ? "observed-slower"
                  : "observed-faster"
    return {
        baseline,
        candidate,
        metric: field,
        medianRatio: ratio,
        medianOverheadPercent: ratio === null ? null : (ratio - 1) * 100,
        pairedRatios: ratios,
        noiseBand,
        quality,
    }
}

if (!child) {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true })
    assert.equal(commit.status, 0, commit.stderr)
    console.log(
        JSON.stringify({
            kind: "provenance",
            benchmark: "logging-overhead",
            schemaVersion: 1,
            smoke,
            ...environmentProvenance(commit.stdout.trim()),
            samples,
            warmupOperations,
            measuredOperations,
            variants,
            expectedMeasurementStages,
            acceptance: {
                correctness:
                    "exact timed requests, results, lifecycle closure, and one queue/network/decode record per enabled warm-up and timed operation",
                maximumRelativeMad,
                minimumMedianCpuMs,
                signalBand: "max(1%, 3 * largest relative MAD)",
                sink: "A counting structured sink validates cardinality and is otherwise side-effect free",
                note: "Performance classifications are descriptive and are not a CI or product-speed gate",
            },
        }),
    )

    const rows = []
    for (let sample = 1; sample <= samples; sample++) {
        const rotated = variants
            .slice((sample - 1) % variants.length)
            .concat(variants.slice(0, (sample - 1) % variants.length))
        for (const mode of modes)
            for (const variant of rotated) {
                const result = spawnSync(
                    process.execPath,
                    [script, "--child", mode, variant, String(sample), ...(smoke ? ["--smoke"] : [])],
                    {
                        encoding: "utf8",
                        timeout: 120_000,
                        windowsHide: true,
                    },
                )
                assert.equal(result.error, undefined)
                assert.equal(result.status, 0, result.stderr)
                const row = JSON.parse(result.stdout)
                rows.push(row)
                console.log(JSON.stringify({ kind: "sample", ...row }))
            }
    }

    for (const mode of modes) {
        const modeRows = rows.filter((row) => row.mode === mode)
        for (const variant of variants) {
            const variantRows = modeRows.filter((row) => row.variant === variant)
            assert.equal(variantRows.length, samples)
            console.log(
                JSON.stringify({
                    kind: "summary",
                    benchmark: "logging-overhead",
                    mode,
                    variant,
                    wallMs: summary(variantRows, "wallMs"),
                    cpuTotalMs: summary(variantRows, "cpuTotalMs"),
                    operationsPerSecond: summary(variantRows, "operationsPerSecond"),
                }),
            )
        }
        for (const [baseline, candidate] of [
            ["omitted", "configured-disabled"],
            ["configured-disabled", "measurements-enabled"],
        ])
            for (const metric of ["wallMs", "cpuTotalMs"])
                console.log(
                    JSON.stringify({
                        kind: "comparison",
                        benchmark: "logging-overhead",
                        mode,
                        ...comparison(modeRows, baseline, candidate, metric),
                    }),
                )
    }
} else {
    const childIndex = process.argv.indexOf("--child")
    const mode = process.argv[childIndex + 1]
    const variant = process.argv[childIndex + 2]
    const sample = Number(process.argv[childIndex + 3])
    assert.ok(modes.includes(mode))
    assert.ok(variants.includes(variant))
    assert.ok(Number.isSafeInteger(sample) && sample >= 1 && sample <= samples)

    const channelId = "1000000000000000000"
    let requests = 0
    let countRequests = false
    let sinkError
    let measurementRecords = 0
    let verifiedWarmupMeasurementRecords = 0
    let verifiedWarmupStageCounts
    const stageCounts = new Map(expectedMeasurementStages.map((stage) => [stage, 0]))
    const originalFetch = globalThis.fetch
    globalThis.fetch = withHostedDiscovery(async (input, init) => {
        const url = new URL(input)
        assert.equal(url.origin, "https://api.fluxer.app")
        assert.equal(url.pathname, `/v1/channels/${channelId}/messages/2000000000000000000`)
        assert.equal(init?.method, "GET")
        if (countRequests) requests++
        return Response.json({
            id: "2000000000000000000",
            channel_id: channelId,
            content: "deterministic logging benchmark payload",
            author: { id: "3000000000000000000", username: "fixture", bot: false },
        })
    })

    const observe = (record) => {
        measurementRecords++
        if (
            record?.category !== "measurement" ||
            record.operation !== "rest.request" ||
            record.outcome !== "success" ||
            !stageCounts.has(record.stage)
        ) {
            sinkError = `Unexpected measurement record ${JSON.stringify(record)}`
            return
        }
        stageCounts.set(record.stage, stageCounts.get(record.stage) + 1)
    }
    const configuration = (logger) => ({
        token: "synthetic-not-a-credential",
        ...(variant === "omitted"
            ? {}
            : {
                  logging: {
                      measurements: variant === "measurements-enabled",
                      ...(logger === undefined ? {} : { logger }),
                  },
              }),
    })
    const verify = (message) => {
        assert.equal(message.id, "2000000000000000000")
        assert.equal(message.channelId, channelId)
        assert.equal(message.content, "deterministic logging benchmark payload")
        assert.ok(Object.isFrozen(message) && Object.isFrozen(message.author))
    }
    const finishWarmup = () => {
        const expectedPerStage = variant === "measurements-enabled" ? warmupOperations : 0
        assert.equal(sinkError, undefined)
        for (const stage of expectedMeasurementStages) assert.equal(stageCounts.get(stage), expectedPerStage)
        assert.equal(measurementRecords, expectedPerStage * expectedMeasurementStages.length)
        verifiedWarmupMeasurementRecords = measurementRecords
        verifiedWarmupStageCounts = Object.fromEntries(stageCounts)
        measurementRecords = 0
        for (const stage of expectedMeasurementStages) stageCounts.set(stage, 0)
        countRequests = true
    }

    let defaultClient
    let primaryError
    try {
        let wallMs
        let cpu
        let state
        if (mode === "default") {
            const { createClient, fromStructuredLogger } = await import("@neontechspace/fluxerly")
            const created = createClient(configuration(fromStructuredLogger(observe)))
            assert.ok(created.isOk())
            const client = created.value
            defaultClient = client
            for (let index = 0; index < warmupOperations; index++) {
                const result = await client.messages.fetch({ id: "2000000000000000000", channelId })
                assert.ok(result.isOk())
                verify(result.value)
            }
            finishWarmup()
            const cpuStarted = process.cpuUsage()
            const started = performance.now()
            for (let index = 0; index < measuredOperations; index++) {
                const result = await client.messages.fetch({ id: "2000000000000000000", channelId })
                assert.ok(result.isOk())
                verify(result.value)
            }
            wallMs = performance.now() - started
            cpu = process.cpuUsage(cpuStarted)
            assert.ok((await client.shutdown()).isOk())
            state = client.state
        } else {
            const { Effect, Logger } = await import("effect")
            const { createClient } = await import("@neontechspace/fluxerly/effect")
            const logger = Logger.make((entry) => {
                const message = entry.message
                if (Array.isArray(message) && message[0] === "Fluxerly") observe(message[1])
            })
            const result = await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const client = yield* createClient(configuration())
                        for (let index = 0; index < warmupOperations; index++)
                            verify(yield* client.messages.fetch({ id: "2000000000000000000", channelId }))
                        finishWarmup()
                        const cpuStarted = process.cpuUsage()
                        const started = performance.now()
                        for (let index = 0; index < measuredOperations; index++)
                            verify(yield* client.messages.fetch({ id: "2000000000000000000", channelId }))
                        const elapsed = performance.now() - started
                        const used = process.cpuUsage(cpuStarted)
                        yield* client.shutdown()
                        return { elapsed, used, state: client.state }
                    }),
                ).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger]))),
            )
            wallMs = result.elapsed
            cpu = result.used
            state = result.state
        }

        assert.equal(state, "Closed")
        assert.equal(requests, measuredOperations)
        const expectedPerStage = variant === "measurements-enabled" ? measuredOperations : 0
        assert.equal(sinkError, undefined)
        for (const stage of expectedMeasurementStages) assert.equal(stageCounts.get(stage), expectedPerStage)
        assert.equal(measurementRecords, expectedPerStage * expectedMeasurementStages.length)
        const cpuUserMs = cpu.user / 1_000
        const cpuSystemMs = cpu.system / 1_000
        console.log(
            JSON.stringify({
                benchmark: "logging-overhead",
                mode,
                variant,
                sample,
                warmupOperations,
                measuredOperations,
                requests,
                verifiedWarmupMeasurementRecords,
                verifiedWarmupStageCounts,
                timedMeasurementRecords: measurementRecords,
                timedStageCounts: Object.fromEntries(stageCounts),
                wallMs,
                cpuUserMs,
                cpuSystemMs,
                cpuTotalMs: cpuUserMs + cpuSystemMs,
                operationsPerSecond: (measuredOperations * 1_000) / wallMs,
                correctness: true,
            }),
        )
    } catch (error) {
        primaryError = error
        throw error
    } finally {
        let cleanupFailure
        if (defaultClient?.state !== undefined && defaultClient.state !== "Closed") {
            try {
                const shutdown = await defaultClient.shutdown()
                assert.ok(shutdown.isOk(), "Default client cleanup failed")
                assert.equal(defaultClient.state, "Closed")
            } catch (cleanupError) {
                cleanupFailure = cleanupError
            }
        }
        globalThis.fetch = originalFetch
        if (primaryError === undefined && cleanupFailure !== undefined) throw cleanupFailure
    }
}
