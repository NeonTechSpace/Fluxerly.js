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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { API } from "typescript/unstable/sync"

const sdk = fileURLToPath(new URL("../", import.meta.url))
const fixtureDirectory = fileURLToPath(new URL("./consumers/", import.meta.url))
const manifest = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"))
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
const pnpm = process.env.npm_execpath
assert.ok(pnpm, "Run the package check through pnpm run test:package")
console.log(`Packed consumer check runtime: Node ${process.version}`)

function run(command, args, cwd, timeout = 120_000) {
    return execFileSync(command, args, { cwd, timeout, encoding: "utf8", windowsHide: true })
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

function writeNamedExampleFixtures(consumer, source, fixtures) {
    const authoredExamples = examples(source)
    for (const {
        name,
        matches,
        count = 1,
        file = (index) => `${name}-${index}.ts`,
        rewrite = (example) => example,
    } of fixtures) {
        const selected = authoredExamples.filter(matches)
        assert.equal(selected.length, count, `Expected ${count} exact ${name} example(s)`)
        for (const [index, example] of selected.entries()) writeFileSync(join(consumer, file(index)), rewrite(example))
    }
}

const sourceCommentApi = new API({ cwd: sdk })
const sourceCommentSnapshot = sourceCommentApi.updateSnapshot({ openProjects: ["tsconfig.json"] })
const sourceCommentProject = sourceCommentSnapshot
    .getProjects()
    .find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
assert.ok(sourceCommentProject, "TypeScript project was not loaded")
const symbolIsAlias = 1 << 21
const documentedHelpers = ["format", "snowflakes", "display", "permissionBits", "colors", "text", "links", "assets"]

function helperMemberComments(project, file, names = documentedHelpers) {
    const source = project.program.getSourceFile(file)
    assert.ok(source, `Helper documentation entry ${file} was not loaded`)
    const module = project.checker.getSymbolAtLocation(source)
    assert.ok(module, `Helper documentation entry ${file} is not a module`)
    const exports = new Map(project.checker.getExportsOfModule(module).map((symbol) => [symbol.name, symbol]))
    return names.map((name) => {
        const exported = exports.get(name)
        assert.ok(exported, `Helper ${name} is missing`)
        const symbol = exported.flags & symbolIsAlias ? project.checker.getAliasedSymbol(exported) : exported
        const members = project.checker.getPropertiesOfType(project.checker.getTypeOfSymbol(symbol))
        assert.ok(members.length > 0, `Helper ${name} has no visible members`)
        return [
            name,
            members.map((member) => {
                const comment = project.checker.getDocumentationCommentOfSymbol(member)
                assert.ok(comment.length > 0, `Consumer helper ${name}.${member.name} has no member documentation`)
                return [member.name, comment]
            }),
        ]
    })
}

function assertPackedHelperComments(consumer, kind) {
    const api = new API({ cwd: consumer })
    try {
        const project = api
            .updateSnapshot({ openProjects: ["tsconfig.json"] })
            .getProjects()
            .find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
        assert.ok(project, "Packed helper documentation project was not loaded")
        assert.deepEqual(
            helperMemberComments(project, join(consumer, "helper-comments.ts")),
            helperMemberComments(sourceCommentProject, join(sdk, "src", kind === "default" ? "index.ts" : "effect.ts")),
            `${kind} packed helper member documentation differs from source`,
        )
    } finally {
        api.close()
    }
}

const publicCommentOwners = new Map()

function sourceEntry(sourceRoot, sourceFile) {
    const relativePath = relative(sourceRoot, sourceFile.fileName).replaceAll("\\", "/")
    assert.ok(
        relativePath.endsWith(".ts") && !relativePath.startsWith("../"),
        `Unsupported public comment owner ${sourceFile.fileName}`,
    )
    return relativePath.slice(0, -3)
}

function enclosingStatement(sourceFile, declaration) {
    return sourceFile.statements.find(
        (statement) =>
            statement.index === declaration.index ||
            statement.declarationList?.declarations?.some((candidate) => candidate.index === declaration.index),
    )
}

function declarationComments(owner, sourceFile) {
    const comments = []
    // Include nested public types, but not comments inside function implementations
    const visit = (node) => {
        for (const comment of node.jsDoc ?? []) comments.push(comment.getText(sourceFile))
        node.forEachChild((child) => {
            if (child !== node.body) visit(child)
        })
    }
    visit(owner)
    return comments
}

function collectExportedOwnerComments(project, sourceRoot, entry, cache) {
    const cached = cache.get(entry)
    if (cached) return cached
    const sourceFile = project.program.getSourceFile(`${sourceRoot}/${entry}.ts`)
    assert.ok(sourceFile, `Source entry src/${entry}.ts was not loaded`)
    const module = project.checker.getSymbolAtLocation(sourceFile)
    assert.ok(module, `Source entry src/${entry}.ts is not a module`)
    const comments = new Map()
    for (const exported of project.checker.getExportsOfModule(module)) {
        const symbol = exported.flags & symbolIsAlias ? project.checker.getAliasedSymbol(exported) : exported
        for (const declaration of symbol.declarations) {
            const ownerSource = project.program.getSourceFile(declaration.path)
            if (!ownerSource) continue
            const owner = enclosingStatement(ownerSource, declaration)
            if (!owner) continue
            const ownerEntry = sourceEntry(sourceRoot, ownerSource)
            const entryComments = comments.get(ownerEntry) ?? []
            entryComments.push(...declarationComments(owner, ownerSource))
            comments.set(ownerEntry, entryComments)
        }
    }
    cache.set(entry, comments)
    return comments
}

function exportedOwnerComments(entry) {
    return collectExportedOwnerComments(sourceCommentProject, join(sdk, "src"), entry, publicCommentOwners)
}

function assertExportedOwnerCommentGuards() {
    const temporary = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-comment-guard-"))
    const sourceRoot = join(temporary, "src")
    mkdirSync(sourceRoot)
    writeFileSync(join(temporary, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext" } }))
    writeFileSync(
        join(sourceRoot, "entry.ts"),
        `/** direct fixture documentation */\nexport const direct = 1\nexport type { Shared } from "./shared.js"\n`,
    )
    writeFileSync(
        join(sourceRoot, "shared.ts"),
        `/** reexported fixture documentation */\nexport type Shared = {\n    /** reexported member documentation */\n    readonly value: string\n} & {\n    /** nested member documentation */\n    readonly options: {\n        /** nested option documentation */\n        readonly enabled: boolean\n    }\n}\n`,
    )
    const documentedHelper = `export declare const helper: {\n    /** Member documentation */\n    readonly value: string\n}\n`
    writeFileSync(join(sourceRoot, "helper.ts"), documentedHelper)
    writeFileSync(join(sourceRoot, "missing.ts"), documentedHelper.replace("/** Member documentation */", ""))
    const api = new API({ cwd: temporary })
    try {
        const snapshot = api.updateSnapshot({ openProjects: ["tsconfig.json"] })
        const project = snapshot.getProjects().find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
        assert.ok(project, "Comment guard fixture project was not loaded")
        const comments = collectExportedOwnerComments(project, sourceRoot, "entry", new Map())
        const normalizeComment = (comment) => comment.replace(/\s+/g, " ").trim()
        assert.deepEqual(comments.get("entry")?.map(normalizeComment), ["/** direct fixture documentation */"])
        assert.deepEqual(comments.get("shared")?.map(normalizeComment), [
            "/** reexported fixture documentation */",
            "/** reexported member documentation */",
            "/** nested member documentation */",
            "/** nested option documentation */",
        ])
        assert.deepEqual(helperMemberComments(project, join(sourceRoot, "helper.ts"), ["helper"]), [
            ["helper", [["value", "Member documentation"]]],
        ])
        assert.throws(
            () => helperMemberComments(project, join(sourceRoot, "missing.ts"), ["helper"]),
            /Consumer helper helper.value has no member documentation/,
        )
    } finally {
        api.close()
        const target = realpathSync(temporary)
        assert.equal(dirname(target), realpathSync(tmpdir()))
        rmSync(target, { recursive: true })
    }
}

assertExportedOwnerCommentGuards()

const temporaryRoot = realpathSync(tmpdir())
const temporary = mkdtempSync(join(temporaryRoot, "fluxerly-package-check-"))
try {
    const tarball = join(temporary, "sdk.tgz")
    const packed = JSON.parse(packageManager(["pack", "--out", tarball, "--json"], sdk))
    const files = packed.files.map((file) => file.path)
    for (const entry of ["index", "effect", "cache", "application", "sharding"]) {
        for (const extension of ["js", "js.map", "d.ts", "d.ts.map"]) {
            assert.ok(files.includes(`dist/${entry}.${extension}`))
        }
    }
    assert.ok(files.every((file) => file === "package.json" || file.startsWith("dist/") || file.startsWith("src/")))

    copyFileSync(join(sdk, "tests/hosted-discovery.mjs"), join(temporary, "hosted-discovery.mjs"))
    for (const kind of ["default", "effect"]) {
        const consumer = join(temporary, kind)
        mkdirSync(consumer)
        const dependencies = { [manifest.name]: `file:${tarball.replaceAll("\\", "/")}` }
        if (kind === "effect") dependencies.effect = manifest.dependencies.effect
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
        packageManager(["install", "--offline", "--strict-peer-dependencies"], consumer)

        const installed = join(consumer, "node_modules", manifest.name)
        assert.deepEqual(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).imports, manifest.imports)
        assert.deepEqual(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).engines, manifest.engines)
        const apiErrorExamples = examples(readFileSync(join(sdk, "src", "api-errors.ts"), "utf8")).filter((example) =>
            /function formatApiErrorDetail/.test(example),
        )
        assert.equal(apiErrorExamples.length, 1)
        writeFileSync(
            join(consumer, "api-error-detail-example.ts"),
            kind === "default"
                ? apiErrorExamples[0]
                : apiErrorExamples[0].replaceAll('"@neontechspace/fluxerly"', '"@neontechspace/fluxerly/effect"'),
        )
        const inputValidationSource = readFileSync(join(sdk, "src", "input-validation.ts"), "utf8")
        writeNamedExampleFixtures(
            consumer,
            kind === "default"
                ? inputValidationSource
                : inputValidationSource.replaceAll('"@neontechspace/fluxerly"', '"@neontechspace/fluxerly/effect"'),
            [
                {
                    name: "input-validation",
                    matches: (example) => /function readInputValidation/.test(example),
                    file: () => "input-validation-example.ts",
                },
            ],
        )
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
        for (const entry of [
            "index",
            "effect",
            "cache",
            "client",
            "errors",
            "api-errors",
            "input-validation",
            "oauth",
            "messages",
            "events",
            "message-errors",
            "message-cleanup",
            "collectors",
            "pagination",
            "logging",
            "embeds",
            "attachments",
            "instance",
            "reactions",
            "pins",
            "guilds",
            "channels",
            "webhooks",
            "users",
            "presence",
            "expressions",
            "invites",
            "audit-logs",
            "discovery",
            "permissions",
            "member-search",
            "helpers",
            "colors",
            "text",
            "message-search",
            "role-hierarchy",
            "assets",
            "application",
            "builders",
            "supervisor",
            "commands",
            "command-arguments",
            "command-help",
            "default-commands",
            "native-commands",
            "default-supervisor",
            "native-supervisor",
            "counts",
            "member-chunks",
            "sharding",
        ]) {
            const declaration = `dist/${entry}.d.ts`
            assert.equal(
                readFileSync(join(installed, declaration), "utf8"),
                readFileSync(join(sdk, declaration), "utf8"),
            )
            const normalizeComment = (text) => text.replace(/\s+/g, " ").trim()
            for (const [owner, comments] of exportedOwnerComments(entry)) {
                const ownerDeclaration = readFileSync(join(installed, `dist/${owner}.d.ts`), "utf8")
                const emitted = [...ownerDeclaration.matchAll(/\/\*\*[\s\S]*?\*\//g)].map(([comment]) =>
                    normalizeComment(comment),
                )
                for (const comment of comments)
                    assert.ok(
                        emitted.includes(normalizeComment(comment)),
                        `Public comment missing from packed dist/${owner}.d.ts`,
                    )
            }
        }
        const defaultDeclarations = readFileSync(join(installed, "dist/index.d.ts"), "utf8")
        assert.match(
            defaultDeclarations,
            /export type \{ CachePolicyErrorReport, MessageCacheSettings, MessageCacheOptions \} from "\.\/cache\.js"/,
        )
        const nativeDeclarations = readFileSync(join(installed, "dist/effect.d.ts"), "utf8")
        assert.match(nativeDeclarations, /export interface MessageCacheOptions<E = never, R = never>/)
        for (const file of files.filter((file) => file.endsWith(".map"))) {
            const sourceMap = JSON.parse(readFileSync(join(installed, file), "utf8"))
            assert.ok(sourceMap.sources.length > 0)
            for (const source of sourceMap.sources) {
                const resolved = resolve(installed, dirname(file), sourceMap.sourceRoot ?? "", source)
                const packedPath = relative(installed, resolved)
                assert.ok(!isAbsolute(packedPath) && packedPath !== ".." && !packedPath.startsWith(`..${sep}`))
                assert.ok(existsSync(resolved))
            }
        }

        if (kind === "default") assert.equal(existsSync(join(consumer, "node_modules/effect")), false)
        copyFileSync(join(fixtureDirectory, `${kind}.mjs`), join(consumer, "consumer.mjs"))
        process.stdout.write(run(process.execPath, ["--enable-source-maps", "consumer.mjs"], consumer, 10_000))
        copyFileSync(join(fixtureDirectory, "sharding-workflow.mjs"), join(consumer, "sharding-workflow.mjs"))
        process.stdout.write(
            run(process.execPath, ["--enable-source-maps", "sharding-workflow.mjs", kind], consumer, 15_000),
        )

        copyFileSync(join(fixtureDirectory, `${kind}.ts`), join(consumer, "consumer.ts"))
        writeFileSync(
            join(consumer, "helper-comments.ts"),
            `export { ${documentedHelpers.join(", ")} } from ${JSON.stringify(kind === "default" ? manifest.name : `${manifest.name}/effect`)}\n`,
        )
        copyFileSync(join(fixtureDirectory, "event-waits.mjs"), join(consumer, "event-waits.mjs"))
        process.stdout.write(run(process.execPath, ["event-waits.mjs", kind], consumer, 10_000))
        writeFileSync(
            join(consumer, "builders-state.ts"),
            readFileSync(join(fixtureDirectory, "builders-state.ts"), "utf8").replaceAll(
                '"@neontechspace/fluxerly"',
                JSON.stringify(kind === "default" ? manifest.name : `${manifest.name}/effect`),
            ),
        )
        writeFileSync(
            join(consumer, "guild-feature-types.ts"),
            readFileSync(join(fixtureDirectory, "guild-feature-types.ts"), "utf8").replaceAll(
                '"@neontechspace/fluxerly"',
                JSON.stringify(kind === "default" ? manifest.name : `${manifest.name}/effect`),
            ),
        )
        const publicSource = readFileSync(join(sdk, "src", kind === "default" ? "index.ts" : "effect.ts"), "utf8")
        const publicFixtureInventory = [
            {
                name: "downloadChunks",
                matches: (example) => /function downloadChunks/.test(example),
                file: () => "attachment-stream-example.ts",
            },
            {
                name: "moveVoiceConnection",
                matches: (example) => /(?:function|const) moveVoiceConnection/.test(example),
                file: () => "voice-example.ts",
            },
            {
                name: "optional-tools",
                matches: (example) => /(?:function|const) installPing/.test(example),
                file: () => "optional-tools-example.ts",
            },
            {
                name: "instance",
                matches: (example) => /(?:function|const) instanceExample/.test(example),
                file: () => "instance-example.ts",
            },
            {
                name: "supervisor",
                matches: (example) => /const workers/.test(example),
                file: () => "supervisor-example.ts",
            },
            {
                name: "nickname",
                matches: (example) => /function nicknameExample/.test(example),
                file: () => "nickname-example.ts",
            },
            {
                name: "debugHandlerExample",
                matches: (example) => /function debugHandlerExample(?:<[^>]+>)?\(/.test(example),
                file: () => "debug-handler-example.ts",
            },
            {
                name: "eventWaitExample",
                matches: (example) => /function eventWaitExample\(/.test(example),
                file: () => "event-wait-example.ts",
            },
            ...[
                "forwardExample",
                "profileExample",
                "countsExample",
                "roleSetExample",
                "attachmentDeleteExample",
                "memberChunksExample",
                "shardingExample",
                "pureHelpersExample",
                "typedCommandExample",
                "commandHelpExample",
            ].map((name) => ({
                name,
                matches: (example) => example.includes(`function ${name}(`),
                file: () => `${name}.ts`,
            })),
        ]
        writeNamedExampleFixtures(consumer, publicSource, publicFixtureInventory)
        writeNamedExampleFixtures(consumer, publicSource, [
            {
                name: "runBot",
                matches: (example) => /(?:async function|const) runBot/.test(example),
                file: () => "run-bot-example.ts",
            },
        ])
        const hierarchySource =
            kind === "default" ? readFileSync(join(sdk, "src/role-hierarchy.ts"), "utf8") : publicSource
        writeNamedExampleFixtures(consumer, hierarchySource, [
            {
                name: "hierarchy",
                matches: (example) => /function hierarchyExample/.test(example),
                file: () => "hierarchy-example.ts",
            },
        ])
        writeNamedExampleFixtures(
            consumer,
            publicSource,
            [
                ["hierarchy-workflow", /hierarchyCheckExample/],
                ["cleanup-workflow", /cleanupWorkflowExample/],
                ["guild-list", /guildListExample/],
                ["guild-memberships", /function guildMembershipsExample/],
                ["user", /(?:function|const) (?:notifyUserExample|botProfileExample)/, 2],
                ["webhook", /(?:function|const) webhookExample/],
                ["collector", /(?:function|const) askName/],
                ["collector-progress", /(?:function|const) messageCollectorProgressExample/],
                ["pins", /(?:function|const) pinsExample/],
                ["read", /(?:function|const) readExample/],
                ["message-search", /(?:(?:async )?function|const) messageSearch(?:Page|Traversal)Example/, 2],
                ["application", /(?:function|const) applicationExample/],
                ["oauth", kind === "default" ? /function oauthExample/ : /const oauthEffectExample/],
                [
                    "guild",
                    /(?:function|const) (?:(?:assign|create)RoleExample|cachedRoleNamesExample|orderRoleDisplay)/,
                    4,
                ],
                ["channel", /(?:function|const) channelExample/],
                ["cleanup", /(?:function|const) cleanupExample/],
                ["delete-mine", /(?:function|const) deleteMineExample/],
                ["typing", /(?:function|const) typingExample/],
                ["moderation", /(?:function|const) moderationExample/],
                ["pagination", /(?:function|const) pagination(?:History|Reaction|Pins|Members)Example/, 4],
                ["reaction-collector", /(?:function|const) reactionCollectorExample/],
                ["reaction", /(?:function|const) reactionExample/],
                ["reaction-users", /(?:function|const) reactionUsersExample/],
                ["reaction-moderation", /(?:function|const) reactionModerationExample/],
                ["selected-presence", /watchSelectedMember/],
            ].map(([name, pattern, count = 1]) => ({
                name,
                matches: (example) => pattern.test(example),
                count,
                file: (index) => (count === 1 ? `${name}-example.ts` : `${name}-example-${index}.ts`),
            })),
        )
        const loggingSource = readFileSync(join(sdk, "src", kind === "default" ? "client.ts" : "effect.ts"), "utf8")
        writeNamedExampleFixtures(consumer, loggingSource, [
            {
                name: "logging",
                matches: (example) => /function loggingExample/.test(example),
                file: () => "logging-example.ts",
            },
        ])
        const rewriteSharedExample = (example) =>
            kind === "default"
                ? example
                : example.replaceAll('"@neontechspace/fluxerly"', '"@neontechspace/fluxerly/effect"')
        for (const entry of [
            "expressions",
            "messages",
            "invites",
            "audit-logs",
            "guilds",
            "events",
            "discovery",
            "permissions",
            "member-search",
            "helpers",
            "assets",
        ]) {
            const source = readFileSync(join(sdk, `src/${entry}.ts`), "utf8")
            writeNamedExampleFixtures(consumer, source, [
                {
                    name: `${entry}-example`,
                    matches: (example) =>
                        /function (expression|expressionEvents|sticker|invite|audit|guildSettings|administrativeEvents|discovery|permissions|memberSearch|helpers|assets)Example/.test(
                            example,
                        ),
                    count: entry === "events" ? 2 : 1,
                    rewrite: rewriteSharedExample,
                },
            ])
        }
        const eventSource = readFileSync(join(sdk, "src/events.ts"), "utf8")
        writeNamedExampleFixtures(
            consumer,
            eventSource,
            [
                ["guild-events", /function guildEventsExample/],
                ["presence-events", /function presenceEventsExample/],
            ].map(([name, pattern]) => ({
                name,
                matches: (example) => pattern.test(example),
                file: () => `${name}-example.ts`,
                rewrite: rewriteSharedExample,
            })),
        )
        if (kind === "effect") {
            writeNamedExampleFixtures(
                consumer,
                publicSource,
                [
                    ["helpers-effect", /const helpersEffectExample/],
                    ["assets-effect", /const assetsEffectExample/],
                ].map(([name, pattern]) => ({
                    name,
                    matches: (example) => pattern.test(example),
                    file: () => `${name}-example.ts`,
                })),
            )
        }
        writeNamedExampleFixtures(consumer, readFileSync(join(sdk, "src/embeds.ts"), "utf8"), [
            {
                name: "embed",
                matches: () => true,
                file: () => "embed-example.ts",
            },
        ])
        writeNamedExampleFixtures(consumer, readFileSync(join(sdk, "src/attachments.ts"), "utf8"), [
            {
                name: "attachment-example",
                matches: () => true,
                count: 2,
                rewrite: rewriteSharedExample,
            },
        ])
        writeNamedExampleFixtures(consumer, readFileSync(join(sdk, "src/messages.ts"), "utf8"), [
            {
                name: "message-metadata",
                matches: (example) => /function messageMetadataExample/.test(example),
                file: () => "message-metadata-example.ts",
                rewrite: rewriteSharedExample,
            },
        ])
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
                include: ["*.ts"],
                exclude: ["run-bot-example.ts"],
            }),
        )
        assertPackedHelperComments(consumer, kind)
        run(process.execPath, [compiler, "-p", "tsconfig.json"], consumer)
        copyFileSync(join(fixtureDirectory, "workflow.mjs"), join(consumer, "workflow.mjs"))
        process.stdout.write(run(process.execPath, ["--enable-source-maps", "workflow.mjs", kind], consumer, 15_000))
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
                    lib: kind === "default" ? ["ES2024"] : ["ES2024", "ESNext.Disposable", "DOM"],
                },
                files: ["run-bot-example.ts"],
            }),
        )
        run(process.execPath, [compiler, "-p", "run-bot-tsconfig.json"], consumer)
        const invocation =
            kind === "default"
                ? "import { createAndReadState } from './out/consumer.js'; if (createAndReadState('fixture-only-not-a-credential') !== 'Disconnected') throw Error('Unexpected state')"
                : "import { Effect } from 'effect'; import { createWithinCallerScope } from './out/consumer.js'; const client = await Effect.runPromise(Effect.scoped(createWithinCallerScope('fixture-only-not-a-credential'))); if (client.state !== 'Closed') throw Error('Scope did not close client')"
        run(process.execPath, ["--input-type=module", "--eval", invocation], consumer, 10_000)
        console.log(`${kind} TypeScript 7 packed consumer passed`)
    }
} finally {
    sourceCommentApi.close()
    const target = realpathSync(temporary)
    assert.equal(dirname(target), temporaryRoot)
    assert.ok(target.startsWith(`${temporaryRoot}${sep}`) && resolve(target) === resolve(temporary))
    rmSync(target, { recursive: true })
}
