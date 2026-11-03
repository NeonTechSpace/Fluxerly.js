import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { commandTimeoutMs } from "./run-all.js"
import { checkClasses } from "./support/check-classes.js"
import { createPacer, defaultIntervalMs, maximumPauseWaitMs } from "./support/live-pacing.js"
import {
    contentionFactor,
    discoveryRedirects,
    harnessWatchdogMs,
    harnessWatchdogs,
    pacedWatchdogMs,
    reservationsPerProcess,
    runnerMarginMs,
    watchdogEntry,
} from "./support/watchdogs.js"

const liveDirectory = new URL("./", import.meta.url)
const parent = realpathSync(tmpdir())
const roots = []
afterEach(() => {
    for (const root of roots.splice(0)) {
        expect(dirname(root)).toBe(parent)
        rmSync(root, { recursive: true })
    }
})

/**
 * Harness files with a module-level process watchdog: a timer at the top of the file that reports and exits the
 * process. The source from the timer to its unref() call is returned with each file
 */
const watchdogHarnesses = readdirSync(liveDirectory)
    .filter((file) => /\.m?js$/.test(file) && !file.includes(".test."))
    .flatMap((file) => {
        const source = readFileSync(new URL(file, liveDirectory), "utf8")
        const start = source.search(/^(?:const watchdog = )?setTimeout\(/m)
        if (start === -1) return []
        const timer = source.slice(start, source.indexOf("unref()", start))
        return timer.includes("process.exit") ? [{ file, timer, source }] : []
    })
    .sort((left, right) => left.file.localeCompare(right.file))

const entries = Object.entries(harnessWatchdogs).flatMap(([harness, scenarios]) =>
    Object.entries(scenarios).map(([scenario, entry]) => ({ harness, scenario, entry })),
)

/**
 * The time sequential requests of one sender spend waiting for paced slots in the worst case, after each request up to
 * `requests`: Before each of its requests, every other process of the run holds its full share of reserved slots. The
 * controlled clock moves only through the pacer's waits, and responses are immediate, so only pacing is measured.
 * Each request starts from the state the earlier ones left, so a scenario with fewer requests reads its time at its
 * own count instead of rerunning the shared pacer's file transactions
 */
async function worstPacedTimesMs(requests, concurrency) {
    const root = mkdtempSync(join(parent, "fluxerly-live-watchdog-"))
    roots.push(root)
    let now = 0
    const options = { statePath: join(root, "pace.json"), now: () => now, lockWaitMs: 0 }
    const ours = createPacer({ ...options, sleep: async (milliseconds) => void (now += milliseconds) })
    // Other processes reserve their slots without waiting here, which pushes ours back as far as they can
    const others = createPacer({ ...options, sleep: async () => {} })
    const after = [now]
    for (let request = 0; request < requests; request++) {
        for (let held = 0; held < (concurrency - 1) * reservationsPerProcess; held++) await others.admit()
        await ours.admit()
        after.push(now)
    }
    return after
}

test("every harness with a process watchdog sizes it from the pacing table instead of a fixed time", () => {
    expect(watchdogHarnesses.map(({ file }) => file)).toEqual(Object.keys(harnessWatchdogs).sort())
    for (const { file, timer, source } of watchdogHarnesses)
        if (timer.endsWith("watchdogMs).") && !/harnessWatchdogMs\(\)\s*,?\s*\)\.$/.test(timer))
            // webhooks.js lets a local check shorten its sized watchdog, never extend it
            expect(source, file).toContain("const sizedWatchdogMs = harnessWatchdogMs()")
        else expect(timer, file).toMatch(/harnessWatchdogMs\(\)\s*,?\s*\)\.$/)
})

test("every declared scenario of those harnesses has a sized watchdog, so none starts unsized", () => {
    for (const { file: harness } of watchdogHarnesses)
        for (const scenario of Object.keys(checkClasses[harness]))
            expect(
                watchdogEntry(harness, ["default", ...scenario.split(" ").filter(Boolean)]),
                `${harness} ${scenario}`,
            ).toBeDefined()
    expect(() => harnessWatchdogMs("sdk.js", ["default", "--unknown"])).toThrow(/no sized watchdog/)
})

test.each([1, 2, 4])("pacing alone cannot trip any watchdog with %i checks running together", async (concurrency) => {
    const requestCount = (entry) => entry.requests + entry.clients * discoveryRedirects
    const pacedAfter = await worstPacedTimesMs(
        Math.max(...entries.map(({ entry }) => requestCount(entry))),
        concurrency,
    )
    for (const { harness, scenario, entry } of entries) {
        const paced = pacedAfter[requestCount(entry)]
        const watchdog = pacedWatchdogMs(entry, { intervalMs: defaultIntervalMs, concurrency })
        // The harness keeps its whole base time for event waits and latency, and a longest pause still fits
        expect(watchdog - entry.baseMs - maximumPauseWaitMs, `${harness} ${scenario}`).toBeGreaterThanOrEqual(paced)
    }
})

test("a slower configured pace lengthens every watchdog", () => {
    for (const { entry } of entries)
        expect(pacedWatchdogMs(entry, { intervalMs: 4_000 })).toBeGreaterThan(
            pacedWatchdogMs(entry, { intervalMs: defaultIntervalMs }),
        )
})

test.each([1, 4])("run-all gives every harness more time than its own watchdog at concurrency %i", (concurrency) => {
    for (const { harness, scenario, entry } of entries) {
        const args = ["default", ...scenario.split(" ").filter(Boolean)]
        // Even a one-minute --timeout-minutes cannot stop a harness before its own watchdog and margin
        expect(commandTimeoutMs({ harness, args }, 60_000, concurrency), `${harness} ${scenario}`).toBe(
            Math.max(60_000 * contentionFactor(concurrency), pacedWatchdogMs(entry, { concurrency }) + runnerMarginMs),
        )
        expect(commandTimeoutMs({ harness, args }, 60_000, concurrency)).toBeGreaterThan(
            pacedWatchdogMs(entry, { concurrency }),
        )
        // A longer --timeout-minutes still applies
        expect(commandTimeoutMs({ harness, args }, 3_600_000, concurrency)).toBe(
            Math.max(
                3_600_000 * contentionFactor(concurrency),
                pacedWatchdogMs(entry, { concurrency }) + runnerMarginMs,
            ),
        )
    }
    // A harness without a process watchdog keeps the runner timeout, scaled for checks that run together
    expect(commandTimeoutMs({ harness: "threads.js", args: ["default"] }, 1_500_000, concurrency)).toBe(
        1_500_000 * contentionFactor(concurrency),
    )
})
