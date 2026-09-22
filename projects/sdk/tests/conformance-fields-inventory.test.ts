import { describe, expect, test } from "vitest"
import { fieldRuleCoverage } from "./conformance-fields-registry.js"
import { fieldOperationKeys } from "./conformance-fields-operations.js"
import {
    directPublicOperationParameters,
    publicFieldInventory,
    reachableGatewayPublicFields,
    reachablePublicFields,
} from "./conformance-fields-source.js"

describe("source-derived public operation field inventory", () => {
    test("matches the reviewed semantic surface baseline", async () => {
        const defaultInventory = publicFieldInventory("src/index.ts", fieldOperationKeys)
        const nativeInventory = publicFieldInventory("src/effect.ts", fieldOperationKeys)
        const lines: string[] = []
        for (const [mode, inventory] of [
            ["default", defaultInventory],
            ["native", nativeInventory],
        ] as const)
            for (const operation of Object.values(inventory.operations))
                lines.push(`operation|${mode}|${operation.key}|${operation.signature}`)
        for (const [mode, inventory] of [
            ["default", defaultInventory],
            ["native", nativeInventory],
        ] as const)
            for (const object of Object.values(inventory.objects))
                if (object.variants.length > 0)
                    lines.push(`union|${mode}|${object.name}|${object.variants.join(" || ")}`)
        const fields = (inventory: typeof defaultInventory) =>
            new Map(
                Object.values(inventory.objects)
                    .flatMap((object) => object.fields)
                    .map((field) => [
                        field.key,
                        `${field.type}|optional=${String(field.optional)}|nullable=${String(field.nullable)}`,
                    ]),
            )
        const defaultFields = fields(defaultInventory)
        const nativeFields = fields(nativeInventory)
        for (const key of [...new Set([...defaultFields.keys(), ...nativeFields.keys()])].sort()) {
            const defaultValue = defaultFields.get(key)
            const nativeValue = nativeFields.get(key)
            if (defaultValue !== undefined && defaultValue === nativeValue)
                lines.push(`field|shared|${key}|${defaultValue}`)
            else {
                if (defaultValue !== undefined) lines.push(`field|default|${key}|${defaultValue}`)
                if (nativeValue !== undefined) lines.push(`field|native|${key}|${nativeValue}`)
            }
        }
        // Review intentional public schema changes, then update with: pnpm exec vitest run -u tests/conformance-fields-inventory.test.ts
        await expect(lines.join("\n")).toMatchFileSnapshot("./conformance-fields-shapes.snapshot.txt")
    }, 15_000)

    test("indexes every registered provider and gateway operation in both entry points", () => {
        expect(fieldOperationKeys).toHaveLength(149)
        for (const entrypoint of ["src/index.ts", "src/effect.ts"] as const) {
            const inventory = publicFieldInventory(entrypoint, fieldOperationKeys)
            expect(Object.keys(inventory.operations).sort()).toEqual(fieldOperationKeys)
            for (const [key, operation] of Object.entries(inventory.operations)) {
                expect(operation.signature, key).toContain("=>")
                expect(operation.successType.length, `${key} success type`).toBeGreaterThan(0)
                for (const parameter of operation.parameters) {
                    expect(parameter.name.length, `${key} parameter name`).toBeGreaterThan(0)
                    expect(parameter.type.length, `${key}.${parameter.name} parameter type`).toBeGreaterThan(0)
                }
            }
            for (const [name, object] of Object.entries(inventory.objects)) {
                expect(object.fields.length, `${name} fields`).toBeGreaterThan(0)
                for (const field of object.fields) {
                    expect(field.key).toBe(`${name}.${field.name}`)
                    expect(field.owner, `${field.key} canonical source owner`).toMatch(/^src\/.+\.ts/)
                    expect(typeof field.optional, `${field.key} optionality`).toBe("boolean")
                    expect(typeof field.nullable, `${field.key} nullability`).toBe("boolean")
                }
            }
        }
    })

    test.runIf(process.env.CONFORMANCE_FIELDS_LIST === "1")("prints deterministic rule keys grouped by source", () => {
        const inventory = publicFieldInventory("src/index.ts", fieldOperationKeys)
        for (const direction of ["request", "response"] as const) {
            const groups: Record<string, string[]> = {}
            for (const field of reachablePublicFields(inventory, direction).fields)
                (groups[field.owner] ??= []).push(field.key)
            for (const keys of Object.values(groups)) keys.sort()
            console.log(
                direction.toUpperCase(),
                JSON.stringify(
                    Object.fromEntries(Object.entries(groups).sort(([left], [right]) => left.localeCompare(right))),
                ),
            )
        }
        console.log(
            "GENERIC_RESPONSES",
            JSON.stringify(
                Object.fromEntries(
                    Object.values(inventory.operations)
                        .filter((operation) => operation.successType.includes("<"))
                        .map((operation) => [operation.key, operation.successType]),
                ),
            ),
        )
        console.log("DIRECT_PARAMETERS", JSON.stringify(directPublicOperationParameters(inventory)))
    })

    test("keeps default and native request object field shapes aligned", () => {
        const defaultInventory = publicFieldInventory("src/index.ts", fieldOperationKeys)
        const nativeInventory = publicFieldInventory("src/effect.ts", fieldOperationKeys)
        const requestNames = (inventory: typeof defaultInventory) =>
            new Set(Object.values(inventory.operations).flatMap((operation) => operation.requestTypes))
        const defaultRequestNames = requestNames(defaultInventory)
        const nativeRequestNames = requestNames(nativeInventory)
        const sharedNames = [...defaultRequestNames].filter(
            (name) => nativeRequestNames.has(name) && nativeInventory.objects[name] !== undefined,
        )
        expect(sharedNames.length).toBeGreaterThan(0)
        for (const name of sharedNames) {
            const fields = (inventory: typeof defaultInventory) =>
                inventory.objects[name]!.fields.map(({ key, optional, nullable }) => ({
                    key,
                    optional,
                    nullable,
                }))
            expect(fields(defaultInventory), name).toEqual(fields(nativeInventory))
        }
    })

    test("retains nested arrays, callback boundaries, nullability and direction in the gap gate", () => {
        const inventory = publicFieldInventory("src/index.ts", fieldOperationKeys)
        expect(inventory.objects.MessageInput?.fields.find((field) => field.name === "embeds")).toMatchObject({
            optional: true,
            nullable: false,
            type: "readonly EmbedInput[] | undefined",
        })
        expect(inventory.objects.AttachmentInput?.variants).toEqual([
            "AttachmentBytesInput",
            "AttachmentFileInput",
            "AttachmentStreamInput",
        ])
        expect(inventory.objects.AttachmentBytesInput?.fields.find((field) => field.name === "data")).toMatchObject({
            optional: false,
            nullable: false,
        })
        expect(inventory.objects.DiscoveryStatus?.fields.find((field) => field.name === "application")).toMatchObject({
            nullable: true,
        })
        expect(inventory.objects.MessageSearchQuery?.fields.find((field) => field.name === "contents")).toMatchObject({
            optional: true,
            nullable: false,
        })
        expect(inventory.objects.EventSubscription?.fields.find((field) => field.name === "next")).toMatchObject({
            optional: false,
            nullable: false,
        })
        expect(reachablePublicFields(inventory, "request").objectNames).not.toContain("EventMap")
        const gateway = reachableGatewayPublicFields(inventory)
        expect(gateway.objectNames).toContain("EventMap")
        expect(gateway.fields.length).toBeGreaterThan(0)
        expect(inventory.operations["AuditLogs.iterate"]?.responseTypes).toEqual(["AuditLogEntry"])
        expect(inventory.operations["Emojis.createMany"]?.responseTypes).toEqual(["ExpressionBatch", "GuildEmoji"])
        expect(inventory.operations["Client.events"]?.responseTypes).toEqual(["EventSubscription"])
        expect(inventory.operations["Messages.fetch"]?.responseTypes).toEqual(["Message"])

        const expected = ["request:Fixture.value", "response:Fixture.value"] as const
        const coverage = fieldRuleCoverage(
            expected,
            [
                {
                    target: "Fixture.value",
                    direction: "request",
                    providerOwner: "fixture.ts:value",
                    sdkOwner: "src/fixture.ts:value",
                    default: { kind: "omitted", detail: "fixture" },
                    length: { kind: "not-applicable", detail: "fixture" },
                    normalization: { kind: "preserved", detail: "fixture" },
                    executableEvidence: ["tests/conformance-fields-inventory.test.ts"],
                },
            ],
            [],
        )
        expect(coverage.unclassifiedTargets).toEqual(["response:Fixture.value"])
    })
})
