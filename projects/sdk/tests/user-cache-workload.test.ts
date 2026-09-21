import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire, stripTypeScriptTypes } from "node:module"
import os from "node:os"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import type { User } from "../src/users.js"

type CacheInstance = {
    begin(...arguments_: unknown[]): unknown
    complete(...arguments_: unknown[]): void
    diagnostics(kind: "users"): {
        configured: boolean
        retainedEntries: number
        accountedBytes: number
        maxEntries: number | null
        maxBytes: number | null
    }
    close(): void
}
type CacheConstructor = new (
    settings: { users: { maxEntries: number; maxBytes: number; maxAgeMs: null } },
    now: () => number,
) => CacheInstance
type Variant = {
    label: "baseline" | "current"
    revision: string
    sourceSha256: string
    UserCache: CacheConstructor
}
type Sample = {
    wallMs: number
    cpuUserMicros: number
    cpuSystemMicros: number
    cpuTotalMicros: number
}

// Set FLUXERLY_USER_CACHE_WORKLOAD=1 only during an idle serial measurement window.
// Disable console interception to retain the raw JSON samples and environment record.
const workload = process.env.FLUXERLY_USER_CACHE_WORKLOAD === "1" ? test : test.skip
const baselineRef = process.env.FLUXERLY_USER_CACHE_BASELINE ?? "a11e78d"
const batchSizes = [250, 500, 1_000, 2_000, 4_000]
const warmups = 3
const samples = 11
const payload = "x".repeat(16)
const repository = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const sourcePath = resolve(repository, "projects/sdk/src/internal/user-cache.ts")
const git = (...arguments_: string[]) => execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim()
const digest = (source: string) => createHash("sha256").update(source).digest("hex")

async function loadVariant(label: Variant["label"], revision: string, source: string): Promise<Variant> {
    const output = stripTypeScriptTypes(source, { mode: "transform" })
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString("base64")}#${digest(source)}`
    const loaded = (await import(/* @vite-ignore */ moduleUrl)) as { UserCache: CacheConstructor }
    return { label, revision, sourceSha256: digest(source), UserCache: loaded.UserCache }
}

function execute(variant: Variant, values: readonly User[], expectedBytes: number) {
    const cache = new variant.UserCache(
        { users: { maxEntries: values.length, maxBytes: expectedBytes, maxAgeMs: null } },
        () => 0,
    )
    const cpuStarted = process.cpuUsage()
    const started = performance.now()
    if (variant.label === "baseline") {
        const generation = cache.begin("users", false)
        cache.complete("users", generation, values, true)
    } else cache.complete(cache.begin("users", { replace: true }), values)
    const wallMs = performance.now() - started
    const cpu = process.cpuUsage(cpuStarted)
    expect(cache.diagnostics("users")).toEqual({
        configured: true,
        retainedEntries: values.length,
        accountedBytes: expectedBytes,
        maxEntries: values.length,
        maxBytes: expectedBytes,
    })
    cache.close()
    expect(cache.diagnostics("users")).toEqual({
        configured: true,
        retainedEntries: 0,
        accountedBytes: 0,
        maxEntries: values.length,
        maxBytes: expectedBytes,
    })
    return {
        wallMs,
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        cpuTotalMicros: cpu.user + cpu.system,
    }
}

function summary(values: readonly number[]) {
    const ordered = [...values].sort((left, right) => left - right)
    return {
        median: ordered[Math.floor(ordered.length / 2)]!,
        p95: ordered[Math.ceil(ordered.length * 0.95) - 1]!,
    }
}

function distribution(raw: readonly Sample[]) {
    return {
        raw,
        wallMs: summary(raw.map((sample) => sample.wallMs)),
        cpuMicros: {
            user: summary(raw.map((sample) => sample.cpuUserMicros)),
            system: summary(raw.map((sample) => sample.cpuSystemMicros)),
            total: summary(raw.map((sample) => sample.cpuTotalMicros)),
        },
    }
}

const ratio = (baseline: number, current: number) => (current === 0 ? null : baseline / current)

workload(
    "compares original and incremental user-cache batch accounting without making heap or cross-SDK claims",
    async () => {
        const baselineRevision = git("rev-parse", baselineRef)
        const currentRevision = git("rev-parse", "HEAD")
        const [baseline, current] = await Promise.all([
            loadVariant(
                "baseline",
                baselineRevision,
                git("show", `${baselineRevision}:projects/sdk/src/internal/user-cache.ts`),
            ),
            loadVariant("current", currentRevision, readFileSync(sourcePath, "utf8")),
        ])
        const require = createRequire(import.meta.url)
        const packageVersion = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version
        console.log(
            JSON.stringify({
                check: "user_cache_batch_accounting_environment",
                decision: "whether incremental accounting removes the prior batch-size scaling defect",
                metrics: [
                    "UserCache complete wall time in milliseconds",
                    "process CPU consumed during complete in microseconds",
                ],
                warmups,
                samples,
                batchSizes,
                threshold: {
                    correctness:
                        "every sample retains exactly the input count and serialized-byte total, then reports zero retained entries and bytes after close",
                    performance: null,
                    note: "performance is descriptive",
                },
                limitations: [
                    "no heap-allocation measurement",
                    "no RSS measurement",
                    "no event-loop delay measurement",
                    "no live Fluxer workload",
                    "no cross-SDK comparison",
                ],
                execution: "baseline and current alternate first position for each measured sample",
                transform: "node:module.stripTypeScriptTypes mode=transform",
                runtime: {
                    node: process.version,
                    v8: process.versions.v8,
                    platform: process.platform,
                    release: os.release(),
                    architecture: process.arch,
                    cpu: os.cpus()[0]?.model ?? null,
                    logicalCpus: os.cpus().length,
                },
                dependencies: {
                    sdk: packageVersion(resolve(repository, "projects/sdk/package.json")),
                    vitest: packageVersion(require.resolve("vitest/package.json")),
                },
                variants: [
                    { label: baseline.label, revision: baseline.revision, sourceSha256: baseline.sourceSha256 },
                    {
                        label: current.label,
                        revision: current.revision,
                        sourceSha256: current.sourceSha256,
                        sourceDirty:
                            git("status", "--porcelain", "--", "projects/sdk/src/internal/user-cache.ts") !== "",
                    },
                ],
            }),
        )

        for (const size of batchSizes) {
            const values: readonly User[] = Array.from({ length: size }, (_, index) =>
                Object.freeze({
                    id: String(index + 1),
                    username: `${String(index).padStart(8, "0")}_${payload}`,
                    discriminator: "0001",
                    displayName: null,
                    avatar: null,
                    avatarColor: null,
                    isBot: false,
                    isSystem: false,
                    flags: 0,
                }),
            )
            const expectedBytes = values.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0)
            for (let warmup = 0; warmup < warmups; warmup++) {
                execute(baseline, values, expectedBytes)
                execute(current, values, expectedBytes)
            }
            const raw = { baseline: [] as Sample[], current: [] as Sample[] }
            for (let sample = 0; sample < samples; sample++) {
                const order = sample % 2 === 0 ? [current, baseline] : [baseline, current]
                for (const variant of order) raw[variant.label].push(execute(variant, values, expectedBytes))
            }
            const baselineResult = distribution(raw.baseline)
            const currentResult = distribution(raw.current)
            console.log(
                JSON.stringify({
                    check: "user_cache_batch_accounting_comparison",
                    size,
                    serializedBytes: expectedBytes,
                    baseline: baselineResult,
                    current: currentResult,
                    baselineToCurrentWallMedianRatio: ratio(baselineResult.wallMs.median, currentResult.wallMs.median),
                    baselineToCurrentCpuMedianRatio: ratio(
                        baselineResult.cpuMicros.total.median,
                        currentResult.cpuMicros.total.median,
                    ),
                }),
            )
        }
    },
    120_000,
)
