import { randomUUID } from "node:crypto"
import { Cause, Clock, Effect, Exit, Stream } from "effect"
import type { OperationOptions } from "#sdk/client"
import { ClientClosedError } from "#sdk/errors"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import { MemberChunkError, type MemberChunk, type MemberChunkFailure } from "#sdk/member-chunks"
import { GatewayRequestBudget } from "./gateway-requests.js"
import { decodeMember } from "./guilds.js"
import { identifier, record } from "./message.js"
import { decodePresenceUpdate } from "./presence.js"

const maximumUint64 = "18446744073709551615"
const positiveId = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length <= 20 &&
    identifier(value) &&
    value !== "0" &&
    (value.length < 20 || value <= maximumUint64)
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

function settings(guildId: unknown, query: unknown, options: unknown): Settings | InputValidationFailure {
    if (!positiveId(guildId))
        return inputValidationFailure("guildId", "format", "Must be a canonical positive uint64 decimal string")
    if (!record(query)) return inputValidationFailure("query", "type", "Must be a member-chunk query object")
    if (Object.keys(query).some((key) => !["all", "userIds", "query", "limit", "presences"].includes(key)))
        return inputValidationFailure(
            "query",
            "allowedFields",
            "Only all, userIds, query, limit, and presences are accepted",
        )
    if (query.presences !== undefined && typeof query.presences !== "boolean")
        return inputValidationFailure("query.presences", "type", "Must be a boolean when supplied")
    const input = options === undefined ? {} : options
    if (!record(input)) return inputValidationFailure("options", "type", "Must be an options object when supplied")
    if (Object.keys(input).some((key) => key !== "timeoutMs" && key !== "maxPendingBytes"))
        return inputValidationFailure("options", "allowedFields", "Only timeoutMs and maxPendingBytes are accepted")
    const timeoutMs = input.timeoutMs === undefined ? 30_000 : input.timeoutMs
    const maxPendingBytes = input.maxPendingBytes === undefined ? 4_194_304 : input.maxPendingBytes
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
    const presences = query.presences === true
    let userIds: readonly string[] | undefined
    let maximumMembers: number
    let selection: Record<string, unknown>
    if (query.all !== undefined && query.all !== true)
        return inputValidationFailure("query.all", "allowedValue", "Must be true when supplied")
    if (query.all === true) {
        if (query.userIds !== undefined || query.query !== undefined || query.limit !== undefined)
            return inputValidationFailure("query", "relationship", "Use all or one explicit selection, not both")
        maximumMembers = 100_000
        selection = { query: "", limit: 0 }
    } else if (query.userIds !== undefined) {
        if (query.query !== undefined || query.limit !== undefined)
            return inputValidationFailure("query", "relationship", "Use userIds or a text query, not both")
        if (!Array.isArray(query.userIds))
            return inputValidationFailure("query.userIds", "type", "Must be an array of canonical user IDs")
        if (query.userIds.length < 1 || query.userIds.length > 100)
            return inputValidationFailure("query.userIds", "length", "Must contain from 1 through 100 user IDs")
        if (!Array.from(query.userIds).every(positiveId))
            return inputValidationFailure(
                "query.userIds",
                "format",
                "Each ID must be a canonical positive uint64 decimal string",
            )
        userIds = Object.freeze([...query.userIds])
        if (new Set(userIds).size !== userIds.length)
            return inputValidationFailure("query.userIds", "unique", "Must not contain duplicate user IDs")
        maximumMembers = userIds.length
        selection = { user_ids: userIds }
    } else if (query.query !== undefined) {
        if (typeof query.query !== "string")
            return inputValidationFailure("query.query", "type", "Must be a string when supplied")
        if (query.query.length > 4_096)
            return inputValidationFailure("query.query", "length", "Must contain at most 4096 UTF-16 code units")
        if (!query.query.isWellFormed())
            return inputValidationFailure("query.query", "format", "Must be a well-formed Unicode string")
        const limit = query.limit === undefined ? 25 : query.limit
        if (typeof limit !== "number")
            return inputValidationFailure("query.limit", "type", "Must be an integer when supplied")
        if (!positive(limit) || limit > 100)
            return inputValidationFailure("query.limit", "range", "Must be an integer from 1 through 100")
        maximumMembers = limit
        selection = { query: query.query, limit }
    } else {
        if (query.limit !== undefined)
            return inputValidationFailure("query", "relationship", "limit requires a text query")
        return inputValidationFailure("query", "required", "Must select all members, user IDs, or a text query")
    }
    const payload = Object.freeze({ guild_id: guildId, ...selection, presences })
    // Op8 nonces are at most 32 bytes, unlike count nonces. Reject frames the gateway would close as oversized
    if (Buffer.byteLength(JSON.stringify({ op: 8, d: { ...payload, nonce: "0".repeat(32) } })) > 4_096)
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
    #timer: ReturnType<typeof setTimeout> | undefined
    #onRelease: (() => void) | undefined
    #release: (() => void) | undefined
    readonly #deadline: number

    constructor(
        readonly nonce: string,
        settings: Settings,
        private readonly clock: Clock.Clock,
        release: () => void,
    ) {
        this.#settings = settings
        this.#release = release
        this.#deadline = this.#now() + settings.timeoutMs
    }

    #now() {
        return Number(this.clock.monotonicTimeNanosUnsafe()) / 1_000_000
    }

    start() {
        this.#timer = setTimeout(
            () => {
                this.#timer = undefined
                try {
                    if (!this.#expired() && !this.#exit && !this.#received) this.start()
                } catch (error) {
                    this.defect(error)
                }
            },
            Math.max(1, Math.ceil(this.#deadline - this.#now())),
        )
    }

    #expired() {
        if (this.#exit || this.#received || this.#now() < this.#deadline) return false
        this.fail(new MemberChunkError("timeout"))
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
        clearTimeout(this.#timer)
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
                defects = Cause.combine(defects, Cause.die(error))
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
        this.#onRelease = () => signal.removeEventListener("abort", abort)
        try {
            signal.addEventListener("abort", abort, { once: true })
            if (signal.aborted) abort()
        } catch (error) {
            this.defect(error)
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
        const invalid = () => this.fail(new MemberChunkError("response"))
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
            return this.fail(new MemberChunkError("overflow"))
        const members: import("#sdk/guilds").GuildMember[] = []
        const batchIds = new Set<string>()
        for (const raw of value.members) {
            const member = decodeMember(raw, config.guildId)
            if (
                !member ||
                !positiveId(member.userId) ||
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
            clearTimeout(this.#timer)
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
            return this.fail(new MemberChunkError("response"))
        this.fail(new MemberChunkError("rateLimit", Math.ceil(value.retry_after * 1_000)))
    }
}

type Sender = (payload: Readonly<Record<string, unknown>>, nonce: string) => void

/** One admitted member stream per connection, sharing four local slots with count requests */
export class MemberChunkOwner {
    #senders = new Map<number, Sender>()
    #active: MemberChunkSource | undefined
    #activeShard: number | undefined
    #closed = false

    constructor(
        private readonly budget: GatewayRequestBudget,
        private readonly routeGuild: (guildId: string) => number | undefined = () => 0,
    ) {}
    attach(sender: Sender, shardId = 0) {
        if (!this.#closed && Number.isSafeInteger(shardId) && shardId >= 0) this.#senders.set(shardId, sender)
    }
    detach(shardId?: number) {
        if (shardId === undefined) {
            this.#senders.clear()
            this.#active?.fail(new MemberChunkError("connectionLost"))
            return
        }
        if (!Number.isSafeInteger(shardId) || shardId < 0) return
        this.#senders.delete(shardId)
        if (this.#activeShard === shardId) this.#active?.fail(new MemberChunkError("connectionLost"))
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
            value.opcode === 8 &&
            record(value.meta) &&
            typeof value.meta.nonce === "string" &&
            value.meta.nonce === this.#active?.nonce
        )
            this.#active.rateLimited(value)
    }

    open(guildId: string, query: unknown, options?: unknown): Effect.Effect<MemberChunkSource, MemberChunkFailure> {
        return Effect.gen({ self: this }, function* () {
            if (this.#closed) return yield* Effect.fail(new ClientClosedError())
            const config = settings(guildId, query, options)
            if (config instanceof InputValidationFailure)
                return yield* Effect.fail(new MemberChunkError("input", null, config.detail))
            const shardId = this.routeGuild(config.guildId)
            const sender = shardId === undefined ? undefined : this.#senders.get(shardId)
            if (!sender) return yield* Effect.fail(new MemberChunkError("notConnected"))
            const clock = yield* Clock.Clock
            if (this.#active) return yield* Effect.fail(new MemberChunkError("busy"))
            const release = this.budget.acquire()
            if (!release) return yield* Effect.fail(new MemberChunkError("busy"))
            let source: MemberChunkSource | undefined
            try {
                source = new MemberChunkSource(randomUUID().replaceAll("-", ""), config, clock, () => {
                    if (this.#active === source) {
                        this.#active = undefined
                        this.#activeShard = undefined
                    }
                    release()
                })
                this.#active = source
                this.#activeShard = shardId
                source.start()
                sender(config.payload, source.nonce)
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
export function memberChunkIterationOptions(value: unknown) {
    const input = value === undefined ? {} : value
    if (!record(input)) return inputValidationFailure("options", "type", "Must be an options object when supplied")
    if (Object.keys(input).some((key) => !["timeoutMs", "maxPendingBytes", "signal"].includes(key)))
        return inputValidationFailure(
            "options",
            "allowedFields",
            "Only timeoutMs, maxPendingBytes, and signal are accepted",
        )
    const signal = input.signal as OperationOptions["signal"]
    if (
        signal !== undefined &&
        (!signal ||
            typeof signal.aborted !== "boolean" ||
            typeof signal.addEventListener !== "function" ||
            typeof signal.removeEventListener !== "function")
    )
        return inputValidationFailure(
            "options.signal",
            "type",
            "Must be an AbortSignal-compatible object when supplied",
        )
    return { request: { timeoutMs: input.timeoutMs, maxPendingBytes: input.maxPendingBytes }, signal }
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
