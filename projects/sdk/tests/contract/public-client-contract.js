import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { API, NodeBuilderFlags } from "typescript/unstable/sync"
import { clientNamespaces } from "./client-namespaces.js"

// TypeScript 7 exposes its installed compiler AST through unstable entry points. This build-time check adds no runtime SDK dependency
const clientNamespaceTypes = clientNamespaces.map(({ type }) => type)
const clientNamespaceSignatures = clientNamespaces.map(({ signature }) => signature)
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
// Member signatures are compared by the compile-time comparator in fixtures/public-client-parity. This script checks
// that its Paired map covers exactly these surfaces, that the comparator rejects deliberate mutations, and the member
// names, runtime keys and comments that types cannot express
// Paired member descriptions must match after whitespace normalization, so a fact is stated once for both APIs.
// Entry-specific result, cancellation and defect rules belong in namespace comments or member remarks instead.
// Each exception names a member whose two descriptions must differ, with the reason
const documentationDivergence = new Map([])

function normalizeDocumentation(documentation) {
    return String(documentation ?? "")
        .replace(/\s+/g, " ")
        .trim()
}

function assertPairedDocumentation(label, defaultApi, native, divergence) {
    for (const member of names(defaultApi)) {
        const qualified = `${label}.${member}`
        const same = (defaultApi.get(member)?.documentation ?? "") === (native.get(member)?.documentation ?? "")
        if (divergence.has(qualified)) {
            assert.ok(!same, `${qualified} is listed as a documentation divergence but both descriptions now match`)
            continue
        }
        assert.ok(
            same,
            `${qualified} documentation differs between the default and native APIs\ndefault: ${defaultApi.get(member)?.documentation}\nnative: ${native.get(member)?.documentation}`,
        )
    }
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
            // Well-known symbol members such as Symbol.asyncDispose exist only where one API style needs them: default
            // handles support `await using`, while native handles close with their Scope. They are unpaired but documented
            if (member.name.startsWith("__@")) {
                assert.ok(
                    checker.getDocumentationCommentOfSymbol(member).length > 0,
                    `${name} symbol member ${member.name} needs a public comment`,
                )
                continue
            }
            members.set(member.name, {
                documented: checker.getDocumentationCommentOfSymbol(member).length > 0,
                documentation: normalizeDocumentation(checker.getDocumentationCommentOfSymbol(member)),
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

export function assertPublicClientContract({
    defaultApi,
    native,
    defaultRuntime,
    nativeRuntime,
    divergence = documentationDivergence,
}) {
    for (const name of pairedSurfaces) {
        const defaultMembers = defaultApi.get(name)
        const nativeMembers = native.get(name)
        assert.ok(defaultMembers, `Default ${name} interface is missing`)
        assert.ok(nativeMembers, `Native ${name} interface is missing`)
        assertSameNames(name, defaultMembers, nativeMembers)
        assertPairedDocumentation(name, defaultMembers, nativeMembers, divergence)
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
    for (const type of clientNamespaceTypes) {
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

function assertTypeParitySurfaces(fixtureSurfaces) {
    assert.deepEqual(
        [...fixtureSurfaces].sort(),
        [...pairedSurfaces].sort(),
        "Public client parity fixture does not pair exactly the paired public surfaces",
    )
}

function fixtureInterfaces() {
    const namespaces = new Map(
        clientNamespaceTypes.map((name) => [
            name,
            new Map([["member", { documented: true, typeName: "() => Result<void, CancelledError>" }]]),
        ]),
    )
    const client = new Map(
        clientNamespaces.map(({ member, signature }) => [
            member,
            { documented: true, readonly: true, typeName: signature },
        ]),
    )
    client.set("shutdown", { documented: true, typeName: "() => ResultAsync<void, never>" })
    return new Map([
        ["Client", client],
        ["WebhookClient", new Map([["shutdown", { documented: true, typeName: "() => ResultAsync<void, never>" }]])],
        ["OAuthClient", new Map([["authorize", { documented: true, typeName: "() => ResultAsync<void, never>" }]])],
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

const parityFixtures = new URL("./fixtures/public-client-parity/", import.meta.url)

function fixtureDiagnostics(mutation) {
    // Inside the package so the fixture resolves the same effect and neverthrow declarations as actual.ts
    const cache = fileURLToPath(new URL("../../node_modules/.cache/", import.meta.url))
    mkdirSync(cache, { recursive: true })
    const temporary = mkdtempSync(join(realpathSync(cache), "fluxerly-parity-mutation-"))
    writeFileSync(
        join(temporary, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: {
                module: "NodeNext",
                lib: ["ES2024", "ESNext.Disposable", "DOM"],
                noEmit: true,
                strict: true,
                exactOptionalPropertyTypes: true,
                types: [],
            },
            files: ["mutation.ts"],
        }),
    )
    writeFileSync(join(temporary, "package.json"), JSON.stringify({ type: "module" }))
    writeFileSync(join(temporary, "compare.ts"), readFileSync(new URL("compare.ts", parityFixtures)))
    writeFileSync(join(temporary, "mutation.ts"), mutation)
    const api = new API({ cwd: temporary })
    try {
        const snapshot = api.updateSnapshot({ openProjects: ["tsconfig.json"] })
        const project = snapshot.getProjects().find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
        assert.ok(project, "Parity mutation fixture project was not loaded")
        return ["compare.ts", "mutation.ts"].flatMap((file) =>
            [...project.program.getSyntacticDiagnostics(file), ...project.program.getSemanticDiagnostics(file)].map(
                (diagnostic) => diagnostic.code,
            ),
        )
    } finally {
        api.close()
        const target = realpathSync(temporary)
        assert.equal(dirname(target), realpathSync(cache))
        rmSync(target, { recursive: true })
    }
}

// Runs the comparator that guards the real entry points against a fixture that starts valid, then removes one marked
// line at a time: A dropped optional option, a dropped result field and a dropped options parameter must each fail
function assertParityMutationSelfTest() {
    const source = readFileSync(new URL("mutation.ts", parityFixtures), "utf8")
    assert.deepEqual(fixtureDiagnostics(source), [], "Parity mutation fixture must start valid")
    for (const marker of [
        "    readonly includeAutomations?: boolean // parity-option\n",
        "    readonly actorId: string // parity-projection\n",
        "        options?: NativeAuditOptions, // parity-parameter\n",
    ]) {
        assert.ok(source.includes(marker), `Parity mutation marker is missing: ${marker.trim()}`)
        const diagnostics = fixtureDiagnostics(source.replace(marker, ""))
        assert.ok(diagnostics.includes(2344), `Removing ${marker.trim()} did not fail type parity`)
    }
}

function assertGuardSelfTest() {
    assert.doesNotThrow(() => assertTypeParitySurfaces(pairedSurfaces))
    assert.throws(
        () => assertTypeParitySurfaces(pairedSurfaces.filter((name) => name !== "ClientCache")),
        /Public client parity fixture does not pair/,
    )
    assert.throws(
        () => assertTypeParitySurfaces([...pairedSurfaces, "Unregistered"]),
        /Public client parity fixture does not pair/,
    )
    const defaultApi = fixtureInterfaces()
    const native = fixtureInterfaces()
    const client = [...defaultApi.get("Client").keys(), ...inheritedClientMembers]
    const namespaces = Object.fromEntries(clientNamespaceTypes.map((type) => [type, ["member"]]))
    const values = Object.fromEntries(pairedValues.map((name) => [name, ["member"]]))
    const runtime = { client, namespaces, values }
    assert.doesNotThrow(() =>
        assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
    )
    native
        .get("Messages")
        .set("member", { documented: true, documentation: "Changed", typeName: "() => Result<void, CancelledError>" })
    assert.throws(
        () => assertPublicClientContract({ defaultApi, native, defaultRuntime: runtime, nativeRuntime: runtime }),
        /Messages\.member documentation differs/,
    )
    assert.doesNotThrow(() =>
        assertPublicClientContract({
            defaultApi,
            native,
            defaultRuntime: runtime,
            nativeRuntime: runtime,
            divergence: new Map([["Messages.member", "fixture reason"]]),
        }),
    )
    native.set("Messages", defaultApi.get("Messages"))
    assert.throws(
        () =>
            assertPublicClientContract({
                defaultApi,
                native,
                defaultRuntime: runtime,
                nativeRuntime: runtime,
                divergence: new Map([["Messages.member", "fixture reason"]]),
            }),
        /Messages\.member is listed as a documentation divergence but both descriptions now match/,
    )
    native.set("Messages", fixtureInterfaces().get("Messages"))
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
    const defaultModule = await import("../../dist/index.js")
    const defaultApi = defaultModule.createClient({ token: "fixture-only-not-a-credential" })
    const namespaces = (client) =>
        Object.fromEntries(clientNamespaces.map(({ type, member }) => [type, Object.keys(client[member])]))
    const values = (module) => Object.fromEntries(pairedValues.map((name) => [name, Object.keys(module[name])]))
    try {
        const defaultRuntime = {
            client: Object.keys(defaultApi),
            namespaces: namespaces(defaultApi),
            values: values(defaultModule),
        }
        const nativeModule = await import("../../dist/effect.js")
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
    const api = new API({ cwd: fileURLToPath(new URL("../../", import.meta.url)) })
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
        const parity = parityProject.program.getSourceFile("tests/contract/fixtures/public-client-parity/actual.ts")
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
        const parityModule = parityProject.checker.getSymbolAtLocation(parity)
        assert.ok(parityModule, "Public client parity fixture is not a module")
        const paired = parityProject.checker.getExportsOfModule(parityModule).find((symbol) => symbol.name === "Paired")
        assert.ok(paired, "Public client parity fixture does not export Paired")
        return {
            typeParityFixtureSurfaces: parityProject.checker
                .getPropertiesOfType(parityProject.checker.getDeclaredTypeOfSymbol(paired))
                .map((member) => member.name),
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
    const { typeParityFixtureSurfaces, defaultApi, native } = sourceInterfaces()
    assertTypeParitySurfaces(typeParityFixtureSurfaces)
    const { defaultRuntime, nativeRuntime } = await runtimeClientSurface()
    assertPublicClientContract({ defaultApi, native, defaultRuntime, nativeRuntime })
    console.log("Public client contract passed")
}
