/**
 * Member chunk streams: One active guild member request per client with bounded unread batches.
 * Invariant: A stream fails only for a connection gap on its shard or client closure, releases local intake on failure, and
 * publishes no cache or event data. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { randomUUID } from "node:crypto"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Stream from "effect/Stream"
import type { OperationOptions } from "#sdk/client"
import { ClientClosedError } from "#sdk/errors"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { MemberChunkError, type MemberChunk, type MemberChunkFailure } from "#sdk/member-chunks"
import { GatewayRequestBudget } from "./gateway-requests.js"
import type { InternalSubmission } from "./gateway/commands.js"
import { decodeMember } from "./guilds.js"
import { fieldsOnce, gatewayIdentifier, record, snapshotArray } from "./decode/primitives.js"
import { readCaller, suspendMarked, thrownCause } from "./defects.js"
import { decodePresenceUpdate } from "./presence.js"
import { Opcode } from "./protocol/gateway.js"
import type { LogicalScheduler, LogicalTimer } from "./logical-scheduler.js"

const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0

interface Settings {
    readonly guildId: string
    readonly presences: boolean
    readonly userIds?: readonly string[]
    readonly maximumMembers: number
    readonly timeoutMs: number
    readonly maxPendingBytes: number
    readonly payload: Readonly<Record<string, unknown>>
}

/** Validate one request, reading each caller query and option field once so the validated value is the one sent */
function settings(guildId: unknown, query: unknown, options: unknown): Settings | InputValidationFailure {
    if (!gatewayIdentifier(guildId))
        return inputValidationFailure(
            "guildId",
            "format",
            "Must be a canonical positive decimal string no greater than 9223372036854775807",
        )
    if (!record(query)) return inputValidationFailure("query", "type", "Must be a member-chunk query object")
    const unsupported = unsupportedKeyFailure(
        query,
        ["all", "userIds", "query", "limit", "presences"],
        "query",
        "the member chunk query",
    )
    if (unsupported) return unsupported
    const field = fieldsOnce(query)
    const presencesInput = field("presences")
    if (presencesInput !== undefined && typeof presencesInput !== "boolean")
        return inputValidationFailure("query.presences", "type", "Must be a boolean when supplied")
    const input = options === undefined ? {} : options
    if (!record(input)) return inputValidationFailure("options", "type", "Must be an options object when supplied")
    const unsupportedOption = unsupportedKeyFailure(
        input,
        ["timeoutMs", "maxPendingBytes"],
        "options",
        "the member chunk options",
    )
    if (unsupportedOption) return unsupportedOption
    const timeoutInput = input.timeoutMs
    const maxPendingInput = input.maxPendingBytes
    const timeoutMs = timeoutInput === undefined ? 30_000 : timeoutInput
    const maxPendingBytes = maxPendingInput === undefined ? 4_194_304 : maxPendingInput
    if (typeof timeoutMs !== "number")
        return inputValidationFailure("options.timeoutMs", "type", "Must be an integer number of milliseconds")
    if (!positive(timeoutMs) || timeoutMs > 2_147_483_647)
        return inputValidationFailure(
            "options.timeoutMs",
            "range",
            "Must be an integer from 1 through 2147483647 milliseconds",
        )
    if (typeof maxPendingBytes !== "number")
        return inputValidationFailure(
            "options.maxPendingBytes",
            "type",
            "Must be a positive safe integer number of bytes",
        )
    if (!positive(maxPendingBytes))
        return inputValidationFailure(
            "options.maxPendingBytes",
            "range",
            "Must be a positive safe integer number of bytes",
        )
    const presences = presencesInput === true
    const all = field("all")
    const userIdsInput = field("userIds")
    const text = field("query")
    const limitInput = field("limit")
    let userIds: readonly string[] | undefined
    let maximumMembers: number
    let selection: Record<string, unknown>
    if (all !== undefined && all !== true)
        return inputValidationFailure("query.all", "allowedValue", "Must be true when supplied")
    if (all === true) {
        if (userIdsInput !== undefined || text !== undefined || limitInput !== undefined)
            return inputValidationFailure("query", "relationship", "Use all or one explicit selection, not both")
        maximumMembers = 100_000
        selection = { query: "", limit: 0 }
    } else if (userIdsInput !== undefined) {
        if (text !== undefined || limitInput !== undefined)
            return inputValidationFailure("query", "relationship", "Use userIds or a text query, not both")
        if (!Array.isArray(userIdsInput))
            return inputValidationFailure("query.userIds", "type", "Must be an array of canonical user IDs")
        // Copy once and validate the copy, so the validated IDs are the ones requested
        const copied = snapshotArray(userIdsInput, 100)
        if (copied === undefined || copied.length < 1)
            return inputValidationFailure("query.userIds", "length", "Must contain from 1 through 100 user IDs")
        if (!copied.every(gatewayIdentifier))
            return inputValidationFailure(
                "query.userIds",
                "format",
                "Each ID must be a canonical positive decimal string no greater than 9223372036854775807",
            )
        userIds = copied as readonly string[]
        if (new Set(userIds).size !== userIds.length)
            return inputValidationFailure("query.userIds", "unique", "Must not contain duplicate user IDs")
        maximumMembers = userIds.length
        selection = { user_ids: userIds }
    } else if (text !== undefined) {
        if (typeof text !== "string")
            return inputValidationFailure("query.query", "type", "Must be a string when supplied")
        if (text.length > 4_096)
            return inputValidationFailure("query.query", "length", "Must contain at most 4096 UTF-16 code units")
        if (!text.isWellFormed())
            return inputValidationFailure("query.query", "format", "Must be a well-formed Unicode string")
        const limit = limitInput === undefined ? 25 : limitInput
        if (typeof limit !== "number")
            return inputValidationFailure("query.limit", "type", "Must be an integer when supplied")
        if (!positive(limit) || limit > 100)
            return inputValidationFailure("query.limit", "range", "Must be an integer from 1 through 100")
        maximumMembers = limit
        selection = { query: text, limit }
    } else {
        if (limitInput !== undefined)
            return inputValidationFailure("query", "relationship", "limit requires a text query")
        return inputValidationFailure("query", "required", "Must select all members, user IDs, or a text query")
    }
    const payload = Object.freeze({ guild_id: guildId, ...selection, presences })
    // Op8 nonces are at most 32 bytes, unlike count nonces. Reject frames the gateway would close as oversized
    if (
        Buffer.byteLength(
            JSON.stringify({ op: Opcode.requestGuildMembers, d: { ...payload, nonce: "0".repeat(32) } }),
        ) > 4_096
    )
        return inputValidationFailure("query", "size", "The encoded gateway request must not exceed 4096 bytes")
    return { guildId, presences, ...(userIds ? { userIds } : {}), maximumMembers, timeoutMs, maxPendingBytes, payload }
}

/** One stream's local intake, bounded unread batches and completion proof. No cache or event publication */
export class MemberChunkSource {
    #settings: Settings | undefined
    #queue: { readonly chunk: MemberChunk; readonly bytes: number }[] = []
    #bytes = 0
    #seen = new Set<string>()
    #nextIndex = 0
    #count: number | undefined
    #received = false
    #exit: Exit.Exit<void, MemberChunkFailure> | undefined
    #wake: (() => void) | undefined
    #timer: LogicalTimer | undefined
    #onRelease: (() => void) | undefined
    #release: (() => void) | undefined
    readonly #deadline: number

    constructor(
        readonly nonce: string,
        settings: Settings,
        private readonly logical: LogicalScheduler,
        release: () => void,
    ) {
        this.#settings = settings
        this.#release = release
        this.#deadline = this.#now() + settings.timeoutMs
    }

    #now() {
        return this.logical.now()
    }

    start() {
        this.#timer = this.logical.set(
            () => {
                this.#timer = undefined
                try {
                    if (!this.#expired() && !this.#exit && !this.#received) this.start()
                } catch (error) {
                    this.defect(error)
                }
            },
            Math.max(1, Math.ceil(this.#deadline - this.#now())),
            "member chunk stream",
        )
    }

    #expired() {
        if (this.#exit || this.#received || this.#now() < this.#deadline) return false
        this.fail(new MemberChunkError({ reason: "timeout" }))
        return true
    }

    #notify() {
        const wake = this.#wake
        this.#wake = undefined
        wake?.()
    }

    #end(exit: Exit.Exit<void, MemberChunkFailure>): Cause.Cause<never> {
        if (this.#exit) return Cause.empty
        this.#exit = exit
        this.logical.clear(this.#timer)
        this.#timer = undefined
        this.#queue.length = 0
        this.#bytes = 0
        this.#seen.clear()
        this.#settings = undefined
        const cleanup = [this.#release, this.#onRelease]
        this.#release = undefined
        this.#onRelease = undefined
        let defects = Cause.empty
        for (const release of cleanup) {
            try {
                release?.()
            } catch (error) {
                // Removing the caller signal listener is a marked read, so its throw is an application fault
                defects = Cause.combine(defects, thrownCause(error))
            }
        }
        if (Cause.hasDies(defects))
            this.#exit = Exit.failCause(Cause.combine(Exit.isFailure(exit) ? exit.cause : Cause.empty, defects))
        this.#notify()
        return defects
    }

    fail(error: MemberChunkFailure) {
        this.#end(Exit.fail(error))
    }
    defect(error: unknown) {
        this.#end(Exit.failCause(Cause.die(error)))
    }

    /** Default-only lifetime cancellation, including pauses between next calls. Cleanup defects join the terminal cause */
    bindSignal(signal: NonNullable<OperationOptions["signal"]>) {
        if (this.#exit) return
        const abort = () => this.#end(Exit.failCause(Cause.interrupt()))
        // Calling the caller signal is application code, so its throws are application faults
        this.#onRelease = () => readCaller(() => signal.removeEventListener("abort", abort))
        try {
            readCaller(() => signal.addEventListener("abort", abort, { once: true }))
            if (readCaller(() => signal.aborted)) abort()
        } catch (error) {
            this.#end(Exit.failCause(thrownCause(error)))
        }
    }

    close: Effect.Effect<void> = Effect.suspend(() => {
        const defects = this.#end(Exit.void)
        return Cause.hasDies(defects) ? Effect.failCause(defects) : Effect.void
    })

    next: Effect.Effect<MemberChunk | undefined, MemberChunkFailure> = Effect.suspend(() => {
        this.#expired()
        if (this.#exit)
            return Exit.isFailure(this.#exit) ? Effect.failCause(this.#exit.cause) : Effect.succeed(undefined)
        const item = this.#queue.shift()
        if (item) {
            this.#bytes -= item.bytes
            if (this.#received && this.#queue.length === 0) {
                const defects = this.#end(Exit.void)
                if (Cause.hasDies(defects)) return Effect.failCause(defects)
            }
            return Effect.succeed(item.chunk)
        }
        return Effect.callback<MemberChunk | undefined, MemberChunkFailure>((resume) => {
            const wake = () => resume(this.next)
            this.#wake = wake
            return Effect.sync(() => {
                if (this.#wake === wake) this.#wake = undefined
            })
        })
    }).pipe(
        Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return Effect.void
            const defects = this.#end(exit)
            return Cause.hasDies(defects) ? Effect.failCause(defects) : Effect.void
        }),
    )

    receive(value: unknown, bytes: number) {
        const config = this.#settings
        if (!config || this.#received || this.#expired()) return
        const invalid = () => this.fail(new MemberChunkError({ reason: "response" }))
        if (
            !record(value) ||
            value.guild_id !== config.guildId ||
            !Number.isInteger(value.chunk_index) ||
            value.chunk_index !== this.#nextIndex ||
            !positive(value.chunk_count) ||
            value.chunk_count > Math.ceil(config.maximumMembers / 1_000) ||
            value.chunk_index >= value.chunk_count ||
            (this.#count !== undefined && value.chunk_count !== this.#count) ||
            !Array.isArray(value.members) ||
            value.members.length > 1_000 ||
            (value.members.length === 0 && (value.chunk_count !== 1 || value.chunk_index !== 0)) ||
            (value.presences !== undefined && !Array.isArray(value.presences))
        )
            return invalid()
        if (!positive(bytes) || bytes > config.maxPendingBytes - this.#bytes)
            return this.fail(new MemberChunkError({ reason: "overflow" }))
        const members: import("#sdk/guilds").GuildMember[] = []
        const batchIds = new Set<string>()
        for (const raw of value.members) {
            const member = decodeMember(raw, config.guildId)
            if (
                !member ||
                !gatewayIdentifier(member.userId) ||
                this.#seen.has(member.userId) ||
                batchIds.has(member.userId) ||
                (config.userIds && !config.userIds.includes(member.userId))
            )
                return invalid()
            batchIds.add(member.userId)
            members.push(member)
        }
        if (this.#seen.size + members.length > config.maximumMembers) return invalid()
        const presences: import("#sdk/events").PresenceUpdate[] = []
        const presenceIds = new Set<string>()
        if (Array.isArray(value.presences)) {
            if (!config.presences || value.presences.length > members.length) return invalid()
            for (const raw of value.presences) {
                if (!record(raw) || (raw.guild_id !== undefined && raw.guild_id !== config.guildId)) return invalid()
                const presence = decodePresenceUpdate({ ...raw, guild_id: config.guildId })
                if (
                    !presence ||
                    !batchIds.has(presence.userId) ||
                    presenceIds.has(presence.userId) ||
                    presence.status === "offline" ||
                    presence.status === "invisible"
                )
                    return invalid()
                presenceIds.add(presence.userId)
                presences.push(presence)
            }
        }
        for (const id of batchIds) this.#seen.add(id)
        this.#count = value.chunk_count
        this.#nextIndex++
        this.#received = this.#nextIndex === this.#count
        if (this.#received) {
            this.logical.clear(this.#timer)
            this.#timer = undefined
        }
        const chunk: MemberChunk = Object.freeze({
            guildId: config.guildId,
            index: value.chunk_index as number,
            count: value.chunk_count,
            members: Object.freeze(members),
            ...(config.presences ? { presences: Object.freeze(presences) } : {}),
            ...(this.#received && config.userIds
                ? { omittedUserIds: Object.freeze(config.userIds.filter((id) => !this.#seen.has(id))) }
                : {}),
        })
        this.#queue.push({ chunk, bytes })
        this.#bytes += bytes
        this.#notify()
    }

    rateLimited(value: unknown) {
        if (!this.#settings || this.#received || this.#expired()) return
        if (
            !record(value) ||
            !record(value.meta) ||
            value.meta.guild_id !== this.#settings.guildId ||
            typeof value.retry_after !== "number" ||
            !Number.isFinite(value.retry_after) ||
            value.retry_after <= 0 ||
            value.retry_after * 1_000 > Number.MAX_SAFE_INTEGER
        )
            return this.fail(new MemberChunkError({ reason: "response" }))
        this.fail(new MemberChunkError({ reason: "rateLimit", retryAfterMs: Math.ceil(value.retry_after * 1_000) }))
    }
}

type Sender = (payload: Readonly<Record<string, unknown>>, nonce: string) => InternalSubmission

/** One admitted member stream per connection, sharing four local slots with count requests */
export class MemberChunkOwner {
    #senders = new Map<number, Sender>()
    #active: MemberChunkSource | undefined
    #activeShard: number | undefined
    #closed = false

    constructor(
        private readonly budget: GatewayRequestBudget,
        private readonly logical: LogicalScheduler,
        private readonly routeGuild: (guildId: string) => number | undefined = () => 0,
    ) {}
    attach(sender: Sender, shardId = 0) {
        if (!this.#closed && Number.isSafeInteger(shardId) && shardId >= 0) this.#senders.set(shardId, sender)
    }
    detach(shardId?: number) {
        if (shardId === undefined) {
            this.#senders.clear()
            this.#active?.fail(new MemberChunkError({ reason: "connectionLost" }))
            return
        }
        if (!Number.isSafeInteger(shardId) || shardId < 0) return
        this.#senders.delete(shardId)
        if (this.#activeShard === shardId) this.#active?.fail(new MemberChunkError({ reason: "connectionLost" }))
    }
    close() {
        this.#closed = true
        this.#senders.clear()
        this.#active?.fail(new ClientClosedError())
    }
    receive(value: unknown, bytes: number) {
        if (record(value) && typeof value.nonce === "string" && value.nonce === this.#active?.nonce)
            this.#active.receive(value, bytes)
    }
    rateLimited(value: unknown) {
        if (
            record(value) &&
            value.opcode === Opcode.requestGuildMembers &&
            record(value.meta) &&
            typeof value.meta.nonce === "string" &&
            value.meta.nonce === this.#active?.nonce
        )
            this.#active.rateLimited(value)
    }

    open(guildId: string, query: unknown, options?: unknown): Effect.Effect<MemberChunkSource, MemberChunkFailure> {
        // Only reading the caller query and options is marked, so opening intake keeps SDK faults as SDK faults
        return suspendMarked(() => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            const config = readCaller(() => settings(guildId, query, options))
            return this.#open(config)
        })
    }

    #open(config: Settings | InputValidationFailure): Effect.Effect<MemberChunkSource, MemberChunkFailure> {
        return Effect.gen({ self: this }, function* () {
            if (config instanceof InputValidationFailure)
                return yield* Effect.fail(new MemberChunkError({ reason: "input", inputValidation: config.detail }))
            const shardId = this.routeGuild(config.guildId)
            const sender = shardId === undefined ? undefined : this.#senders.get(shardId)
            if (!sender) return yield* Effect.fail(new MemberChunkError({ reason: "notConnected" }))
            if (this.#active) return yield* Effect.fail(new MemberChunkError({ reason: "busy" }))
            const release = this.budget.acquire()
            if (!release) return yield* Effect.fail(new MemberChunkError({ reason: "busy" }))
            let source: MemberChunkSource | undefined
            let withdraw: (() => void) | undefined
            try {
                source = new MemberChunkSource(randomUUID().replaceAll("-", ""), config, this.logical, () => {
                    if (this.#active === source) {
                        this.#active = undefined
                        this.#activeShard = undefined
                    }
                    withdraw?.()
                    withdraw = undefined
                    release()
                })
                this.#active = source
                this.#activeShard = shardId
                source.start()
                const submission = sender(config.payload, source.nonce)
                if (typeof submission === "string") {
                    const error = new MemberChunkError({ reason: submission === "busy" ? "busy" : "connectionLost" })
                    source.fail(error)
                    return yield* Effect.fail(error)
                }
                withdraw = submission?.cancel
                return source
            } catch (error) {
                source?.defect(error)
                if (!source) release()
                return yield* Effect.die(error)
            }
        })
    }
}

/** Copy the default stream's options before opening intake, without giving native streams a signal contract */
export function memberChunkIterationOptions(value: unknown, signal: unknown) {
    const input = value === undefined ? {} : value
    if (!record(input)) return inputValidationFailure("options", "type", "Must be an options object when supplied")
    const unsupported = unsupportedKeyFailure(
        input,
        ["timeoutMs", "maxPendingBytes", "signal"],
        "options",
        "the member chunk options",
    )
    if (unsupported) return unsupported
    // The default adapter validated the signal it read before this call
    return {
        request: { timeoutMs: input.timeoutMs, maxPendingBytes: input.maxPendingBytes },
        signal: signal as OperationOptions["signal"],
    }
}

export const memberChunkStream = (create: Effect.Effect<MemberChunkSource, MemberChunkFailure>) =>
    Stream.unwrap(
        Effect.gen(function* () {
            const source = yield* Effect.acquireRelease(create, (source) => source.close)
            return Stream.unfold(undefined, () =>
                source.next.pipe(
                    Effect.map((chunk) => (chunk === undefined ? undefined : ([chunk, undefined] as const))),
                ),
            )
        }),
    )
