import { existsSync } from "node:fs"
import { Effect, Exit, Scope } from "effect"
import { API } from "typescript/unstable/sync"
import { describe, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type ClientOptions, type MemberReference } from "../src/index.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../src/effect.js"
import { InputValidationFailure } from "../src/input-validation.js"
import { channelEdit } from "../src/internal/channels.js"
import { memberRolesSet, roleCreate } from "../src/internal/guilds.js"
import { identifier } from "../src/internal/message.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"
import {
    conformanceReferenceCases,
    fieldValidationCases,
    namespaceConformance,
    operationConformance,
    providerRevision,
    registryScope,
    requestReferenceViolations,
} from "./conformance-registry.js"

const symbolIsAlias = 1 << 21

function publicInterfaces(path: "src/index.ts" | "src/effect.ts") {
    const api = new API({ cwd: process.cwd() })
    try {
        const snapshot = api.updateSnapshot({ openProjects: ["tsconfig.json"] })
        const project = snapshot.getProjects().find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
        expect(project, "TypeScript project was not loaded").toBeDefined()
        const source = project!.program.getSourceFile(path)
        expect(source, `${path} was not loaded`).toBeDefined()
        const module = project!.checker.getSymbolAtLocation(source!)
        expect(module, `${path} is not a module`).toBeDefined()
        const exports = new Map(project!.checker.getExportsOfModule(module!).map((symbol) => [symbol.name, symbol]))
        const members = (name: string) => {
            const exported = exports.get(name)
            expect(exported, `${path} does not export ${name}`).toBeDefined()
            const symbol = exported!.flags & symbolIsAlias ? project!.checker.getAliasedSymbol(exported!) : exported!
            return project!.checker.getPropertiesOfType(project!.checker.getDeclaredTypeOfSymbol(symbol))
        }
        const clientNamespaces = members("Client")
            .filter(
                (member) =>
                    !["state", "shards", "gatewayLatencyMs", "shutdown", "run", "connect", "outcome"].includes(
                        member.name,
                    ),
            )
            .filter((member) => {
                const type = project!.checker.getTypeOfSymbol(member)
                return type !== undefined && !project!.checker.typeToString(type).includes("=>")
            })
            .map((member) => {
                const type = project!.checker.getTypeOfSymbol(member)
                return type === undefined ? undefined : project!.checker.typeToString(type).match(/^\w+/)?.[0]
            })
            .filter((name): name is string => name !== undefined)
        return {
            clientNamespaces: clientNamespaces.sort(),
            operations: new Map(
                Object.keys(namespaceConformance).map((name) => [
                    name,
                    members(name)
                        .map((member) => member.name)
                        .sort(),
                ]),
            ),
        }
    } finally {
        api.close()
    }
}

describe("Client namespace-object conformance registry", () => {
    test("maps every Client namespace object and its operations in both public entry points", () => {
        const expectedNamespaces = Object.keys(namespaceConformance).sort()
        for (const path of ["src/index.ts", "src/effect.ts"] as const) {
            const inventory = publicInterfaces(path)
            expect(inventory.clientNamespaces).toEqual(expectedNamespaces)
            for (const [namespace, contract] of Object.entries(namespaceConformance)) {
                const registered = [
                    ...contract.providerOperations,
                    ...Object.keys("localOperations" in contract ? contract.localOperations : {}),
                ].sort()
                expect(inventory.operations.get(namespace), `${path} ${namespace}`).toEqual(registered)
            }
        }
    })

    test("keeps pinned provider owners and positive/negative evidence for registered Client namespaces", () => {
        expect(providerRevision).toMatch(/^[a-f0-9]{40}$/)
        expect(registryScope.coverage).toBe("partial")
        expect(registryScope.established).not.toHaveLength(0)
        expect(registryScope.remaining).not.toHaveLength(0)
        for (const [namespace, contract] of Object.entries(namespaceConformance)) {
            expect(contract.positiveEvidence.length, `${namespace} positive evidence`).toBeGreaterThan(0)
            expect(contract.negativeEvidence.length, `${namespace} negative evidence`).toBeGreaterThan(0)
            for (const path of [...contract.positiveEvidence, ...contract.negativeEvidence]) {
                expect(existsSync(path), `${namespace} evidence ${path}`).toBe(true)
            }
            if (contract.providerOperations.length > 0) {
                expect(contract.providerSources.length, `${namespace} pinned source owners`).toBeGreaterThan(0)
                for (const path of contract.providerSources) expect(path).not.toMatch(/^https?:/)
            } else {
                expect(Object.keys("localOperations" in contract ? contract.localOperations : {})).not.toHaveLength(0)
            }
        }
    })

    test("assigns every registered Client provider operation complete metadata without placeholders", () => {
        const providerOperations = Object.entries(namespaceConformance)
            .flatMap(([namespace, contract]) =>
                contract.providerOperations.map((operation) => `${namespace}.${operation}`),
            )
            .sort()
        expect(Object.keys(operationConformance).sort()).toEqual(providerOperations)
        for (const [operation, metadata] of Object.entries(operationConformance)) {
            expect(Object.keys(metadata).sort(), operation).toEqual(
                [
                    "audit",
                    "credential",
                    "method",
                    "pagination",
                    "path",
                    "rateScope",
                    "requestOwner",
                    "responseOwner",
                ].sort(),
            )
            for (const [field, value] of Object.entries(metadata))
                expect(value.length, `${operation}.${field}`).toBeGreaterThan(0)
            for (const owner of [metadata.requestOwner, metadata.responseOwner]) {
                for (const path of owner.split("; ").filter((item) => item.startsWith("src/")))
                    expect(existsSync(path), `${operation} owner ${path}`).toBe(true)
            }
        }
        expect(Object.values(operationConformance).flatMap(Object.values)).not.toContain("unknown-not-yet-verified")
    })

    test("detects deliberate method, path, and authorization mutations in the shared request case", () => {
        const expected = conformanceReferenceCases.membersSetRoles.request
        expect(
            requestReferenceViolations(expected, {
                method: expected.method,
                path: expected.path,
                authorization: `${expected.authorizationPrefix}fixture`,
            }),
        ).toEqual([])
        expect(
            requestReferenceViolations(expected, {
                method: "PUT",
                path: expected.path,
                authorization: `${expected.authorizationPrefix}fixture`,
            }),
        ).toEqual(["method"])
        expect(
            requestReferenceViolations(expected, {
                method: expected.method,
                path: "/guilds/20/members/32",
                authorization: `${expected.authorizationPrefix}fixture`,
            }),
        ).toEqual(["path"])
        expect(
            requestReferenceViolations(expected, {
                method: expected.method,
                path: expected.path,
                authorization: "Bearer fixture",
            }),
        ).toEqual(["authorization"])
    })
})

describe("field-specific validation conformance", () => {
    test("keeps response Snowflake strings lexical instead of applying a request-range rule", () => {
        for (const item of fieldValidationCases.responseSnowflake)
            expect(identifier(item.value), item.name).toBe(item.accepted)
    })

    test("applies the REST Snowflake range separately from the intentional positive-ID policy", () => {
        for (const item of fieldValidationCases.restSnowflake) {
            const result = memberRolesSet({ guildId: "1", userId: "2" }, [item.value])
            expect(!(result instanceof InputValidationFailure), item.name).toBe(item.sdkAccepted)
        }
        expect(
            fieldValidationCases.restSnowflake
                .filter((item) => item.disposition !== "aligned")
                .map((item) => item.name),
        ).toEqual(["zero"])
    })

    test("keeps the pinned handler's default-role rejection when its request schema accepts the Snowflake", () => {
        const reference = conformanceReferenceCases.membersSetRoles
        expect(fieldValidationCases.handlerOverSchema.value).toBe(reference.target.guildId)
        expect(reference.schemaAcceptedHandlerRejectedRoleIds).toEqual([reference.target.guildId])
        const result = memberRolesSet(reference.target, reference.schemaAcceptedHandlerRejectedRoleIds)
        expect(result).toBeInstanceOf(InputValidationFailure)
        expect(result).toMatchObject({ detail: { path: "roleIds[]", constraint: "relationship" } })
    })

    test.each(["default", "native"] as const)(
        "%s members.setRoles accepts signed-63 max and rejects larger decimal IDs before dispatch",
        async (mode) => {
            const reference = conformanceReferenceCases.membersSetRoles
            const target: MemberReference = reference.target
            const requests: Array<{
                readonly roles: readonly string[]
                readonly method: string
                readonly path: string
                readonly authorization: string | null
            }> = []
            stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
                const roles = (JSON.parse(String(init.body)) as { readonly roles: string[] }).roles
                requests.push({
                    roles,
                    method: init.method ?? "GET",
                    path: new URL(url).pathname.replace(/^\/v1/, ""),
                    authorization: new Headers(init.headers).get("authorization"),
                })
                return Response.json({
                    user: { id: target.userId, username: "target-member", bot: false },
                    roles,
                    joined_at: "2026-09-08T12:00:00.000Z",
                    nick: null,
                })
            })
            const scope = Scope.makeUnsafe()
            const options = { token: "fixture" }
            const defaultApi = mode === "default" ? createClient(options as ClientOptions)._unsafeUnwrap() : undefined
            const native =
                mode === "native"
                    ? await Effect.runPromise(createNative(options as NativeClientOptions).pipe(Scope.provide(scope)))
                    : undefined
            onTestFinished(async () => {
                vi.unstubAllGlobals()
                try {
                    if (defaultApi) (await defaultApi.shutdown())._unsafeUnwrap()
                    else await Effect.runPromise(native!.shutdown())
                } finally {
                    await Effect.runPromise(Scope.close(scope, Exit.void))
                }
            })
            const setRoles = async (ids: readonly string[]) => {
                if (defaultApi) {
                    const result = await defaultApi.members.setRoles(target, ids)
                    if (result.isErr()) throw result.error
                    return result.value
                }
                return Effect.runPromise(native!.members.setRoles(target, ids))
            }

            await expect(setRoles(reference.acceptedRoleIds)).resolves.toMatchObject({
                roleIds: reference.acceptedRoleIds,
            })
            for (const id of [...reference.rejectedRoleIds, ...reference.schemaAcceptedHandlerRejectedRoleIds])
                await expect(setRoles([id])).rejects.toMatchObject({
                    _tag: "GuildOperationError",
                    operation: "members.setRoles",
                    reason: "input",
                    outcome: "notDispatched",
                })
            expect(requests.map(({ roles }) => roles)).toEqual([reference.acceptedRoleIds])
            const [request] = requests
            expect(request).toBeDefined()
            if (request === undefined) throw new Error("The accepted role set did not dispatch")
            expect(requestReferenceViolations(reference.request, request)).toEqual([])
        },
    )

    test("uses the provider's signed-63-bit request bound for permission bigint fields", () => {
        for (const item of fieldValidationCases.permissions) {
            const result = roleCreate("1", { name: "fixture", permissions: item.value })
            expect(!(result instanceof InputValidationFailure), item.name).toBe(item.accepted)
        }
    })

    test("rejects sparse and duplicate role sets and snapshots mutable inputs before admission", () => {
        expect(memberRolesSet({ guildId: "1", userId: "2" }, new Array(1) as string[])).toBeInstanceOf(
            InputValidationFailure,
        )
        expect(memberRolesSet({ guildId: "1", userId: "2" }, ["3", "3"])).toBeInstanceOf(InputValidationFailure)

        const roleIds = ["3"]
        const result = memberRolesSet({ guildId: "1", userId: "2" }, roleIds)
        expect(result).not.toBeInstanceOf(InputValidationFailure)
        roleIds[0] = "4"
        expect(JSON.parse((result as { readonly json: string }).json)).toEqual({ roles: ["3"] })
    })

    test("distinguishes omitted, null, empty, and explicit-empty edit values", () => {
        expect(channelEdit("1", {})).toBeInstanceOf(InputValidationFailure)
        expect(channelEdit("1", { topic: undefined } as unknown as Parameters<typeof channelEdit>[1])).toBeInstanceOf(
            InputValidationFailure,
        )
        expect(channelEdit("1", { topic: "" })).toBeInstanceOf(InputValidationFailure)

        const cleared = channelEdit("1", { topic: null })
        expect(cleared).not.toBeInstanceOf(InputValidationFailure)
        expect(JSON.parse((cleared as { readonly json: string }).json)).toEqual({ topic: null })

        const emptyOverwrites = channelEdit("1", { permissionOverwrites: [] })
        expect(emptyOverwrites).not.toBeInstanceOf(InputValidationFailure)
        expect(JSON.parse((emptyOverwrites as { readonly json: string }).json)).toEqual({ permission_overwrites: [] })
    })
})
