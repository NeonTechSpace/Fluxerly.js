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
        const pairs = Object.keys(defaultInventory.objects)
            .filter((name) => name.startsWith("Default") && nativeInventory.objects[name.slice(7)] !== undefined)
            .map((name) => [name, name.slice(7)] as const)
        expect(pairs.length).toBeGreaterThan(0)
        for (const [defaultName, nativeName] of pairs) {
            const fields = (inventory: PublicFieldInventory, name: string) =>
                inventory.objects[name]!.fields.map(({ name, optional, nullable }) => ({ name, optional, nullable }))
            const defaultFields = fields(defaultInventory, defaultName)
            expect(
                defaultFields.filter(({ name }) => name !== "signal"),
                defaultName,
            ).toEqual(fields(nativeInventory, nativeName))
            const signal = defaultFields.find(({ name }) => name === "signal")
            if (signal !== undefined) expect(signal, `${defaultName}.signal`).toMatchObject({ optional: true })
        }
    })
})
