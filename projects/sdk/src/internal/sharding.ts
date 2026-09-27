/**
 * Shard plan: Validation of the fixed local shard assignment, automatic plan sizing, scaling hooks and guild-to-shard
 * routing.
 * Invariant: A plan is immutable once known and decides guild ownership, never cache contents or discovery hints. An
 * automatic plan is computed at the first connect from the bot's guild count. The client replaces it with a new, larger
 * plan only when Fluxer closes a shard with 4011 (sharding required), and an explicit plan never changes.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { ConfigurationError } from "#sdk/errors"
import type { IdentifyCoordinator, SessionSnapshot, SessionStore } from "#sdk/sharding"
import { settingError } from "./client/configuration-fields.js"
import { record } from "./decode/primitives.js"
import { maxGuildsPerShard, sessionRetentionMs } from "./protocol/gateway.js"
import { unsupportedKeyHint } from "./suggest.js"

/** Largest total shard count Fluxer accepts */
export const maximumShardCount = 16_384

/**
 * Average guilds per shard that automatic sharding aims for, four fifths of Fluxer's per-shard ceiling.
 * Fluxer counts the guilds routed to each shard, not the average. The validate_session_guild_count function in
 * fluxer_gateway/src/gateway/gateway_sharding.erl at fluxerapp/fluxer commit 858a2d9e2b987330edd81711bb53e4f7edc0bbcc
 * rejects Identify with 4011 when one shard's own guilds exceed 2,500. Routing by (id >> 22) % totalShards is uneven,
 * so a plan sized to the ceiling almost always overfills a shard above about 20,000 guilds. At 2,000 the fullest of
 * 16,384 shards stays near 2,200 and leaves room for growth before a 4011 closure makes the client move to a larger plan
 */
export const guildsPerShard = (maxGuildsPerShard * 4) / 5

export interface ShardPlan {
    readonly totalShards: number
    readonly shardIds: readonly number[]
    readonly identifyShards: boolean
}

/** Validated sharding settings: A known plan or "auto", plus the optional scaling hooks */
export interface ShardingConfiguration {
    readonly plan: ShardPlan | "auto"
    readonly identify: IdentifyCoordinator | undefined
    readonly sessions: SessionStore | undefined
    /** Whether shards that resume a stored session refill the guild, role and channel caches through REST */
    readonly refillCaches: boolean
}

const defaultShardPlan = immutablePlan(1, [0])
const defaultSharding: ShardingConfiguration = Object.freeze({
    plan: defaultShardPlan,
    identify: undefined,
    sessions: undefined,
    refillCaches: true,
})

function hook<K extends string>(
    value: unknown,
    field: "identify" | "sessions",
    methods: readonly K[],
): Record<K, (...args: never[]) => unknown> | undefined | ConfigurationError {
    if (value === undefined) return undefined
    // Methods may come from a class prototype, and other members such as a store's own state are left alone
    if (!record(value) || methods.some((method) => typeof value[method] !== "function"))
        return settingError(
            field,
            field === "identify"
                ? 'The option "sharding.identify" must be an object with a permit function'
                : 'The option "sharding.sessions" must be an object with load and save functions',
        )
    // Bind the methods now so later caller mutation cannot change the hooks this client calls
    return Object.freeze(
        Object.fromEntries(
            methods.map((method) => [method, (value[method] as (...args: never[]) => unknown).bind(value)]),
        ),
    ) as Record<K, (...args: never[]) => unknown>
}

/** Validate and copy the one-time sharding settings without changing caller-owned input */
export function parseSharding(input: unknown): ShardingConfiguration | ConfigurationError {
    if (input === undefined) return defaultSharding
    if (input === "auto")
        return Object.freeze({ plan: "auto", identify: undefined, sessions: undefined, refillCaches: true })
    if (!record(input)) return new ConfigurationError("sharding", 'Sharding settings must be an object or "auto"')
    const shardingKeys = ["totalShards", "shardIds", "identify", "sessions", "refillCaches"]
    const unsupported = Reflect.ownKeys(input).find((key) => typeof key !== "string" || !shardingKeys.includes(key))
    if (unsupported !== undefined)
        return new ConfigurationError(
            "sharding",
            typeof unsupported === "string"
                ? `Unsupported sharding setting ${JSON.stringify(unsupported)}`
                : "Sharding settings must not contain symbol keys",
            { hint: unsupportedKeyHint(typeof unsupported === "string" ? unsupported : "", shardingKeys, "settings") },
        )
    const identify = hook(input.identify, "identify", ["permit"])
    if (identify instanceof ConfigurationError) return identify
    const sessions = hook(input.sessions, "sessions", ["load", "save"])
    if (sessions instanceof ConfigurationError) return sessions
    const refillCaches = input.refillCaches ?? true
    if (typeof refillCaches !== "boolean")
        return new ConfigurationError("sharding", 'The option "sharding.refillCaches" must be a boolean')
    const hooks = {
        identify: identify as IdentifyCoordinator | undefined,
        sessions: sessions as SessionStore | undefined,
        refillCaches,
    }
    const totalShards = input.totalShards
    if (totalShards === "auto") {
        if (input.shardIds !== undefined)
            return new ConfigurationError(
                "shardIds",
                "Automatic sharding assigns every shard, so omit sharding.shardIds",
                {
                    hint: "Set sharding.totalShards to a number to run only some shards",
                },
            )
        return Object.freeze({ plan: "auto", ...hooks })
    }
    if (
        typeof totalShards !== "number" ||
        !Number.isSafeInteger(totalShards) ||
        totalShards < 1 ||
        totalShards > maximumShardCount
    ) {
        return new ConfigurationError(
            "totalShards",
            'The option "sharding.totalShards" must be "auto" or an integer from 1 through 16,384',
        )
    }

    const inputShardIds = input.shardIds
    if (inputShardIds === undefined) {
        return Object.freeze({
            plan: immutablePlan(
                totalShards,
                Array.from({ length: totalShards }, (_, shardId) => shardId),
            ),
            ...hooks,
        })
    }
    if (!Array.isArray(inputShardIds) || inputShardIds.length === 0)
        return new ConfigurationError("shardIds", 'The option "sharding.shardIds" must be a non-empty array')

    const shardIds: number[] = []
    const seen = new Set<number>()
    for (const shardId of inputShardIds) {
        if (
            typeof shardId !== "number" ||
            !Number.isSafeInteger(shardId) ||
            shardId < 0 ||
            shardId >= totalShards ||
            seen.has(shardId)
        ) {
            return new ConfigurationError(
                "shardIds",
                `The option "sharding.shardIds" must contain unique integers from 0 through ${totalShards - 1}`,
            )
        }
        seen.add(shardId)
        shardIds.push(shardId)
    }
    return Object.freeze({ plan: immutablePlan(totalShards, shardIds), ...hooks })
}

/** The plan automatic sharding picks for a guild count: Every shard, at most guildsPerShard guilds each on average */
export function automaticShardPlan(guildCount: number): ShardPlan {
    return fullShardPlan(Math.min(maximumShardCount, Math.max(1, Math.ceil(guildCount / guildsPerShard))))
}

/**
 * The plan an automatic client moves to after Fluxer closed one of its shards with 4011 (sharding required): The plan
 * for the new guild count, or one shard more than before when that count still fits the old total, because Fluxer
 * found a shard above its ceiling whatever the average. Callers check that the old total is below maximumShardCount
 */
export function largerShardPlan(guildCount: number, previousTotalShards: number): ShardPlan {
    const counted = automaticShardPlan(guildCount)
    return counted.totalShards > previousTotalShards
        ? counted
        : fullShardPlan(Math.min(maximumShardCount, previousTotalShards + 1))
}

/** Moves to a larger automatic plan allowed within reshardWindowMs, for a client or a supervisor */
const reshardLimit = 3
const reshardWindowMs = 3_600_000

/**
 * Admit a move to a larger automatic plan at now, recording it in history, or return why it is refused: The plan
 * already has the largest total, or reshardLimit moves happened within reshardWindowMs. The history keeps only moves
 * inside the window
 */
export function admitReshard(history: number[], now: number, totalShards: number): string | undefined {
    if (totalShards >= maximumShardCount)
        return `the plan already has the largest total of ${maximumShardCount.toLocaleString("en-US")} shards`
    const recent = history.filter((at) => now - at < reshardWindowMs)
    history.splice(0, history.length, ...recent)
    if (history.length >= reshardLimit) return `it already moved to a larger plan ${reshardLimit} times within an hour`
    history.push(now)
    return undefined
}

/** A plan of totalShards shards, all owned by this client */
function fullShardPlan(totalShards: number): ShardPlan {
    return immutablePlan(
        totalShards,
        Array.from({ length: totalShards }, (_, shardId) => shardId),
    )
}

/** Route a guild snowflake to its planned shard. Callers provide a validated plan total */
export function guildShardId(guildId: string, totalShards: number): number {
    return Number((BigInt(guildId) >> 22n) % BigInt(totalShards))
}

function immutablePlan(totalShards: number, shardIds: readonly number[]): ShardPlan {
    return Object.freeze({
        totalShards,
        shardIds: Object.freeze([...shardIds]),
        identifyShards: totalShards > 1,
    })
}

/** Allowed clock difference between the process that saved a snapshot and the one loading it */
const snapshotClockSkewMs = 5_000

/** Check a loaded snapshot: The frozen copy to resume, or why it cannot be resumed */
export function checkSnapshot(
    value: unknown,
    gatewayUrl: string,
    totalShards: number,
    nowMs: number,
): { readonly snapshot: SessionSnapshot } | { readonly problem: string } {
    if (
        !record(value) ||
        typeof value.sessionId !== "string" ||
        value.sessionId.length === 0 ||
        value.sessionId.length > 256 ||
        typeof value.sequence !== "number" ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 0 ||
        typeof value.resumeUrl !== "string" ||
        typeof value.savedAt !== "number" ||
        !Number.isSafeInteger(value.savedAt) ||
        typeof value.totalShards !== "number" ||
        !Number.isSafeInteger(value.totalShards) ||
        value.totalShards < 1
    )
        return { problem: "the snapshot is malformed" }
    const age = nowMs - value.savedAt
    if (age >= sessionRetentionMs) return { problem: "the snapshot is older than Fluxer's 60-second resume window" }
    if (age < -snapshotClockSkewMs) return { problem: "the snapshot was saved in the future" }
    // Resume sends the token, so it only goes to the gateway this client discovered itself
    if (value.resumeUrl !== gatewayUrl) return { problem: "the snapshot belongs to a different gateway endpoint" }
    // Fluxer binds a session to the shard tuple it identified with, so resuming it under another plan routes guilds to the wrong shard
    if (value.totalShards !== totalShards) return { problem: "the snapshot belongs to a different shard plan" }
    return {
        snapshot: Object.freeze({
            sessionId: value.sessionId,
            sequence: value.sequence,
            resumeUrl: value.resumeUrl,
            savedAt: value.savedAt,
            totalShards: value.totalShards,
        }),
    }
}
