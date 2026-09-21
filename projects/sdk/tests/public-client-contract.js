import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { API, NodeBuilderFlags } from "typescript/unstable/sync"

// TypeScript 7 exposes its installed compiler AST through unstable entry points. This build-time check adds no runtime SDK dependency
const clientNamespaces = [
    ["Instance", "instance"],
    ["Discovery", "discovery"],
    ["Presence", "presence"],
    ["CurrentBotApplication", "application"],
    ["Users", "users"],
    ["DirectMessages", "directMessages", "DirectMessages<M>"],
    ["Webhooks", "webhooks"],
    ["Roles", "roles"],
    ["PermissionHelpers", "permissions"],
    ["Guilds", "guilds"],
    ["Invites", "invites"],
    ["AuditLogs", "auditLogs"],
    ["Emojis", "emojis"],
    ["Stickers", "stickers"],
    ["Channels", "channels"],
    ["Members", "members"],
    ["Attachments", "attachments"],
    ["Messages", "messages", "Messages<M>"],
    ["ClientCache", "cache", "ClientCache<M>"],
]
const clientNamespaceTypes = clientNamespaces.map(([type]) => type)
const clientNamespaceSignatures = clientNamespaces.map(([type, , signature]) => signature ?? type)
const returnedHandles = ["Subscription", "Collector", "ReactionCollector"]
const pairedValues = ["format", "snowflakes", "display", "permissionBits", "colors", "text", "links", "assets"]
const pairedSurfaces = [
    "Client",
    "WebhookClient",
    "OAuthClient",
    ...returnedHandles,
    ...clientNamespaceTypes,
    ...pairedValues,
]
const inheritedClientMembers = ["state", "shards", "gatewayLatencyMs"]
const symbolIsAlias = 1 << 21
const structurallyDistinctMembers = new Set([
    "Client.events",
    "Client.observeState",
    "Client.on",
    "Collector.stop",
    "Messages.collect",
    "Messages.collectReactions",
    "Messages.keepTyping",
    "ReactionCollector.stop",
    "Subscription.unsubscribe",
])
const defaultSignalOnlyMembers = new Set([
    "Client.connect",
    "Client.run",
    "Client.waitForClose",
    "Collector.waitForClose",
    "ReactionCollector.waitForClose",
    "Subscription.waitForClose",
])

function splitTopLevel(value, separator) {
    const parts = []
    let depth = 0
    let quote = ""
    let start = 0
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]
        if (quote) {
            if (character === "\\") index += 1
            else if (character === quote) quote = ""
            continue
        }
        if (character === '"' || character === "'") quote = character
        else if ("(<[{".includes(character)) depth += 1
        else if (")>]}".includes(character)) depth -= 1
        else if (character === separator && depth === 0) {
            parts.push(value.slice(start, index))
            start = index + 1
        }
    }
    parts.push(value.slice(start))
    return parts
}

function genericArguments(value, name) {
    const prefix = `${name}<`
    if (!value.startsWith(prefix) || !value.endsWith(">")) return undefined
    let depth = 0
    for (let index = name.length; index < value.length; index += 1) {
        if (value[index] === "<") depth += 1
        else if (value[index] === ">") {
            depth -= 1
            if (depth === 0 && index !== value.length - 1) return undefined
        }
    }
    return splitTopLevel(value.slice(prefix.length, -1), ",")
}

function normalizeSharedType(value) {
    return value
        .replace(/\s+/g, "")
        .replace(/Default([A-Z][A-Za-z0-9]*Options)/g, "$1")
        .replaceAll("AttachmentStreamOptions", "AttachmentDownloadOptions")
        .replaceAll("MessageSearchOptions", "MessageOperationOptions")
}

function normalizeFailure(value, ignoredFailures) {
    const expected = splitTopLevel(normalizeSharedType(value), "|").filter(
        (failure) => !ignoredFailures.includes(failure),
    )
    return expected.sort().join("|") || "never"
}

function normalizeReturnType(value, ignoredFailures) {
    let arguments_ = genericArguments(value, "ResultAsync")
    if (arguments_)
        return `operation<${normalizeSharedType(arguments_[0])},${normalizeFailure(arguments_[1], ignoredFailures)}>`
    arguments_ = genericArguments(value, "Result")
    if (arguments_)
        return `operation<${normalizeSharedType(arguments_[0])},${normalizeFailure(arguments_[1], ignoredFailures)}>`
    arguments_ = genericArguments(value, "Effect")
    if (arguments_)
        return `operation<${normalizeSharedType(arguments_[0])},${normalizeFailure(arguments_[1], ignoredFailures)}>`
    arguments_ = genericArguments(value, "AsyncIterable")
    if (arguments_) {
        const item = genericArguments(arguments_[0], "Result")
        if (item) return `stream<${normalizeSharedType(item[0])},${normalizeFailure(item[1], ignoredFailures)}>`
    }
    arguments_ = genericArguments(value, "Stream")
    if (arguments_)
        return `stream<${normalizeSharedType(arguments_[0])},${normalizeFailure(arguments_[1], ignoredFailures)}>`
    return normalizeSharedType(value)
}

function topLevelArrow(value) {
    let depth = 0
    for (let index = 0; index < value.length - 1; index += 1) {
        if ("(<[{".includes(value[index])) depth += 1
        else if (")>]}".includes(value[index])) depth -= 1
        else if (value[index] === "=" && value[index + 1] === ">" && depth === 0) return index
    }
    return -1
}

function normalizeMemberType(label, value, ignoredFailures = []) {
    const arrow = topLevelArrow(value)
    if (arrow === -1) return normalizeSharedType(value)
    let parameters = normalizeSharedType(value.slice(0, arrow))
    if (defaultSignalOnlyMembers.has(label)) {
        parameters = parameters.replace(/^\(options\?:OperationOptions\|undefined\)$/, "()")
    }
    return `${parameters}=>${normalizeReturnType(value.slice(arrow + 2).trim(), ignoredFailures)}`
}

function interfacesFromExportGraph(checker, sourceFile, surfaceNames = pairedSurfaces) {
    const module = checker.getSymbolAtLocation(sourceFile)
    assert.ok(module, `${sourceFile.fileName} is not a module`)
    const exports = new Map(checker.getExportsOfModule(module).map((symbol) => [symbol.name, symbol]))
    const interfaces = new Map()
    for (const name of surfaceNames) {
        const exported = exports.get(name)
        if (!exported) continue
        const symbol = exported.flags & symbolIsAlias ? checker.getAliasedSymbol(exported) : exported
        const type = pairedValues.includes(name)
            ? checker.getTypeOfSymbol(symbol)
            : checker.getDeclaredTypeOfSymbol(symbol)
        const members = new Map()
        for (const member of checker.getPropertiesOfType(type)) {
            members.set(member.name, {
                documented: checker.getDocumentationCommentOfSymbol(member).length > 0,
                typeName: checker.typeToString(
                    checker.getTypeOfSymbol(member),
                    undefined,
                    NodeBuilderFlags.NoTruncation,
                ),
            })
        }
        interfaces.set(name, members)
    }
    return interfaces
}

function assertExportGraphSelfTest() {
    const temporary = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-client-contract-"))
    const sourceRoot = join(temporary, "src")
    mkdirSync(sourceRoot)
    writeFileSync(join(temporary, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext" } }))
    writeFileSync(
        join(sourceRoot, "client.ts"),
        `import type { Feature } from "./feature.js"\n/** client fixture documentation */\nexport interface Client {\n    /** client fixture member documentation */\n    readonly feature: Feature\n}\n`,
    )
    writeFileSync(
        join(sourceRoot, "feature.ts"),
        `/** feature fixture documentation */\nexport interface Feature {\n    /** feature fixture member documentation */\n    readonly value: string\n}\n`,
    )
    writeFileSync(
        join(sourceRoot, "entry.ts"),
        `export type { Client } from "./client.js"\nexport type { Feature } from "./feature.js"\n`,
    )
    const api = new API({ cwd: temporary })
    try {
        const snapshot = api.updateSnapshot({ openProjects: ["tsconfig.json"] })
        const project = snapshot.getProjects().find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
        assert.ok(project, "Client-contract fixture project was not loaded")
        const entry = project.program.getSourceFile(join(sourceRoot, "entry.ts"))
        assert.ok(entry, "Client-contract fixture entry was not loaded")
        const interfaces = interfacesFromExportGraph(project.checker, entry, ["Client", "Feature"])
        assert.deepEqual([...interfaces.keys()], ["Client", "Feature"])
        assert.equal(interfaces.get("Client")?.get("feature")?.documented, true)
        assert.equal(interfaces.get("Feature")?.get("value")?.documented, true)
    } finally {
        api.close()
        const target = realpathSync(temporary)
        assert.equal(dirname(target), realpathSync(tmpdir()))
        rmSync(target, { recursive: true })
    }
}

function names(members) {
    return [...members.keys()].sort()
}

function assertSameNames(label, defaultApi, native) {
    assert.deepEqual(names(defaultApi), names(native), `${label} has one-sided public members`)
}

function assertSameStructuralSignatures(label, defaultApi, native) {
    for (const member of names(defaultApi)) {
        const qualified = `${label}.${member}`
        if (structurallyDistinctMembers.has(qualified)) continue
        const defaultType = defaultApi.get(member)?.typeName
        const nativeType = native.get(member)?.typeName
        assert.equal(typeof defaultType, "string", `Default ${qualified} needs a compiler type`)
        assert.equal(typeof nativeType, "string", `Native ${qualified} needs a compiler type`)
        const nativeStructure = normalizeMemberType(qualified, nativeType, ["CancelledError"])
        const defaultStructure = normalizeMemberType(qualified, defaultType, ["CancelledError"])
        const defaultWithoutSignalConfiguration = normalizeMemberType(qualified, defaultType, [
            "CancelledError",
            "ConfigurationError",
        ])
        assert.ok(
            defaultStructure === nativeStructure || defaultWithoutSignalConfiguration === nativeStructure,
            `${qualified} has structurally different public types\ndefault: ${defaultStructure}\nnative: ${nativeStructure}`,
        )
    }
}

export function assertPublicClientContract({ defaultApi, native, defaultRuntime, nativeRuntime }) {
    for (const name of pairedSurfaces) {
        const defaultMembers = defaultApi.get(name)
        const nativeMembers = native.get(name)
        assert.ok(defaultMembers, `Default ${name} interface is missing`)
        assert.ok(nativeMembers, `Native ${name} interface is missing`)
        assertSameNames(name, defaultMembers, nativeMembers)
        assertSameStructuralSignatures(name, defaultMembers, nativeMembers)
        for (const member of names(defaultMembers)) {
            assert.ok(defaultMembers.get(member)?.documented, `Default ${name}.${member} needs a public comment`)
            assert.ok(nativeMembers.get(member)?.documented, `Native ${name}.${member} needs a public comment`)
        }
    }
    const defaultClient = defaultApi.get("Client")
    const nativeClient = native.get("Client")
    const clientNamespacesOf = (client) =>
        [...client]
            .filter(
                ([name, member]) =>
                    !inheritedClientMembers.includes(name) &&
                    member.typeName !== undefined &&
                    !member.typeName.includes("=>"),
            )
            .map(([, member]) => member.typeName)
            .sort()
    assert.deepEqual(
        clientNamespacesOf(defaultClient),
        [...clientNamespaceSignatures].sort(),
        "Default Client namespace inventory drifted",
    )
    assert.deepEqual(
        clientNamespacesOf(nativeClient),
        [...clientNamespaceSignatures].sort(),
        "Native Client namespace inventory drifted",
    )

    const expectedClientKeys = [...new Set([...inheritedClientMembers, ...defaultClient.keys()])].sort()
    assert.deepEqual(
        [...defaultRuntime.client].sort(),
        expectedClientKeys,
        "Default Client runtime has undeclared members",
    )
    assert.deepEqual(
        [...nativeRuntime.client].sort(),
        expectedClientKeys,
        "Native Client runtime has undeclared members",
    )
    for (const [type] of clientNamespaces) {
        assert.deepEqual(
            [...defaultRuntime.namespaces[type]].sort(),
            names(defaultApi.get(type)),
            `Default ${type} runtime drifted`,
        )
        assert.deepEqual(
            [...nativeRuntime.namespaces[type]].sort(),
            names(native.get(type)),
            `Native ${type} runtime drifted`,
        )
    }
    for (const name of pairedValues) {
        assert.deepEqual(
            [...defaultRuntime.values[name]].sort(),
            names(defaultApi.get(name)),
            `Default ${name} runtime drifted`,
        )
        assert.deepEqual(
            [...nativeRuntime.values[name]].sort(),
            names(native.get(name)),
            `Native ${name} runtime drifted`,
        )
    }
}

function fixtureInterfaces() {
    const namespaces = new Map(
        clientNamespaceTypes.map((name) => [
            name,
            new Map([["member", { documented: true, typeName: "() => Result<void, CancelledError>" }]]),
        ]),
    )
    const client = new Map(
        clientNamespaces.map(([type, member, signature]) => [
            member,
            { documented: true, readonly: true, typeName: signature ?? type },
        ]),
    )
    client.set("shutdown", { documented: true, typeName: "() => ResultAsync<void, never>" })
    return new Map([
        ["Client", client],
        ["WebhookClient", new Map([["shutdown", { documented: true, typeName: "() => ResultAsync<void, never>" }]])],
        [
            "OAuthClient",
            new Map([
                [
                    "authorize",
                    {
                        documented: true,
                        typeName:
                            "(input: AuditInput, options?: DefaultAuditOptions | undefined) => ResultAsync<AuditEntry, CancelledError | AuditFailure>",
                    },
                ],
            ]),
        ],
        ...returnedHandles.map((name) => [
            name,
            new Map([["close", { documented: true, typeName: "() => ResultAsync<void, never>" }]]),
        ]),
        ...namespaces,
        ...pairedValues.map((name) => [
            name,
            new Map([["member", { documented: true, typeName: "() => Result<void, HelperError>" }]]),
        ]),
    ])
}

function fixtureDiagnostics(source) {
    const temporary = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-parity-mutation-"))
    writeFileSync(
        join(temporary, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, files: ["mutation.ts"] }),
    )
    writeFileSync(join(temporary, "mutation.ts"), source)
    const api = new API({ cwd: temporary })
    try {
        const snapshot = api.updateSnapshot({ openProjects: ["tsconfig.json"] })
        const project = snapshot.getProjects().find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
        assert.ok(project, "Parity mutation fixture project was not loaded")
        return [
            ...project.program.getSyntacticDiagnostics("mutation.ts"),
            ...project.program.getSemanticDiagnostics("mutation.ts"),
        ].map((diagnostic) => diagnostic.code)
    } finally {
        api.close()
        const target = realpathSync(temporary)
        assert.equal(dirname(target), realpathSync(tmpdir()))
        rmSync(target, { recursive: true })
    }
}

function assertParityMutationSelfTest() {
    const source = readFileSync(
        fileURLToPath(new URL("./fixtures/public-client-parity/mutation.ts", import.meta.url)),
        "utf8",
    )
    assert.deepEqual(fixtureDiagnostics(source), [], "Parity mutation fixture must start valid")
    for (const marker of [
        "    readonly includeAutomations?: boolean // parity-option\n",
        "    readonly actorId: string // parity-projection\n",
    ]) {
        assert.ok(source.includes(marker), `Parity mutation marker is missing: ${marker.trim()}`)
        const diagnostics = fixtureDiagnostics(source.replace(marker, ""))
        assert.ok(diagnostics.includes(2344), `Removing ${marker.trim()} did not fail type parity`)
    }
}

function assertGuardSelfTest() {
    const defaultApi = fixtureInterfaces()
    const native = fixtureInterfaces()
    const client = [...defaultApi.get("Client").keys(), ...inheritedClientMembers]
    const namespaces = Object.fromEntries(clientNamespaces.map(([type]) => [type, ["member"]]))
    const values = Object.fromEntries(pairedValues.map((name) => [name, ["member"]]))
    const runtime = { client, namespaces, values }
    assert.doesNotThrow(() =>
        assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
    )
    native.get("Messages").set("missing", { documented: true })
    assert.throws(
        () => assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
        /Messages has one-sided public members/,
    )
    native.set("Messages", new Map([["member", { documented: false, typeName: "() => Result<void, CancelledError>" }]]))
    assert.throws(
        () => assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
        /Native Messages\.member needs a public comment/,
    )
    native.set("Messages", defaultApi.get("Messages"))
    native.get("OAuthClient").get("authorize").typeName =
        "(input: AuditInput, options?: AuditOptions | undefined) => Effect<AuditEntryWithoutActor, AuditFailure, never>"
    assert.throws(
        () => assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
        /OAuthClient\.authorize has structurally different public types/,
    )
    native.set("OAuthClient", fixtureInterfaces().get("OAuthClient"))
    native.get("Client").delete("attachments")
    assert.throws(
        () => assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
        /Client has one-sided public members/,
    )
    native.set("Client", defaultApi.get("Client"))
    defaultApi.get("Client").set("future", { documented: true, readonly: true, typeName: "Future" })
    native.get("Client").set("future", { documented: true, readonly: true, typeName: "Future" })
    assert.throws(
        () => assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
        /Default Client namespace inventory drifted/,
    )
    defaultApi.get("Client").delete("future")
    native.get("Client").delete("future")
    assert.throws(
        () =>
            assertPublicClientContract({
                defaultApi,
                native,
                defaultRuntime: { ...runtime, namespaces: { ...namespaces, Messages: ["unexpected"] } },
                nativeRuntime: runtime,
            }),
        /Default Messages runtime drifted/,
    )
    assert.throws(
        () =>
            assertPublicClientContract({
                defaultApi,
                native,
                defaultRuntime: { ...runtime, client: [...client, "undeclared"] },
                nativeRuntime: runtime,
            }),
        /Default Client runtime has undeclared members/,
    )
}

async function runtimeClientSurface() {
    const defaultModule = await import("../dist/index.js")
    const defaultApi = defaultModule.createClient({ token: "fixture-only-not-a-credential" })._unsafeUnwrap()
    const namespaces = (client) =>
        Object.fromEntries(clientNamespaces.map(([type, member]) => [type, Object.keys(client[member])]))
    const values = (module) => Object.fromEntries(pairedValues.map((name) => [name, Object.keys(module[name])]))
    try {
        const defaultRuntime = {
            client: Object.keys(defaultApi),
            namespaces: namespaces(defaultApi),
            values: values(defaultModule),
        }
        const nativeModule = await import("../dist/effect.js")
        const nativeRuntime = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const native = yield* nativeModule.createClient({ token: "fixture-only-not-a-credential" })
                    return { client: Object.keys(native), namespaces: namespaces(native), values: values(nativeModule) }
                }),
            ),
        )
        return { defaultRuntime, nativeRuntime }
    } finally {
        ;(await defaultApi.shutdown())._unsafeUnwrap()
    }
}

function sourceInterfaces() {
    const api = new API({ cwd: fileURLToPath(new URL("../", import.meta.url)) })
    try {
        const snapshot = api.updateSnapshot({ openProjects: ["tsconfig.json", "tsconfig.test.json"] })
        const project = snapshot.getProjects().find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
        const parityProject = snapshot
            .getProjects()
            .find((candidate) => candidate.configFileName.endsWith("/tsconfig.test.json"))
        assert.ok(project, "TypeScript project was not loaded")
        assert.ok(parityProject, "TypeScript test project was not loaded")
        const defaultApi = project.program.getSourceFile("src/index.ts")
        const native = project.program.getSourceFile("src/effect.ts")
        const parity = parityProject.program.getSourceFile("tests/fixtures/public-client-parity/actual.ts")
        assert.ok(defaultApi, "Default source file was not loaded")
        assert.ok(native, "Native source file was not loaded")
        assert.ok(parity, "Public client parity fixture was not loaded")
        const parityDiagnostics = [
            ...parityProject.program.getSyntacticDiagnostics(parity.fileName),
            ...parityProject.program.getSemanticDiagnostics(parity.fileName),
        ].map((diagnostic) => diagnostic.code)
        assert.deepEqual(
            parityDiagnostics,
            [],
            `Public client parity fixture failed with ${parityDiagnostics.join(", ")}`,
        )
        return {
            defaultApi: interfacesFromExportGraph(project.checker, defaultApi),
            native: interfacesFromExportGraph(project.checker, native),
        }
    } finally {
        api.close()
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    assertGuardSelfTest()
    assertExportGraphSelfTest()
    assertParityMutationSelfTest()
    const { defaultApi, native } = sourceInterfaces()
    const { defaultRuntime, nativeRuntime } = await runtimeClientSurface()
    assertPublicClientContract({ defaultApi, native, defaultRuntime, nativeRuntime })
    console.log("Public client contract passed")
}
