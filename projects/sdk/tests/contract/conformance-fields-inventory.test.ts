import { describe, expect, test } from "vitest"
import { publicFieldInventories, type PublicFieldInventory } from "./conformance-fields-source.js"

// Compiler-backed extraction is synchronous setup, not a timed runtime operation.
// Both checks use the same source-derived inventory, regardless of shuffled test order.
const inventories = (() => {
    const { default: defaultInventory, native } = publicFieldInventories()
    return [
        ["default", defaultInventory],
        ["native", native],
    ] as const
})()

const fieldShapes = (inventory: PublicFieldInventory) =>
    new Map(
        Object.values(inventory.objects)
            .flatMap((object) => object.fields)
            .map((field) => [
                field.key,
                `${field.type}|optional=${String(field.optional)}|nullable=${String(field.nullable)}`,
            ]),
    )

describe("source-derived public operation field inventory", () => {
    test("matches the reviewed semantic surface baseline", async () => {
        const lines: string[] = []
        for (const [mode, inventory] of inventories)
            for (const operation of Object.values(inventory.operations))
                lines.push(`operation|${mode}|${operation.key}|${operation.signature}`)
        for (const [mode, inventory] of inventories)
            for (const member of inventory.members) lines.push(`member|${mode}|${member.key}|${member.type}`)
        for (const [mode, inventory] of inventories)
            for (const object of Object.values(inventory.objects))
                if (object.variants.length > 0)
                    lines.push(`union|${mode}|${object.name}|${object.variants.join(" || ")}`)
        const [[, defaultInventory], [, nativeInventory]] = inventories
        const defaultFields = fieldShapes(defaultInventory)
        const nativeFields = fieldShapes(nativeInventory)
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
        // Review an intentional public shape change, then update from projects/sdk with:
        // pnpm exec vitest run tests/contract/conformance-fields-inventory.test.ts -u
        await expect(lines.join("\n")).toMatchFileSnapshot("./conformance-fields-shapes.snapshot.txt")
    })

    test("keeps default operation options to the native fields plus an optional signal", () => {
        const [[, defaultInventory], [, nativeInventory]] = inventories
        const hasSignal = (inventory: PublicFieldInventory, name: string) =>
            inventory.objects[name]!.fields.some((field) => field.name === "signal")
        // Each entry point exports an operation's options under one name with its own shape, so the default
        // options are the same-named native options that the default API extends with an AbortSignal
        const names = Object.keys(defaultInventory.objects).filter(
            (name) =>
                /(Options|Request)$/.test(name) &&
                nativeInventory.objects[name] !== undefined &&
                hasSignal(defaultInventory, name) &&
                !hasSignal(nativeInventory, name),
        )
        expect(names).toEqual(expect.arrayContaining(["RequestOptions", "AuditedRequestOptions", "RestRequest"]))
        for (const name of names) {
            const fields = (inventory: PublicFieldInventory) =>
                inventory.objects[name]!.fields.map(({ name, optional, nullable }) => ({ name, optional, nullable }))
            const defaultFields = fields(defaultInventory)
            expect(
                defaultFields.filter(({ name }) => name !== "signal"),
                name,
            ).toEqual(fields(nativeInventory))
            expect(
                defaultFields.find(({ name }) => name === "signal"),
                `${name}.signal`,
            ).toMatchObject({ optional: true })
        }
    })
})
