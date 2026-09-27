// Runs SDK-work live checks with bounded concurrency. The SDK is built once, then every shared-state check runs alone
// before the read-only and test-owned checks, up to --concurrency at once. Each check's commands come from its
// package script or direct harness command, and its lock class and authorization level from support/check-classes.js.
// Checks that need per-run authorization or a present person are refused. Each check writes one log file, and the
// run ends with a summary of results, remaining lock files and journals. Harness locks, journals and cleanup are
// unchanged: a check that fails or times out keeps its evidence for the documented recovery rerun
import { spawn } from "node:child_process"
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { declaredCheck, strongestClass } from "./support/check-classes.js"

const sdkRoot = fileURLToPath(new URL("../../", import.meta.url))
const usage =
    "Usage: node tests/live/run-all.js [--concurrency <n>] [--timeout-minutes <n>] [--out <directory>] [--list] [check...]"

const bothModes = (harness) => [
    { harness, args: ["default"] },
    { harness, args: ["effect"] },
]

/** SDK-work direct harness commands, which have no package script */
const directChecks = {
    "bot-runner": bothModes("bot-runner.js"),
    "text-validation": bothModes("text-validation.js"),
    "recovery-window": bothModes("recovery-window.js"),
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
                },
            ]
        }),
    )
}

function parseArguments(argv) {
    const options = {
        // Higher values exceed the provider's per-minute request limit. See the live check guide
        concurrency: 1,
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
        else if (argument === "--out") options.out = value()
        else if (argument === "--list") options.list = true
        else if (argument.startsWith("-")) throw new Error(usage)
        else options.names.push(argument)
    }
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
        throw new Error("--concurrency must be a positive integer")
    if (!(options.timeoutMinutes > 0)) throw new Error("--timeout-minutes must be positive")
    return options
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

function runProcess(command, args, log, { shell = false, timeoutMs }) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd: sdkRoot, env: childEnvironment(), shell, windowsHide: true })
        child.stdout.pipe(log, { end: false })
        child.stderr.pipe(log, { end: false })
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

/** Runs a check's commands in order and stops at the first failure, as the package scripts do */
async function runCheck(check, out, timeoutMs) {
    const { log, close } = openLog(join(out, `${check.name.replaceAll(":", "-")}.log`))
    const started = performance.now()
    let result = { code: 0, timedOut: false }
    for (const { harness, args } of check.commands) {
        log.write(`$ node tests/live/${harness} ${args.join(" ")}\n`)
        result = await runProcess(process.execPath, [join("tests/live", harness), ...args], log, { timeoutMs })
        if (result.code !== 0) break
    }
    await close()
    return { ...result, seconds: Math.round((performance.now() - started) / 1000) }
}

function formatSeconds(seconds) {
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

async function main() {
    const options = parseArguments(process.argv.slice(2))
    const checks = liveChecks()
    if (options.list) {
        for (const check of checks.values())
            console.log(`${check.name}\t${check.lockClass}\t${check.sdkWork ? "SDK work" : "manual"}`)
        return 0
    }
    const selected =
        options.names.length === 0
            ? [...checks.values()].filter((check) => check.sdkWork)
            : options.names.map((name) => {
                  const check = checks.get(name)
                  if (!check) throw new Error(`Unknown live check: ${name}`)
                  if (!check.sdkWork) throw new Error(`${name} needs per-run authorization or a person present`)
                  return check
              })
    const before = sandboxFiles()
    if (before.locks.length > 0) {
        console.error(`A live lock exists (${before.locks.join(", ")}). Confirm its run has stopped before retrying`)
        return 1
    }
    if (before.journals.length > 0)
        console.log(`Existing journals: ${before.journals.join(", ")}. Their checks run recovery only`)

    const out = options.out ?? join(tmpdir(), `fluxerly-live-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`)
    mkdirSync(out, { recursive: true })
    console.log(`Logs: ${out}`)
    const started = performance.now()

    const build = openLog(join(out, "build.log"))
    const built = await runProcess("pnpm run build", [], build.log, { shell: true })
    await build.close()
    if (built.code !== 0) {
        console.error("Build failed. See build.log")
        return 1
    }

    const timeoutMs = options.timeoutMinutes * 60_000
    const results = []
    // A timed-out harness is killed before its finalizer runs, so its lock stays and every later check would fail
    // only on that lock. The run stops scheduling after a timeout and records the remaining checks as skipped
    let stopped = false
    const record = (check, result) => {
        const status = result.timedOut ? "timeout" : result.code === 0 ? "pass" : "fail"
        if (result.timedOut) stopped = true
        results.push({ name: check.name, lockClass: check.lockClass, status, ...result })
        console.log(`${status.padEnd(7)} ${check.name} (${formatSeconds(result.seconds)})`)
    }
    const skip = (check) => {
        results.push({ name: check.name, lockClass: check.lockClass, status: "skipped", code: null, seconds: 0 })
        console.log(`skipped ${check.name}`)
    }

    // Shared-state checks hold the exclusive lock, so they run alone before the shared phase
    for (const check of selected.filter((check) => check.lockClass === "shared-state")) {
        if (stopped) {
            skip(check)
            continue
        }
        console.log(`start   ${check.name} (exclusive)`)
        record(check, await runCheck(check, out, timeoutMs))
    }
    const queue = selected.filter((check) => check.lockClass !== "shared-state")
    const worker = async () => {
        for (let check = queue.shift(); check; check = queue.shift()) {
            if (stopped) {
                skip(check)
                continue
            }
            console.log(`start   ${check.name}`)
            record(check, await runCheck(check, out, timeoutMs))
        }
    }
    await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker))

    const after = sandboxFiles()
    const failed = results.filter((result) => result.status !== "pass" && result.status !== "skipped")
    const skipped = results.filter((result) => result.status === "skipped")
    const summary = [
        ...results.map(
            (result) =>
                `${result.status.padEnd(7)} ${result.lockClass.padEnd(12)} ${formatSeconds(result.seconds).padStart(7)} ${result.name}`,
        ),
        "",
        `Wall time ${formatSeconds(Math.round((performance.now() - started) / 1000))}, ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped after a timeout, concurrency ${options.concurrency}`,
        `Lock files left: ${after.locks.join(", ") || "none"}`,
        `Journals left: ${after.journals.join(", ") || "none"}`,
    ].join("\n")
    writeFileSync(join(out, "summary.txt"), `${summary}\n`)
    console.log(`\n${summary}`)
    return failed.length === 0 && skipped.length === 0 && after.locks.length === 0 && after.journals.length === 0
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
