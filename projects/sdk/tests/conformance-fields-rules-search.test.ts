import { existsSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { InputValidationFailure } from "../src/input-validation.js"
import { encodeMessageSearch } from "../src/internal/message-search.js"
import { fieldOperationKeys } from "./conformance-fields-operations.js"
import { fieldRuleCoverage } from "./conformance-fields-registry.js"
import { searchFieldRules, searchLocalFieldExclusions } from "./conformance-fields-rules-search.js"
import { publicFieldInventory, reachablePublicFields } from "./conformance-fields-source.js"

const ownedSources = new Set(["src/discovery.ts", "src/member-search.ts", "src/message-search.ts"])
const ownedPaginationTargets = new Set([
    "MemberSearchIterationLimits.maxItems",
    "MemberSearchIterationLimits.maxPages",
    "MessageSearchIterationLimits.maxItems",
    "MessageSearchIterationLimits.maxPages",
])

describe("search field-rule annotations", () => {
    test("cover every exact source-owned request and response field once without delegation", () => {
        const inventory = publicFieldInventory("src/index.ts", fieldOperationKeys)
        const targets = (["request", "response"] as const).flatMap((direction) =>
            reachablePublicFields(inventory, direction)
                .fields.filter(
                    (field) =>
                        field.owner.split("; ").some((owner) => ownedSources.has(owner)) ||
                        (field.owner === "src/pagination.ts" && ownedPaginationTargets.has(field.key)),
                )
                .map((field) => `${direction}:${field.key}` as const),
        )
        expect(targets).toHaveLength(127)
        expect(targets.filter((target) => target.startsWith("request:"))).toHaveLength(64)
        expect(targets.filter((target) => target.startsWith("response:"))).toHaveLength(63)
        expect(searchFieldRules).toHaveLength(121)
        expect(searchLocalFieldExclusions).toHaveLength(6)
        expect(fieldRuleCoverage(targets, searchFieldRules, searchLocalFieldExclusions)).toEqual({
            duplicateTargets: [],
            unknownTargets: [],
            unclassifiedTargets: [],
            delegatedTargets: [],
        })
        for (const item of [...searchFieldRules, ...searchLocalFieldExclusions]) {
            expect(item.sdkOwner).toMatch(/^src\/.+\.ts:/)
            expect(item.executableEvidence.length).toBeGreaterThan(0)
            for (const evidence of item.executableEvidence) expect(existsSync(evidence), evidence).toBe(true)
            if ("providerOwner" in item) expect(item.providerOwner).toMatch(/\.ts:/)
        }
    })

    test("distinguish required observations from provider-owned request defaults", () => {
        const byTarget = new Map(searchFieldRules.map((rule) => [`${rule.direction}:${rule.target}`, rule]))
        for (const target of [
            "DiscoveryCategory.id",
            "DiscoveryCategory.name",
            "DiscoveryGuild.id",
            "MemberSearchHit.guildId",
            "MemberSearchHit.userId",
            "MemberSearchHit.username",
            "DiscoverySearchPage.guilds",
            "DiscoverySearchPage.categoryCounts",
            "DiscoverySearchPage.total",
            "MemberSearchPage.guildId",
            "MemberSearchPage.members",
            "MemberSearchPage.pageResultCount",
            "MemberSearchPage.totalResultCount",
            "MemberSearchPage.indexing",
            "MessageSearchChannel.id",
            "MessageSearchChannel.type",
            "MessageSearchPage.messages",
            "MessageSearchPage.channels",
            "MessageSearchPage.total",
            "MessageSearchPage.hitsPerPage",
            "MessageSearchPage.page",
        ])
            expect(byTarget.get(`response:${target}`)?.default, target).toMatchObject({ kind: "none" })
        for (const target of [
            "MessageSearchQuery.sortBy",
            "MessageSearchQuery.sortOrder",
            "MessageSearchQuery.includeNsfw",
        ])
            expect(byTarget.get(`request:${target}`)?.default, target).toMatchObject({ kind: "provider" })
    })

    test("maps the complete public message-search vocabulary without rewriting values", () => {
        const channelIds = ["20"]
        const encoded = encodeMessageSearch(
            { guildId: "40", channelId: "20" },
            {
                limit: 2,
                page: 3,
                maxId: "300",
                minId: "100",
                content: "release",
                contents: ["one", "two"],
                exactPhrases: ["exact phrase"],
                channelIds,
                excludeChannelIds: ["21"],
                authorTypes: ["bot"],
                excludeAuthorTypes: ["webhook"],
                authorIds: ["30"],
                excludeAuthorIds: ["31"],
                mentions: ["32"],
                excludeMentions: ["33"],
                mentionedEveryone: false,
                pinned: true,
                has: ["link"],
                excludeHas: ["poll"],
                embedTypes: ["article"],
                excludeEmbedTypes: ["video"],
                embedProviders: ["example"],
                excludeEmbedProviders: ["blocked"],
                linkHostnames: ["example.com"],
                excludeLinkHostnames: ["blocked.example"],
                attachmentFilenames: ["report.txt"],
                excludeAttachmentFilenames: ["secret.txt"],
                attachmentExtensions: ["txt"],
                excludeAttachmentExtensions: ["exe"],
                sortBy: "relevance",
                sortOrder: "asc",
                includeNsfw: true,
            },
        )
        expect(encoded).not.toBeInstanceOf(InputValidationFailure)
        if (encoded instanceof InputValidationFailure) throw encoded
        channelIds[0] = "99"
        expect(JSON.parse(encoded.json)).toEqual({
            scope: "current",
            context_guild_id: "40",
            context_channel_id: "20",
            hits_per_page: 2,
            page: 3,
            max_id: "300",
            min_id: "100",
            content: "release",
            contents: ["one", "two"],
            exact_phrases: ["exact phrase"],
            channel_id: ["20"],
            exclude_channel_id: ["21"],
            author_type: ["bot"],
            exclude_author_type: ["webhook"],
            author_id: ["30"],
            exclude_author_id: ["31"],
            mentions: ["32"],
            exclude_mentions: ["33"],
            mention_everyone: false,
            pinned: true,
            has: ["link"],
            exclude_has: ["poll"],
            embed_type: ["article"],
            exclude_embed_type: ["video"],
            embed_provider: ["example"],
            exclude_embed_provider: ["blocked"],
            link_hostname: ["example.com"],
            exclude_link_hostname: ["blocked.example"],
            attachment_filename: ["report.txt"],
            exclude_attachment_filename: ["secret.txt"],
            attachment_extension: ["txt"],
            exclude_attachment_extension: ["exe"],
            sort_by: "relevance",
            sort_order: "asc",
            include_nsfw: true,
        })
    })
})
