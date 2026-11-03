// The opt-in pace calibration behind calibrate-pace.js, and the stored result that run-all.js --calibrated-pace reads.
// Fluxer's front door limits all traffic from one address with a threshold and window it does not publish, so the
// live pacer keeps a measured safe pace: 80 request starts a minute, with no burst. A calibration measures a higher one
// without guessing: It sends read-only requests at a fixed spacing, raises the rate one small step at a time and holds
// each step for two minutes, so every step covers a whole minute window at least twice. It stops at the first 429 of
// any kind, after which every sender pauses as live-pacing.js requires, and stores a rate below the highest step that
// finished without one. Nothing here runs unless a person starts calibrate-pace.js with its process-only opt-in
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultIntervalMs } from "./live-pacing.js"
import { stateRoot } from "./state-root.js"

const sdkRoot = fileURLToPath(stateRoot)
/** The stored calibration. It is ignored by Git like every other `.env.test.*` file and never holds credentials */
export const calibrationPath = join(sdkRoot, ".env.test.pace-calibration.json")
/** A calibration older than this no longer describes the front door, so run-all.js refuses to use it */
export const calibrationMaxAgeMs = 14 * 24 * 60 * 60 * 1_000
/** Share of the highest clean rate that the stored pace uses */
export const safetyShare = 0.8
/** The default ramp: From today's pace up in steps of 10 a minute, each held for two minutes, up to 160 a minute */
export const defaultPlan = Object.freeze({
    startPerMinute: Math.round(60_000 / defaultIntervalMs),
    stepPerMinute: 10,
    ceilingPerMinute: 160,
    stepMs: 120_000,
})

/** The steps of a ramp, each with its rate, its spacing and the number of requests that fill its duration */
export function calibrationSteps(plan = defaultPlan) {
    const { startPerMinute, stepPerMinute, ceilingPerMinute, stepMs } = plan
    if (
        ![startPerMinute, stepPerMinute, ceilingPerMinute, stepMs].every((value) => Number.isFinite(value) && value > 0)
    )
        throw new Error("Every calibration setting must be a positive number")
    if (ceilingPerMinute < startPerMinute) throw new Error("The calibration ceiling is below its start")
    const steps = []
    for (let perMinute = startPerMinute; perMinute <= ceilingPerMinute; perMinute += stepPerMinute) {
        const intervalMs = Math.ceil(60_000 / perMinute)
        steps.push({ perMinute, intervalMs, requests: Math.ceil(stepMs / intervalMs) })
    }
    return steps
}

/**
 * Whether a 429 came from the front door rather than a route bucket: The front door answers in plain text without
 * bucket headers, while route limits answer with JSON and `x-ratelimit-bucket`
 */
export function frontDoorLimit(response) {
    return !response.headers.has("x-ratelimit-bucket") && !/json/i.test(response.headers.get("content-type") ?? "")
}

/**
 * Runs the ramp. `send(index)` sends the request with that running index through a pacer with the step's spacing, which
 * `pacerFor(intervalMs)` selects before each step, and resolves its Response. The ramp stops at the first 429 and
 * sends nothing after it. Resolves the highest step that finished cleanly, the step that met the 429 and its kind
 */
export async function runCalibration({ send, pacerFor, plan = defaultPlan, onStep = () => {} }) {
    let cleanPerMinute
    let index = 0
    for (const step of calibrationSteps(plan)) {
        pacerFor(step.intervalMs)
        onStep(step)
        for (let request = 0; request < step.requests; request++) {
            const response = await send(index++)
            await response.body?.cancel()
            if (response.status === 429)
                return {
                    cleanPerMinute,
                    limitedAtPerMinute: step.perMinute,
                    limitedBy: frontDoorLimit(response) ? "front door" : "route",
                    requests: index,
                }
        }
        cleanPerMinute = step.perMinute
    }
    return { cleanPerMinute, limitedAtPerMinute: undefined, limitedBy: undefined, requests: index }
}

/**
 * The stored pace for a ramp result: `safetyShare` of the highest clean rate. When even the first step met a 429, the
 * clean rate is taken as one step below it, so the stored pace is slower than the one that was limited
 */
export function safePace(result, plan = defaultPlan) {
    const clean = result.cleanPerMinute ?? result.limitedAtPerMinute - plan.stepPerMinute
    const perMinute = Math.max(1, Math.floor(clean * safetyShare))
    return { safePerMinute: perMinute, safeIntervalMs: Math.ceil(60_000 / perMinute) }
}

/** Stores a ramp result with its time, plan and safe pace. The record holds rates and times only */
export function storeCalibration(result, { plan = defaultPlan, now = Date.now(), path = calibrationPath } = {}) {
    const record = {
        measuredAt: new Date(now).toISOString(),
        plan,
        cleanPerMinute: result.cleanPerMinute ?? null,
        limitedAtPerMinute: result.limitedAtPerMinute ?? null,
        limitedBy: result.limitedBy ?? null,
        requests: result.requests,
        ...safePace(result, plan),
    }
    writeFileSync(path, `${JSON.stringify(record, null, 4)}\n`)
    return record
}

/**
 * The pace interval of a stored calibration, for run-all.js --calibrated-pace. A missing, unreadable or stale record
 * throws, so a run never speeds up on old or guessed evidence
 */
export function calibratedIntervalMs({ path = calibrationPath, now = Date.now() } = {}) {
    let record
    try {
        record = JSON.parse(readFileSync(path, "utf8"))
    } catch {
        throw new Error("No stored pace calibration. Run the calibration first, see the live check guide")
    }
    const measured = Date.parse(record?.measuredAt)
    if (!Number.isFinite(measured) || !Number.isSafeInteger(record?.safeIntervalMs) || record.safeIntervalMs <= 0)
        throw new Error("The stored pace calibration is unreadable. Run the calibration again")
    if (now - measured > calibrationMaxAgeMs)
        throw new Error("The stored pace calibration is older than 14 days. Run the calibration again")
    return record.safeIntervalMs
}
