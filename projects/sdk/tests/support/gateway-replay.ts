import type { CacheKind, EventName } from "../../src/index.js"
import { eventDispatchTypes } from "../../src/internal/gateway/event-dispatches.js"
import { createTestClient, type TestClient } from "../../src/testing.js"

// Shared by the gateway field checks (tests/contract/gateway-captures.test.ts and gateway-docs.test.ts). A field counts
// as read when giving it another valid value changes a delivered event. Dispatches are replayed through the in-memory
// client, and the delivered events and the contents of every enabled cache are compared with an unchanged replay, with
// the two kept apart because a cache can keep a field that the event leaves out. That holds however a decoder reaches
// the field, including copies and spreads that would hide an access from a recorder. A replacement the client rejects
// says nothing about exposure, so only accepted replacements count. A rejection shows as data that the unchanged
// replay delivered and the replacement does not

/** One dispatch to replay */
export interface Step {
    readonly event: string
    readonly payload: unknown
}

export type Pointer = readonly (string | number)[]
export interface Leaf {
    readonly pointer: Pointer
    readonly path: string
}

/** Every scalar and empty container in a payload, with its location and its path using [] for array elements */
export function leaves(value: unknown, pointer: Pointer = [], path = ""): Leaf[] {
    if (Array.isArray(value) && value.length > 0)
        return value.flatMap((item, index) => leaves(item, [...pointer, index], `${path}[]`))
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0)
        return Object.entries(value).flatMap(([key, item]) =>
            leaves(item, [...pointer, key], path ? `${path}.${key}` : key),
        )
    return [{ pointer, path }]
}

export function withValue(payload: unknown, pointer: Pointer, replacement: unknown): unknown {
    const copy = structuredClone(payload) as Record<string | number, unknown>
    let cursor = copy
    for (const step of pointer.slice(0, -1)) cursor = cursor[step] as Record<string | number, unknown>
    cursor[pointer[pointer.length - 1]!] = replacement
    return copy
}

const snowflake = /^[0-9]{16,20}$/
const clock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Other values of the same kind as a captured one. A null stands for any nullable kind, so it tries each */
export function probesFor(original: unknown): unknown[] {
    if (typeof original === "string") {
        if (snowflake.test(original)) return ["1000000000000000099"]
        if (clock.test(original)) return ["2030-01-01T00:00:00.000Z"]
        if (/^https?:\/\//.test(original)) return ["https://example.invalid/probe"]
        if (/^[0-9]+$/.test(original)) return [original === "1" ? "2" : "1"]
        if (/^(a_)?[0-9a-f]{8,}$/.test(original)) return ["0123456789abcdef0123456789abcdef"]
        return ["probe-value"]
    }
    if (typeof original === "number") return [original + 1, original === 0 ? 2 : 0]
    if (typeof original === "boolean") return [!original]
    if (original === null)
        return [
            "probe-value",
            "1000000000000000099",
            "2030-01-01T00:00:00.000Z",
            "0123456789abcdef0123456789abcdef",
            1,
            true,
        ]
    if (Array.isArray(original)) return [["1000000000000000099"], ["probe-value"], [{ probe: "value" }]]
    return [{ probe: "value" }]
}

export const cacheKinds: readonly CacheKind[] = [
    "messages",
    "guilds",
    "members",
    "roles",
    "channels",
    "users",
    "directMessages",
    "emojis",
    "stickers",
]

/** Every object path in a value, with [] for array elements */
function shape(value: unknown, path = "", into = new Set<string>()) {
    if (Array.isArray(value)) for (const item of value) shape(item, `${path}[]`, into)
    else if (value !== null && typeof value === "object")
        for (const [key, item] of Object.entries(value)) {
            into.add(`${path}.${key}`)
            shape(item, `${path}.${key}`, into)
        }
    return into
}

const bigintText = (_key: string, item: unknown) => (typeof item === "bigint" ? `${item}n` : item)

export interface Outcome {
    readonly deliveries: number
    /** The names of the delivered events, in order */
    readonly names: readonly string[]
    /** Dispatches the client skipped as malformed, which a dispatch without any delivery shows too */
    readonly malformed: number
    readonly shape: ReadonlySet<string>
    /** The delivered events alone, so a field kept only by a cache does not look delivered */
    readonly events: string
    /** The contents of every enabled cache */
    readonly caches: string
    /** Events and caches together */
    readonly text: string
}

/** A test client with every cache enabled and a handler on every public event, and the means to replay dispatches */
export interface Replay {
    readonly harness: TestClient
    /** What the client delivered and cached after replaying the steps in order, from a cleared cache */
    outcome(steps: readonly Step[]): Promise<Outcome>
    shutdown(): Promise<void>
}

export async function openReplay(): Promise<Replay> {
    const harness = createTestClient({
        cache: Object.fromEntries(cacheKinds.map((kind) => [kind, true])),
    })
    let delivered: unknown[] = []
    for (const name of Object.keys(eventDispatchTypes))
        harness.client.on(name as EventName, (value: unknown) => void delivered.push({ name, value }))
    await harness.ready()
    return {
        harness,
        async outcome(steps) {
            harness.client.cache.clear()
            delivered = []
            const skipped = harness.counters().eventsDropped.malformed
            for (const step of steps) harness.emit(step.event, step.payload)
            await harness.idle()
            const value = {
                delivered,
                cached: cacheKinds.map((kind) => harness.client.cache.entries(kind, { limit: 1000 })),
            }
            return {
                deliveries: delivered.length,
                names: delivered.map((item) => (item as { name: string }).name),
                malformed: harness.counters().eventsDropped.malformed - skipped,
                shape: shape(JSON.parse(JSON.stringify(value, bigintText))),
                events: JSON.stringify(value.delivered, bigintText),
                caches: JSON.stringify(value.cached, bigintText),
                text: JSON.stringify(value, bigintText),
            }
        },
        shutdown: () => harness.shutdown(),
    }
}

/**
 * Whether a replacement was accepted, and where it made a difference: "event" when a delivered event differs, "cache"
 * when only cache contents do. A field that only a cache keeps is not exposed by the event that carried it
 */
export function compare(baseline: Outcome, replaced: Outcome): "rejected" | "unchanged" | "event" | "cache" {
    if (
        replaced.deliveries !== baseline.deliveries ||
        replaced.malformed !== baseline.malformed ||
        [...baseline.shape].some((path) => !replaced.shape.has(path))
    )
        return "rejected"
    if (replaced.events !== baseline.events) return "event"
    return replaced.caches === baseline.caches ? "unchanged" : "cache"
}
