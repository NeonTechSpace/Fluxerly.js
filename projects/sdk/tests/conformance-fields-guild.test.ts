import { existsSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { operationConformance } from "./conformance-registry.js"
import { guildFieldRules, guildLocalFieldExclusions } from "./conformance-fields-rules-guild.js"
import {
    publicFieldInventory,
    reachableGatewayPublicFields,
    reachablePublicFields,
} from "./conformance-fields-source.js"
import {
    clientTopLevelOperationConformance,
    standaloneOperationConformance,
} from "./standalone-conformance-registry.js"

const operationKeys = Object.freeze(
    Object.keys({
        ...operationConformance,
        ...standaloneOperationConformance,
        ...clientTopLevelOperationConformance,
    }).sort(),
)

const ownedSources = new Set([
    "src/guilds.ts",
    "src/channels.ts",
    "src/audit-logs.ts",
    "src/expressions.ts",
    "src/invites.ts",
])

const delegatedKeys = new Set([
    "request:MemberProfileEdit.bio",
    "request:MemberProfileEdit.pronouns",
    "request:RoleCreate.name",
    "request:RoleEdit.name",
    "request:ReactionEmojiInput.animated",
    "request:ReactionEmojiInput.guildId",
    "request:ReactionEmojiInput.id",
    "request:ReactionEmojiInput.name",
])

describe("guild-family field-rule annotations", () => {
    test("cover the exact source-derived request, response, and gateway-only fields owned by these modules", () => {
        const inventory = publicFieldInventory("src/index.ts", operationKeys)
        const expected = new Set<string>()
        const responseKeys = new Set(reachablePublicFields(inventory, "response").fields.map((field) => field.key))
        for (const direction of ["request", "response"] as const) {
            for (const field of reachablePublicFields(inventory, direction).fields) {
                if (field.owner.split("; ").some((owner) => ownedSources.has(owner))) {
                    const key = `${direction}:${field.key}`
                    if (!delegatedKeys.has(key)) expected.add(key)
                }
            }
        }
        for (const field of reachableGatewayPublicFields(inventory).fields) {
            if (!responseKeys.has(field.key) && field.owner.split("; ").some((owner) => ownedSources.has(owner)))
                expected.add(`gateway:${field.key}`)
        }
        const actual = [
            ...guildFieldRules.map((item) => `${item.direction}:${item.target}`),
            ...guildLocalFieldExclusions.map((item) => `${item.direction}:${item.target}`),
        ]
        expect(new Set(actual).size).toBe(actual.length)
        expect(actual.sort()).toEqual([...expected].sort())
        expect(actual.filter((key) => key.startsWith("gateway:"))).toHaveLength(36)
    }, 15_000)

    test("record pinned provider owners, SDK symbols, and executable evidence", () => {
        for (const item of [...guildFieldRules, ...guildLocalFieldExclusions]) {
            if ("providerOwner" in item) expect(item.providerOwner).toMatch(/\.ts:/)
            expect(item.sdkOwner).toMatch(/^src\/.+\.ts:/)
            expect(item.executableEvidence.length, `${item.direction}:${item.target}`).toBeGreaterThan(0)
            for (const evidence of item.executableEvidence) expect(existsSync(evidence), evidence).toBe(true)
        }
    })

    test("keeps deliberate SDK defaults and decoder absence rules explicit", () => {
        const byKey = new Map(guildFieldRules.map((rule) => [`${rule.direction}:${rule.target}`, rule]))
        expect(byKey.get("request:InviteCreate.maxAgeSeconds")?.default).toMatchObject({
            kind: "value",
            value: "86400",
        })
        expect(byKey.get("request:InviteCreate.unique")?.default).toMatchObject({ kind: "value", value: "true" })
        expect(byKey.get("request:RoleCreate.permissions")?.default).toMatchObject({
            kind: "value",
            value: "0n",
        })
        expect(byKey.get("request:GuildListQuery.withCounts")?.default).toMatchObject({
            kind: "value",
            value: "false",
            detail: expect.stringContaining("always serializes false"),
        })
        expect(byKey.get("request:ChannelPosition.syncPermissionsOnMove")?.default.kind).toBe("omitted")
        expect(byKey.get("response:GuildMember.nickname")?.default.kind).toBe("omitted")
        expect(byKey.get("response:GuildMember.isBot")?.default).toMatchObject({ kind: "value", value: "false" })
        expect(byKey.get("gateway:GuildDeletion.unavailable")?.default).toMatchObject({
            kind: "value",
            value: "false",
        })
    })

    test("records audit-header trimming as request canonicalization", () => {
        const byKey = new Map(guildFieldRules.map((rule) => [`${rule.direction}:${rule.target}`, rule]))
        for (const target of [
            "DefaultGuildAuditOperationOptions.auditReason",
            "DefaultModerationOptions.auditReason",
            "DefaultTimeoutOptions.auditReason",
            "DefaultExpressionDeleteOptions.auditReason",
            "DefaultChannelAuditOperationOptions.auditReason",
        ])
            expect(byKey.get(`request:${target}`)?.normalization).toMatchObject({
                kind: "canonicalized",
                detail: expect.stringContaining("trims surrounding whitespace"),
            })
    })

    test("does not turn provider response absence into a required observation or hidden default", () => {
        const inventory = publicFieldInventory("src/index.ts", operationKeys)
        const fields = reachablePublicFields(inventory, "response").fields.filter((field) =>
            field.owner.split("; ").some((owner) => ownedSources.has(owner)),
        )
        const rules = new Map(guildFieldRules.map((rule) => [`${rule.direction}:${rule.target}`, rule]))
        const exclusions = new Set(
            guildLocalFieldExclusions.map((exclusion) => `${exclusion.direction}:${exclusion.target}`),
        )
        for (const field of fields) {
            const key = `response:${field.key}`
            if (exclusions.has(key)) continue
            const annotation = rules.get(key)
            expect(annotation, key).toBeDefined()
            if (field.optional) expect(annotation?.default.kind, key).toBe("omitted")
            else expect(annotation?.default.kind, key).not.toBe("omitted")
        }
    })

    test("does not assign defaults to required public request properties", () => {
        const inventory = publicFieldInventory("src/index.ts", operationKeys)
        const fields = reachablePublicFields(inventory, "request").fields.filter((field) =>
            field.owner.split("; ").some((owner) => ownedSources.has(owner)),
        )
        const rules = new Map(guildFieldRules.map((rule) => [`${rule.direction}:${rule.target}`, rule]))
        const exclusions = new Set(
            guildLocalFieldExclusions.map((exclusion) => `${exclusion.direction}:${exclusion.target}`),
        )
        for (const field of fields) {
            const key = `request:${field.key}`
            if (delegatedKeys.has(key) || exclusions.has(key)) continue
            if (field.optional) expect(rules.get(key)?.default.kind, key).not.toBe("none")
            else expect(rules.get(key)?.default.kind, key).toBe("none")
        }
    })
})
