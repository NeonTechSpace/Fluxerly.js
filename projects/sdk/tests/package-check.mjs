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

const temporaryRoot = realpathSync(tmpdir())
const temporary = mkdtempSync(join(temporaryRoot, "fluxerly-package-check-"))
try {
    const tarball = join(temporary, "sdk.tgz")
    const packed = JSON.parse(packageManager(["pack", "--out", tarball, "--json"], sdk))
    const files = packed.files.map((file) => file.path)
    for (const entry of ["index", "effect", "cache"]) {
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
        assert.deepEqual(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).engines, manifest.engines)
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
            "messages",
            "events",
            "message-errors",
            "collectors",
            "pagination",
            "logging",
            "embeds",
            "attachments",
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
            "messages",
            "helpers",
            "message-search",
            "role-hierarchy",
            "assets",
        ]) {
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

        copyFileSync(join(fixtureDirectory, `${kind}.ts`), join(consumer, "consumer.ts"))
        const publicSource = readFileSync(join(sdk, "src", kind === "default" ? "index.ts" : "effect.ts"), "utf8")
        const publicExamples = examples(publicSource)
        const nicknameExamples = publicExamples.filter((example) => /function nicknameExample/.test(example))
        assert.equal(nicknameExamples.length, 1)
        writeFileSync(join(consumer, "nickname-example.ts"), nicknameExamples[0])
        const hierarchySource =
            kind === "default" ? readFileSync(join(sdk, "src/role-hierarchy.ts"), "utf8") : publicSource
        const hierarchyExamples = examples(hierarchySource).filter((example) =>
            /function hierarchyExample/.test(example),
        )
        assert.equal(hierarchyExamples.length, 1)
        writeFileSync(join(consumer, "hierarchy-example.ts"), hierarchyExamples[0])
        const userExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) (?:notifyUserExample|botProfileExample)/.test(example))
        assert.equal(userExamples.length, 2)
        for (const [index, example] of userExamples.entries())
            writeFileSync(join(consumer, `user-example-${index}.ts`), example)
        const webhookExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) webhookExample/.test(example))
        assert.equal(webhookExamples.length, 1)
        writeFileSync(join(consumer, "webhook-example.ts"), webhookExamples[0])
        const collectorExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) askName/.test(example))
        assert.equal(collectorExamples.length, 1)
        const collectorProgressExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) messageCollectorProgressExample/.test(example))
        assert.equal(collectorProgressExamples.length, 1)
        writeFileSync(join(consumer, "collector-progress-example.ts"), collectorProgressExamples[0])
        const pinsExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) pinsExample/.test(example))
        assert.equal(pinsExamples.length, 1)
        writeFileSync(join(consumer, "pins-example.ts"), pinsExamples[0])
        const readExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) readExample/.test(example))
        assert.equal(readExamples.length, 1)
        writeFileSync(join(consumer, "read-example.ts"), readExamples[0])
        const messageSearchExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:(?:async )?function|const) messageSearch(?:Page|Traversal)Example/.test(example))
        assert.equal(messageSearchExamples.length, 2)
        for (const [index, example] of messageSearchExamples.entries())
            writeFileSync(join(consumer, `message-search-example-${index}.ts`), example)
        const guildExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) =>
                /(?:function|const) (?:(?:assign|create)RoleExample|cachedRoleNamesExample|orderRoleDisplay)/.test(
                    example,
                ),
            )
        assert.equal(guildExamples.length, 4)
        const channelExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) channelExample/.test(example))
        assert.equal(channelExamples.length, 1)
        writeFileSync(join(consumer, "channel-example.ts"), channelExamples[0])
        const cleanupExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) cleanupExample/.test(example))
        assert.equal(cleanupExamples.length, 1)
        writeFileSync(join(consumer, "cleanup-example.ts"), cleanupExamples[0])
        const typingExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) typingExample/.test(example))
        assert.equal(typingExamples.length, 1)
        writeFileSync(join(consumer, "typing-example.ts"), typingExamples[0])
        const moderationExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) moderationExample/.test(example))
        assert.equal(moderationExamples.length, 1)
        writeFileSync(join(consumer, "moderation-example.ts"), moderationExamples[0])
        const paginationExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) pagination(?:History|Reaction|Pins|Members)Example/.test(example))
        assert.equal(paginationExamples.length, 4)
        for (const [index, example] of paginationExamples.entries())
            writeFileSync(join(consumer, `pagination-example-${index}.ts`), example)
        for (const [index, example] of guildExamples.entries())
            writeFileSync(join(consumer, `guild-example-${index}.ts`), example)
        // Compile the actual authored example against the packed exports, not a separately maintained copy
        writeFileSync(join(consumer, "collector-example.ts"), collectorExamples[0])
        const reactionExamples = [...publicSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /(?:function|const) reaction(?:Users|Moderation|Collector)?Example/.test(example))
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
        const loggingExamples = [...loggingSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /function loggingExample/.test(example))
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
            const examples = [...source.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
                .map((match) =>
                    match[1]
                        .split(/\r?\n/)
                        .map((line) => line.replace(/^\s*\* ?/, ""))
                        .join("\n"),
                )
                .filter((example) =>
                    /function (expression|expressionEvents|sticker|invite|audit|guildSettings|administrativeEvents|discovery|permissions|memberSearch|helpers|assets)Example/.test(
                        example,
                    ),
                )
            assert.equal(examples.length, entry === "events" ? 2 : 1)
            for (const [index, authored] of examples.entries()) {
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
            const nativeHelperExamples = [...nativeHelperSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
                .map((match) =>
                    match[1]
                        .split(/\r?\n/)
                        .map((line) => line.replace(/^\s*\* ?/, ""))
                        .join("\n"),
                )
                .filter((example) => /const helpersEffectExample/.test(example))
            assert.equal(nativeHelperExamples.length, 1)
            writeFileSync(join(consumer, "helpers-effect-example.ts"), nativeHelperExamples[0])
            const nativeAssetExamples = [...nativeHelperSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
                .map((match) =>
                    match[1]
                        .split(/\r?\n/)
                        .map((line) => line.replace(/^\s*\* ?/, ""))
                        .join("\n"),
                )
                .filter((example) => /const assetsEffectExample/.test(example))
            assert.equal(nativeAssetExamples.length, 1)
            writeFileSync(join(consumer, "assets-effect-example.ts"), nativeAssetExamples[0])
        }
        const embedExamples = [...embedSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)].map((match) =>
            match[1]
                .split(/\r?\n/)
                .map((line) => line.replace(/^\s*\* ?/, ""))
                .join("\n"),
        )
        assert.equal(embedExamples.length, 1)
        writeFileSync(join(consumer, "embed-example.ts"), embedExamples[0])
        const attachmentSource = readFileSync(join(sdk, "src/attachments.ts"), "utf8")
        const attachmentExamples = [...attachmentSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)].map((match) =>
            match[1]
                .split(/\r?\n/)
                .map((line) => line.replace(/^\s*\* ?/, ""))
                .join("\n"),
        )
        assert.equal(attachmentExamples.length, 1)
        writeFileSync(join(consumer, "attachment-example.ts"), attachmentExamples[0])
        const messageSource = readFileSync(join(sdk, "src/messages.ts"), "utf8")
        const messageMetadataExamples = [...messageSource.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
            .map((match) =>
                match[1]
                    .split(/\r?\n/)
                    .map((line) => line.replace(/^\s*\* ?/, ""))
                    .join("\n"),
            )
            .filter((example) => /function messageMetadataExample/.test(example))
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
