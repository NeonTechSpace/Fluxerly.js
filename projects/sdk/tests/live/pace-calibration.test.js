import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { createPacer, pacedFetch, readState } from "./support/live-pacing.js"
import {
    calibratedIntervalMs,
    calibrationMaxAgeMs,
    calibrationSteps,
    defaultPlan,
    runCalibration,
    safePace,
    storeCalibration,
} from "./support/pace-calibration.js"

const parent = realpathSync(tmpdir())
const roots = []
afterEach(() => {
    for (const root of roots.splice(0)) {
        expect(dirname(root)).toBe(parent)
        rmSync(root, { recursive: true })
    }
})

function folder() {
    const root = mkdtempSync(join(parent, "fluxerly-live-calibration-"))
    roots.push(root)
    return root
}

const small = { startPerMinute: 80, stepPerMinute: 20, ceilingPerMinute: 120, stepMs: 6_000 }

/** A calibration over a fake transport and the real pacer on a controlled clock. `limitAt` answers that request with 429 */
async function calibrate(plan, { limitAt, frontDoor = true } = {}) {
    const root = folder()
    let now = 0
    const starts = []
    let fetch
    const transport = async () => {
        starts.push(now)
        if (starts.length - 1 === limitAt)
            return frontDoor
                ? new Response("429 - Ratelimited", { status: 429, headers: { "retry-after": "5" } })
                : Response.json(
                      { retry_after: 1 },
                      { status: 429, headers: { "retry-after": "1", "x-ratelimit-bucket": "fixture" } },
                  )
        return Response.json({})
    }
    const statePath = join(root, ".env.test.pace.json")
    const result = await runCalibration({
        plan,
        pacerFor: (intervalMs) => {
            const pacer = createPacer({
                statePath,
                intervalMs,
                now: () => now,
                sleep: async (milliseconds) => void (now += milliseconds),
                lockWaitMs: 0,
            })
            fetch = pacedFetch(transport, pacer)
        },
        send: () => fetch("https://fluxer.com/api/v1/users/@me"),
    })
    return { result, starts, state: readState(statePath) }
}

test("the default ramp starts at today's pace and rises in small steps that each cover two minutes", () => {
    const steps = calibrationSteps(defaultPlan)
    expect(steps.map((step) => step.perMinute)).toEqual([80, 90, 100, 110, 120, 130, 140, 150, 160])
    expect(steps[0]).toEqual({ perMinute: 80, intervalMs: 750, requests: 160 })
    for (const step of steps) expect(step.requests * step.intervalMs).toBeGreaterThanOrEqual(defaultPlan.stepMs)
})

test("a clean ramp keeps each step's spacing and stores a pace below its highest step", async () => {
    const { result, starts } = await calibrate(small)
    expect(result).toEqual({ cleanPerMinute: 120, limitedAtPerMinute: undefined, limitedBy: undefined, requests: 30 })
    const steps = calibrationSteps(small)
    let index = 0
    for (const step of steps)
        for (let request = 0; request < step.requests; request++, index++)
            if (index > 0) expect(starts[index] - starts[index - 1]).toBeGreaterThanOrEqual(step.intervalMs)
    expect(safePace(result, small)).toEqual({ safePerMinute: 96, safeIntervalMs: 625 })
})

// Catches: A calibration that kept probing after Fluxer refused a request, or stored the refused rate as safe
test("the ramp stops at the first 429, sends nothing after it and pauses every sender", async () => {
    const { result, starts, state } = await calibrate(small, { limitAt: 12 })
    expect(starts).toHaveLength(13)
    expect(result).toEqual({ cleanPerMinute: 80, limitedAtPerMinute: 100, limitedBy: "front door", requests: 13 })
    expect(state.throttled).toMatchObject({ waitMs: 5_000 })
    expect(state.pausedUntil).toBeGreaterThan(starts.at(-1))
    expect(safePace(result, small)).toEqual({ safePerMinute: 64, safeIntervalMs: 938 })
})

test("a route 429 also stops the ramp and is reported as a route limit", async () => {
    const { result } = await calibrate(small, { limitAt: 0, frontDoor: false })
    expect(result).toMatchObject({ cleanPerMinute: undefined, limitedAtPerMinute: 80, limitedBy: "route" })
    // Even the first step was refused, so the stored pace is slower than today's
    expect(safePace(result, small).safeIntervalMs).toBeGreaterThan(750)
})

test("a stored calibration is used only while it is recent and readable", () => {
    const root = folder()
    const path = join(root, "calibration.json")
    expect(() => calibratedIntervalMs({ path })).toThrow(/No stored pace calibration/)
    const record = storeCalibration(
        { cleanPerMinute: 120, limitedAtPerMinute: 130, limitedBy: "front door", requests: 900 },
        { path, now: 1_000 },
    )
    expect(record).toMatchObject({ safePerMinute: 96, safeIntervalMs: 625, limitedBy: "front door" })
    expect(calibratedIntervalMs({ path, now: 1_000 + calibrationMaxAgeMs })).toBe(625)
    expect(() => calibratedIntervalMs({ path, now: 1_001 + calibrationMaxAgeMs })).toThrow(/older than 14 days/)
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), safeIntervalMs: "fast" }))
    expect(() => calibratedIntervalMs({ path, now: 1_000 })).toThrow(/unreadable/)
})
