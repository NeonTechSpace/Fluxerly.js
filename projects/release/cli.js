// @ts-check

import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { withReleaseAuthentication } from "./authentication.js"
import { prepareCandidate, readCandidate } from "./candidate.js"
import { selectBaseline } from "./planning.js"
import { forwardRedacted } from "./redact.js"
import { createRegistries } from "./registries.js"
import { inspectPublished, publishCandidate } from "./recovery.js"
import { readSourcePlan, versionSource } from "./source.js"
import { assertReleaseSupport } from "./support.js"

const workspace = resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)
const registries = createRegistries()

/**
 * @param {string[]} args
 * @param {string[]} allowed
 * @returns {Record<string, any>}
 */
function arguments_(args, allowed) {
    /** @type {Record<string, any>} */
    const result = {}
    for (let index = 0; index < args.length; index++) {
        const key = args[index].replace(/^--/, "")
        if (!args[index].startsWith("--") || !allowed.includes(key) || key in result)
            throw new Error("Unknown or duplicate release option")
        if (index + 1 >= args.length || args[index + 1].startsWith("--"))
            throw new Error("Release option needs a value")
        result[key] = args[++index]
    }
    if (result.epoch !== undefined) {
        if (!/^\d+$/.test(result.epoch)) throw new Error("Epoch must be a number")
        result.epoch = Number(result.epoch)
    }
    return result
}

/**
 * Runs a provider command. Non-interactive output is forwarded to stderr with token-like values redacted, so that
 * stdout keeps only the command's JSON result
 * @param {string} executable
 * @param {string[]} args
 * @param {{ cwd?: string, interactive?: boolean, timeout?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<void>}
 */
function command(executable, args, { cwd = workspace, interactive = false, timeout = 300_000, env = process.env } = {}) {
    return new Promise((resolve_, reject) => {
        const child = spawn(executable, args, {
            cwd,
            env,
            windowsHide: true,
            stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
        })
        if (!interactive) {
            forwardRedacted(child.stdout, process.stderr, env)
            forwardRedacted(child.stderr, process.stderr, env)
        }
        const timer = setTimeout(() => {
            if (child.pid === undefined) return
            if (process.platform === "win32")
                spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
            else {
                try {
                    process.kill(-child.pid, "SIGKILL")
                } catch {}
            }
        }, timeout)
        child.once("error", () => {
            clearTimeout(timer)
            reject(new Error("Release provider command could not start"))
        })
        child.once("close", (code) => {
            clearTimeout(timer)
            if (code === 0) resolve_()
            else reject(new Error("Release provider command failed or exceeded its deadline, inspect its output above"))
        })
    })
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 */
function pnpm(args, cwd, env = process.env) {
    const path = env.npm_execpath
    if (path && /\.[cm]?js$/.test(path)) return command(process.execPath, [path, ...args], { cwd, env })
    return command(path || "pnpm", args, { cwd, env })
}

async function stage(options) {
    // Resolved at runtime so that type checking stays within the release tooling
    const { stageRelease } = await import(new URL("../sdk/scripts/packages.js", import.meta.url).href)
    return stageRelease(options)
}

async function assertBaseline(candidate) {
    const inventory = await registries.inventory(candidate.name)
    const version = selectBaseline({ ...inventory, version: candidate.version, channel: candidate.channel })
    if (version !== (candidate.baseline?.version ?? null))
        throw new Error(
            "Published baseline changed since review, prepare a new candidate without changing an existing version",
        )
    return inventory
}

async function publish(directory, candidate, env) {
    if (!candidate.docs || !/^[a-f0-9]{40}$/.test(candidate.sourceCommit))
        throw new Error("Publication requires a bound same-source documentation snapshot")
    const result = await publishCandidate(candidate, {
        registries,
        assertBaseline: () => assertBaseline(candidate),
        publisher: (tag) =>
            pnpm(
                [
                    "publish",
                    join(directory, "sdk.tgz"),
                    "--access",
                    "public",
                    "--tag",
                    tag,
                    "--no-git-checks",
                    "--provenance",
                ],
                workspace,
                env,
            ),
    })
    console.log(JSON.stringify({ ...summary(directory, candidate), ...result }))
}

function summary(directory, candidate) {
    return {
        directory,
        name: candidate.name,
        version: candidate.version,
        channel: candidate.channel,
        line: candidate.line,
        sourceCommit: candidate.sourceCommit,
        checksum: candidate.checksum,
        notes: join(directory, "notes.md"),
        docs: candidate.docs ? join(directory, candidate.docs.path) : null,
    }
}

async function main() {
    const [action, ...args] = process.argv.slice(2)
    assertReleaseSupport(action)
    if (action === "check-support") {
        console.log("Release prerequisite passed: The required Effect peer range starts at the tested SDK development version")
    } else if (action === "changeset") {
        if (args[0] && !["add", "status", "--help", "-h", "--version", "-v"].includes(args[0]))
            throw new Error(
                "Use Changesets for fragment authoring or status, release:version and release:publish own release effects",
            )
        if (args.includes("--empty"))
            throw new Error("Website-only changes need no SDK fragment, empty release fragments are not used")
        await command(process.execPath, [require.resolve("@changesets/cli/bin.js"), ...args], { interactive: true })
    } else if (action === "plan" || action === "version") {
        const options = arguments_(args, ["channel", "epoch", "line"])
        if (action === "version") {
            console.log(JSON.stringify(await versionSource({ workspace, options, registries, stage })))
        } else console.log(JSON.stringify((await readSourcePlan(workspace, options)).plan))
    } else if (action === "prepare") {
        const options = arguments_(args, ["output", "line", "docs"])
        if (!options.output) throw new Error("Prepare needs --output NEW_ABSOLUTE_DIRECTORY")
        console.log(
            JSON.stringify(
                await prepareCandidate({
                    workspace,
                    line: options.line,
                    docs: options.docs,
                    output: resolve(options.output),
                    registries,
                    stage,
                }),
            ),
        )
    } else if (action === "inspect" || action === "verify" || action === "publish" || action === "status") {
        if (!args[0] || args[0].startsWith("--")) throw new Error("Candidate command needs a candidate directory")
        const options = arguments_(args.slice(1), ["checksum"])
        if (action !== "inspect" && !options.checksum)
            throw new Error("Status, verify and publish require --checksum with the externally reviewed candidate SHA256")
        const directory = resolve(args[0])
        const candidate = await readCandidate(directory, options)
        if (action === "publish") await withReleaseAuthentication(process.env, (env) => publish(directory, candidate, env))
        else if (action === "inspect")
            console.log(JSON.stringify({ ...summary(directory, candidate), scope: "local-candidate-only" }))
        else {
            const status = await inspectPublished(candidate, registries)
            if (action === "verify" && status.npm === "different")
                throw new Error("npm serves different bytes for this version than the reviewed candidate")
            if (action === "verify" && !status.complete) throw new Error("npm version is not published")
            console.log(JSON.stringify({ ...summary(directory, candidate), ...status }))
        }
    } else throw new Error("Use check-support, changeset, plan, version, prepare, inspect, status, verify or publish")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : "Release command failed")
        process.exitCode = 1
    })
