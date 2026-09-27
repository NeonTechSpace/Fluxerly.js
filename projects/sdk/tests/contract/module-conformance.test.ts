import { describe, expect, test } from "vitest"
import * as defaultModule from "../../src/index.js"
import * as effectModule from "../../src/effect.js"
import * as testingModule from "../../src/testing.js"
import * as effectTestingModule from "../../src/effect-testing.js"
import { expectedModuleExports, validateModuleConformance } from "./module-conformance-registry.js"

describe("public runtime module conformance", () => {
    test.each([
        ["default", defaultModule],
        ["effect", effectModule],
        ["testing", testingModule],
        ["effectTesting", effectTestingModule],
    ] as const)("inventories every %s entrypoint value export", (mode, moduleObject) => {
        expect(validateModuleConformance(mode, moduleObject).names).toEqual(expectedModuleExports(mode))
    })

    test("shares the fixture objects between both testing entrypoints", () => {
        expect(effectTestingModule.fixtures).toBe(testingModule.fixtures)
        expect(effectTestingModule.fixtureToken).toBe(testingModule.fixtureToken)
        expect(effectTestingModule.createFixtures).toBe(testingModule.createFixtures)
        expect(effectTestingModule.createTestClient).not.toBe(testingModule.createTestClient)
    })
})
