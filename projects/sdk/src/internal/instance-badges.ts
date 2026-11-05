/**
 * Instance community badge reads: Request validation and response decoding for client.instance.fetchBadges.
 * Invariant: Requests go through the shared REST scheduler as guild-family reads and never enter a cache.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { InstanceBadge, InstanceBadgePage } from "#sdk/instance"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { fieldsOnce, identifier, inputId, integerInRange, record, snapshotArray } from "./decode/primitives.js"
import type { GuildRequest } from "./guilds.js"

/** Fluxer's lookup and page limits for community badges */
const maxLookupIds = 100
const maxPageLimit = 200
const defaultPageLimit = 100
const position = /^-?[0-9]{1,19}$/

const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string"

function decodeBadge(value: unknown): InstanceBadge | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.name !== "string" ||
        !nullableText(value.description) ||
        typeof value.asset_url !== "string" ||
        !nullableText(value.href) ||
        typeof value.position !== "string" ||
        !position.test(value.position)
    )
        return undefined
    return Object.freeze({
        id: value.id,
        name: value.name,
        description: value.description,
        assetUrl: value.asset_url,
        href: value.href,
        position: value.position,
    })
}

/** Build one community badge lookup by IDs, or one page of every community badge */
export function instanceBadges(query: unknown): GuildRequest<InstanceBadgePage> | InputValidationFailure {
    const input = query === undefined ? {} : query
    if (!record(input)) return inputValidationFailure("query", "type", "Badge query must be an object")
    const unsupported = unsupportedKeyFailure(input, ["ids", "after", "limit"], "query", "the badge query")
    if (unsupported) return unsupported
    const field = fieldsOnce(input)
    const ids = field("ids")
    const after = field("after")
    const limit = field("limit")
    const parameters = new URLSearchParams()
    let maximum: number
    if (ids !== undefined) {
        if (after !== undefined || limit !== undefined)
            return inputValidationFailure("query.ids", "relationship", "Send either ids or after and limit")
        if (!Array.isArray(ids)) return inputValidationFailure("query.ids", "type", "Badge IDs must be an array")
        const items = snapshotArray(ids, maxLookupIds)
        if (items === undefined || items.length === 0)
            return inputValidationFailure("query.ids", "length", `Send 1 through ${maxLookupIds} badge IDs`)
        const trimmed = items.map(inputId)
        if (!trimmed.every((id) => id !== undefined))
            return inputValidationFailure(
                "query.ids[]",
                "format",
                "Badge IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
            )
        parameters.set("ids", trimmed.join(","))
        maximum = items.length
    } else {
        if (after !== undefined && (typeof after !== "string" || after === ""))
            return inputValidationFailure("query.after", "format", "Badge cursor must be the nextAfter of a page")
        if (limit !== undefined && !integerInRange(limit, 1, maxPageLimit))
            return inputValidationFailure(
                "query.limit",
                "range",
                `Badge limit must be an integer from 1 through ${maxPageLimit}`,
            )
        if (after !== undefined) parameters.set("after", after as string)
        if (limit !== undefined) parameters.set("limit", String(limit))
        maximum = (limit as number | undefined) ?? defaultPageLimit
    }
    const search = parameters.toString()
    return {
        guildId: "instance",
        bucket: "instance:badges",
        path: `/instance/badges${search === "" ? "" : `?${search}`}`,
        method: "GET",
        status: 200,
        decode: (value) => {
            if (
                !record(value) ||
                typeof value.version !== "string" ||
                !nullableText(value.next) ||
                !Array.isArray(value.badges) ||
                value.badges.length > maximum
            )
                return undefined
            const badges: InstanceBadge[] = []
            for (const item of value.badges) {
                const badge = decodeBadge(item)
                if (!badge) return undefined
                badges.push(badge)
            }
            return Object.freeze({
                version: value.version,
                badges: Object.freeze(badges),
                nextAfter: value.next,
            })
        },
    }
}
