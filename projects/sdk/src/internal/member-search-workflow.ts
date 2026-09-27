/**
 * Member search workflows: Bounded traversal over member search pages.
 * Invariant: Traversal combines existing page operations with bounded work and retains no roster.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Effect from "effect/Effect"
import { GuildOperationError, Permissions, type GuildOperationOptions } from "#sdk/guilds"
import type { MemberSearchQuery, MemberSearchIterationLimits } from "#sdk/member-search"
import { PaginationError } from "#sdk/pagination"
import type { ClientOwner } from "./client.js"
import { guildFetch, memberSelf, roleList } from "./guilds.js"
import { calculatePermissions } from "./permissions.js"
import { encodeMemberSearchQuery, memberSearch } from "./member-search.js"
import { Pagination } from "./pagination.js"
import { suspendInput } from "./defects.js"
import { identifier, record } from "./decode/primitives.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"

const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0

/** Search may enqueue indexing, so the shared REST owner's POST retry policy remains unchanged */
export function searchMembers(
    owner: Pick<ClientOwner, "guild" | "logical"> & { readonly defaultTimeoutMs?: number },
    guildId: string,
    query?: MemberSearchQuery,
    options?: GuildOperationOptions,
) {
    const invalid = (failure: InputValidationFailure) =>
        Effect.fail(
            new GuildOperationError({
                operation: "members.search",
                reason: "input",
                outcome: "notDispatched",
                inputValidation: failure.detail,
            }),
        )
    // Reading and validating the caller query and options is marked as application input
    return suspendInput(() => {
        const request = memberSearch(guildId, query)
        if (request instanceof InputValidationFailure) return invalid(request)
        if (options !== undefined && !record(options))
            return invalid(inputValidationFailure("options", "type", "Member search options must be an object"))
        const unsupported = record(options)
            ? unsupportedKeyFailure(options, ["timeoutMs", "signal"], "options", "the member search options")
            : undefined
        if (unsupported) return invalid(unsupported)
        const timeoutInput = options?.timeoutMs
        const timeout = timeoutInput === undefined ? (owner.defaultTimeoutMs ?? 30_000) : timeoutInput
        if (!positive(timeout) || timeout > 2_147_483_647)
            return invalid(
                inputValidationFailure(
                    "options.timeoutMs",
                    "range",
                    "Member search timeout must be an integer from 1 through 2,147,483,647 ms",
                ),
            )
        return Effect.succeed([request, timeout] as const)
    }).pipe(Effect.flatMap(([request, timeout]) => searchValidated(owner, guildId, request, timeout)))
}

/** Run one validated member search, checking Manage Guild first when the filters select sensitive join sources */
function searchValidated(
    owner: Pick<ClientOwner, "guild" | "logical">,
    guildId: string,
    request: Exclude<ReturnType<typeof memberSearch>, InputValidationFailure>,
    timeout: number,
) {
    return Effect.gen(function* () {
        const body = JSON.parse(request.json!) as { join_source_type?: unknown[]; source_invite_code?: unknown[] }
        const sensitive = (body.join_source_type?.length ?? 0) > 0 || (body.source_invite_code?.length ?? 0) > 0
        const now = () => owner.logical.now()
        const deadline = now() + timeout
        const remaining = () =>
            Effect.suspend(() => {
                const left = Math.ceil(deadline - now())
                return left > 0
                    ? Effect.succeed({ timeoutMs: left })
                    : Effect.fail(
                          new GuildOperationError({
                              operation: "members.search",
                              reason: "timeout",
                              outcome: "notDispatched",
                          }),
                      )
            })
        if (sensitive) {
            const [member, guild, roles] = yield* Effect.all(
                [
                    remaining().pipe(
                        Effect.flatMap((options) =>
                            owner.guild("members.fetchSelf", () => memberSelf(guildId), options),
                        ),
                    ),
                    remaining().pipe(
                        Effect.flatMap((options) => owner.guild("guilds.fetch", () => guildFetch(guildId), options)),
                    ),
                    remaining().pipe(
                        Effect.flatMap((options) => owner.guild("roles.fetchAll", () => roleList(guildId), options)),
                    ),
                ],
                { concurrency: 3 },
            )
            const bits = yield* calculatePermissions({ guild, member, roles })
            if ((bits & Permissions.ManageGuild) !== Permissions.ManageGuild)
                return yield* Effect.fail(
                    new GuildOperationError({
                        operation: "members.search",
                        reason: "rejected",
                        outcome: "notDispatched",
                    }),
                )
        }
        return yield* owner.guild("members.search", () => request, yield* remaining())
    })
}

export function searchMemberPagination(
    owner: Pick<ClientOwner, "guild" | "logical" | "subscribe" | "state"> & { readonly defaultTimeoutMs?: number },
    guildId: string,
    filters: Omit<MemberSearchQuery, "limit">,
    limits: MemberSearchIterationLimits,
    options?: GuildOperationOptions,
) {
    // Reading and validating the caller filters, limits and options is marked as application input
    return suspendInput(() => {
        const invalid = (failure: InputValidationFailure) =>
            Effect.fail(
                new PaginationError({
                    operation: "members.iterateSearch",
                    reason: "input",
                    inputValidation: failure.detail,
                }),
            )
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
        const unsupportedLimit = unsupportedKeyFailure(
            limits,
            ["maxItems", "maxPages", "pageSize"],
            "limits",
            "the member search limits",
        )
        if (unsupportedLimit) return invalid(unsupportedLimit)
        const maxItems = limits.maxItems
        if (!positive(maxItems))
            return invalid(
                inputValidationFailure(
                    "limits.maxItems",
                    "range",
                    "The limit maxItems is required and must be a positive safe integer",
                ),
            )
        if (options !== undefined && !record(options))
            return invalid(inputValidationFailure("options", "type", "Member search options must be an object"))
        // The native Effect API cancels by interruption, so its options have no signal
        const unsupportedOption = record(options)
            ? unsupportedKeyFailure(options, ["timeoutMs"], "options", "the member search options")
            : undefined
        if (unsupportedOption) return invalid(unsupportedOption)
        const pageSize = limits.pageSize === undefined ? 100 : limits.pageSize,
            maxPages = limits.maxPages === undefined ? 100 : limits.maxPages
        if (!positive(pageSize) || pageSize > 100)
            return invalid(
                inputValidationFailure(
                    "limits.pageSize",
                    "range",
                    "The limit pageSize must be an integer from 1 through 100",
                ),
            )
        if (!positive(maxPages))
            return invalid(
                inputValidationFailure(
                    "limits.maxPages",
                    "range",
                    "The limit maxPages must be a positive safe integer",
                ),
            )
        const timeoutMs = options?.timeoutMs
        if (timeoutMs !== undefined && (!positive(timeoutMs) || timeoutMs > 2_147_483_647))
            return invalid(
                inputValidationFailure(
                    "options.timeoutMs",
                    "range",
                    "Member search timeout must be an integer from 1 through 2,147,483,647 ms",
                ),
            )
        if (!identifier(guildId))
            return invalid(inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings"))
        const validated = encodeMemberSearchQuery(filters)
        if (validated instanceof InputValidationFailure) return invalid(validated)
        const copied = validated.query
        const requestOptions = timeoutMs === undefined ? {} : { timeoutMs }
        const source = {
            identity: (hit: import("#sdk/member-search").MemberSearchHit) => hit.userId,
            load: (cursor: string | undefined, limit: number) =>
                Effect.gen(function* () {
                    const offset = cursor === undefined ? 0 : Number(cursor)
                    const page = yield* searchMembers(owner, guildId, { ...copied, offset, limit }, requestOptions)
                    if (page.indexing)
                        return yield* Effect.fail(
                            new PaginationError({ operation: "members.iterateSearch", reason: "indexing" }),
                        )
                    const next = offset + page.members.length
                    if (!Number.isSafeInteger(next) || (page.members.length === 0 && offset < page.totalResultCount))
                        return yield* Effect.fail(
                            new PaginationError({ operation: "members.iterateSearch", reason: "cursorStalled" }),
                        )
                    return { items: page.members, next: next >= page.totalResultCount ? null : String(next) }
                }),
        }
        return Effect.succeed(
            () =>
                new Pagination(
                    owner,
                    "members.iterateSearch",
                    {
                        maxItems,
                        maxPages,
                        pageSize,
                        cursor: String(copied.offset ?? 0),
                        options: requestOptions,
                    },
                    source,
                ),
        )
    }).pipe(Effect.map((create) => create()))
}
