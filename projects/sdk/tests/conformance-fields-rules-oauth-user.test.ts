import { existsSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { operationConformance } from "./conformance-registry.js"
import { oauthUserFieldRules, oauthUserLocalFieldExclusions } from "./conformance-fields-rules-oauth-user.js"
import { publicFieldInventory, reachablePublicFields } from "./conformance-fields-source.js"
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

const ownedSources = new Set(["src/oauth.ts", "src/users.ts", "src/webhooks.ts"])
const delegatedKeys = new Set([
    "request:WebhookCreate.name",
    "request:WebhookEdit.name",
    "request:WebhookTokenEdit.name",
    "request:WebhookMessageInput.username",
    "response:ChannelLinkTarget.id",
])
const ownedWebhookUnionKeys = new Set([
    "request:WebhookMessageInput.attachments",
    "request:WebhookMessageInput.content",
    "request:WebhookMessageInput.embeds",
    "request:WebhookMessageInput.stickerIds",
])

describe("OAuth, user, and webhook field-rule annotations", () => {
    test("cover the exact source-derived fields owned by these modules except the shared text rules", () => {
        const inventory = publicFieldInventory("src/index.ts", operationKeys)
        const expected = new Set<string>()
        for (const direction of ["request", "response"] as const) {
            for (const field of reachablePublicFields(inventory, direction).fields) {
                if (field.owner.split("; ").some((owner) => ownedSources.has(owner))) {
                    const key = `${direction}:${field.key}`
                    if (!delegatedKeys.has(key)) expected.add(key)
                }
            }
        }
        for (const key of ownedWebhookUnionKeys) expected.add(key)
        const actual = [
            ...oauthUserFieldRules
                .filter((item) => item.direction !== "gateway")
                .map((item) => `${item.direction}:${item.target}`),
            ...oauthUserLocalFieldExclusions.map((item) => `${item.direction}:${item.target}`),
        ]
        expect(oauthUserFieldRules.filter((item) => item.direction !== "gateway")).toHaveLength(95)
        expect(oauthUserLocalFieldExclusions).toHaveLength(5)
        expect(new Set(actual).size).toBe(actual.length)
        expect(actual.sort()).toEqual([...expected].sort())
    }, 15_000)

    test("classifies the two gateway-only recipient change fields separately", () => {
        expect(
            oauthUserFieldRules
                .filter((item) => item.direction === "gateway")
                .map((item) => `${item.direction}:${item.target}`)
                .sort(),
        ).toEqual(
            ["gateway:DirectMessageRecipientChange.channelId", "gateway:DirectMessageRecipientChange.userId"].sort(),
        )
    })

    test("record exact source owners, executable evidence, and no delegated rule details", () => {
        for (const item of [...oauthUserFieldRules, ...oauthUserLocalFieldExclusions]) {
            expect(item.sdkOwner).toMatch(/^src\/.+\.ts:/)
            expect(item.executableEvidence.length, `${item.direction}:${item.target}`).toBeGreaterThan(0)
            for (const evidence of item.executableEvidence) expect(existsSync(evidence), evidence).toBe(true)
            if ("providerOwner" in item) {
                expect(item.providerOwner).toMatch(/\.(?:ts|md)(?::|#)/)
                expect(item.length.kind, `${item.direction}:${item.target}`).not.toBe("delegated")
                expect(item.normalization.kind, `${item.direction}:${item.target}`).not.toBe("delegated")
            }
        }
    })

    test("keep material SDK defaults and local-only projections explicit", () => {
        const rules = new Map(oauthUserFieldRules.map((item) => [`${item.direction}:${item.target}`, item]))
        expect(rules.get("request:OAuthAuthorizationInput.scopes")?.normalization.kind).toBe("canonicalized")
        expect(rules.get("response:User.isBot")?.default).toMatchObject({ kind: "value", value: "false" })
        expect(rules.get("response:DirectMessageChannel.nicknames")?.default).toMatchObject({
            kind: "value",
            value: "{}",
        })
        expect(rules.get("request:WebhookMessageInput.allowedMentions")?.default.kind).toBe("value")
        expect(oauthUserLocalFieldExclusions.map((item) => `${item.direction}:${item.target}`).sort()).toEqual(
            [
                "request:DefaultOAuthOperationOptions.timeoutMs",
                "response:CreatedWebhook.credentials",
                "response:CreatedWebhook.webhook",
                "response:DirectMessageLatestMessages.omittedChannelIds",
                "response:WebhookCredentials.revealToken",
            ].sort(),
        )
    })
})
