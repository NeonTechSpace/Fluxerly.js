import { existsSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { channelName, memberNickname, normalizedText, rawText } from "../src/internal/field-text.js"
import { sharedTextFieldRules } from "./conformance-fields-rules-shared.js"

describe("shared field-rule annotations", () => {
    test("keep every annotation complete and tied to executable evidence", () => {
        expect(new Set(sharedTextFieldRules.map((rule) => rule.target)).size).toBe(sharedTextFieldRules.length)
        for (const rule of sharedTextFieldRules) {
            expect(rule.providerOwner).toMatch(/\.ts:/)
            expect(rule.sdkOwner).toMatch(/^src\/.+\.ts:/)
            expect(rule.length.kind).not.toBe("delegated")
            expect(rule.normalization.kind).not.toBe("delegated")
            expect(rule.executableEvidence.length, `${rule.target} executable evidence`).toBeGreaterThan(0)
            for (const evidence of rule.executableEvidence) expect(existsSync(evidence), evidence).toBe(true)
        }
    })

    test("measures provider-normalized text in UTF-16 code units without rewriting the value", () => {
        expect(normalizedText(" \fA\u202e ", 1, 1)).toBe(true)
        expect(normalizedText("😀", 1, 1)).toBe(false)
        expect(normalizedText("😀", 2, 2)).toBe(true)
        expect(rawText("😀", 2, 2)).toBe(true)
    })

    test("keeps channel-name and nickname preprocessing distinct", () => {
        expect(channelName("  guild\u200d  channel  ")).toBe(true)
        expect(channelName("\u200d")).toBe(false)
        expect(memberNickname("   ")).toBe(true)
        expect(memberNickname("\u202e")).toBe(false)
    })
})
