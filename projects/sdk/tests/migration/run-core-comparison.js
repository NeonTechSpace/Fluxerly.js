import assert from "node:assert/strict"
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const fixture = dirname(fileURLToPath(import.meta.url))
const sdk = join(fixture, "..", "..")
const npmCli = join(sdk, "node_modules", "npm", "bin", "npm-cli.js")
const typeScriptCli = join(sdk, "node_modules", "typescript", "bin", "tsc")
const temporaryRoot = realpathSync(tmpdir())
const temporary = mkdtempSync(join(temporaryRoot, "fluxerly-core-migration-"))

function assertOwnedTemporary(path) {
    const target = resolve(path)
    const fromRoot = relative(temporaryRoot, target)
    assert.equal(dirname(target), temporaryRoot)
    assert.ok(!fromRoot.startsWith("..") && !fromRoot.includes("/", 1) && !fromRoot.includes("\\", 1))
    assert.ok(basename(target).startsWith("fluxerly-core-migration-"))
    return target
}

function run(command, args, timeoutMs) {
    const child = spawnSync(command, args, {
        cwd: temporary,
        encoding: "utf8",
        stdio: "pipe",
        timeout: timeoutMs,
        windowsHide: true,
    })
    if (child.error) throw child.error
    if (child.status !== 0) {
        throw new Error(
            [`Command failed: ${command} ${args.join(" ")}`, child.stdout, child.stderr].filter(Boolean).join("\n"),
        )
    }
    process.stdout.write(child.stdout)
    process.stderr.write(child.stderr)
}

try {
    assert.ok(existsSync(npmCli), "Build the SDK workspace dependencies before running the comparison")
    assert.ok(
        existsSync(typeScriptCli),
        "Install the SDK workspace TypeScript dependency before running the comparison",
    )
    cpSync(join(fixture, "core-package.json"), join(temporary, "package.json"))
    cpSync(join(fixture, "core-package-lock.json"), join(temporary, "package-lock.json"))
    cpSync(join(fixture, "core-variant.js"), join(temporary, "core-variant.js"))
    cpSync(join(fixture, "core-variant-typecheck.ts.txt"), join(temporary, "core-variant-typecheck.ts"))
    cpSync(join(fixture, "nonvoice-contract.js"), join(temporary, "nonvoice-contract.js"))
    run(
        process.execPath,
        [npmCli, "ci", "--ignore-scripts", "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund"],
        180_000,
    )
    const installedManifest = JSON.parse(
        readFileSync(join(temporary, "node_modules", "@fluxerjs", "core", "package.json"), "utf8"),
    )
    assert.equal(installedManifest.version, "3.1.0")
    run(
        process.execPath,
        [
            typeScriptCli,
            "--noEmit",
            "--strict",
            "--skipLibCheck",
            "--target",
            "ES2023",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "core-variant-typecheck.ts",
        ],
        60_000,
    )
    run(process.execPath, ["core-variant.js"], 30_000)
} finally {
    const owned = assertOwnedTemporary(temporary)
    const removed = assertOwnedTemporary(`${owned}-removed`)
    renameSync(owned, removed)
    rmSync(removed, { recursive: true, force: true })
}
