// Opt-in calibration of the live request pace. Run it only when a maintainer decides to measure a faster pace, with
// FLUXERLY_LIVE_CALIBRATE=1 in the process environment. The env file never authorizes it. It holds the exclusive
// sandbox lock, verifies bot, application and server identity, then sends only read-only requests: It rotates over
// five reads the live checks already make, starts at today's pace and raises the rate in small steps held for two
// minutes each, as support/pace-calibration.js describes. It stops at the first 429 and pauses every live sender for at
// least its Retry-After, then stores a pace below the highest clean step in .env.test.pace-calibration.json. A run uses
// that pace only when started with run-all.js --calibrated-pace. Creates no journal and changes no server content.
// Optional process-only FLUXERLY_LIVE_CALIBRATE_CEILING sets the highest rate tried, 160 a minute by default
import {
    HarnessCheckError,
    acquireLock,
    loadSandboxEnvironment,
    processAuthorized,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createPacer, defaultStatePath, installLivePacing, pacedFetch } from "./support/live-pacing.js"
import { defaultPlan, runCalibration, storeCalibration } from "./support/pace-calibration.js"
import { createReporter } from "./support/reporting.js"
import { readSandbox } from "./support/sandbox-api.js"

const report = createReporter({})
const ceiling = Number(process.env.FLUXERLY_LIVE_CALIBRATE_CEILING ?? defaultPlan.ceilingPerMinute)
const plan = { ...defaultPlan, ceilingPerMinute: ceiling }

let lock
let stage = "configuration"
try {
    if (!processAuthorized("FLUXERLY_LIVE_CALIBRATE"))
        throw new HarnessCheckError("configuration", "Set FLUXERLY_LIVE_CALIBRATE=1 to run the pace calibration")
    if (!Number.isSafeInteger(ceiling) || ceiling < defaultPlan.startPerMinute)
        throw new HarnessCheckError(
            "configuration",
            "FLUXERLY_LIVE_CALIBRATE_CEILING must be a whole rate of 80 or more",
        )
    const { guildId, applicationId, token } = loadSandboxEnvironment({ requireApplicationToken: true })
    stage = "sandbox_lock"
    lock = acquireLock()
    stage = "sandbox_identity"
    await verifySandboxIdentity((path) => readSandbox(path, token), { applicationId, guildId })
    report(stage, { passed: true })

    stage = "pace_calibration"
    // The base fetch under the shared pacing layer. Each step swaps in a pacer with its own spacing on the same state
    // file, so the spacing carries from the identity reads and into the next run
    const { base } = installLivePacing()
    let fetch
    const paths = [
        "/users/@me",
        "/applications/@me",
        `/guilds/${guildId}`,
        `/guilds/${guildId}/channels`,
        `/guilds/${guildId}/roles`,
    ]
    const result = await runCalibration({
        plan,
        pacerFor: (intervalMs) => {
            const pacer = createPacer({
                statePath: defaultStatePath,
                intervalMs,
                logPath: process.env.FLUXERLY_LIVE_REQUEST_LOG,
            })
            fetch = pacedFetch(base, pacer)
        },
        send: (index) =>
            fetch(`https://fluxer.com/api/v1${paths[index % paths.length]}`, {
                headers: { Authorization: `Bot ${token}` },
                redirect: "error",
            }),
        onStep: (step) => report("pace_calibration_step", { perMinute: step.perMinute, requests: step.requests }),
    })
    const record = storeCalibration(result, { plan })
    report(stage, {
        passed: true,
        cleanPerMinute: record.cleanPerMinute,
        limitedAtPerMinute: record.limitedAtPerMinute,
        limitedBy: record.limitedBy,
        requests: record.requests,
        safePerMinute: record.safePerMinute,
        safeIntervalMs: record.safeIntervalMs,
    })
    if (result.limitedAtPerMinute !== undefined)
        console.log("Fluxer answered with a 429, so the calibration stopped. Wait before any further live run")
} catch (error) {
    report(error instanceof HarnessCheckError ? error.check : stage, { passed: false })
    process.exitCode = 1
} finally {
    if (lock !== undefined && !lock.release()) {
        report("sandbox_lock_cleanup", { passed: false, lockRetained: true })
        process.exitCode = 1
    }
}
