import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { format } from "prettier"
import { stageRelease } from "../../scripts/packages.js"
import { authoredGuides } from "../../../web/scripts/generate.js"
import { exampleVariants } from "../../../web/scripts/example-blocks.js"
import { guideImportSpecifiers } from "./guide-imports.js"

const sdk = fileURLToPath(new URL("../../", import.meta.url))
const fixtureDirectory = fileURLToPath(new URL("./consumers/", import.meta.url))
const manifest = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"))
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
const pnpm = process.env.npm_execpath
assert.ok(pnpm, "Run the package check through pnpm run test:package")
console.log(`Packed consumer check runtime: Node ${process.version}`)

// SDK log records and supervised child lines from passing consumers stay out of the report
const sdkOutputLine =
    /^(?:\[(?:shard \d+|child [^\]\n]+)\] |\{"time":"[^"]+","level":"[a-z]+","category":"[a-z]+","code":"|Fluxerly [^\n]* failed: )/
// Effect's logger prints a native client's record as a header followed by indented stack and field lines
const effectRecordHeader = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] [A-Z]+ \(#\d+\):/

function withoutSdkOutput(text) {
    let insideRecord = false
    return text
        .split(/(?<=\n)/)
        .filter((line) => {
            if (effectRecordHeader.test(line)) insideRecord = true
            else if (insideRecord && !/^(?:\s|\}\r?\n?$)/.test(line)) insideRecord = false
            return !insideRecord && !sdkOutputLine.test(line)
        })
        .join("")
}

/** Run a command and return its standard output. A failure carries everything the command printed, SDK records included */
function run(command, args, cwd, timeout = 120_000) {
    const result = spawnSync(command, args, {
        cwd,
        timeout,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
    })
    const stdout = result.stdout ?? ""
    const stderr = result.stderr ?? ""
    if (result.error || result.status !== 0) {
        const outcome = result.error ? String(result.error) : `exit ${result.status ?? result.signal}`
        throw Object.assign(
            new Error(
                `Command failed (${outcome}): ${[command, ...args].join(" ")}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
                { cause: result.error },
            ),
            { status: result.status, signal: result.signal, stdout, stderr },
        )
    }
    process.stderr.write(withoutSdkOutput(stderr))
    return stdout
}

function packageManager(args, cwd) {
    return /\.[cm]?js$/.test(pnpm) ? run(process.execPath, [pnpm, ...args], cwd) : run(pnpm, args, cwd)
}

function examples(source) {
    return [...source.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)].map((match) =>
        match[1]
            .split(/\r?\n/)
            .map((line) => line.replace(/^\s*\* ?/, ""))
            .join("\n"),
    )
}

const checkedExampleSources = new Map()

function normalizeJavaScriptExample(source) {
    return format(source, { parser: "babel", semi: false, printWidth: 100 })
}

function rememberExample(consumer, example) {
    const checked = checkedExampleSources.get(consumer) ?? new Set()
    checked.add(example.replaceAll("\r\n", "\n").trim())
    checkedExampleSources.set(consumer, checked)
}

/** Write the authored examples a consumer runs, or rewrites for the other entry point, under stable file names */
function writeNamedExampleFixtures(consumer, source, fixtures) {
    const authoredExamples = examples(source)
    for (const { name, matches, file = (index) => `${name}-${index}.ts`, rewrite = (example) => example } of fixtures) {
        const selected = authoredExamples.filter(matches)
        assert.ok(selected.length > 0, `Missing the ${name} documentation example`)
        for (const [index, example] of selected.entries()) {
            const rewritten = rewrite(example)
            writeFileSync(join(consumer, file(index)), rewritten)
            rememberExample(consumer, rewritten)
        }
    }
}

const sourceFiles = readdirSync(join(sdk, "src"), { recursive: true })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".ts"))
    .toSorted()

function writeAdditionalDocumentationExamples(consumer, kind) {
    const files = []
    for (const owner of sourceFiles) {
        const source = readFileSync(join(sdk, "src", owner), "utf8")
        for (const [index, example] of examples(source).entries()) {
            // Compile each example as authored, against its actual public entry point, without rewriting its API usage
            const native = /from\s+["'](?:effect|@neontechspace\/fluxerly\/effect)["']/.test(example)
            if (native !== (kind === "effect")) continue
            if (checkedExampleSources.get(consumer)?.has(example.replaceAll("\r\n", "\n").trim())) continue
            const file = `additional-documentation-${owner.slice(0, -3).replaceAll("/", "-")}-${index}.ts`
            writeFileSync(join(consumer, file), `${example}\nexport {}\n`)
            rememberExample(consumer, example)
            files.push(file)
        }
    }
    return files
}

const guideLanguages = new Map([
    ["js", "js"],
    ["javascript", "js"],
    ["ts", "ts"],
    ["typescript", "ts"],
])

function guideCodeBlocks(guides) {
    const blocks = []
    for (const guide of guides) {
        const lines = guide.content.split(/\r?\n/)
        for (let line = 0; line < lines.length; line++) {
            const opening = lines[line].match(/^ {0,3}(`{3,}|~{3,})[ \t]*(js|javascript|ts|typescript)[ \t]*$/i)
            if (!opening) continue
            const language = guideLanguages.get(opening[2].toLowerCase())
            const fence = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*$`)
            const end = lines.findIndex((candidate, index) => index > line && fence.test(candidate))
            if (end < 0) throw new Error(`Unclosed ${language} guide example in ${guide.slug}`)
            blocks.push({
                guide: guide.slug,
                language,
                source: lines.slice(line + 1, end).join("\n"),
                line: line + 1,
            })
            line = end
        }
    }
    return blocks
}

// A program may import an entry point together with its testing entry point, but not both API styles
const entryPointKinds = new Map([
    [manifest.name, "default"],
    [`${manifest.name}/testing`, "default"],
    [`${manifest.name}/effect`, "effect"],
    [`${manifest.name}/effect/testing`, "effect"],
])

function entryPointKind(imports, location) {
    const entries = new Set([...imports].flatMap((specifier) => entryPointKinds.get(specifier) ?? []))
    if (entries.size !== 1) throw new Error(`Example must import public SDK entry points of one kind: ${location}`)
    return entries.values().next().value
}

function guideImportKind(example) {
    return entryPointKind(example.imports, `${example.guide}:${example.line}`)
}

function topLevelConstPrograms(source) {
    return [...source.matchAll(/^const\s+program\s*=/gm)]
}

const websiteGuides = await authoredGuides()
const authoredGuideExamples = await Promise.all(
    guideCodeBlocks(websiteGuides).map(async (example) => {
        const imports = await guideImportSpecifiers(example.source)
        return { ...example, imports, kind: guideImportKind({ ...example, imports }) }
    }),
)
const guideExampleCounts = Object.fromEntries(
    ["default", "effect"].map((kind) => [
        kind,
        authoredGuideExamples.filter((example) => example.kind === kind).length,
    ]),
)
console.log(
    `Authored website guide coverage: ${authoredGuideExamples.length} fenced JavaScript or TypeScript examples across ${websiteGuides.length} inventoried guides (${guideExampleCounts.default} default, ${guideExampleCounts.effect} Effect). JavaScript uses checkJs false and TypeScript is strict`,
)

function writeAuthoredGuideExamples(consumer, kind) {
    const javascript = []
    const typescript = []
    for (const [index, example] of authoredGuideExamples.entries()) {
        if (example.kind !== kind) continue
        const file = `authored-guide-${example.guide}-${index + 1}.${example.language}`
        writeFileSync(join(consumer, file), example.source)
        const files = example.language === "js" ? javascript : typescript
        files.push(file)
    }
    return { javascript, typescript }
}

// Standalone example programs stay in the repository. The shipped starters are checked separately below
const exampleRoot = join(sdk, "examples")
const repositoryExamples = await Promise.all(
    readdirSync(exampleRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "starter")
        .flatMap((entry) =>
            readdirSync(join(exampleRoot, entry.name))
                .filter((file) => /\.(?:js|ts)$/.test(file))
                .map((file) => ({ folder: entry.name, file })),
        )
        .toSorted((left, right) => `${left.folder}/${left.file}`.localeCompare(`${right.folder}/${right.file}`))
        .map(async ({ folder, file }) => {
            const source = readFileSync(join(exampleRoot, folder, file), "utf8")
            const imports = await guideImportSpecifiers(source)
            const location = `examples/${folder}/${file}`
            return { folder, file, source, language: file.slice(-2), kind: entryPointKind(imports, location) }
        }),
)
assert.ok(repositoryExamples.length > 0, "Expected repository example programs outside examples/starter")

// Blank lines are layout only. The TypeScript to JavaScript conversion drops them, and bot.js may keep them for reading
const javascriptProgram = async (source) =>
    (await normalizeJavaScriptExample(source)).replaceAll(/\n(?:[ \t]*\n)+/g, "\n")
const pairedExampleFolders = [...new Set(repositoryExamples.map((example) => example.folder))].filter((folder) =>
    ["bot.ts", "bot.js"].every((file) =>
        repositoryExamples.some((example) => example.folder === folder && example.file === file),
    ),
)
for (const folder of pairedExampleFolders) {
    const source = (file) =>
        repositoryExamples.find((example) => example.folder === folder && example.file === file).source
    assert.equal(
        await javascriptProgram(source("bot.js")),
        await javascriptProgram(exampleVariants(source("bot.ts"), "ts").js),
        `examples/${folder}/bot.js must be the JavaScript variant the website derives from bot.ts`,
    )
}
const repositoryExampleCounts = Object.fromEntries(
    ["default", "effect"].map((kind) => [kind, repositoryExamples.filter((example) => example.kind === kind).length]),
)
console.log(
    `Repository example coverage: ${repositoryExamples.length} programs in ${new Set(repositoryExamples.map((example) => example.folder)).size} folders (${repositoryExampleCounts.default} default, ${repositoryExampleCounts.effect} Effect), ${pairedExampleFolders.length} bot.js files matching their bot.ts. TypeScript is strict and JavaScript uses checkJs with strict settings except noImplicitAny`,
)

function writeRepositoryExamples(consumer, kind) {
    const javascript = []
    const typescript = []
    for (const example of repositoryExamples) {
        if (example.kind !== kind) continue
        const file = `repository-example-${example.folder}-${example.file}`
        writeFileSync(join(consumer, file), example.source)
        const files = example.language === "js" ? javascript : typescript
        files.push(file)
    }
    return { javascript, typescript }
}

function completeEffectStarter() {
    const starters = authoredGuideExamples.filter((example) => {
        if (example.guide !== "effect-first-bot" || example.language !== "ts" || example.kind !== "effect") return false
        const programs = topLevelConstPrograms(example.source)
        return (
            example.imports.has(`${manifest.name}/effect`) &&
            programs.length === 1 &&
            (example.source.match(/process\.env\.FLUXER_BOT_TOKEN/g) ?? []).length === 1
        )
    })
    assert.equal(starters.length, 1, "Expected one complete authored Effect starter")
    return starters[0]
}

/** Declaration files reachable from one packed entry point, and the external modules each one imports */
function declarationImports(installed, entry) {
    const reached = new Map()
    const visit = (file) => {
        if (reached.has(file)) return
        const external = []
        reached.set(file, external)
        const text = readFileSync(file, "utf8")
        for (const [, specifier] of text.matchAll(/(?:\bfrom\s+|\bimport\(\s*|^import\s+)["']([^"']+)["']/gm)) {
            const local = specifier.startsWith("#sdk/")
                ? join(installed, "dist", `${specifier.slice("#sdk/".length)}.d.ts`)
                : specifier.startsWith(".")
                  ? resolve(dirname(file), specifier.replace(/\.js$/, ".d.ts"))
                  : undefined
            if (local === undefined) external.push(specifier)
            else {
                assert.ok(existsSync(local), `${relative(installed, file)} imports missing ${specifier}`)
                visit(local)
            }
        }
    }
    visit(join(installed, "dist", `${entry}.d.ts`))
    return reached
}

// Default consumers compile without Effect's declarations, so no default declaration may reach the effect package
function assertDefaultDeclarationsAvoidEffect(installed) {
    const reached = new Map([...declarationImports(installed, "index"), ...declarationImports(installed, "testing")])
    const offenders = [...reached].flatMap(([file, external]) =>
        external
            .filter((specifier) => specifier === "effect" || specifier.startsWith("effect/"))
            .map((specifier) => `${relative(installed, file)} -> ${specifier}`),
    )
    assert.deepEqual(offenders, [], "Default declarations must not import effect")
    // Guard the walk itself: the native entry point must reach effect through the same traversal
    assert.ok(
        [...declarationImports(installed, "effect").values()].some((external) => external.includes("effect")),
        "Declaration import walk did not find the native entry point's effect import",
    )
}

// Public documentation reaches packed declarations only while the build keeps comments and internal declarations
const buildOptions = JSON.parse(readFileSync(join(sdk, "tsconfig.json"), "utf8")).compilerOptions
assert.equal(buildOptions.removeComments, undefined, "The build must keep public comments in declarations")
assert.equal(buildOptions.stripInternal, undefined, "The build must keep every public declaration")

const temporaryRoot = realpathSync(tmpdir())
const temporary = mkdtempSync(join(temporaryRoot, "fluxerly-package-check-"))
try {
    const staged = await stageRelease({ version: manifest.version, output: join(temporary, "artifacts") })
    const tarball = staged.npm.tarball
    const stagedFiles = JSON.parse(readFileSync(staged.manifestPath, "utf8")).npm
    const files = stagedFiles.map((file) => file.path)
    // A ceiling about a fifth above the current size catches accidental duplication, such as embedded map sources.
    // Raise it deliberately when the SDK itself grows
    const unpackedBytes = stagedFiles.reduce((total, file) => total + file.size, 0)
    assert.ok(unpackedBytes <= 10_000_000, `The npm package unpacks to ${unpackedBytes} bytes, above the 10 MB ceiling`)
    for (const entry of ["index", "effect", "testing", "effect-testing", "cache", "application", "sharding"]) {
        for (const extension of ["js", "js.map", "d.ts", "d.ts.map"]) {
            assert.ok(files.includes(`dist/${entry}.${extension}`))
        }
    }
    assert.ok(
        files.every(
            (file) =>
                ["package.json", "README.md", "agents/AGENTS.md", "esm-only.cjs", "LICENSE", "CHANGELOG.md"].includes(
                    file,
                ) ||
                file.startsWith("dist/") ||
                file.startsWith("examples/starter/") ||
                file.startsWith("src/"),
        ),
    )
    assert.ok(files.includes("agents/AGENTS.md"))
    assert.ok(files.includes("README.md"))
    assert.ok(files.includes("LICENSE"))
    assert.ok(files.includes("esm-only.cjs"))
    assert.ok(!files.includes("AGENTS.md"), "Contributor instructions must not ship as consumer guidance")
    assert.deepEqual(
        files.filter((file) => file.startsWith("examples/starter/")).toSorted(),
        ["bot-effect.ts", "bot.js", "bot.ts"].map((file) => `examples/starter/${file}`),
        "The package must ship only the standalone bot examples",
    )

    // Consumer fixtures import ../hosted-discovery.mjs, which resolves only in this packed layout
    copyFileSync(join(sdk, "tests/support/hosted-discovery.mjs"), join(temporary, "hosted-discovery.mjs"))
    for (const kind of ["default", "effect"]) {
        const consumer = join(temporary, kind)
        mkdirSync(consumer)
        const dependencies = { [manifest.name]: `file:${tarball.replaceAll("\\", "/")}` }
        if (kind === "effect") dependencies.effect = manifest.peerDependencies.effect
        writeFileSync(
            join(consumer, "package.json"),
            JSON.stringify({
                private: true,
                type: "module",
                dependencies,
                devDependencies: { "@types/node": manifest.devDependencies["@types/node"] },
            }),
        )
        writeFileSync(join(consumer, "pnpm-workspace.yaml"), "allowBuilds:\n  msgpackr-extract: false\n")
        packageManager(["install", "--prefer-offline", "--ignore-scripts", "--strict-peer-dependencies"], consumer)

        const installed = join(consumer, "node_modules", manifest.name)
        for (const path of files) {
            assert.deepEqual(
                readFileSync(join(installed, path)),
                readFileSync(join(staged.npm.directory, path)),
                `Packed bytes differ from staged ${path}`,
            )
        }
        for (const path of ["README.md", "agents/AGENTS.md"]) {
            assert.equal(readFileSync(join(installed, path), "utf8"), readFileSync(join(sdk, path), "utf8"))
        }
        assert.deepEqual(readFileSync(join(installed, "LICENSE")), readFileSync(join(sdk, "../../LICENSE")))
        // The SDK is ESM-only, so require() must reach the explanatory module rather than fail to resolve
        for (const specifier of [
            manifest.name,
            `${manifest.name}/effect`,
            `${manifest.name}/testing`,
            `${manifest.name}/effect/testing`,
        ])
            assert.throws(
                () => createRequire(join(consumer, "package.json"))(specifier),
                (error) => error.constructor === Error && error.code === undefined && /ESM-only/.test(error.message),
            )
        if (kind === "default") {
            // The installed command writes the rules into the application's AGENTS.md, as the guides instruct
            packageManager(["exec", "fluxerly", "agents"], consumer)
            const agents = readFileSync(join(consumer, "AGENTS.md"), "utf8")
            assert.ok(
                agents.includes(`@neontechspace/fluxerly ${manifest.version}`),
                "AGENTS.md names the installed version",
            )
            assert.ok(
                agents.includes("run `pnpm exec fluxerly agents` to refresh"),
                "AGENTS.md names the project's command",
            )
            assert.ok(agents.includes("1. Import only from"), "AGENTS.md contains the rules")
        }
        const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
        assert.ok(!installedManifest.private && !installedManifest.scripts && !installedManifest.devDependencies)
        for (const field of ["peerDependencies", "peerDependenciesMeta", "imports", "engines"])
            assert.deepEqual(
                installedManifest[field],
                manifest[field],
                `Packed ${field} differs from the source manifest`,
            )
        if (kind === "effect") {
            const appRequire = createRequire(join(consumer, "package.json"))
            const sdkRequire = createRequire(join(installed, "package.json"))
            assert.equal(
                appRequire.resolve("effect"),
                sdkRequire.resolve("effect"),
                "Native consumer must share Effect",
            )
        }
        const guideExample = [
            ...readFileSync(join(installed, "agents/AGENTS.md"), "utf8").matchAll(/```ts\r?\n([\s\S]*?)```/g),
        ]
            .map((match) => match[1])
            .filter((example) => example.includes('from "effect"') === (kind === "effect"))
        assert.equal(guideExample.length, 1, `Expected one ${kind} example in the shipped agent guide`)
        writeFileSync(join(consumer, "agent-guide.ts"), guideExample[0])
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
        // Each packed entry point starts with its source overview comment
        const normalizeComment = (text) => text.replace(/\s+/g, " ").trim()
        for (const entry of ["index", "effect"]) {
            const overview = readFileSync(join(sdk, "src", `${entry}.ts`), "utf8").match(/^\/\*\*[\s\S]*?\*\//)?.[0]
            assert.ok(overview?.includes("@packageDocumentation"), `Missing ${entry} entry-point overview`)
            assert.ok(
                normalizeComment(readFileSync(join(installed, `dist/${entry}.d.ts`), "utf8")).startsWith(
                    normalizeComment(overview),
                ),
                `Entry-point overview missing from packed dist/${entry}.d.ts`,
            )
        }
        assertDefaultDeclarationsAvoidEffect(installed)
        for (const file of files.filter((file) => file.endsWith(".map"))) {
            const sourceMap = JSON.parse(readFileSync(join(installed, file), "utf8"))
            assert.ok(sourceMap.sources.length > 0)
            // Maps point at the shipped src/ files instead of embedding a second copy of every source
            assert.equal(sourceMap.sourcesContent, undefined, `${file} embeds sources that src/ already ships`)
            for (const source of sourceMap.sources) {
                const resolved = resolve(installed, dirname(file), sourceMap.sourceRoot ?? "", source)
                const packedPath = relative(installed, resolved)
                assert.ok(!isAbsolute(packedPath) && packedPath !== ".." && !packedPath.startsWith(`..${sep}`))
                assert.ok(existsSync(resolved))
            }
        }

        for (const file of ["loopback.js", "starter.js"])
            copyFileSync(join(fixtureDirectory, file), join(consumer, file))
        if (kind === "default") {
            assert.equal(existsSync(join(consumer, "node_modules/effect")), false)
            const websiteGuide = websiteGuides.find((guide) => guide.slug === "quick-start").content
            const websiteExamples = [...websiteGuide.matchAll(/```js\r?\n([\s\S]*?)```/g)]
            assert.equal(
                websiteExamples.length,
                1,
                "Expected one website bot block shared by JavaScript and TypeScript",
            )
            for (const file of ["bot.js", "bot.ts"]) {
                assert.equal(
                    await normalizeJavaScriptExample(readFileSync(join(installed, "examples/starter", file), "utf8")),
                    await normalizeJavaScriptExample(websiteExamples[0][1]),
                    `The installed ${file} must match the rendered runnable starter`,
                )
            }
            // The README bot is compiled with the starters rather than compared as text
            const readmeExamples = [
                ...readFileSync(join(installed, "README.md"), "utf8").matchAll(/```js\r?\n([\s\S]*?)```/g),
            ]
            assert.ok(readmeExamples.length > 0, "Expected a bot example in the packed README")
            for (const [index, [, source]] of readmeExamples.entries())
                writeFileSync(join(consumer, `readme-example-${index}.ts`), `${source}\nexport {}\n`)
            for (const filename of ["bot.js", "bot.ts"]) {
                writeFileSync(join(consumer, filename), websiteExamples[0][1])
                process.stdout.write(
                    withoutSdkOutput(run(process.execPath, ["starter.js", kind, filename], consumer, 15_000)),
                )
            }
        }
        if (kind === "effect") {
            const starter = completeEffectStarter()
            assert.equal(
                starter.source.trim(),
                readFileSync(join(installed, "examples/starter/bot-effect.ts"), "utf8").trim(),
                "The rendered native starter must use the installed application source",
            )
            writeFileSync(join(consumer, "bot-effect.ts"), starter.source)
            process.stdout.write(
                withoutSdkOutput(run(process.execPath, ["starter.js", kind, "bot-effect.ts"], consumer, 15_000)),
            )
        }
        copyFileSync(join(fixtureDirectory, `${kind}.js`), join(consumer, "consumer.js"))
        process.stdout.write(
            withoutSdkOutput(run(process.execPath, ["--enable-source-maps", "consumer.js"], consumer, 10_000)),
        )
        copyFileSync(join(fixtureDirectory, "sharding-workflow.js"), join(consumer, "sharding-workflow.js"))
        process.stdout.write(
            withoutSdkOutput(
                run(process.execPath, ["--enable-source-maps", "sharding-workflow.js", kind], consumer, 15_000),
            ),
        )
        copyFileSync(join(fixtureDirectory, "testing.js"), join(consumer, "testing.js"))
        process.stdout.write(withoutSdkOutput(run(process.execPath, ["testing.js", kind], consumer, 15_000)))
        copyFileSync(join(fixtureDirectory, "module-conformance.js"), join(consumer, "module-conformance.js"))
        copyFileSync(
            join(sdk, "tests/contract/module-conformance-registry.js"),
            join(consumer, "module-conformance-registry.js"),
        )
        process.stdout.write(withoutSdkOutput(run(process.execPath, ["module-conformance.js", kind], consumer, 10_000)))

        copyFileSync(join(fixtureDirectory, `${kind}.ts`), join(consumer, "consumer.ts"))
        copyFileSync(join(fixtureDirectory, `testing-${kind}.ts`), join(consumer, "testing-consumer.ts"))
        // Type-only consumers of exports that the entry point consumers above do not name
        if (kind === "default") copyFileSync(join(fixtureDirectory, "logging.ts"), join(consumer, "logging.ts"))
        if (kind === "effect") {
            copyFileSync(join(fixtureDirectory, "message-fields.ts"), join(consumer, "message-fields.ts"))
            copyFileSync(join(fixtureDirectory, "event-accounting.ts"), join(consumer, "event-accounting.ts"))
        }
        for (const file of ["builders-state.ts", "guild-feature-types.ts"])
            writeFileSync(
                join(consumer, file),
                readFileSync(join(fixtureDirectory, file), "utf8").replaceAll(
                    '"@neontechspace/fluxerly"',
                    JSON.stringify(kind === "default" ? manifest.name : `${manifest.name}/effect`),
                ),
            )
        // Each entry point re-exports its hand-written API modules, which hold the authored examples
        const apiDirectory = join(sdk, "src/api", kind === "default" ? "default" : "effect")
        const publicSource = [
            join(sdk, "src", kind === "default" ? "index.ts" : "effect.ts"),
            ...readdirSync(apiDirectory)
                .filter((file) => file.endsWith(".ts"))
                .sort()
                .map((file) => join(apiDirectory, file)),
        ]
            .map((file) => readFileSync(file, "utf8"))
            .join("\n")
        // Examples that workflow.js imports from out/, and runnable programs checked with the starters
        writeNamedExampleFixtures(consumer, publicSource, [
            {
                name: "optional-tools",
                matches: (example) => /(?:function|const) installPing/.test(example),
                file: () => "optional-tools-example.ts",
            },
            {
                name: "commandGroupExample",
                matches: (example) => example.includes("function commandGroupExample("),
                file: () => "commandGroupExample.ts",
            },
            {
                name: "runBot",
                matches: (example) => /function pingBot\(/.test(example),
                file: () => "run-bot-example.ts",
            },
        ])
        writeNamedExampleFixtures(
            consumer,
            kind === "default" ? readFileSync(join(sdk, "src/client.ts"), "utf8") : publicSource,
            [
                {
                    name: "logging",
                    matches: (example) => /function loggingExample/.test(example),
                    file: () => "logging-example.ts",
                },
            ],
        )
        // Shared module examples import the default entry point and must also compile against the native one
        const rewriteSharedExample = (example) =>
            kind === "default"
                ? example
                : example.replaceAll('"@neontechspace/fluxerly"', '"@neontechspace/fluxerly/effect"')
        for (const [file, pattern] of [
            ["api-errors", /function formatApiErrorDetail/],
            ["input-validation", /function readInputValidation/],
            ["client", /function selectedMessagesExample/],
            ["expressions", /function expressionExample/],
            ["invites", /function inviteExample/],
            ["audit-logs", /function auditExample/],
            ["guilds", /function guildSettingsExample/],
            ["events", /function (?:administrativeEvents|expressionEvents|guildEvents|presenceEvents)Example/],
            ["discovery", /function discoveryExample/],
            ["permissions", /function permissionsExample/],
            ["member-search", /function memberSearchExample/],
            ["helpers", /function helpersExample/],
            ["assets", /function assetsExample/],
            ["attachments", /./],
            ["messages", /function (?:messageMetadata|sticker)Example/],
        ])
            writeNamedExampleFixtures(consumer, readFileSync(join(sdk, "src", `${file}.ts`), "utf8"), [
                {
                    name: `shared-${file}`,
                    matches: (example) => pattern.test(example),
                    rewrite: rewriteSharedExample,
                },
            ])
        const additionalExamples = writeAdditionalDocumentationExamples(consumer, kind)
        const authoredGuideFixtures = writeAuthoredGuideExamples(consumer, kind)
        const repositoryExampleFixtures = writeRepositoryExamples(consumer, kind)
        writeFileSync(
            join(consumer, "tsconfig.json"),
            JSON.stringify({
                compilerOptions: {
                    target: "ES2024",
                    module: "NodeNext",
                    // Handler signals are AbortSignal and handles are AsyncDisposable, which Node.js types declare for the default API
                    types: kind === "default" ? ["node"] : [],
                    strict: true,
                    exactOptionalPropertyTypes: true,
                    noUncheckedIndexedAccess: true,
                    noEmitOnError: true,
                    outDir: "out",
                    lib: kind === "default" ? ["ES2024"] : ["ES2024", "ESNext.Disposable", "DOM"],
                },
                include: ["*.ts"],
                exclude: [
                    "bot.ts",
                    "logging-example.ts",
                    "run-bot-example.ts",
                    "bot-effect.ts",
                    "readme-example-*.ts",
                    ...additionalExamples,
                    ...authoredGuideFixtures.typescript,
                    ...repositoryExampleFixtures.typescript,
                ],
            }),
        )
        run(process.execPath, [compiler, "-p", "tsconfig.json"], consumer)
        copyFileSync(join(fixtureDirectory, "agent-guide.js"), join(consumer, "agent-guide.js"))
        process.stdout.write(withoutSdkOutput(run(process.execPath, ["agent-guide.js"], consumer, 15_000)))
        copyFileSync(join(fixtureDirectory, "workflow.js"), join(consumer, "workflow.js"))
        process.stdout.write(
            withoutSdkOutput(run(process.execPath, ["--enable-source-maps", "workflow.js", kind], consumer, 15_000)),
        )
        writeFileSync(
            join(consumer, "run-bot-tsconfig.json"),
            JSON.stringify({
                compilerOptions: {
                    target: "ES2024",
                    module: "NodeNext",
                    types: ["node"],
                    strict: true,
                    exactOptionalPropertyTypes: true,
                    noUncheckedIndexedAccess: true,
                    noEmit: true,
                    allowJs: true,
                    checkJs: true,
                    allowImportingTsExtensions: true,
                    erasableSyntaxOnly: true,
                    lib: kind === "default" ? ["ES2024"] : ["ES2024", "ESNext.Disposable", "DOM"],
                },
                include:
                    kind === "default"
                        ? ["run-bot-example.ts", "logging-example.ts", "bot.ts", "readme-example-*.ts"]
                        : ["run-bot-example.ts", "logging-example.ts", "bot-effect.ts"],
            }),
        )
        run(process.execPath, [compiler, "-p", "run-bot-tsconfig.json"], consumer)
        if (additionalExamples.length > 0) {
            writeFileSync(
                join(consumer, "documentation-tsconfig.json"),
                JSON.stringify({
                    compilerOptions: {
                        target: "ES2024",
                        module: "NodeNext",
                        types: ["node"],
                        strict: true,
                        exactOptionalPropertyTypes: true,
                        noUncheckedIndexedAccess: true,
                        noEmit: true,
                        allowImportingTsExtensions: true,
                        lib: kind === "default" ? ["ES2024"] : ["ES2024", "ESNext.Disposable", "DOM"],
                    },
                    files: additionalExamples,
                }),
            )
            run(process.execPath, [compiler, "-p", "documentation-tsconfig.json"], consumer)
        }
        console.log(`${kind} additional authored documentation examples passed: ${additionalExamples.length}`)
        if (authoredGuideFixtures.typescript.length > 0) {
            writeFileSync(
                join(consumer, "authored-guide-typescript-tsconfig.json"),
                JSON.stringify({
                    compilerOptions: {
                        target: "ES2024",
                        module: "NodeNext",
                        types: ["node"],
                        strict: true,
                        exactOptionalPropertyTypes: true,
                        noUncheckedIndexedAccess: true,
                        noEmit: true,
                        allowJs: true,
                        checkJs: true,
                        allowImportingTsExtensions: true,
                        lib: kind === "default" ? ["ES2024"] : ["ES2024", "ESNext.Disposable", "DOM"],
                    },
                    files: authoredGuideFixtures.typescript,
                }),
            )
            run(process.execPath, [compiler, "-p", "authored-guide-typescript-tsconfig.json"], consumer)
        }
        if (authoredGuideFixtures.javascript.length > 0) {
            writeFileSync(
                join(consumer, "authored-guide-javascript-tsconfig.json"),
                JSON.stringify({
                    compilerOptions: {
                        target: "ES2024",
                        module: "NodeNext",
                        types: ["node"],
                        strict: true,
                        exactOptionalPropertyTypes: true,
                        noUncheckedIndexedAccess: true,
                        allowJs: true,
                        checkJs: false,
                        noEmit: true,
                        allowImportingTsExtensions: true,
                        lib: kind === "default" ? ["ES2024"] : ["ES2024", "ESNext.Disposable", "DOM"],
                    },
                    files: authoredGuideFixtures.javascript,
                }),
            )
            run(process.execPath, [compiler, "-p", "authored-guide-javascript-tsconfig.json"], consumer)
        }
        console.log(
            `${kind} authored website guide examples passed: ${authoredGuideFixtures.javascript.length} JavaScript and ${authoredGuideFixtures.typescript.length} TypeScript`,
        )
        const exampleCompilerOptions = {
            target: "ES2024",
            module: "NodeNext",
            types: ["node"],
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            noEmit: true,
            allowJs: true,
            checkJs: true,
            allowImportingTsExtensions: true,
            lib: kind === "default" ? ["ES2024"] : ["ES2024", "ESNext.Disposable", "DOM"],
        }
        for (const { language, files, compilerOptions } of [
            {
                language: "typescript",
                files: repositoryExampleFixtures.typescript,
                compilerOptions: exampleCompilerOptions,
            },
            // Parameter annotations exist only in the TypeScript source, whose strict check covers them
            {
                language: "javascript",
                files: repositoryExampleFixtures.javascript,
                compilerOptions: { ...exampleCompilerOptions, noImplicitAny: false },
            },
        ]) {
            if (files.length === 0) continue
            const config = `repository-example-${language}-tsconfig.json`
            writeFileSync(join(consumer, config), JSON.stringify({ compilerOptions, files }))
            run(process.execPath, [compiler, "-p", config], consumer)
        }
        console.log(
            `${kind} repository example programs passed: ${repositoryExampleFixtures.javascript.length} JavaScript and ${repositoryExampleFixtures.typescript.length} TypeScript`,
        )
        if (kind === "default") {
            copyFileSync(join(fixtureDirectory, "javascript-tooling.js"), join(consumer, "javascript-tooling.js"))
            writeFileSync(
                join(consumer, "javascript-tooling-tsconfig.json"),
                JSON.stringify({
                    compilerOptions: {
                        target: "ES2024",
                        module: "NodeNext",
                        types: ["node"],
                        lib: ["ES2024"],
                        strict: true,
                        exactOptionalPropertyTypes: true,
                        noUncheckedIndexedAccess: true,
                        allowJs: true,
                        checkJs: true,
                        noEmit: true,
                    },
                    files: ["javascript-tooling.js"],
                }),
            )
            run(process.execPath, [compiler, "-p", "javascript-tooling-tsconfig.json"], consumer)
            console.log("Packed checked-JavaScript inference, Result narrowing and invalid-input diagnostics passed")
        }
        const invocation =
            kind === "default"
                ? "import { createAndReadState } from './out/consumer.js'; if (createAndReadState('fixture-only-not-a-credential') !== 'Disconnected') throw Error('Unexpected state')"
                : "import { Effect } from 'effect'; import { createWithinCallerScope } from './out/consumer.js'; const client = await Effect.runPromise(Effect.scoped(createWithinCallerScope('fixture-only-not-a-credential'))); if (client.state !== 'Closed') throw Error('Scope did not close client')"
        run(process.execPath, ["--input-type=module", "--eval", invocation], consumer, 10_000)
        const testingInvocation =
            kind === "default"
                ? "import { pingTest } from './out/testing-consumer.js'; const requests = await pingTest(); if (requests.length !== 1) throw Error('The respond handler did not run once')"
                : "import { Effect } from 'effect'; import { pingTest } from './out/testing-consumer.js'; const requests = await Effect.runPromise(pingTest); if (requests.length !== 1) throw Error('The respond handler did not run once')"
        run(process.execPath, ["--input-type=module", "--eval", testingInvocation], consumer, 15_000)
        console.log(`${kind} TypeScript 7 packed consumer passed`)
    }
    const incompatibleEffect = join(temporary, "incompatible-effect")
    mkdirSync(incompatibleEffect)
    writeFileSync(join(incompatibleEffect, "package.json"), JSON.stringify({ name: "effect", version: "4.0.0-rc.116" }))
    const incompatibleConsumer = join(temporary, "incompatible-consumer")
    mkdirSync(incompatibleConsumer)
    writeFileSync(
        join(incompatibleConsumer, "package.json"),
        JSON.stringify({
            private: true,
            type: "module",
            dependencies: {
                [manifest.name]: `file:${tarball.replaceAll("\\", "/")}`,
                effect: `file:${incompatibleEffect.replaceAll("\\", "/")}`,
            },
        }),
    )
    writeFileSync(join(incompatibleConsumer, "pnpm-workspace.yaml"), "allowBuilds:\n  msgpackr-extract: false\n")
    assert.throws(
        () =>
            packageManager(
                ["install", "--prefer-offline", "--ignore-scripts", "--strict-peer-dependencies"],
                incompatibleConsumer,
            ),
        (error) => /peer/i.test(String(error.stdout) + String(error.stderr)),
        "An Effect version outside the peer range must fail strict peer installation rather than silently use separate runtimes",
    )
    console.log("Native Effect outside the peer range rejected by strict peer installation")
} finally {
    const target = realpathSync(temporary)
    assert.equal(dirname(target), temporaryRoot)
    assert.ok(target.startsWith(`${temporaryRoot}${sep}`) && resolve(target) === resolve(temporary))
    rmSync(target, { recursive: true })
}
