import { existsSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { operationConformance } from "./conformance-registry.js"
import { fieldRuleCoverage } from "./conformance-fields-registry.js"
import { gatewayFieldRules, gatewayLocalFieldExclusions } from "./conformance-fields-rules-gateway.js"
import {
    publicFieldInventory,
    reachableGatewayPublicFields,
    reachablePublicFields,
} from "./conformance-fields-source.js"
import {
    clientTopLevelOperationConformance,
    standaloneOperationConformance,
} from "./standalone-conformance-registry.js"

const operationKeys = Object.keys({
    ...operationConformance,
    ...standaloneOperationConformance,
    ...clientTopLevelOperationConformance,
}).sort()

const requestSources = new Set([
    "src/events.ts",
    "src/presence.ts",
    "src/member-chunks.ts",
    "src/counts.ts",
    "src/instance.ts",
    "src/client.ts",
    "src/collectors.ts",
    "src/index.ts",
])
const responseSources = new Set([
    "src/member-chunks.ts",
    "src/counts.ts",
    "src/instance.ts",
    "src/application.ts",
    "src/index.ts",
    "src/assets.ts",
    "src/helpers.ts",
])
const paginationTypes = [
    "AuditLogIterationQuery.",
    "GuildIterationQuery.",
    "HistoryIterationQuery.",
    "PinIterationQuery.",
    "UserIterationQuery.",
]
const siblingOwned = new Set([
    "AuditLogIterationQuery.before",
    "AuditLogIterationQuery.userId",
    "AuditLogIterationQuery.actionType",
    "PermissionTarget.guildId",
    "PermissionTarget.userId",
])
const presenceResponseFields = new Set([
    "PresenceUpdate.afk",
    "PresenceUpdate.guildId",
    "PresenceUpdate.mobile",
    "PresenceUpdate.status",
    "PresenceUpdate.userId",
])

describe("gateway and SDK-local field-rule annotations", () => {
    test("cover the exact assigned source-derived fields", () => {
        const inventory = publicFieldInventory("src/index.ts", operationKeys)
        const operationFields = (["request", "response"] as const).flatMap((direction) =>
            reachablePublicFields(inventory, direction).fields.flatMap((field) => {
                const owners = field.owner.split("; ")
                const selected =
                    direction === "request"
                        ? owners.some((owner) => requestSources.has(owner)) ||
                          (owners.includes("src/pagination.ts") &&
                              paginationTypes.some((prefix) => field.key.startsWith(prefix))) ||
                          field.key === "PermissionTarget.channelId"
                        : owners.some((owner) => responseSources.has(owner)) || presenceResponseFields.has(field.key)
                if (!selected || siblingOwned.has(field.key)) return []
                return [`${direction}:${field.key}` as const]
            }),
        )
        const gatewayFields = reachableGatewayPublicFields(inventory)
            .fields.filter((field) => field.owner.split("; ").includes("src/events.ts"))
            .map((field) => `gateway:${field.key}` as const)
        const expected = [...operationFields, ...gatewayFields]
        const coverage = fieldRuleCoverage(expected, gatewayFieldRules, gatewayLocalFieldExclusions)
        expect(gatewayFields).toHaveLength(80)
        expect(expected).toHaveLength(234)
        expect(gatewayFieldRules).toHaveLength(131)
        expect(gatewayLocalFieldExclusions).toHaveLength(103)
        expect(coverage.duplicateTargets).toEqual([])
        expect(coverage.unknownTargets).toEqual([])
        expect(coverage.unclassifiedTargets).toEqual([])
        expect(coverage.delegatedTargets).toEqual([])
    }, 15_000)

    test("records concrete pinned provider owners, SDK symbols, and existing executable evidence", () => {
        for (const item of [...gatewayFieldRules, ...gatewayLocalFieldExclusions]) {
            if ("providerOwner" in item) expect(item.providerOwner).toMatch(/\.(?:ts:|md#)/)
            expect(item.sdkOwner).toMatch(/^src\/.+\.ts:/)
            expect(item.executableEvidence.length, `${item.direction}:${item.target}`).toBeGreaterThan(0)
            for (const evidence of item.executableEvidence) expect(existsSync(evidence), evidence).toBe(true)
        }
    })

    test("distinguishes SDK canonicalization from preserved provider scalars and explicit defaults", () => {
        const byKey = new Map(gatewayFieldRules.map((rule) => [`${rule.direction}:${rule.target}`, rule]))
        expect(byKey.get("request:CustomStatusInput.emoji")?.normalization.kind).toBe("canonicalized")
        expect(byKey.get("gateway:GuildCreate.isNewJoin")?.default).toMatchObject({
            kind: "value",
            value: "true",
        })
        expect(byKey.get("gateway:GuildCreate.isNewJoin")?.normalization.kind).toBe("canonicalized")
        expect(byKey.get("request:CustomStatusEmoji.id")?.default.kind).toBe("none")
        expect(byKey.get("request:CustomStatusEmoji.name")?.length).toMatchObject({
            kind: "bounded",
            unit: "UTF-16-code-units",
            minimum: 1,
            maximum: 32,
        })
        expect(byKey.get("response:InstanceEndpoints.apiPublic")?.normalization.kind).toBe("canonicalized")
        expect(byKey.get("response:ResolvedInstance.apiCodeVersion")?.normalization.kind).toBe("preserved")
        expect(byKey.get("response:ResolvedInstance.presignedAttachmentUploads")?.normalization.kind).toBe("preserved")
        expect(byKey.get("response:ResolvedInstance.endpoints")?.normalization.kind).toBe("canonicalized")
        expect(byKey.get("request:GuildIterationQuery.withCounts")?.default).toMatchObject({
            kind: "value",
            value: "false",
        })
    })
})
