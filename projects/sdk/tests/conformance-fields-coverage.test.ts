import { describe, expect, test } from "vitest"
import { fieldOperationKeys } from "./conformance-fields-operations.js"
import { fieldRuleCoverage, type FieldRuleAnnotation, type LocalFieldExclusion } from "./conformance-fields-registry.js"
import { gatewayFieldRules, gatewayLocalFieldExclusions } from "./conformance-fields-rules-gateway.js"
import { guildFieldRules, guildLocalFieldExclusions } from "./conformance-fields-rules-guild.js"
import { messageFieldRules, messageLocalFieldExclusions } from "./conformance-fields-rules-message.js"
import { oauthUserFieldRules, oauthUserLocalFieldExclusions } from "./conformance-fields-rules-oauth-user.js"
import { searchFieldRules, searchLocalFieldExclusions } from "./conformance-fields-rules-search.js"
import { sharedTextFieldRules } from "./conformance-fields-rules-shared.js"
import {
    publicFieldInventory,
    reachableGatewayPublicFields,
    reachablePublicFields,
} from "./conformance-fields-source.js"

const authoredRules = [
    ...sharedTextFieldRules,
    ...messageFieldRules,
    ...guildFieldRules,
    ...oauthUserFieldRules,
    ...searchFieldRules,
    ...gatewayFieldRules,
]
const authoredExclusions = [
    ...messageLocalFieldExclusions,
    ...guildLocalFieldExclusions,
    ...oauthUserLocalFieldExclusions,
    ...searchLocalFieldExclusions,
    ...gatewayLocalFieldExclusions,
]

const nativeRequestTypeAliases: Readonly<Record<string, string>> = {
    AttachmentDownloadOptions: "DefaultAttachmentDownloadOptions",
    AttachmentRefreshOptions: "DefaultAttachmentRefreshOptions",
    AttachmentStreamOptions: "DefaultAttachmentStreamOptions",
    BotApplicationOperationOptions: "DefaultBotApplicationOperationOptions",
    ChannelAuditOperationOptions: "DefaultChannelAuditOperationOptions",
    ChannelOperationOptions: "DefaultChannelOperationOptions",
    CollectorOptions: "DefaultCollectorOptions",
    CountOperationOptions: "DefaultCountOperationOptions",
    EventWaitOptions: "DefaultEventWaitOptions",
    ExpressionDeleteOptions: "DefaultExpressionDeleteOptions",
    GuildAuditOperationOptions: "DefaultGuildAuditOperationOptions",
    GuildOperationOptions: "DefaultGuildOperationOptions",
    InstanceResolveOptions: "DefaultInstanceResolveOptions",
    MemberChunkOptions: "DefaultMemberChunkOptions",
    MessageCleanupOptions: "DefaultMessageCleanupOptions",
    MessageOperationOptions: "DefaultMessageOperationOptions",
    MessageSearchOptions: "DefaultMessageSearchOptions",
    ModerationOptions: "DefaultModerationOptions",
    OAuthOperationOptions: "DefaultOAuthOperationOptions",
    ReactionCollectorOptions: "DefaultReactionCollectorOptions",
    SendOptions: "DefaultSendOptions",
    TimeoutOptions: "DefaultTimeoutOptions",
    UserOperationOptions: "DefaultUserOperationOptions",
    WebhookOperationOptions: "DefaultWebhookOperationOptions",
}

function gatewayClassifications(targets: readonly string[]) {
    const explicitRules = authoredRules.filter((rule) => rule.direction === "gateway")
    const explicitExclusions = authoredExclusions.filter((rule) => rule.direction === "gateway")
    const explicit = new Set([
        ...explicitRules.map((rule) => rule.target),
        ...explicitExclusions.map((rule) => rule.target),
    ])
    const mirrors: FieldRuleAnnotation[] = []
    const mirrorExclusions: LocalFieldExclusion[] = []
    for (const target of targets) {
        if (explicit.has(target)) continue
        const responseRule = authoredRules.find((rule) => rule.direction === "response" && rule.target === target)
        if (responseRule !== undefined) mirrors.push({ ...responseRule, direction: "gateway" })
        else {
            const responseExclusion = authoredExclusions.find(
                (rule) => rule.direction === "response" && rule.target === target,
            )
            if (responseExclusion !== undefined) mirrorExclusions.push({ ...responseExclusion, direction: "gateway" })
        }
    }
    return { rules: [...explicitRules, ...mirrors], exclusions: [...explicitExclusions, ...mirrorExclusions] }
}

function classificationsForMode(
    entrypoint: "src/index.ts" | "src/effect.ts",
    expected: readonly string[],
    gateway: ReturnType<typeof gatewayClassifications>,
) {
    const availableRules = [...authoredRules.filter((rule) => rule.direction !== "gateway"), ...gateway.rules]
    const availableExclusions = [
        ...authoredExclusions.filter((rule) => rule.direction !== "gateway"),
        ...gateway.exclusions,
    ]
    const rules: FieldRuleAnnotation[] = []
    const exclusions: LocalFieldExclusion[] = []
    for (const key of expected) {
        const separator = key.indexOf(":")
        const direction = key.slice(0, separator)
        const target = key.slice(separator + 1)
        const rule = availableRules.find((item) => item.direction === direction && item.target === target)
        const exclusion = availableExclusions.find((item) => item.direction === direction && item.target === target)
        if (rule !== undefined) rules.push(rule)
        else if (exclusion !== undefined) exclusions.push(exclusion)
        else if (entrypoint === "src/effect.ts" && direction === "request") {
            const dot = target.indexOf(".")
            const nativeType = target.slice(0, dot)
            const defaultType = nativeRequestTypeAliases[nativeType]
            if (defaultType === undefined) continue
            const defaultTarget = `${defaultType}${target.slice(dot)}`
            const defaultRule = availableRules.find(
                (item) => item.direction === "request" && item.target === defaultTarget,
            )
            const defaultExclusion = availableExclusions.find(
                (item) => item.direction === "request" && item.target === defaultTarget,
            )
            if (defaultRule !== undefined) rules.push({ ...defaultRule, target })
            else if (defaultExclusion !== undefined) exclusions.push({ ...defaultExclusion, target })
        }
    }
    return { rules, exclusions }
}

describe("complete public operation object-field rule coverage", () => {
    test("audits the raw authored registry before mode-specific alias selection", () => {
        const inventories = (["src/index.ts", "src/effect.ts"] as const).map((entrypoint) =>
            publicFieldInventory(entrypoint, fieldOperationKeys),
        )
        const expected = [
            ...new Set(
                inventories.flatMap((inventory) => [
                    ...reachablePublicFields(inventory, "request").fields.map(
                        (field) => `request:${field.key}` as const,
                    ),
                    ...reachablePublicFields(inventory, "response").fields.map(
                        (field) => `response:${field.key}` as const,
                    ),
                    ...reachableGatewayPublicFields(inventory).fields.map((field) => `gateway:${field.key}` as const),
                ]),
            ),
        ]
        const coverage = fieldRuleCoverage(expected, authoredRules, authoredExclusions)
        expect(coverage.duplicateTargets).toEqual([])
        expect(coverage.unknownTargets).toEqual([])
        expect(coverage.delegatedTargets).toEqual([])

        const first = authoredRules[0]!
        const counterfeit = fieldRuleCoverage(
            expected,
            [...authoredRules, first, { ...first, target: "Counterfeit.missing" }],
            authoredExclusions,
        )
        expect(counterfeit.duplicateTargets).toContain(`${first.direction}:${first.target}`)
        expect(counterfeit.unknownTargets).toContain(`${first.direction}:Counterfeit.missing`)
    }, 15_000)

    test.each(["src/index.ts", "src/effect.ts"] as const)(
        "classifies every exact %s request, response and supported gateway field once",
        (entrypoint) => {
            const inventory = publicFieldInventory(entrypoint, fieldOperationKeys)
            const requestTargets = reachablePublicFields(inventory, "request").fields.map(
                (field) => `request:${field.key}` as const,
            )
            const responseTargets = reachablePublicFields(inventory, "response").fields.map(
                (field) => `response:${field.key}` as const,
            )
            const gatewayTargets = reachableGatewayPublicFields(inventory).fields.map(
                (field) => `gateway:${field.key}` as const,
            )
            const gateway = gatewayClassifications(gatewayTargets.map((target) => target.slice("gateway:".length)))
            const expected = [...requestTargets, ...responseTargets, ...gatewayTargets]
            const classified = classificationsForMode(entrypoint, expected, gateway)
            if (process.env.CONFORMANCE_FIELDS_LIST === "1")
                console.log(
                    "FIELD_COVERAGE",
                    JSON.stringify({
                        entrypoint,
                        request: requestTargets.length,
                        response: responseTargets.length,
                        gateway: gatewayTargets.length,
                        rules: classified.rules.length,
                        exclusions: classified.exclusions.length,
                    }),
                )
            const coverage = fieldRuleCoverage(expected, classified.rules, classified.exclusions)
            expect(coverage).toEqual({
                duplicateTargets: [],
                unknownTargets: [],
                unclassifiedTargets: [],
                delegatedTargets: [],
            })
        },
        15_000,
    )

    test("keeps every authored provider rule concrete", () => {
        expect(authoredRules.length).toBeGreaterThan(0)
        expect(
            authoredRules.filter((rule) => rule.length.kind === "delegated" || rule.normalization.kind === "delegated"),
        ).toEqual([])
    })
})
