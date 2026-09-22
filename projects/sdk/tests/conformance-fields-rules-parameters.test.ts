import { describe, expect, test } from "vitest"
import { fieldOperationKeys } from "./conformance-fields-operations.js"
import { fieldRuleCoverage } from "./conformance-fields-registry.js"
import {
    directParameterFieldRules,
    directParameterLocalExclusions,
    nativeDirectParameterLocalExclusions,
} from "./conformance-fields-rules-parameters.js"
import { directPublicOperationParameters, publicFieldInventory } from "./conformance-fields-source.js"

describe("direct operation parameter field rules", () => {
    test.each(["src/index.ts", "src/effect.ts"] as const)("classifies every %s direct parameter once", (entrypoint) => {
        const inventory = publicFieldInventory(entrypoint, fieldOperationKeys)
        const expected = directPublicOperationParameters(inventory).map(
            (parameter) => `request:${parameter.key}` as const,
        )
        if (process.env.CONFORMANCE_FIELDS_LIST === "1") console.log(entrypoint, JSON.stringify(expected))
        const exclusions =
            entrypoint === "src/effect.ts"
                ? [...directParameterLocalExclusions, ...nativeDirectParameterLocalExclusions]
                : directParameterLocalExclusions
        const coverage = fieldRuleCoverage(expected, directParameterFieldRules, exclusions)
        expect(expected).toHaveLength(entrypoint === "src/effect.ts" ? 110 : 109)
        expect(directParameterFieldRules).toHaveLength(106)
        expect(exclusions).toHaveLength(entrypoint === "src/effect.ts" ? 4 : 3)
        expect(coverage).toEqual({
            duplicateTargets: [],
            unknownTargets: [],
            unclassifiedTargets: [],
            delegatedTargets: [],
        })
        const rules = new Map(directParameterFieldRules.map((rule) => [rule.target, rule]))
        for (const parameter of directPublicOperationParameters(inventory)) {
            const rule = rules.get(parameter.key)
            if (rule !== undefined)
                expect(rule.default.kind, parameter.key).toBe(parameter.optional ? "omitted" : "none")
        }
    })

    test("keeps nullable resets, millisecond units, and opaque tokens explicit", () => {
        const rules = new Map(directParameterFieldRules.map((rule) => [rule.target, rule]))
        expect(rules.get("Members.setNickname(nickname)")?.length).toMatchObject({
            kind: "bounded",
            unit: "UTF-16-code-units",
            maximum: 32,
        })
        expect(rules.get("Members.timeout(durationMs)")?.length).toMatchObject({
            kind: "bounded",
            unit: "milliseconds",
            minimum: 1,
            maximum: 31_536_000_000,
        })
        expect(rules.get("Members.timeout(durationMs)")?.normalization).toMatchObject({ kind: "canonicalized" })
        expect(rules.get("OAuthClient.refresh(refreshToken)")?.normalization).toMatchObject({ kind: "preserved" })
        const parameters = directPublicOperationParameters(publicFieldInventory("src/index.ts", fieldOperationKeys))
        expect(parameters.find((parameter) => parameter.key === "OAuthClient.revoke(input.token)")).toMatchObject({
            optional: false,
            nullable: false,
        })
        expect(
            parameters.find((parameter) => parameter.key === "OAuthClient.revoke(input.tokenTypeHint)"),
        ).toMatchObject({ optional: true, nullable: false })
    })
})
