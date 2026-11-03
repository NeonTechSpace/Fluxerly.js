// Runs SDK-work live checks with bounded concurrency: named categories from support/categories.js or checks, the
// categories that changed files need, or for a release every SDK-work check. The SDK is compiled once into a private
// copy beside the logs and every harness runs from there, so the run never writes the repository's build and holds no
// build lock. Every shared-state check runs alone before the read-only and test-owned checks, which run up to
// --concurrency at once, two by default. Every check shares one request pacer, so a second lane spends no more requests
// a minute: The first lane starts with the checks that mostly wait on Fluxer events or fixed observation windows, and
// their waits overlap the other lane's paced requests. Each check's commands come from its package script or direct
// harness command, and its lock class and authorization level from support/check-classes.js.
// Checks that need per-run authorization or a present person are refused. Each check writes one log file, and the
// run ends with a summary of results, remaining lock files and journals. Harness locks, journals and cleanup are
// unchanged: a check that fails or times out keeps its evidence for the documented recovery rerun. A check whose
// journal existed before the run only recovers, so it is reported as recovered rather than passed.
// Every live request of every check passes through the shared pacer in support/live-pacing.js, and each check's
// requests are logged to <check>.requests.jsonl next to its log, with when each request was ready, how long it waited
// for its slot and how long its response took. Each command's start and end go to timeline.jsonl, and the time of each
// harness stage line to <check>.stages.jsonl. A hosted 429 marks the run throttled: The running check finishes,
// including its cleanup, and no further check starts
import { execFileSync, spawn } from "node:child_process"
import {
    appendFileSync,
    copyFileSync,
    cpSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { categories, categoriesForChanges, selectionUnits } from "./support/categories.js"
import {
    categoryInputs,
    inputHash,
    loadPasses,
    reuseDecisions,
    savePasses,
    updatePasses,
} from "./support/pass-records.js"
import { declaredCheck, strongestClass } from "./support/check-classes.js"
import {
    loadSandboxEnvironment,
    runIdentityValue,
    runIdentityVariable,
    verifySandboxIdentity,
} from "./support/harness.js"
import { clearThrottle, paceIntervalMs, readState } from "./support/live-pacing.js"
import { calibratedIntervalMs } from "./support/pace-calibration.js"
import { recoveredOnlyExitCode } from "./support/reporting.js"
import { readSandbox } from "./support/sandbox-api.js"
import { stateRootVariable } from "./support/state-root.js"
import { contentionFactor, pacedWatchdogMs, runnerMarginMs, watchdogEntry } from "./support/watchdogs.js"

const sdkRoot = fileURLToPath(new URL("../../", import.meta.url))
export const usage = `Usage: node tests/live/run-all.js [options] <category or check>...
       node tests/live/run-all.js [options] --changed [--base <git ref>]
       node tests/live/run-all.js [options] --full

During work, run the categories that cover the change, each about three minutes or less: Name them, or let --changed
pick them from the files changed since the base, by default where HEAD left the pushed main. Changes to documentation, the
website or tooling outside the SDK run nothing. smoke is a quick two-minute confidence check. --full runs every
category that has not passed on the same inputs within 14 days, and is for releases only. With --fresh it reruns all,
about 42 minutes

Options:
  --changed              Select the categories that the changed files touch
  --base <git ref>       Compare with this ref instead of the merge base of HEAD and the pushed main
  --full                 Run the whole suite, for a release, except categories that passed on the same inputs
                         within 14 days
  --fresh                With --full, run every category, reusing no earlier pass
  --list                 Print the categories, or with a selection the checks it would run, and send nothing
  --concurrency <n>      Lanes for checks that share the sandbox lock, 2 by default
  --calibrated-pace      Use the pace of a calibration from the last 14 days instead of 750 ms
  --build-lock <file>    Hold an flock on this file only while compiling the private build copy
  --timeout-minutes <n>  Harness process timeout, 25 by default, never below a harness's own watchdog
  --out <directory>      Log directory, a new temporary one by default`

/**
 * Checks that spend most of their time waiting on Fluxer events, heartbeats or fixed observation windows rather than
 * on paced requests, longest wait first. The first lane runs them, so their waits overlap the other lane's requests
 */
export const waitingChecks = Object.freeze([
    "recovery-window",
    "recovery:cancel",
    "recovery",
    "sdk",
    "typing",
    "sandbox",
    "collectors",
    "member-chunks",
    "supervisor",
])

const bothModes = (harness, ...flags) => [
    { harness, args: ["default", ...flags] },
    { harness, args: ["effect", ...flags] },
]

/** SDK-work direct harness commands, which have no package script */
const directChecks = {
    "bot-runner": bothModes("bot-runner.js"),
    "text-validation": bothModes("text-validation.js"),
    "recovery-window": bothModes("recovery-window.js"),
    "recovery-window-session-restart": bothModes("recovery-window.js", "--session-restart"),
}

// Journals are named after their harness file, with these exceptions. See "Journals and restoration" in the live check
// guide
const journalNames = {
    "guild-feature-toggles.js": "guild-features",
    "typing-interactive.js": "typing",
    "role-display-reset.js": "role-reset",
    "vanity-url.js": "vanity",
}
// Scenarios of these harnesses keep separate journals, named after the scenario's lock key
const scenarioJournals = new Set(["command-conveniences.js", "gateway-capture.js", "messages.js"])

/** The journal file a harness command recovers when it exists */
export function journalFile({ harness, args }) {
    const name = scenarioJournals.has(harness)
        ? declaredCheck(harness, args).key
        : (journalNames[harness] ?? harness.replace(/\.js$/, ""))
    return `.env.test.${name}.local`
}

/** Parses `pnpm run build && node tests/live/<harness> <args> && ...` into harness commands */
function scriptCommands(script) {
    return script
        .split(" && ")
        .filter((part) => part !== "pnpm run build")
        .map((part) => {
            const match = /^node tests\/live\/([a-z0-9-]+\.m?js)((?: [a-z0-9-]+)*)$/.exec(part)
            if (!match) throw new Error(`Unsupported live script command: ${part}`)
            return { harness: match[1], args: match[2].trim().split(" ").filter(Boolean) }
        })
}

/**
 * Every declared live check: package scripts named without their `test:live:` prefix (`test:live` itself is
 * `sandbox`), and direct harness commands named by their harness
 */
export function liveChecks(packageJson = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"))) {
    const checks = new Map()
    for (const [script, command] of Object.entries(packageJson.scripts)) {
        if (script !== "test:live" && !script.startsWith("test:live:")) continue
        if (script === "test:live:all") continue
        const name = script === "test:live" ? "sandbox" : script.slice("test:live:".length)
        checks.set(name, scriptCommands(command))
    }
    for (const [name, commands] of Object.entries(directChecks)) checks.set(name, commands)
    return new Map(
        [...checks].map(([name, commands]) => {
            const declarations = commands.map(({ harness, args }) => declaredCheck(harness, args))
            if (declarations.includes(undefined)) throw new Error(`Check ${name} has an undeclared lock class`)
            return [
                name,
                {
                    name,
                    commands,
                    lockClass: strongestClass(declarations.map((declaration) => declaration.lockClass)),
                    sdkWork: declarations.every((declaration) => declaration.level === "sdk-work"),
                    parallelModes: declarations.every((declaration) => declaration.parallelModes === true),
                },
            ]
        }),
    )
}

function parseArguments(argv) {
    const options = {
        // Every check shares one pacer, so a second lane only overlaps one check's waits with another's requests. More
        // lanes add contention for paced slots without another waiting lane to fill. See the live check guide
        concurrency: 2,
        calibratedPace: false,
        changed: false,
        base: undefined,
        full: false,
        fresh: false,
        buildLock: undefined,
        timeoutMinutes: 25,
        out: undefined,
        list: false,
        names: /** @type {string[]} */ ([]),
    }
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        const value = () => {
            const next = argv[++index]
            if (next === undefined) throw new Error(usage)
            return next
        }
        if (argument === "--") continue
        else if (argument === "--concurrency") options.concurrency = Number(value())
        else if (argument === "--timeout-minutes") options.timeoutMinutes = Number(value())
        else if (argument === "--calibrated-pace") options.calibratedPace = true
        else if (argument === "--changed") options.changed = true
        else if (argument === "--base") options.base = value()
        else if (argument === "--full") options.full = true
        else if (argument === "--fresh") options.fresh = true
        else if (argument === "--build-lock") options.buildLock = value()
        else if (argument === "--out") options.out = value()
        else if (argument === "--list") options.list = true
        else if (argument === "--help") options.help = true
        else if (argument.startsWith("-")) throw new Error(usage)
        else options.names.push(argument)
    }
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
        throw new Error("--concurrency must be a positive integer")
    if (!(options.timeoutMinutes > 0)) throw new Error("--timeout-minutes must be positive")
    if ([options.changed, options.full, options.names.length > 0].filter(Boolean).length > 1)
        throw new Error("Use one of: category or check names, --changed or --full")
    if (options.base !== undefined && !options.changed) throw new Error("--base needs --changed")
    if (options.fresh && !options.full) throw new Error("--fresh needs --full")
    return options
}

/**
 * Verifies bot, application and server identity once for the run, through the shared pacer, and returns the value that
 * lets harnesses which need only the bot ID skip their own three identity reads. Returns undefined without an env file,
 * where every harness fails on its own configuration check, and null when the identity does not match
 */
async function runIdentity(out) {
    if (!existsSync(join(sdkRoot, ".env.test.local"))) return undefined
    process.env.FLUXERLY_LIVE_REQUEST_LOG = join(out, "run.requests.jsonl")
    try {
        const sandbox = loadSandboxEnvironment()
        const { botId } = await verifySandboxIdentity((path) => readSandbox(path, sandbox.token), sandbox)
        return runIdentityValue(botId, sandbox)
    } catch {
        // allow-silent: The caller reports the failed identity check and starts no check. No details are printed
        return null
    }
}

/**
 * The repository paths changed since `base`, committed or not, plus untracked files. Without a base, the merge base of
 * HEAD and the pushed main, so commits not yet pushed to main still count, then the local main, then HEAD itself
 */
function changedPaths(base) {
    const git = (...args) => execFileSync("git", args, { cwd: sdkRoot, encoding: "utf8" }).trim()
    let from = base
    for (const main of ["origin/main", "main"]) {
        if (from !== undefined) break
        try {
            from = git("merge-base", "HEAD", main)
        } catch {
            // allow-silent: The next candidate, and finally HEAD, still covers uncommitted changes
        }
    }
    from ??= "HEAD"
    const root = git("rev-parse", "--show-toplevel")
    const lines = (text) => text.split("\n").filter(Boolean)
    return [
        ...new Set([
            ...lines(execFileSync("git", ["diff", "--name-only", from], { cwd: root, encoding: "utf8" })),
            ...lines(
                execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }),
            ),
        ]),
    ]
}

/**
 * The input hash of every category for the repository's current files, committed or not, or undefined outside a Git
 * checkout, where no pass is reused or recorded
 */
function categoryHashes(checks) {
    let root
    try {
        root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: sdkRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim()
    } catch {
        // allow-silent: Without Git there are no file lists to hash, so every category runs and no pass is recorded
        return undefined
    }
    const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        encoding: "utf8",
    })
        .split("\n")
        .filter(Boolean)
    const inputs = categoryInputs(paths, checks)
    return Object.fromEntries(
        Object.entries(inputs).map(([category, files]) => [
            category,
            inputHash(files, (path) => readFileSync(join(root, path))),
        ]),
    )
}

/**
 * Compiles the SDK sources into `copy/dist` and copies the package manifest and the live harnesses beside it, linking
 * the installed dependencies, so harnesses resolve the package from the copy. Only the compile reads the repository,
 * under an flock of `buildLock` when given. Resolves the compiler's result
 */
async function buildCopy(copy, log, buildLock) {
    mkdirSync(copy, { recursive: true })
    const typescript = createRequire(join(sdkRoot, "package.json")).resolve("typescript/package.json")
    const compiler = join(dirname(typescript), "bin/tsc")
    const compile = [
        compiler,
        "-p",
        "tsconfig.json",
        "--outDir",
        join(copy, "dist"),
        "--declaration",
        "false",
        "--declarationMap",
        "false",
        "--sourceMap",
        "false",
    ]
    const result = buildLock
        ? await runProcess("flock", [buildLock, process.execPath, ...compile], log, {})
        : await runProcess(process.execPath, compile, log, {})
    if (result.code !== 0) return result
    copyFileSync(join(sdkRoot, "package.json"), join(copy, "package.json"))
    if (existsSync(join(sdkRoot, "esm-only.cjs")))
        copyFileSync(join(sdkRoot, "esm-only.cjs"), join(copy, "esm-only.cjs"))
    cpSync(join(sdkRoot, "tests/live"), join(copy, "tests/live"), { recursive: true })
    symlinkSync(join(sdkRoot, "node_modules"), join(copy, "node_modules"), "junction")
    return result
}

/** Lock files and journals in the SDK directory, by name only. Their contents are never read here */
function sandboxFiles() {
    const names = readdirSync(sdkRoot)
    return {
        locks: names.filter((name) => name.startsWith(".env.test.local.lock")),
        journals: names.filter((name) => /^\.env\.test\.[a-z0-9-]+\.local$/.test(name)),
    }
}

// Process values authorize targets and effects for single manual runs, so checks read only the env file
function childEnvironment() {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FLUXER_TEST_")))
}

function runProcess(command, args, log, { shell = false, timeoutMs, env = {}, onLine, cwd = sdkRoot }) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            env: { ...childEnvironment(), ...env },
            shell,
            windowsHide: true,
        })
        child.stdout.pipe(log, { end: false })
        child.stderr.pipe(log, { end: false })
        if (onLine) {
            let rest = ""
            child.stdout.on("data", (chunk) => {
                const lines = (rest + chunk.toString("utf8")).split("\n")
                rest = lines.pop() ?? ""
                for (const line of lines) onLine(line)
            })
            child.stdout.on("end", () => rest && onLine(rest))
        }
        let timedOut = false
        const timer =
            timeoutMs === undefined
                ? undefined
                : setTimeout(() => {
                      timedOut = true
                      child.kill()
                  }, timeoutMs)
        child.on("error", () => {
            clearTimeout(timer)
            resolve({ code: null, timedOut })
        })
        child.on("close", (code) => {
            clearTimeout(timer)
            resolve({ code, timedOut })
        })
    })
}

function openLog(path) {
    const log = createWriteStream(path)
    return { log, close: () => new Promise((resolve) => log.end(resolve)) }
}

/**
 * The time and the mode, stage and outcome fields of one harness output line, for the stage timeline. Other fields,
 * and lines that are not JSON objects with a stage name, are left out, so the timeline holds no IDs or payload values
 */
export function stageRecord(line, at) {
    let value
    try {
        value = JSON.parse(line)
    } catch {
        // allow-silent: Lines that are not JSON, such as stack traces, have no stage to time
        return undefined
    }
    if (value === null || typeof value !== "object" || typeof value.check !== "string") return undefined
    return {
        at,
        ...(typeof value.mode === "string" ? { mode: value.mode } : {}),
        check: value.check,
        ...(typeof value.passed === "boolean" ? { passed: value.passed } : {}),
    }
}

/** The number of logged requests and hosted 429s in a check's request log */
export function requestCounts(path) {
    if (!existsSync(path)) return { requests: 0, limited: 0 }
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
    return { requests: lines.length, limited: lines.filter((line) => JSON.parse(line).status === 429).length }
}

function appendLine(path, value) {
    appendFileSync(path, `${JSON.stringify(value)}\n`)
}

/**
 * Runs a check's commands in order and stops at the first failure, as the package scripts do. A command whose journal
 * existed before the run only recovers and exits with recoveredOnlyExitCode, so the check's later commands do not start a
 * fresh test and the check counts as recovered rather than passed or failed
 */
async function runCheck(check, out, timeoutMs, journals, concurrency = 1, runEnv = {}, cwd = sdkRoot) {
    const name = check.name.replaceAll(":", "-")
    const { log, close } = openLog(join(out, `${name}.log`))
    const requestLog = join(out, `${name}.requests.jsonl`)
    const env = {
        ...runEnv,
        FLUXERLY_LIVE_REQUEST_LOG: requestLog,
        FLUXERLY_LIVE_CONCURRENCY: String(concurrency),
    }
    const onLine = (line) => {
        const record = stageRecord(line, new Date().toISOString())
        if (record) appendLine(join(out, `${name}.stages.jsonl`), record)
    }
    const started = performance.now()
    let result = { code: 0, timedOut: false }
    for (const { harness, args } of check.commands) {
        log.write(`$ node tests/live/${harness} ${args.join(" ")}\n`)
        const startedAt = new Date().toISOString()
        const commandStarted = performance.now()
        result = await runProcess(process.execPath, [join("tests/live", harness), ...args], log, {
            timeoutMs: commandTimeoutMs({ harness, args }, timeoutMs, concurrency),
            env,
            onLine,
            cwd,
        })
        appendLine(join(out, "timeline.jsonl"), {
            check: check.name,
            command: [harness, ...args].join(" "),
            startedAt,
            endedAt: new Date().toISOString(),
            ms: Math.round(performance.now() - commandStarted),
            code: result.code,
            ...(result.timedOut ? { timedOut: true } : {}),
        })
        if (result.code !== 0) break
    }
    await close()
    const recoveredOnly = result.code === recoveredOnlyExitCode && !result.timedOut
    if (recoveredOnly) result = { ...result, code: 0 }
    const recovered = recoveredOnly || check.commands.some((command) => journals.includes(journalFile(command)))
    return {
        ...result,
        recovered,
        ...requestCounts(requestLog),
        seconds: Math.round((performance.now() - started) / 1000),
    }
}

/**
 * Runs the read-only and test-owned checks in `queue` on `concurrency` lanes and resolves when every lane is done.
 * The first lane takes the waiting checks first and the other lanes take the rest first, so a waiting check overlaps
 * paced work instead of another wait. A lane that runs out of its own list takes from the other. `run(check, lane)` runs
 * one check, and `skip(check)` records one instead once `stopped()` says no further check may start
 */
export async function runLanes(queue, concurrency, { run, skip, stopped }) {
    const baseName = (check) => check.name.split("@")[0]
    const waiting_ = (check) => waitingChecks.includes(baseName(check))
    const waiting = queue
        .filter((check) => waiting_(check))
        .sort((left, right) => waitingChecks.indexOf(baseName(left)) - waitingChecks.indexOf(baseName(right)))
    const rest = queue.filter((check) => !waiting_(check))
    const lane = async (index) => {
        const [own, other] = index === 0 ? [waiting, rest] : [rest, waiting]
        for (let check = own.shift() ?? other.shift(); check; check = own.shift() ?? other.shift()) {
            if (stopped()) skip(check)
            else await run(check, index)
        }
    }
    const lanes = Math.max(1, Math.min(concurrency, queue.length))
    await Promise.all(Array.from({ length: lanes }, (_, index) => lane(index)))
}

/**
 * How long one harness process may run: The --timeout-minutes value, raised for paced waits when checks run together,
 * and never shorter than the harness's own sized watchdog plus runnerMarginMs, so the harness reports its own timeout
 * and pacing cannot trip either
 */
export function commandTimeoutMs({ harness, args }, timeoutMs, concurrency = 1) {
    const entry = watchdogEntry(harness, args)
    const contended = timeoutMs * contentionFactor(concurrency)
    return entry === undefined
        ? contended
        : Math.max(contended, pacedWatchdogMs(entry, { concurrency }) + runnerMarginMs)
}

function formatSeconds(seconds) {
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

async function main() {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) {
        console.log(usage)
        return 0
    }
    const checks = liveChecks()
    let names = options.names
    if (options.changed) {
        const { categories: picked, reasons } = categoriesForChanges(changedPaths(options.base), checks)
        for (const { path, categories: chosen } of reasons) console.log(`${path}: ${chosen.join(", ")}`)
        if (picked.length === 0) {
            console.log("No live category covers these changes, so nothing runs")
            return 0
        }
        console.log(`Categories: ${picked.join(" ")}`)
        names = picked
    }
    if (options.list && !options.full && names.length === 0) {
        for (const [category, members] of Object.entries(categories)) console.log(`${category}\t${members.join(" ")}`)
        console.log("")
        for (const check of checks.values())
            console.log(`${check.name}\t${check.lockClass}\t${check.sdkWork ? "SDK work" : "manual"}`)
        return 0
    }
    if (!options.full && names.length === 0) {
        console.error(usage)
        return 1
    }
    // Hashes are taken before the compile, so a recorded pass describes the files the run compiled and checked
    const hashes = categoryHashes(checks)
    let selected
    if (options.full) {
        if (hashes === undefined) console.log("Not a Git checkout, so no earlier pass is reused")
        const decisions =
            hashes === undefined
                ? Object.keys(categories).map((category) => ({ category, run: true, reason: "no Git checkout" }))
                : reuseDecisions(loadPasses(), hashes, { fresh: options.fresh })
        for (const decision of decisions)
            console.log(
                decision.run
                    ? `run       ${decision.category} (${decision.reason})`
                    : `reuse     ${decision.category} (passed ${decision.passedAt} on the same inputs)`,
            )
        const run = decisions.filter((decision) => decision.run).map((decision) => decision.category)
        if (run.length === 0) {
            console.log(
                "Every category passed on the same inputs within 14 days, so nothing runs. Use --fresh to rerun",
            )
            return 0
        }
        selected = selectionUnits(run, checks)
    } else selected = selectionUnits(names, checks)
    if (options.list) {
        for (const check of selected) console.log(`${check.name}\t${check.lockClass}`)
        return 0
    }
    const before = sandboxFiles()
    if (before.locks.length > 0) {
        console.error(`A live lock exists (${before.locks.join(", ")}). Confirm its run has stopped before retrying`)
        return 1
    }
    if (before.journals.length > 0)
        console.log(`Existing journals: ${before.journals.join(", ")}. Their checks run recovery only`)

    // The pace comes from FLUXERLY_LIVE_PACE_MS, or with --calibrated-pace from a recent stored calibration
    const paceEnv = options.calibratedPace ? { FLUXERLY_LIVE_PACE_MS: String(calibratedIntervalMs()) } : {}
    Object.assign(process.env, paceEnv)
    const intervalMs = paceIntervalMs()
    // An earlier run's throttle mark is cleared, while its last request start and pause keep pacing this run
    clearThrottle()
    const out = options.out ?? join(tmpdir(), `fluxerly-live-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`)
    mkdirSync(out, { recursive: true })
    console.log(`Logs: ${out}`)
    console.log(`Pace: at most one request start every ${intervalMs} ms`)
    const started = performance.now()

    // The run compiles the SDK into a private copy beside its logs and runs every harness from there, so it never writes
    // the repository's build and a rebuild during the run cannot change code under a running check
    const build = openLog(join(out, "build.log"))
    const buildStartedAt = new Date().toISOString()
    const copy = join(out, "build")
    const built = await buildCopy(copy, build.log, options.buildLock)
    await build.close()
    appendLine(join(out, "timeline.jsonl"), {
        check: "build",
        startedAt: buildStartedAt,
        endedAt: new Date().toISOString(),
        ms: Math.round(performance.now() - started),
        code: built.code,
    })
    if (built.code !== 0) {
        console.error("Build failed. See build.log")
        return 1
    }
    const identity = await runIdentity(out)
    if (identity === null) {
        console.error(
            readState().throttled
                ? "Fluxer answered the identity check with HTTP 429, so no check started. Wait before the next run"
                : "The sandbox identity check failed, so no check started. Run one check alone to see which part",
        )
        return 1
    }
    const checkEnv = {
        ...paceEnv,
        [stateRootVariable]: sdkRoot,
        ...(identity === undefined ? {} : { [runIdentityVariable]: identity }),
    }

    const timeoutMs = options.timeoutMinutes * 60_000
    const results = []
    // A timed-out harness is killed before its finalizer runs, so its lock stays and every later check would fail
    // only on that lock. The run stops scheduling after a timeout and records the remaining checks as skipped.
    // A hosted 429 that any sender received stops scheduling the same way, so the run adds no further pressure
    let stopped = false
    let throttled
    const record = (check, result) => {
        const status = result.timedOut
            ? "timeout"
            : result.code !== 0
              ? "fail"
              : result.recovered
                ? "recovered"
                : "pass"
        if (result.timedOut) stopped = true
        throttled ??= readState().throttled
        if (throttled) stopped = true
        results.push({ name: check.name, lockClass: check.lockClass, status, ...result })
        console.log(`${status.padEnd(9)} ${check.name} (${formatSeconds(result.seconds)})`)
    }
    const skip = (check) => {
        results.push({
            name: check.name,
            lockClass: check.lockClass,
            status: "skipped",
            code: null,
            seconds: 0,
            requests: 0,
            limited: 0,
        })
        console.log(`skipped   ${check.name}`)
    }

    // Shared-state checks hold the exclusive lock, so they run alone before the shared phase
    for (const check of selected.filter((check) => check.lockClass === "shared-state")) {
        if (stopped) {
            skip(check)
            continue
        }
        console.log(`start     ${check.name} (exclusive)`)
        record(check, await runCheck(check, out, timeoutMs, before.journals, 1, checkEnv, copy))
    }
    const queue = selected.filter((check) => check.lockClass !== "shared-state")
    // Checks that run together share the pacer, so each one's paced waits and watchdog grow with their number
    const concurrency = Math.max(1, Math.min(options.concurrency, queue.length))
    await runLanes(queue, concurrency, {
        stopped: () => stopped,
        skip,
        run: async (check) => {
            console.log(`start     ${check.name}`)
            record(check, await runCheck(check, out, timeoutMs, before.journals, concurrency, checkEnv, copy))
        },
    })

    if (hashes !== undefined) savePasses(updatePasses(loadPasses(), { hashes, results, throttled: Boolean(throttled) }))
    const after = sandboxFiles()
    const withStatus = (...statuses) => results.filter((result) => statuses.includes(result.status))
    const passed = withStatus("pass")
    const recovered = withStatus("recovered")
    const failed = withStatus("fail", "timeout")
    const skipped = withStatus("skipped")
    // The run's own identity reads count too
    const own = requestCounts(join(out, "run.requests.jsonl"))
    const requests = results.reduce((sum, result) => sum + result.requests, own.requests)
    const limited = results.reduce((sum, result) => sum + result.limited, own.limited)
    const summary = [
        ...results.map(
            (result) =>
                `${result.status.padEnd(9)} ${result.lockClass.padEnd(12)} ${formatSeconds(result.seconds).padStart(7)} ${String(result.requests).padStart(5)} ${result.name}`,
        ),
        "",
        `Wall time ${formatSeconds(Math.round((performance.now() - started) / 1000))}, ${passed.length} passed, ${recovered.length} recovered only, ${failed.length} failed, ${skipped.length} skipped after a timeout or throttle, concurrency ${options.concurrency}`,
        `Requests ${requests}, hosted 429s ${limited}, pace ${intervalMs} ms`,
        ...(throttled
            ? [
                  `Throttled: Fluxer answered ${throttled.route ?? "a request"} with HTTP 429 and asked for ${throttled.waitMs} ms, so no further check started. Wait before the next run`,
              ]
            : []),
        ...(recovered.length > 0
            ? [`Recovered only, run again to test: ${recovered.map((result) => result.name).join(", ")}`]
            : []),
        `Lock files left: ${after.locks.join(", ") || "none"}`,
        `Journals left: ${after.journals.join(", ") || "none"}`,
    ].join("\n")
    writeFileSync(join(out, "summary.txt"), `${summary}\n`)
    console.log(`\n${summary}`)
    return !throttled && passed.length === results.length && after.locks.length === 0 && after.journals.length === 0
        ? 0
        : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
    main().then(
        (code) => {
            process.exitCode = code
        },
        (error) => {
            console.error(error instanceof Error ? error.message : String(error))
            process.exitCode = 1
        },
    )
