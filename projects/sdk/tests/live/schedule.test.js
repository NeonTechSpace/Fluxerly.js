import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { liveChecks, runLanes, waitingChecks } from "./run-all.js"
import { createPacer, defaultIntervalMs } from "./support/live-pacing.js"
import { discoveryRedirects, pacedWatchdogMs, reservationsPerProcess, watchdogEntry } from "./support/watchdogs.js"

const parent = realpathSync(tmpdir())
const roots = []
afterEach(() => {
    for (const root of roots.splice(0)) {
        expect(dirname(root)).toBe(parent)
        rmSync(root, { recursive: true })
    }
})

const checks = liveChecks()
const releaseSelection = [...checks.values()].filter((check) => check.sdkWork)

test("the waiting list names SDK-work checks that run in the shared phase", () => {
    for (const name of waitingChecks) expect(checks.get(name)?.sdkWork, name).toBe(true)
    for (const name of waitingChecks) expect(checks.get(name).lockClass, name).not.toBe("shared-state")
})

test("the first lane takes the waiting checks first and the other lane the rest, each check once", async () => {
    const queue = releaseSelection.filter((check) => check.lockClass !== "shared-state")
    const lanes = [[], []]
    await runLanes([...queue], 2, {
        stopped: () => false,
        skip: () => expect.unreachable(),
        run: async (check, lane) => {
            lanes[lane].push(check.name)
            await new Promise((resolve) => setImmediate(resolve))
        },
    })
    expect([...lanes[0], ...lanes[1]].sort()).toEqual(queue.map((check) => check.name).sort())
    // The waiting checks start in their listed order, longest wait first, and the other lane starts none of them
    // while it still has other checks
    expect(lanes[0].slice(0, waitingChecks.length)).toEqual([...waitingChecks])
    expect(lanes[1].slice(0, 5).some((name) => waitingChecks.includes(name))).toBe(false)
})

test("a stopped run skips every check that has not started", async () => {
    const queue = releaseSelection.filter((check) => check.lockClass !== "shared-state")
    const ran = []
    const skipped = []
    await runLanes([...queue], 2, {
        stopped: () => ran.length >= 2,
        skip: (check) => skipped.push(check.name),
        run: async (check) => {
            ran.push(check.name)
            await new Promise((resolve) => setImmediate(resolve))
        },
    })
    expect(ran).toHaveLength(2)
    expect(skipped).toHaveLength(queue.length - 2)
})

/**
 * A virtual clock for many concurrent senders. `sleep` waits on it, and `drive` advances it to the earliest pending
 * sleep whenever every sender is waiting, so a whole run takes no host time and its timing is exact
 */
function virtualClock() {
    let now = 0
    const timers = []
    const sleep = (milliseconds) =>
        new Promise((resolve) => timers.push({ at: now + Math.max(0, milliseconds), resolve }))
    const settle = () => new Promise((resolve) => setImmediate(resolve))
    async function drive(work) {
        let done = false
        const result = work.finally(() => {
            done = true
        })
        while (!done) {
            await settle()
            if (done) break
            if (timers.length === 0) throw new Error("Every sender waits without a pending sleep")
            const at = Math.min(...timers.map((timer) => timer.at))
            now = Math.max(now, at)
            for (const timer of timers.filter((item) => item.at === at)) {
                timers.splice(timers.indexOf(timer), 1)
                timer.resolve()
            }
        }
        return result
    }
    return { now: () => now, sleep, drive }
}

/**
 * The worst case of one harness command for its sized watchdog: It spends its whole base time waiting, spread around
 * its requests, and sends every request its entry counts, discovery redirects included, in bursts of as many as one
 * process can hold reserved at once. Commands without a watchdog, which keep the runner timeout, wait a minute around
 * ten requests
 */
function commandModel({ harness, args }) {
    const entry = watchdogEntry(harness, args) ?? { baseMs: 60_000, requests: 10, clients: 0 }
    return { entry, requests: entry.requests + entry.clients * discoveryRedirects, sized: watchdogEntry(harness, args) }
}

test("the release run's two-lane schedule keeps the pace budget and fits every watchdog on a virtual clock", async () => {
    const root = mkdtempSync(join(parent, "fluxerly-live-schedule-"))
    roots.push(root)
    const clock = virtualClock()
    const intervalMs = defaultIntervalMs
    const pacer = createPacer({
        statePath: join(root, ".env.test.pace.json"),
        intervalMs,
        now: clock.now,
        sleep: clock.sleep,
        lockWaitMs: 0,
    })
    const starts = []
    const overruns = []
    let commands = 0

    async function runCommand(command, concurrency) {
        const { entry, requests, sized } = commandModel(command)
        const bursts = Math.ceil(requests / reservationsPerProcess)
        const gapMs = entry.baseMs / (bursts + 1)
        const began = clock.now()
        for (let sent = 0; sent < requests; sent += reservationsPerProcess) {
            await clock.sleep(gapMs)
            const burst = Math.min(reservationsPerProcess, requests - sent)
            await Promise.all(
                Array.from({ length: burst }, async () => {
                    await pacer.admit()
                    starts.push(clock.now())
                }),
            )
        }
        await clock.sleep(gapMs)
        const elapsed = clock.now() - began
        commands++
        // A harness without its own watchdog is bounded by the runner's 25-minute default, scaled for the lanes
        const limit = sized ? pacedWatchdogMs(entry, { intervalMs, concurrency }) : 25 * 60_000
        if (elapsed >= limit) overruns.push({ command: [command.harness, ...command.args].join(" "), elapsed, limit })
    }
    const runCheck = async (check, concurrency) => {
        for (const command of check.commands) await runCommand(command, concurrency)
    }

    await clock.drive(
        (async () => {
            for (const check of releaseSelection.filter((item) => item.lockClass === "shared-state"))
                await runCheck(check, 1)
            await runLanes(
                releaseSelection.filter((check) => check.lockClass !== "shared-state"),
                2,
                { stopped: () => false, skip: () => {}, run: (check) => runCheck(check, 2) },
            )
        })(),
    )

    expect(commands).toBe(releaseSelection.reduce((sum, check) => sum + check.commands.length, 0))
    expect(overruns).toEqual([])
    starts.sort((left, right) => left - right)
    expect(starts.length).toBeGreaterThan(2_000)
    // Every request start keeps the interval from the one before it, so no burst ever leaves the pacer
    for (let index = 1; index < starts.length; index++)
        expect(starts[index] - starts[index - 1]).toBeGreaterThanOrEqual(intervalMs)
    // No minute window, wherever it starts, holds more than 80 request starts
    let windowStart = 0
    let busiest = 0
    for (let index = 0; index < starts.length; index++) {
        while (starts[index] - starts[windowStart] >= 60_000) windowStart++
        busiest = Math.max(busiest, index - windowStart + 1)
    }
    expect(busiest).toBeLessThanOrEqual(60_000 / intervalMs)
}, 120_000)
