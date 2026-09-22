import { describe, expect, test } from "vitest"
import { fieldOperationKeys } from "./conformance-fields-operations.js"
import { fieldRuleCoverage } from "./conformance-fields-registry.js"
import { messageFieldRules, messageLocalFieldExclusions } from "./conformance-fields-rules-message.js"
import { sharedTextFieldRules } from "./conformance-fields-rules-shared.js"
import {
    publicFieldInventory,
    reachableGatewayPublicFields,
    reachablePublicFields,
} from "./conformance-fields-source.js"

const owners = new Set([
    "src/messages.ts",
    "src/embeds.ts",
    "src/attachments.ts",
    "src/reactions.ts",
    "src/pins.ts",
    "src/message-cleanup.ts",
])
const externallyOwnedKeys = new Set([
    "request:WebhookMessageInput.attachments",
    "request:WebhookMessageInput.content",
    "request:WebhookMessageInput.embeds",
    "request:WebhookMessageInput.stickerIds",
])
const additionallyOwnedKeys = ["request:ReactionEmojiInput.guildId"] as const

describe("message-family field rules", () => {
    test("classifies every source-derived request, response and gateway field without duplicate or unknown targets", () => {
        const inventory = publicFieldInventory("src/index.ts", fieldOperationKeys)
        const requestAndResponse = (["request", "response"] as const).flatMap((direction) =>
            reachablePublicFields(inventory, direction)
                .fields.filter((field) => field.owner.split("; ").some((owner) => owners.has(owner)))
                .map((field) => `${direction}:${field.key}` as const),
        )
        const gateway = reachableGatewayPublicFields(inventory)
            .fields.filter((field) => field.owner.split("; ").some((owner) => owners.has(owner)))
            .map((field) => `gateway:${field.key}` as const)
        const expected = [...new Set([...requestAndResponse, ...gateway, ...additionallyOwnedKeys])].filter(
            (key) => !externallyOwnedKeys.has(key),
        )
        const expectedSet = new Set<string>(expected)
        const sharedRules = sharedTextFieldRules.filter((rule) => expectedSet.has(`${rule.direction}:${rule.target}`))
        const coverage = fieldRuleCoverage(
            expected,
            [...messageFieldRules, ...sharedRules],
            messageLocalFieldExclusions,
        )
        expect(coverage.duplicateTargets).toEqual([])
        expect(coverage.unknownTargets).toEqual([])
        expect(coverage.unclassifiedTargets).toEqual([])
    })

    test("keeps required observations, optional absence and deliberate SDK defaults semantically distinct", () => {
        const inventory = publicFieldInventory("src/index.ts", fieldOperationKeys)
        const responseFields = reachablePublicFields(inventory, "response").fields.filter((field) =>
            field.owner.split("; ").some((owner) => owners.has(owner)),
        )
        const gatewayFields = reachableGatewayPublicFields(inventory).fields.filter((field) =>
            field.owner.split("; ").some((owner) => owners.has(owner)),
        )
        const rules = new Map(messageFieldRules.map((rule) => [`${rule.direction}:${rule.target}`, rule]))
        const exclusions = new Set(
            messageLocalFieldExclusions.map((exclusion) => `${exclusion.direction}:${exclusion.target}`),
        )
        const mismatches: string[] = []
        for (const [direction, fields] of [
            ["response", responseFields],
            ["gateway", gatewayFields],
        ] as const) {
            for (const field of fields) {
                const key = `${direction}:${field.key}`
                if (exclusions.has(key)) continue
                const kind = rules.get(key)?.default.kind
                if (field.optional ? kind !== "omitted" : kind !== "none" && kind !== "value")
                    mismatches.push(`${key} (${field.optional ? "optional" : "required"}) uses ${kind ?? "no rule"}`)
            }
        }
        expect(rules.get("response:MessageUser.isBot")?.default).toMatchObject({ kind: "value", value: "false" })
        expect(rules.get("response:ReactionUser.isBot")?.default).toMatchObject({ kind: "value", value: "false" })
        expect(
            messageFieldRules
                .filter((rule) => rule.direction !== "request" && rule.default.kind === "provider")
                .map((rule) => `${rule.direction}:${rule.target}`),
        ).toEqual([])
        expect(mismatches).toEqual([])
    })
})
