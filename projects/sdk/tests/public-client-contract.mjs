import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { API } from "typescript/unstable/sync"

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
const pairedInterfaces = ["Client", "WebhookClient", "OAuthClient", ...clientNamespaceTypes]
const inheritedClientMembers = ["state", "shards", "gatewayLatencyMs"]
const symbolIsAlias = 1 << 21

function interfacesFromExportGraph(checker, sourceFile, interfaceNames = pairedInterfaces) {
    const module = checker.getSymbolAtLocation(sourceFile)
    assert.ok(module, `${sourceFile.fileName} is not a module`)
    const exports = new Map(checker.getExportsOfModule(module).map((symbol) => [symbol.name, symbol]))
    const interfaces = new Map()
    for (const name of interfaceNames) {
        const exported = exports.get(name)
        if (!exported) continue
        const symbol = exported.flags & symbolIsAlias ? checker.getAliasedSymbol(exported) : exported
        const members = new Map()
        for (const member of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) {
            members.set(member.name, {
                documented: checker.getDocumentationCommentOfSymbol(member).length > 0,
                typeName: checker.typeToString(checker.getTypeOfSymbol(member)),
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

export function assertPublicClientContract({ defaultApi, native, defaultRuntime, nativeRuntime }) {
    for (const name of pairedInterfaces) {
        const defaultMembers = defaultApi.get(name)
        const nativeMembers = native.get(name)
        assert.ok(defaultMembers, `Default ${name} interface is missing`)
        assert.ok(nativeMembers, `Native ${name} interface is missing`)
        assertSameNames(name, defaultMembers, nativeMembers)
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
}

function fixtureInterfaces() {
    const namespaces = new Map(clientNamespaceTypes.map((name) => [name, new Map([["member", { documented: true }]])]))
    const client = new Map(
        clientNamespaces.map(([type, member, signature]) => [
            member,
            { documented: true, readonly: true, typeName: signature ?? type },
        ]),
    )
    client.set("shutdown", { documented: true })
    return new Map([
        ["Client", client],
        ["WebhookClient", new Map([["shutdown", { documented: true }]])],
        ["OAuthClient", new Map([["authorize", { documented: true }]])],
        ...namespaces,
    ])
}

function assertGuardSelfTest() {
    const defaultApi = fixtureInterfaces()
    const native = fixtureInterfaces()
    const client = [...defaultApi.get("Client").keys(), ...inheritedClientMembers]
    const namespaces = Object.fromEntries(clientNamespaces.map(([type]) => [type, ["member"]]))
    const runtime = { client, namespaces }
    assert.doesNotThrow(() =>
        assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
    )
    native.get("Messages").set("missing", { documented: true })
    assert.throws(
        () => assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
        /Messages has one-sided public members/,
    )
    native.set("Messages", new Map([["member", { documented: false }]]))
    assert.throws(
        () => assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
        /Native Messages\.member needs a public comment/,
    )
    native.set("Messages", defaultApi.get("Messages"))
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
    try {
        const defaultRuntime = { client: Object.keys(defaultApi), namespaces: namespaces(defaultApi) }
        const nativeModule = await import("../dist/effect.js")
        const nativeRuntime = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const native = yield* nativeModule.createClient({ token: "fixture-only-not-a-credential" })
                    return { client: Object.keys(native), namespaces: namespaces(native) }
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
        const snapshot = api.updateSnapshot({ openProjects: ["tsconfig.json"] })
        const project = snapshot.getProjects().find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
        assert.ok(project, "TypeScript project was not loaded")
        const defaultApi = project.program.getSourceFile("src/index.ts")
        const native = project.program.getSourceFile("src/effect.ts")
        assert.ok(defaultApi, "Default source file was not loaded")
        assert.ok(native, "Native source file was not loaded")
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
    const { defaultApi, native } = sourceInterfaces()
    const { defaultRuntime, nativeRuntime } = await runtimeClientSurface()
    assertPublicClientContract({ defaultApi, native, defaultRuntime, nativeRuntime })
    console.log("Public client contract passed")
}
