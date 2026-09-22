import { describe, expect, test } from "vitest"
import * as defaultModule from "../src/index.js"
import * as effectModule from "../src/effect.js"
import { expectedModuleExports, moduleConformance, validateModuleConformance } from "./module-conformance-registry.js"

describe("public runtime module conformance", () => {
    test.each([
        ["default", defaultModule],
        ["effect", effectModule],
    ] as const)("inventories every %s entrypoint value export", (mode, moduleObject) => {
        const result = validateModuleConformance(mode, moduleObject)
        expect(result.names).toEqual(expectedModuleExports(mode))
        expect(Object.keys(moduleConformance[mode].categories)).toEqual(
            expect.arrayContaining([
                "local helper namespaces",
                "local builders",
                "local constants",
                "public error classes",
                "client factory",
                "supervisor factory and tools",
            ]),
        )
    })

    test("records the exact intentional runtime differences between entrypoints", () => {
        const defaultNames = expectedModuleExports("default")
        const effectNames = expectedModuleExports("effect")
        expect(defaultNames.filter((name) => !effectNames.includes(name))).toEqual(
            [...moduleConformance.default.intentionalDifferences.onlyHere].sort(),
        )
        expect(effectNames.filter((name) => !defaultNames.includes(name))).toEqual(
            [...moduleConformance.effect.intentionalDifferences.onlyHere].sort(),
        )
        expect(moduleConformance.default.intentionalDifferences.onlyInOtherEntrypoint).toEqual(
            moduleConformance.effect.intentionalDifferences.onlyHere,
        )
        expect(moduleConformance.effect.intentionalDifferences.onlyInOtherEntrypoint).toEqual(
            moduleConformance.default.intentionalDifferences.onlyHere,
        )
    })

    test("rejects counterfeit modules with a dropped or added runtime value", () => {
        const { createClient: _dropped, ...missing } = defaultModule
        expect(() => validateModuleConformance("default", missing)).toThrow(/missing: createClient/)
        expect(() => validateModuleConformance("effect", { ...effectModule, counterfeit: true })).toThrow(
            /added: counterfeit/,
        )
    })
})
