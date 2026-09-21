import { spawn, spawnSync } from "node:child_process"
import { open, readFile, unlink } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { withReleaseAuthentication } from "./authentication.js"
import { prepareCandidate, readCandidate } from "./candidate.js"
import { npmChannelTag, selectBaseline } from "./planning.js"
import { createRegistries } from "./registries.js"
import { inspectPublished, publishCandidate } from "./recovery.js"
import { readSourcePlan, versionSource } from "./source.js"
import { assertReleaseSupport } from "./support.js"

const workspace = resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)
const registries = createRegistries()

function arguments_(args, allowed) {
    const result = {}
    for (let index = 0; index < args.length; index++) {
        const key = args[index].replace(/^--/, "")
        if (!args[index].startsWith("--") || !allowed.includes(key) || key in result)
            throw new Error("Unknown or duplicate release option")
        if (key === "bootstrap") result[key] = true
        else {
            if (index + 1 >= args.length || args[index + 1].startsWith("--"))
                throw new Error("Release option needs a value")
            result[key] = args[++index]
        }
    }
    if (result.epoch !== undefined) {
        if (!/^\d+$/.test(result.epoch)) throw new Error("Epoch must be a number")
        result.epoch = Number(result.epoch)
    }
    return result
}

function command(
    executable,
    args,
    { cwd = workspace, interactive = false, timeout = 300_000, env = process.env } = {},
) {
    return new Promise((resolve_, reject) => {
        const child = spawn(executable, args, {
            cwd,
            env,
            windowsHide: true,
            stdio: interactive ? "inherit" : "ignore",
            detached: process.platform !== "win32",
        })
        const timer = setTimeout(() => {
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
            else reject(new Error("Release provider command failed or exceeded its deadline"))
        })
    })
}

function pnpm(args, cwd, env = process.env) {
    const path = env.npm_execpath
    if (!path) throw new Error("Run release commands through pnpm")
    return /\.[cm]?js$/.test(path)
        ? command(process.execPath, [path, ...args], { cwd, env })
        : command(path, args, { cwd, env })
}

async function stage(options) {
    const { stageRelease } = await import("../sdk/scripts/packages.js")
    return stageRelease(options)
}

async function lockPublication(run) {
    const path = join(workspace, ".release-publish-npm.lock")
    let handle
    try {
        handle = await open(path, "wx")
    } catch {
        throw new Error("Publication lock exists, verify no publisher is active before removing the stale lock")
    }
    const owner = JSON.stringify({ pid: process.pid })
    try {
        await handle.writeFile(owner)
        await handle.close()
        return await run()
    } finally {
        await handle.close().catch(() => {})
        if ((await readFile(path, "utf8")) === owner) await unlink(path)
    }
}

async function assertBaseline(candidate) {
    const inventory = await registries.inventory(candidate.name, { bootstrap: candidate.bootstrap })
    const version = selectBaseline({
        ...inventory,
        version: candidate.version,
        channel: candidate.channel,
        bootstrap: candidate.bootstrap,
    })
    if (version !== (candidate.baseline?.version ?? null))
        throw new Error(
            "Published baseline changed since review, prepare a new candidate without changing an existing version",
        )
    return inventory
}

async function publish(directory, candidate, env) {
    if (!candidate.docs || !/^[a-f0-9]{40}$/.test(candidate.sourceCommit))
        throw new Error("Publication requires a bound same-source documentation snapshot")
    const result = await lockPublication(async () => {
        const initialInventory = await assertBaseline(candidate)
        const channel = npmChannelTag(candidate, initialInventory.npmTags)
        const publicationTag = channel.advance ? channel.tag : `${candidate.channel}-${candidate.line.replaceAll(".", "-")}`
        const status = await publishCandidate(candidate, {
            registries,
            publisher: () =>
                pnpm(
                    [
                        "publish",
                        join(directory, "sdk.tgz"),
                        "--access",
                        "public",
                        "--tag",
                        publicationTag,
                        "--no-git-checks",
                        "--provenance",
                    ],
                    workspace,
                    env,
                ),
        })
        const updated = await registries.inventory(candidate.name)
        if (updated.npmTags[channel.tag] !== channel.expectedVersion)
            throw new Error("npm version is published but channel tag readback failed, inspect the tag without republishing")
        return { ...status, tag: channel.tag, tagVersion: channel.expectedVersion }
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
        console.log("Release prerequisite passed: Exact required Effect peer matches the SDK development dependency")
    } else if (action === "changeset") {
        if (args[0] && !["add", "status", "--help", "-h", "--version", "-v"].includes(args[0]))
            throw new Error(
                "Use Changesets for fragment authoring or status, release:version and release:publish own release effects",
            )
        if (args.includes("--empty"))
            throw new Error("Website-only changes need no SDK fragment, empty release fragments are not used")
        await command(process.execPath, [require.resolve("@changesets/cli/bin.js"), ...args], { interactive: true })
    } else if (["plan", "version"].includes(action)) {
        const options = arguments_(args, ["channel", "epoch", "line", "bootstrap"])
        if (action === "version") {
            console.log(JSON.stringify(await versionSource({ workspace, options, registries, stage })))
        } else console.log(JSON.stringify((await readSourcePlan(workspace, options)).plan))
    } else if (action === "prepare") {
        const options = arguments_(args, ["output", "line", "bootstrap", "docs"])
        if (!options.output) throw new Error("Prepare needs --output NEW_ABSOLUTE_DIRECTORY")
        console.log(
            JSON.stringify(
                await prepareCandidate({ workspace, ...options, output: resolve(options.output), registries, stage }),
            ),
        )
    } else if (["inspect", "verify", "publish", "status"].includes(action)) {
        if (!args[0] || args[0].startsWith("--")) throw new Error("Candidate command needs a candidate directory")
        const options = arguments_(args.slice(1), ["checksum"])
        if (action !== "inspect" && !options.checksum)
            throw new Error("Status, verify and publish require --checksum with the externally reviewed candidate SHA256")
        const directory = resolve(args[0])
        const candidate = await readCandidate(directory, options)
        if (action === "publish") await withReleaseAuthentication(process.env, (env) => publish(directory, candidate, env))
        else if (action === "inspect") console.log(JSON.stringify({ ...summary(directory, candidate), scope: "local-candidate-only" }))
        else {
            const status = await inspectPublished(candidate, registries)
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
