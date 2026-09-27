// @ts-check

// Installs a published SDK version from the official npm registry into an isolated consumer and imports every public
// entry point on the running Node version
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseVersion } from "./planning.js"

const name = "@neontechspace/fluxerly"

/**
 * Consumer program that imports each entry point and requires it to export at least one function
 * @param {string[]} entries Export keys from the installed manifest, such as "." and "./effect"
 */
export function importProgram(entries) {
    const specifiers = entries.map((entry) => `${name}${entry.slice(1)}`)
    return [
        `for (const specifier of ${JSON.stringify(specifiers)}) {`,
        `    const module = await import(specifier)`,
        `    if (!Object.values(module).some((value) => typeof value === "function"))`,
        `        throw new Error(specifier + " exports no functions")`,
        `}`,
    ].join("\n")
}

/**
 * Reads the public entry points from the installed manifest, so the check follows the package's exports
 * @param {any} manifest
 */
export function entryPoints(manifest) {
    const entries = Object.keys(manifest.exports ?? {})
    if (!entries.includes(".") || entries.some((entry) => entry !== "." && !/^\.\/[a-z/-]+$/.test(entry)))
        throw new Error("The installed package does not declare its public entry points")
    return entries
}

/**
 * @typedef {(args: string[], cwd: string, env: NodeJS.ProcessEnv) => void} Runner
 */

/** @type {Runner} */
function runNode(args, cwd, env) {
    execFileSync(process.execPath, args, { cwd, env, stdio: "inherit", timeout: 180_000, windowsHide: true })
}

/**
 * @param {{ version: string, npm: string, run?: Runner, wait?: (milliseconds: number) => Promise<void>,
 *   attempts?: number, delay?: number, root?: string, progress?: (message: string) => void }} options
 */
export async function smokeRegistryInstall({
    version,
    npm,
    run = runNode,
    wait = (milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds)),
    attempts = 5,
    delay = 30_000,
    root = realpathSync(tmpdir()),
    progress = (message) => console.error(message),
}) {
    if (parseVersion(version).major < 1000) throw new Error("Registry smoke checks need a public release version")
    const consumer = mkdtempSync(join(root, "fluxerly-registry-smoke-"))
    try {
        const userConfig = join(consumer, "empty.npmrc")
        writeFileSync(userConfig, "")
        writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))
        // An empty user configuration keeps inherited registry overrides and credentials out of the consumer
        /** @type {NodeJS.ProcessEnv} */
        const env = { ...process.env, NPM_CONFIG_USERCONFIG: userConfig }
        delete env.NPM_TOKEN
        delete env.NODE_AUTH_TOKEN
        const install = [
            npm,
            "install",
            `${name}@${version}`,
            "--save-exact",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--prefer-online",
            "--update-notifier=false",
            "--registry",
            "https://registry.npmjs.org/",
            "--cache",
            join(consumer, ".npm-cache"),
        ]
        // Registry metadata caches can briefly lag a new version, so installation is retried within a fixed bound
        for (let attempt = 1; ; attempt++) {
            try {
                run(install, consumer, env)
                break
            } catch {
                if (attempt >= attempts)
                    throw new Error(`npm could not install ${name}@${version} from the registry after ${attempts} attempts`)
                progress(`npm install attempt ${attempt} failed, retrying in ${Math.round(delay / 1000)} seconds`)
                await wait(delay)
            }
        }
        const installed = JSON.parse(readFileSync(join(consumer, "node_modules", name, "package.json"), "utf8"))
        if (installed.name !== name || installed.version !== version)
            throw new Error("npm installed a different package identity or version")
        const entries = entryPoints(installed)
        run(["--input-type=module", "--eval", importProgram(entries)], consumer, env)
        return { name, version, node: process.versions.node, entries }
    } finally {
        rmSync(consumer, { recursive: true, force: true })
    }
}

async function main() {
    const args = process.argv.slice(2)
    if (args.length !== 2 || args[0] !== "--version") throw new Error("Use --version EXACT_PUBLISHED_VERSION")
    // The SDK pins the npm CLI used for consumer checks, so registry installs use the same client on every runtime
    const sdk = createRequire(fileURLToPath(new URL("../sdk/package.json", import.meta.url)))
    const manifest = sdk("npm/package.json")
    const npm = join(dirname(sdk.resolve("npm/package.json")), manifest.bin.npm)
    const result = await smokeRegistryInstall({ version: args[1], npm })
    console.log(JSON.stringify(result))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : "Registry smoke install failed")
        process.exitCode = 1
    })
