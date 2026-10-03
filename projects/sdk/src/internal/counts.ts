/**
 * Fresh gateway counts: Nonce-correlated guild and channel member count requests across shards.
 * Invariant: One logical request holds one admission slot across its shard fragments and releases every fragment on terminal
 * failure or interruption. Provider omissions are result data, not a substitute for routing, readiness or transport failures,
 * and no count is retained. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { randomUUID } from "node:crypto"
import * as Effect from "effect/Effect"
import {
    CountOperationError,
    type ChannelMemberCount,
    type ChannelMemberCountsResult,
    type CountOperation,
    type CountOperationOptions,
    type GuildCount,
    type GuildCountsResult,
} from "#sdk/counts"
import { ClientClosedError } from "#sdk/errors"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { withDeadline } from "./effect-failures.js"
import { GatewayRequestBudget } from "./gateway-requests.js"
import type { InternalSubmission } from "./gateway/commands.js"
import { gatewayIdentifier, nonNegativeInteger, record, snapshotArray } from "./decode/primitives.js"
import { readCaller, suspendMarked } from "./defects.js"

const defaultTimeoutMs = 30_000

interface GatewaySender {
    readonly guilds: (guildIds: readonly string[], nonce: string) => InternalSubmission
    readonly channels: (guildId: string, channelIds: readonly string[], nonce: string) => InternalSubmission
}

interface RoutedGuilds {
    readonly shardId: number
    readonly guildIds: readonly string[]
    readonly sender: GatewaySender
}

interface Request {
    readonly operation: CountOperation
    readonly ids: readonly string[]
    readonly guildId?: string
    readonly complete: (result: Effect.Effect<GuildCountsResult | ChannelMemberCountsResult, CountFailure>) => void
    readonly release: () => void
    readonly nonces: Set<string>
    readonly withdraw: Set<() => void>
    readonly counts: Map<string, GuildCount | ChannelMemberCount>
    finished: boolean
}

interface Pending {
    readonly request: Request
    readonly shardId: number
    readonly guildIds: readonly string[]
    readonly channelIds?: readonly string[]
}

type CountFailure = CountOperationError | ClientClosedError
type GatewayRoute = (guildId: string) => number | undefined

/** Gateway-private bridge for fresh count frames. It retains only active reply correlations, never count observations */
export interface CountGatewayOwner {
    attach(
        guilds: (guildIds: readonly string[], nonce: string) => InternalSubmission,
        channels: (guildId: string, channelIds: readonly string[], nonce: string) => InternalSubmission,
        shardId?: number,
    ): void
    detach(shardId?: number): void
    receiveGuildCounts(value: unknown): void
    receiveChannelMemberCounts(value: unknown): void
}

const shard = (value: unknown): value is number => nonNegativeInteger(value)

function copyIdentifiers(
    value: unknown,
    path: "guildIds" | "channelIds",
    maximum: number,
): readonly string[] | InputValidationFailure {
    if (!Array.isArray(value)) return inputValidationFailure(path, "type", "Must be a non-empty array of canonical IDs")
    // Copy once and validate the copy, so the validated IDs are the ones requested
    const ids = snapshotArray(value, maximum)
    if (ids === undefined || ids.length < 1)
        return inputValidationFailure(path, "length", `Must contain from 1 through ${maximum} IDs`)
    if (!ids.every(gatewayIdentifier))
        return inputValidationFailure(
            path,
            "format",
            "Each ID must be a canonical positive decimal string no greater than 9223372036854775807",
        )
    return new Set(ids).size === ids.length
        ? (ids as readonly string[])
        : inputValidationFailure(path, "unique", "Must not contain duplicate IDs")
}

function timeout(value: unknown): number | InputValidationFailure {
    if (value !== undefined && !record(value))
        return inputValidationFailure("options", "type", "Must be an options object when supplied")
    const unsupported =
        value === undefined
            ? undefined
            : unsupportedKeyFailure(value, ["timeoutMs", "signal"], "options", "the operation options")
    if (unsupported) return unsupported
    const timeoutMs = value === undefined ? undefined : value.timeoutMs
    const duration = timeoutMs === undefined ? defaultTimeoutMs : timeoutMs
    if (typeof duration !== "number")
        return inputValidationFailure("options.timeoutMs", "type", "Must be an integer number of milliseconds")
    return Number.isSafeInteger(duration) && duration >= 1 && duration <= 2_147_483_647
        ? duration
        : inputValidationFailure(
              "options.timeoutMs",
              "range",
              "Must be an integer from 1 through 2147483647 milliseconds",
          )
}

function nonce(value: unknown): string | undefined {
    return record(value) && typeof value.nonce === "string" ? value.nonce : undefined
}

function reply(value: unknown): { readonly counts: readonly unknown[] } | undefined {
    return record(value) && Array.isArray(value.counts) ? { counts: value.counts } : undefined
}

function guildCounts(guildIds: readonly string[], value: unknown): readonly GuildCount[] | undefined {
    const response = reply(value)
    if (!response || response.counts.length > guildIds.length) return undefined
    const counts = new Map<string, GuildCount>()
    for (const entry of response.counts) {
        if (
            !record(entry) ||
            !gatewayIdentifier(entry.guild_id) ||
            !nonNegativeInteger(entry.member_count) ||
            !nonNegativeInteger(entry.online_count) ||
            Object.hasOwn(entry, "channel_id") ||
            !guildIds.includes(entry.guild_id) ||
            counts.has(entry.guild_id)
        )
            return undefined
        counts.set(
            entry.guild_id,
            Object.freeze({
                guildId: entry.guild_id,
                memberCount: entry.member_count,
                onlineCount: entry.online_count,
            }),
        )
    }
    return Object.freeze(guildIds.flatMap((guildId) => (counts.has(guildId) ? [counts.get(guildId)!] : [])))
}

function channelCounts(
    guildId: string,
    channelIds: readonly string[],
    value: unknown,
): readonly ChannelMemberCount[] | undefined {
    const response = reply(value)
    if (!response || response.counts.length > channelIds.length) return undefined
    const counts = new Map<string, ChannelMemberCount>()
    for (const entry of response.counts) {
        if (
            !record(entry) ||
            entry.guild_id !== guildId ||
            !gatewayIdentifier(entry.channel_id) ||
            !nonNegativeInteger(entry.member_count) ||
            !nonNegativeInteger(entry.online_count) ||
            !channelIds.includes(entry.channel_id) ||
            counts.has(entry.channel_id)
        )
            return undefined
        counts.set(
            entry.channel_id,
            Object.freeze({
                guildId,
                channelId: entry.channel_id,
                memberCount: entry.member_count,
                onlineCount: entry.online_count,
            }),
        )
    }
    return Object.freeze(channelIds.flatMap((channelId) => (counts.has(channelId) ? [counts.get(channelId)!] : [])))
}

/**
 * Owns nonce-correlated count requests across attached shards. Each logical request keeps one shared admission slot,
 * even when its requested guilds need several gateway commands
 */
export class CountOwner implements CountGatewayOwner {
    #senders = new Map<number, GatewaySender>()
    #pending = new Map<string, Pending>()
    #closed = false

    constructor(
        private readonly budget = new GatewayRequestBudget(),
        private readonly routeGuild: GatewayRoute = () => 0,
    ) {}

    attach(
        guilds: (guildIds: readonly string[], nonce: string) => InternalSubmission,
        channels: (guildId: string, channelIds: readonly string[], nonce: string) => InternalSubmission,
        shardId = 0,
    ) {
        if (!this.#closed && shard(shardId)) this.#senders.set(shardId, { guilds, channels })
    }

    detach(shardId?: number) {
        if (shardId === undefined) {
            this.#senders.clear()
            this.#failPending(() => true, "connectionLost")
            return
        }
        if (!shard(shardId)) return
        this.#senders.delete(shardId)
        this.#failPending((pending) => pending.shardId === shardId, "connectionLost")
    }

    close() {
        if (this.#closed) return
        this.#closed = true
        this.#senders.clear()
        this.#failPending(() => true, new ClientClosedError())
    }

    fetchGuilds(guildIds: readonly string[], options?: CountOperationOptions) {
        return this.#request("guilds.fetchCounts", guildIds, undefined, options).pipe(
            Effect.map((result) => result as GuildCountsResult),
        )
    }

    fetchChannels(guildId: string, channelIds: readonly string[], options?: CountOperationOptions) {
        return this.#request("channels.fetchMemberCounts", channelIds, guildId, options).pipe(
            Effect.map((result) => result as ChannelMemberCountsResult),
        )
    }

    receiveGuildCounts(value: unknown) {
        const valueNonce = nonce(value)
        if (!valueNonce) return
        const pending = this.#pending.get(valueNonce)
        if (!pending || pending.request.operation !== "guilds.fetchCounts") return
        const counts = guildCounts(pending.guildIds, value)
        if (!counts) {
            this.#settle(
                pending.request,
                Effect.fail(new CountOperationError({ operation: pending.request.operation, reason: "response" })),
            )
            return
        }
        this.#complete(valueNonce, counts)
    }

    receiveChannelMemberCounts(value: unknown) {
        const valueNonce = nonce(value)
        if (!valueNonce) return
        const pending = this.#pending.get(valueNonce)
        if (!pending || pending.request.operation !== "channels.fetchMemberCounts" || !pending.channelIds) return
        const counts = channelCounts(pending.request.guildId!, pending.channelIds, value)
        if (!counts) {
            this.#settle(
                pending.request,
                Effect.fail(new CountOperationError({ operation: pending.request.operation, reason: "response" })),
            )
            return
        }
        this.#complete(valueNonce, counts)
    }

    #request(
        operation: CountOperation,
        ids: readonly string[],
        guildId: string | undefined,
        options?: CountOperationOptions,
    ) {
        // Only reading the caller IDs and options is marked, so a throw there is an application fault
        return suspendMarked(() => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const guildRequest = operation === "guilds.fetchCounts"
            const copiedIds = readCaller(() =>
                copyIdentifiers(ids, guildRequest ? "guildIds" : "channelIds", guildRequest ? 100 : 25),
            )
            if (copiedIds instanceof InputValidationFailure)
                return Effect.fail(
                    new CountOperationError({ operation, reason: "input", inputValidation: copiedIds.detail }),
                )
            const duration = readCaller(() => timeout(options))
            if (duration instanceof InputValidationFailure)
                return Effect.fail(
                    new CountOperationError({ operation, reason: "input", inputValidation: duration.detail }),
                )
            const channelGuildId = guildRequest ? undefined : gatewayIdentifier(guildId) ? guildId : undefined
            if (!guildRequest && channelGuildId === undefined)
                return Effect.fail(
                    new CountOperationError({
                        operation,
                        reason: "input",
                        inputValidation: inputValidationFailure(
                            "guildId",
                            "format",
                            "Must be a canonical positive decimal string no greater than 9223372036854775807",
                        ).detail,
                    }),
                )
            const routed = guildRequest
                ? this.#routeGuilds(copiedIds)
                : this.#routeGuilds(Object.freeze([channelGuildId!]))
            if (!routed) return Effect.fail(new CountOperationError({ operation, reason: "notConnected" }))
            const request = Effect.callback<GuildCountsResult | ChannelMemberCountsResult, CountFailure>((complete) => {
                const release = this.budget.acquire()
                if (!release) {
                    complete(Effect.fail(new CountOperationError({ operation, reason: "busy" })))
                    return
                }
                const pendingRequest: Request = {
                    operation,
                    ids: copiedIds,
                    ...(guildRequest ? {} : { guildId: channelGuildId! }),
                    complete,
                    release,
                    nonces: new Set(),
                    withdraw: new Set(),
                    counts: new Map(),
                    finished: false,
                }
                try {
                    const fragments = routed.map(({ shardId, guildIds, sender }) => ({
                        nonce: randomUUID(),
                        pending: {
                            request: pendingRequest,
                            shardId,
                            guildIds,
                            ...(guildRequest ? {} : { channelIds: copiedIds }),
                        },
                        sender,
                    }))
                    for (const { nonce, pending } of fragments) {
                        this.#pending.set(nonce, pending)
                        pendingRequest.nonces.add(nonce)
                    }
                    for (const { nonce, pending, sender } of fragments) {
                        if (pendingRequest.finished) break
                        const submission = guildRequest
                            ? sender.guilds(pending.guildIds, nonce)
                            : sender.channels(channelGuildId!, copiedIds, nonce)
                        if (typeof submission === "string") {
                            this.#settle(
                                pendingRequest,
                                Effect.fail(
                                    new CountOperationError({
                                        operation,
                                        reason: submission === "busy" ? "busy" : "connectionLost",
                                    }),
                                ),
                            )
                            break
                        }
                        if (submission) pendingRequest.withdraw.add(submission.cancel)
                    }
                } catch (defect) {
                    this.#cancel(pendingRequest)
                    throw defect
                }
                return Effect.sync(() => this.#cancel(pendingRequest))
            }).pipe(withDeadline(duration, () => new CountOperationError({ operation, reason: "timeout" })))
            return request
        })
    }

    #routeGuilds(guildIds: readonly string[]): readonly RoutedGuilds[] | undefined {
        const routed = new Map<number, string[]>()
        for (const guildId of guildIds) {
            const shardId = this.routeGuild(guildId)
            if (!shard(shardId)) return undefined
            const ids = routed.get(shardId)
            if (ids) ids.push(guildId)
            else routed.set(shardId, [guildId])
        }
        const groups: RoutedGuilds[] = []
        for (const [shardId, guilds] of routed) {
            const sender = this.#senders.get(shardId)
            if (!sender) return undefined
            groups.push({ shardId, guildIds: Object.freeze(guilds), sender })
        }
        return Object.freeze(groups)
    }

    #complete(nonce: string, counts: readonly (GuildCount | ChannelMemberCount)[]) {
        const pending = this.#pending.get(nonce)
        if (!pending || pending.request.finished) return
        const request = pending.request
        for (const count of counts) {
            const id =
                request.operation === "guilds.fetchCounts" ? count.guildId : (count as ChannelMemberCount).channelId
            if (request.counts.has(id)) {
                this.#settle(
                    request,
                    Effect.fail(new CountOperationError({ operation: request.operation, reason: "response" })),
                )
                return
            }
            request.counts.set(id, count)
        }
        this.#pending.delete(nonce)
        request.nonces.delete(nonce)
        if (request.nonces.size !== 0) return
        const result =
            request.operation === "guilds.fetchCounts" ? this.#guildResult(request) : this.#channelResult(request)
        this.#settle(request, Effect.succeed(result))
    }

    #guildResult(request: Request): GuildCountsResult {
        const counts = Object.freeze(
            request.ids.flatMap((guildId) => {
                const count = request.counts.get(guildId)
                return count ? [count as GuildCount] : []
            }),
        )
        return Object.freeze({
            counts,
            omittedGuildIds: Object.freeze(request.ids.filter((guildId) => !request.counts.has(guildId))),
        })
    }

    #channelResult(request: Request): ChannelMemberCountsResult {
        const counts = Object.freeze(
            request.ids.flatMap((channelId) => {
                const count = request.counts.get(channelId)
                return count ? [count as ChannelMemberCount] : []
            }),
        )
        return Object.freeze({
            counts,
            omittedChannelIds: Object.freeze(request.ids.filter((channelId) => !request.counts.has(channelId))),
        })
    }

    #failPending(predicate: (pending: Pending) => boolean, failure: CountOperationError["reason"] | ClientClosedError) {
        const requests = new Set<Request>()
        for (const pending of this.#pending.values()) if (predicate(pending)) requests.add(pending.request)
        for (const request of requests) {
            this.#settle(
                request,
                Effect.fail(
                    failure instanceof ClientClosedError
                        ? failure
                        : new CountOperationError({ operation: request.operation, reason: failure }),
                ),
            )
        }
    }

    #settle(request: Request, result: Effect.Effect<GuildCountsResult | ChannelMemberCountsResult, CountFailure>) {
        if (request.finished) return
        request.finished = true
        for (const nonce of request.nonces) this.#pending.delete(nonce)
        request.nonces.clear()
        for (const withdraw of request.withdraw) withdraw()
        request.withdraw.clear()
        request.release()
        request.complete(result)
    }

    #cancel(request: Request) {
        if (request.finished) return
        request.finished = true
        for (const nonce of request.nonces) this.#pending.delete(nonce)
        request.nonces.clear()
        for (const withdraw of request.withdraw) withdraw()
        request.withdraw.clear()
        request.release()
    }
}
