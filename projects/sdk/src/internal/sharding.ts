import { ConfigurationError } from "#sdk/errors"
import { record } from "./message.js"

const maximumShardCount = 16_384

export interface ShardPlan {
    readonly totalShards: number
    readonly shardIds: readonly number[]
    readonly identifyShards: boolean
}

const defaultShardPlan = immutablePlan(1, [0])

/** Validate and copy the one-time local shard assignment without changing caller-owned input */
export function parseShardPlan(input: unknown): ShardPlan | ConfigurationError {
    if (input === undefined) return defaultShardPlan
    if (!record(input)) return new ConfigurationError("sharding", "Sharding settings must be an object")
    if (Reflect.ownKeys(input).some((key) => key !== "totalShards" && key !== "shardIds"))
        return new ConfigurationError("sharding", "Sharding settings must contain only totalShards and shardIds")

    const totalShards = input.totalShards
    if (
        typeof totalShards !== "number" ||
        !Number.isSafeInteger(totalShards) ||
        totalShards < 1 ||
        totalShards > maximumShardCount
    ) {
        return new ConfigurationError("totalShards", "totalShards must be an integer from 1 through 16,384")
    }

    const inputShardIds = input.shardIds
    if (inputShardIds === undefined) {
        return immutablePlan(
            totalShards,
            Array.from({ length: totalShards }, (_, shardId) => shardId),
        )
    }
    if (!Array.isArray(inputShardIds) || inputShardIds.length === 0)
        return new ConfigurationError("shardIds", "shardIds must be a non-empty array")

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
                "shardIds must contain unique integers from 0 through totalShards minus one",
            )
        }
        seen.add(shardId)
        shardIds.push(shardId)
    }
    return immutablePlan(totalShards, shardIds)
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
