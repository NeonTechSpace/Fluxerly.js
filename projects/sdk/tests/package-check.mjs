import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const sdk = fileURLToPath(new URL("../", import.meta.url))
const fixtureDirectory = fileURLToPath(new URL("./consumers/", import.meta.url))
const manifest = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"))
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
const pnpm = process.env.npm_execpath
assert.ok(pnpm, "Run the package check through pnpm run test:package")

function run(command, args, cwd, timeout = 120_000) {
    return execFileSync(command, args, { cwd, timeout, encoding: "utf8", windowsHide: true })
}

function packageManager(args, cwd) {
    return /\.[cm]?js$/.test(pnpm) ? run(process.execPath, [pnpm, ...args], cwd) : run(pnpm, args, cwd)
}

const temporaryRoot = realpathSync(tmpdir())
const temporary = mkdtempSync(join(temporaryRoot, "fluxerly-package-check-"))
try {
    const tarball = join(temporary, "sdk.tgz")
    const packed = JSON.parse(packageManager(["pack", "--out", tarball, "--json"], sdk))
    const files = packed.files.map((file) => file.path)
    for (const entry of ["index", "effect"]) {
        for (const extension of ["js", "js.map", "d.ts", "d.ts.map"]) {
            assert.ok(files.includes(`dist/${entry}.${extension}`))
        }
    }
    assert.ok(files.every((file) => file === "package.json" || file.startsWith("dist/") || file.startsWith("src/")))

    for (const kind of ["default", "effect"]) {
        const consumer = join(temporary, kind)
        mkdirSync(consumer)
        const dependencies = { [manifest.name]: `file:${tarball.replaceAll("\\", "/")}` }
        if (kind === "effect") dependencies.effect = manifest.dependencies.effect
        writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }))
        writeFileSync(join(consumer, "pnpm-workspace.yaml"), "allowBuilds:\n  msgpackr-extract: false\n")
        packageManager(["install", "--offline", "--strict-peer-dependencies"], consumer)

        const installed = join(consumer, "node_modules", manifest.name)
        assert.deepEqual(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).imports, manifest.imports)
        run(
            process.execPath,
            [
                "--input-type=module",
                "--eval",
                "import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url'; import { realpathSync } from 'node:fs'; assert.equal(import.meta.resolve('#sdk/internal/client'), pathToFileURL(realpathSync('dist/internal/client.js')).href)",
            ],
            installed,
            10_000,
        )
        for (const entry of ["index", "effect", "client", "errors", "messages", "events", "message-errors"]) {
            const declaration = `dist/${entry}.d.ts`
            assert.equal(
                readFileSync(join(installed, declaration), "utf8"),
                readFileSync(join(sdk, declaration), "utf8"),
            )
            const source = readFileSync(join(sdk, `src/${entry}.ts`), "utf8")
            const normalizeComment = (text) => text.replace(/\s+/g, " ").trim()
            const emitted = [...readFileSync(join(installed, declaration), "utf8").matchAll(/\/\*\*[\s\S]*?\*\//g)].map(
                ([comment]) => normalizeComment(comment),
            )
            // Public source comments precede implementation helpers in the two entry points
            const publicSource =
                entry === "index" || entry === "effect" ? source.split("export function createClient")[0] : source
            for (const [comment] of publicSource.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
                assert.ok(
                    emitted.includes(normalizeComment(comment)),
                    `Public comment missing from packed ${declaration}`,
                )
            }
        }
        for (const file of files.filter((file) => file.endsWith(".map"))) {
            const sourceMap = JSON.parse(readFileSync(join(installed, file), "utf8"))
            assert.ok(sourceMap.sources.length > 0)
            for (const source of sourceMap.sources) {
                assert.ok(existsSync(resolve(installed, dirname(file), sourceMap.sourceRoot ?? "", source)))
            }
        }

        if (kind === "default") assert.equal(existsSync(join(consumer, "node_modules/effect")), false)
        copyFileSync(join(fixtureDirectory, `${kind}.mjs`), join(consumer, "consumer.mjs"))
        process.stdout.write(run(process.execPath, ["--enable-source-maps", "consumer.mjs"], consumer, 10_000))

        copyFileSync(join(fixtureDirectory, `${kind}.ts`), join(consumer, "consumer.ts"))
        writeFileSync(
            join(consumer, "tsconfig.json"),
            JSON.stringify({
                compilerOptions: {
                    target: "ES2024",
                    module: "NodeNext",
                    types: [],
                    strict: true,
                    exactOptionalPropertyTypes: true,
                    noUncheckedIndexedAccess: true,
                    noEmitOnError: true,
                    outDir: "out",
                    lib: kind === "default" ? ["ES2024"] : ["ES2024", "ESNext.Disposable", "DOM"],
                },
                include: ["consumer.ts"],
            }),
        )
        run(process.execPath, [compiler, "-p", "tsconfig.json"], consumer)
        const invocation =
            kind === "default"
                ? "import { createAndReadState } from './out/consumer.js'; if (createAndReadState('fixture-only-not-a-credential') !== 'Disconnected') throw Error('Unexpected state')"
                : "import { Effect } from 'effect'; import { createWithinCallerScope } from './out/consumer.js'; const client = await Effect.runPromise(Effect.scoped(createWithinCallerScope('fixture-only-not-a-credential'))); if (client.state !== 'Closed') throw Error('Scope did not close client')"
        run(process.execPath, ["--input-type=module", "--eval", invocation], consumer, 10_000)
        console.log(`${kind} TypeScript 7 packed consumer passed`)
    }
} finally {
    const target = realpathSync(temporary)
    assert.equal(dirname(target), temporaryRoot)
    assert.ok(target.startsWith(`${temporaryRoot}${sep}`) && resolve(target) === resolve(temporary))
    rmSync(target, { recursive: true })
}
