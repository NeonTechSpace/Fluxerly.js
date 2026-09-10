import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { ConfigurationError } from "../src/errors.js"
import { validateConfiguration } from "../src/internal/configuration.js"
import { guildShardId, parseShardPlan } from "../src/internal/sharding.js"

const token = "fixture-only-not-a-credential"
const malformedPlans: readonly (readonly [unknown, ConfigurationError["field"]])[] = [
    [null, "sharding"],
    [[], "sharding"],
    [{}, "totalShards"],
    [{ totalShards: 0 }, "totalShards"],
    [{ totalShards: 1.5 }, "totalShards"],
    [{ totalShards: 16_385 }, "totalShards"],
    [{ totalShards: 2, shardIds: [] }, "shardIds"],
    [{ totalShards: 2, shardIds: [0, 0] }, "shardIds"],
    [{ totalShards: 2, shardIds: [-1] }, "shardIds"],
    [{ totalShards: 2, shardIds: [2] }, "shardIds"],
    [{ totalShards: 2, shardIds: [0.5] }, "shardIds"],
    [{ totalShards: 2, shardIds: "0" }, "shardIds"],
    [{ totalShards: 2, unknown: true }, "sharding"],
]

function parsed(input: unknown) {
    const result = parseShardPlan(input)
    if (result instanceof ConfigurationError) throw result
    return result
}

function rejected(input: unknown, field: ConfigurationError["field"]) {
    const result = parseShardPlan(input)
    expect(result).toBeInstanceOf(ConfigurationError)
    if (result instanceof ConfigurationError) expect(result.field).toBe(field)
}

describe("shard plans", () => {
    test("defaults to one local shard without shard identify metadata", () => {
        const configuration = Effect.runSync(validateConfiguration({ token }))

        expect(configuration.sharding).toEqual({ totalShards: 1, shardIds: [0], identifyShards: false })
        expect(Object.isFrozen(configuration.sharding)).toBe(true)
        expect(Object.isFrozen(configuration.sharding.shardIds)).toBe(true)
    })

    test("copies and freezes a supplied partial assignment", () => {
        const shardIds = [2, 0]
        const configuration = Effect.runSync(validateConfiguration({ token, sharding: { totalShards: 4, shardIds } }))
        shardIds[0] = 1

        expect(configuration.sharding).toEqual({ totalShards: 4, shardIds: [2, 0], identifyShards: true })
        expect(() => (configuration.sharding.shardIds as number[]).push(1)).toThrow(TypeError)
    })

    test("assigns every shard when IDs are omitted", () => {
        expect(parsed({ totalShards: 3 })).toEqual({ totalShards: 3, shardIds: [0, 1, 2], identifyShards: true })
    })

    test.each(malformedPlans)("rejects malformed plans", (input, field) => {
        rejected(input, field)
    })

    test("rejects non-enumerable unsupported settings", () => {
        const input = { totalShards: 2 }
        Object.defineProperty(input, "unexpected", { value: true })

        rejected(input, "sharding")
    })

    test("routes guild snowflakes using exact bigint arithmetic", () => {
        const totalShards = 16_384
        const expectedShardId = 12_345n
        const guildId = (((987_654n * BigInt(totalShards) + expectedShardId) << 22n) + 99n).toString()

        expect(guildShardId(guildId, totalShards)).toBe(Number(expectedShardId))
    })
})
