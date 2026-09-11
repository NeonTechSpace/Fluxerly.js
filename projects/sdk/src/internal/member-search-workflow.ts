import { Effect } from "effect"
import { GuildOperationError, Permissions, type GuildOperationOptions } from "#sdk/guilds"
import type { MemberSearchQuery, MemberSearchIterationLimits } from "#sdk/member-search"
import { PaginationError } from "#sdk/pagination"
import type { ClientOwner } from "./client.js"
import { guildFetch, memberSelf, roleList } from "./guilds.js"
import { calculatePermissions } from "./permissions.js"
import { memberSearch } from "./member-search.js"
import { Pagination } from "./pagination.js"
import { record } from "./message.js"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"

const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0

/** Search may enqueue indexing, so the shared REST owner's POST retry policy remains unchanged */
export function searchMembers(
    owner: ClientOwner,
    guildId: string,
    query?: MemberSearchQuery,
    options?: GuildOperationOptions,
) {
    return Effect.gen(function* () {
        const invalid = (failure: InputValidationFailure) =>
            new GuildOperationError("members.search", "input", "notDispatched", null, null, null, failure.detail)
        const request = memberSearch(guildId, query)
        if (request instanceof InputValidationFailure)
            return yield* Effect.fail(
                new GuildOperationError("members.search", "input", "notDispatched", null, null, null, request.detail),
            )
        if (options !== undefined && !record(options))
            return yield* Effect.fail(
                invalid(inputValidationFailure("options", "type", "Member search options must be an object")),
            )
        if (record(options) && Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal"))
            return yield* Effect.fail(
                invalid(
                    inputValidationFailure(
                        "options",
                        "allowedFields",
                        "Member search options may contain only timeoutMs and signal",
                    ),
                ),
            )
        const timeout = options?.timeoutMs === undefined ? 30_000 : options.timeoutMs
        if (!positive(timeout) || timeout > 2_147_483_647)
            return yield* Effect.fail(
                invalid(
                    inputValidationFailure(
                        "options.timeoutMs",
                        "range",
                        "Member search timeout must be a positive safe integer no greater than 2,147,483,647",
                    ),
                ),
            )
        const body = JSON.parse(request.json!) as { join_source_type?: unknown[]; source_invite_code?: unknown[] }
        const sensitive = (body.join_source_type?.length ?? 0) > 0 || (body.source_invite_code?.length ?? 0) > 0
        const deadline = performance.now() + timeout
        const remaining = () =>
            Effect.suspend(() => {
                const left = Math.ceil(deadline - performance.now())
                return left > 0
                    ? Effect.succeed({ timeoutMs: left })
                    : Effect.fail(new GuildOperationError("members.search", "timeout", "notDispatched"))
            })
        if (sensitive) {
            const member = yield* owner.guild("members.fetchSelf", () => memberSelf(guildId), yield* remaining())
            const guild = yield* owner.guild("guilds.fetch", () => guildFetch(guildId), yield* remaining())
            const roles = yield* owner.guild("roles.fetchAll", () => roleList(guildId), yield* remaining())
            const bits = yield* calculatePermissions({ guild, member, roles })
            if ((bits & Permissions.ManageGuild) !== Permissions.ManageGuild)
                return yield* Effect.fail(new GuildOperationError("members.search", "rejected", "notDispatched"))
        }
        return yield* owner.guild("members.search", () => request, yield* remaining())
    })
}

export function searchMemberPagination(
    owner: ClientOwner,
    guildId: string,
    filters: Omit<MemberSearchQuery, "limit">,
    limits: MemberSearchIterationLimits,
    options?: GuildOperationOptions,
) {
    return Effect.suspend(() => {
        const invalid = (failure: InputValidationFailure) =>
            Effect.fail(new PaginationError("members.iterateSearch", "input", failure.detail))
        if (!record(filters))
            return invalid(inputValidationFailure("filters", "type", "Member search filters must be an object"))
        if ("limit" in filters)
            return invalid(
                inputValidationFailure(
                    "filters",
                    "allowedFields",
                    "Member search iteration filters cannot contain limit",
                ),
            )
        if (!record(limits))
            return invalid(inputValidationFailure("limits", "type", "Member search limits must be an object"))
        if (Object.keys(limits).some((key) => !["maxItems", "maxPages", "pageSize"].includes(key)))
            return invalid(
                inputValidationFailure(
                    "limits",
                    "allowedFields",
                    "Member search limits may contain only maxItems, maxPages, and pageSize",
                ),
            )
        if (!positive(limits.maxItems))
            return invalid(
                inputValidationFailure("limits.maxItems", "range", "maxItems must be a positive safe integer"),
            )
        if (options !== undefined && !record(options))
            return invalid(inputValidationFailure("options", "type", "Member search options must be an object"))
        if (record(options) && Object.keys(options).some((key) => key !== "timeoutMs"))
            return invalid(
                inputValidationFailure(
                    "options",
                    "allowedFields",
                    "Native member search options may contain only timeoutMs",
                ),
            )
        const pageSize = limits.pageSize === undefined ? 100 : limits.pageSize,
            maxPages = limits.maxPages === undefined ? 100 : limits.maxPages
        if (!positive(pageSize) || pageSize > 100)
            return invalid(
                inputValidationFailure(
                    "limits.pageSize",
                    "range",
                    "pageSize must be a positive safe integer no greater than 100",
                ),
            )
        if (!positive(maxPages))
            return invalid(
                inputValidationFailure("limits.maxPages", "range", "maxPages must be a positive safe integer"),
            )
        if (options?.timeoutMs !== undefined && (!positive(options.timeoutMs) || options.timeoutMs > 2_147_483_647))
            return invalid(
                inputValidationFailure(
                    "options.timeoutMs",
                    "range",
                    "Member search timeout must be a positive safe integer no greater than 2,147,483,647",
                ),
            )
        const validated = memberSearch(guildId, { ...filters, limit: pageSize })
        if (validated instanceof InputValidationFailure) return invalid(validated)
        const copied = JSON.parse(JSON.stringify(filters)) as Omit<MemberSearchQuery, "limit">
        const requestOptions = options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
        const source = {
            identity: (hit: import("#sdk/member-search").MemberSearchHit) => hit.userId,
            load: (cursor: string | undefined, limit: number) =>
                Effect.gen(function* () {
                    const offset = cursor === undefined ? 0 : Number(cursor)
                    const page = yield* searchMembers(owner, guildId, { ...copied, offset, limit }, requestOptions)
                    if (page.indexing)
                        return yield* Effect.fail(new PaginationError("members.iterateSearch", "indexing"))
                    const next = offset + page.members.length
                    if (!Number.isSafeInteger(next) || (page.members.length === 0 && offset < page.totalResultCount))
                        return yield* Effect.fail(new PaginationError("members.iterateSearch", "cursorStalled"))
                    return { items: page.members, next: next >= page.totalResultCount ? null : String(next) }
                }),
        }
        return Effect.succeed(
            new Pagination(
                owner,
                "members.iterateSearch",
                {
                    maxItems: limits.maxItems,
                    maxPages,
                    pageSize,
                    cursor: String(copied.offset ?? 0),
                    options: requestOptions,
                },
                source,
            ),
        )
    })
}
