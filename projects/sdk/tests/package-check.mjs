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
        const publicExamples = examples(publicSource)
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
            ...[
                "forwardExample",
                "profileExample",
                "countsExample",
                "roleSetExample",
                "attachmentDeleteExample",
                "memberChunksExample",
                "shardingExample",
                "pureHelpersExample",
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
        const hierarchyExamples = examples(hierarchySource).filter((example) =>
            /function hierarchyExample/.test(example),
        )
        assert.equal(hierarchyExamples.length, 1)
        writeFileSync(join(consumer, "hierarchy-example.ts"), hierarchyExamples[0])
        const hierarchyWorkflowExamples = publicExamples.filter((example) => /hierarchyCheckExample/.test(example))
        assert.equal(hierarchyWorkflowExamples.length, 1)
        writeFileSync(join(consumer, "hierarchy-workflow-example.ts"), hierarchyWorkflowExamples[0])
        const cleanupWorkflowExamples = publicExamples.filter((example) => /cleanupWorkflowExample/.test(example))
        assert.equal(cleanupWorkflowExamples.length, 1)
        writeFileSync(join(consumer, "cleanup-workflow-example.ts"), cleanupWorkflowExamples[0])
        const guildListExamples = publicExamples.filter((example) => /guildListExample/.test(example))
        assert.equal(guildListExamples.length, 1)
        writeFileSync(join(consumer, "guild-list-example.ts"), guildListExamples[0])
        const guildMembershipExamples = examples(publicSource).filter((example) =>
            /function guildMembershipsExample/.test(example),
        )
        assert.equal(guildMembershipExamples.length, 1)
        writeFileSync(join(consumer, "guild-memberships-example.ts"), guildMembershipExamples[0])
        const userExamples = examples(publicSource).filter((example) =>
            /(?:function|const) (?:notifyUserExample|botProfileExample)/.test(example),
        )
        assert.equal(userExamples.length, 2)
        for (const [index, example] of userExamples.entries())
            writeFileSync(join(consumer, `user-example-${index}.ts`), example)
        const webhookExamples = examples(publicSource).filter((example) =>
            /(?:function|const) webhookExample/.test(example),
        )
        assert.equal(webhookExamples.length, 1)
        writeFileSync(join(consumer, "webhook-example.ts"), webhookExamples[0])
        const collectorExamples = examples(publicSource).filter((example) => /(?:function|const) askName/.test(example))
        assert.equal(collectorExamples.length, 1)
        const collectorProgressExamples = examples(publicSource).filter((example) =>
            /(?:function|const) messageCollectorProgressExample/.test(example),
        )
        assert.equal(collectorProgressExamples.length, 1)
        writeFileSync(join(consumer, "collector-progress-example.ts"), collectorProgressExamples[0])
        const pinsExamples = examples(publicSource).filter((example) => /(?:function|const) pinsExample/.test(example))
        assert.equal(pinsExamples.length, 1)
        writeFileSync(join(consumer, "pins-example.ts"), pinsExamples[0])
        const readExamples = examples(publicSource).filter((example) => /(?:function|const) readExample/.test(example))
        assert.equal(readExamples.length, 1)
        writeFileSync(join(consumer, "read-example.ts"), readExamples[0])
        const messageSearchExamples = examples(publicSource).filter((example) =>
            /(?:(?:async )?function|const) messageSearch(?:Page|Traversal)Example/.test(example),
        )
        assert.equal(messageSearchExamples.length, 2)
        for (const [index, example] of messageSearchExamples.entries())
            writeFileSync(join(consumer, `message-search-example-${index}.ts`), example)
        const applicationExamples = examples(publicSource).filter((example) =>
            /(?:function|const) applicationExample/.test(example),
        )
        assert.equal(applicationExamples.length, 1)
        writeFileSync(join(consumer, "application-example.ts"), applicationExamples[0])
        const oauthExamples = publicExamples.filter((example) =>
            kind === "default" ? /function oauthExample/.test(example) : /const oauthEffectExample/.test(example),
        )
        assert.equal(oauthExamples.length, 1)
        writeFileSync(join(consumer, "oauth-example.ts"), oauthExamples[0])
        const guildExamples = examples(publicSource).filter((example) =>
            /(?:function|const) (?:(?:assign|create)RoleExample|cachedRoleNamesExample|orderRoleDisplay)/.test(example),
        )
        assert.equal(guildExamples.length, 4)
        const channelExamples = examples(publicSource).filter((example) =>
            /(?:function|const) channelExample/.test(example),
        )
        assert.equal(channelExamples.length, 1)
        writeFileSync(join(consumer, "channel-example.ts"), channelExamples[0])
        const cleanupExamples = examples(publicSource).filter((example) =>
            /(?:function|const) cleanupExample/.test(example),
        )
        assert.equal(cleanupExamples.length, 1)
        writeFileSync(join(consumer, "cleanup-example.ts"), cleanupExamples[0])
        const deleteMineExamples = examples(publicSource).filter((example) =>
            /(?:function|const) deleteMineExample/.test(example),
        )
        assert.equal(deleteMineExamples.length, 1)
        writeFileSync(join(consumer, "delete-mine-example.ts"), deleteMineExamples[0])
        const typingExamples = examples(publicSource).filter((example) =>
            /(?:function|const) typingExample/.test(example),
        )
        assert.equal(typingExamples.length, 1)
        writeFileSync(join(consumer, "typing-example.ts"), typingExamples[0])
        const moderationExamples = examples(publicSource).filter((example) =>
            /(?:function|const) moderationExample/.test(example),
        )
        assert.equal(moderationExamples.length, 1)
        writeFileSync(join(consumer, "moderation-example.ts"), moderationExamples[0])
        const paginationExamples = examples(publicSource).filter((example) =>
            /(?:function|const) pagination(?:History|Reaction|Pins|Members)Example/.test(example),
        )
        assert.equal(paginationExamples.length, 4)
        for (const [index, example] of paginationExamples.entries())
            writeFileSync(join(consumer, `pagination-example-${index}.ts`), example)
        for (const [index, example] of guildExamples.entries())
            writeFileSync(join(consumer, `guild-example-${index}.ts`), example)
        // Compile the actual authored example against the packed exports, not a separately maintained copy
        writeFileSync(join(consumer, "collector-example.ts"), collectorExamples[0])
        const reactionExamples = examples(publicSource).filter((example) =>
            /(?:function|const) reaction(?:Users|Moderation|Collector)?Example/.test(example),
        )
        assert.equal(reactionExamples.length, 4)
        writeFileSync(
            join(consumer, "reaction-collector-example.ts"),
            reactionExamples.find((example) => /reactionCollectorExample/.test(example)),
        )
        writeFileSync(
            join(consumer, "reaction-example.ts"),
            reactionExamples.find((example) => /reactionExample/.test(example)),
        )
        writeFileSync(
            join(consumer, "reaction-users-example.ts"),
            reactionExamples.find((example) => /reactionUsersExample/.test(example)),
        )
        const loggingSource = readFileSync(join(sdk, "src", kind === "default" ? "client.ts" : "effect.ts"), "utf8")
        writeFileSync(
            join(consumer, "reaction-moderation-example.ts"),
            reactionExamples.find((example) => /reactionModerationExample/.test(example)),
        )
        const loggingExamples = examples(loggingSource).filter((example) => /function loggingExample/.test(example))
        assert.equal(loggingExamples.length, 1)
        writeFileSync(join(consumer, "logging-example.ts"), loggingExamples[0])
        const embedSource = readFileSync(join(sdk, "src/embeds.ts"), "utf8")
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
            const entryExamples = examples(source).filter((example) =>
                /function (expression|expressionEvents|sticker|invite|audit|guildSettings|administrativeEvents|discovery|permissions|memberSearch|helpers|assets)Example/.test(
                    example,
                ),
            )
            assert.equal(entryExamples.length, entry === "events" ? 2 : 1)
            for (const [index, authored] of entryExamples.entries()) {
                const example =
                    kind === "default"
                        ? authored
                        : authored.replaceAll('"@neontechspace/fluxerly"', '"@neontechspace/fluxerly/effect"')
                writeFileSync(join(consumer, `${entry}-example-${index}.ts`), example)
            }
        }
        const guildEventExamples = examples(readFileSync(join(sdk, "src/events.ts"), "utf8")).filter((example) =>
            /function guildEventsExample/.test(example),
        )
        assert.equal(guildEventExamples.length, 1)
        writeFileSync(
            join(consumer, "guild-events-example.ts"),
            kind === "default"
                ? guildEventExamples[0]
                : guildEventExamples[0].replaceAll('"@neontechspace/fluxerly"', '"@neontechspace/fluxerly/effect"'),
        )
        if (kind === "effect") {
            const nativeHelperSource = readFileSync(join(sdk, "src/effect.ts"), "utf8")
            const nativeHelperExamples = examples(nativeHelperSource).filter((example) =>
                /const helpersEffectExample/.test(example),
            )
            assert.equal(nativeHelperExamples.length, 1)
            writeFileSync(join(consumer, "helpers-effect-example.ts"), nativeHelperExamples[0])
            const nativeAssetExamples = examples(nativeHelperSource).filter((example) =>
                /const assetsEffectExample/.test(example),
            )
            assert.equal(nativeAssetExamples.length, 1)
            writeFileSync(join(consumer, "assets-effect-example.ts"), nativeAssetExamples[0])
        }
        const presenceEventSource = readFileSync(join(sdk, "src/events.ts"), "utf8")
        const presenceEventExamples = examples(presenceEventSource).filter((example) =>
            /function presenceEventsExample/.test(example),
        )
        assert.equal(presenceEventExamples.length, 1)
        const presenceEventExample =
            kind === "default"
                ? presenceEventExamples[0]
                : presenceEventExamples[0].replaceAll('"@neontechspace/fluxerly"', '"@neontechspace/fluxerly/effect"')
        writeFileSync(join(consumer, "presence-events-example.ts"), presenceEventExample)
        const selectedPresenceExamples = examples(publicSource).filter((example) => /watchSelectedMember/.test(example))
        assert.equal(selectedPresenceExamples.length, 1)
        writeFileSync(join(consumer, "selected-presence-example.ts"), selectedPresenceExamples[0])
        const embedExamples = examples(embedSource)
        assert.equal(embedExamples.length, 1)
        writeFileSync(join(consumer, "embed-example.ts"), embedExamples[0])
        const attachmentSource = readFileSync(join(sdk, "src/attachments.ts"), "utf8")
        const attachmentExamples = examples(attachmentSource)
        assert.equal(attachmentExamples.length, 2)
        for (const [index, example] of attachmentExamples.entries())
            writeFileSync(
                join(consumer, `attachment-example-${index}.ts`),
                kind === "default"
                    ? example
                    : example.replaceAll('"@neontechspace/fluxerly"', '"@neontechspace/fluxerly/effect"'),
            )
        const messageSource = readFileSync(join(sdk, "src/messages.ts"), "utf8")
        const messageMetadataExamples = examples(messageSource).filter((example) =>
            /function messageMetadataExample/.test(example),
        )
        assert.equal(messageMetadataExamples.length, 1)
        writeFileSync(
            join(consumer, "message-metadata-example.ts"),
            kind === "default"
                ? messageMetadataExamples[0]
                : messageMetadataExamples[0].replaceAll(
                      '"@neontechspace/fluxerly"',
                      '"@neontechspace/fluxerly/effect"',
                  ),
        )
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
