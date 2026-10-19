import { readFileSync } from "node:fs"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { CacheKind, EventName } from "../../src/index.js"
import { eventDispatchTypes } from "../../src/internal/gateway/event-dispatches.js"
import { createTestClient, type TestClient } from "../../src/testing.js"

// Gateway events have no machine-readable schema, so the decoder tests elsewhere use hand-written payloads, and a
// field the SDK drops goes unnoticed. This check feeds payloads captured from the hosted service (scrubbed of every
// identifier, name, text, address, hash and time by tests/live/gateway-capture.js, and refreshed as the live check
// guide describes) through the real client, and reports every payload field the client never reads.
//
// A field counts as read when giving it another valid value changes what the client delivers or caches. Each field is
// replaced in turn by values of its own kind, the captures are replayed through the in-memory client, and the
// delivered events and the contents of every enabled cache are compared with an unchanged replay. That holds however
// a decoder reaches the field, including copies and spreads that would hide an access from a recorder. A field the
// client validates but never exposes is reported too, because the application cannot see it either. A replacement the
// client rejects says nothing about exposure, so only accepted replacements count. A rejection shows as data that the
// unchanged replay delivered and the replacement does not. A field that rejects every replacement cannot be judged,
// so it must be listed as unprobed with the reason, and an unread field there would go unreported

interface Capture {
    readonly label: string
    readonly event: string
    readonly payload: unknown
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/gateway-captures.json", import.meta.url), "utf8")) as {
    readonly captures: readonly Capture[]
}

// Fields captured from the hosted service that the client does not read, each with the reason. Keys are
// `<event or *> <field path>`, with [] for any array element, * for every event that carries the field, and a parent
// path covering the fields below it. A field without an entry fails the check, so a new unread field needs a decision
// here. An entry is removed when the client starts reading its fields or the captures stop carrying them.
// Entries marked "Dropped" are payload data an application might want, not decisions to leave it out
const ignoredOnPurpose: Readonly<Record<string, string>> = {
    "MESSAGE_CREATE channel_type":
        "Dropped: The kind of channel the message was sent in, which Message does not expose",
    "MESSAGE_DELETE member": "Dropped: The author's member in a deletion, which MessageDeletion does not carry",
    "* member.user.avatar": "GuildMember projects the account's username and bot flag only",
    "* member.user.avatar_color": "GuildMember projects the account's username and bot flag only",
    "* member.user.discriminator": "GuildMember projects the account's username and bot flag only",
    "* member.user.flags": "GuildMember projects the account's username and bot flag only",
    "* member.user.global_name": "GuildMember projects the account's username and bot flag only",
}

// Fields the check cannot tell apart from an unread one, because the client rejects every replacement the check can
// build. The client may well read them, but an unread field here would not be reported. Same keys as above. Each entry
// is removed when the check can probe the field, or when the captures stop carrying it
const unprobedOnPurpose: Readonly<Record<string, string>> = {
    "* attachments": "Empty in every capture of the event, and the check builds no sample element",
    "* embeds": "Empty in every capture of the event, and the check builds no sample element",
    "* mentions": "Empty in every capture of the event, and the check builds no sample element",
    "* stickers": "Empty in every capture of the event, and the check builds no sample element",
    "* permission_overwrites": "Empty in every capture of the event, and the check builds no sample element",
    "MESSAGE_CREATE referenced_message.attachments": "Empty in the capture, and the check builds no sample element",
    "MESSAGE_CREATE referenced_message.embeds": "Empty in the capture, and the check builds no sample element",
    "MESSAGE_CREATE referenced_message.mentions": "Empty in the capture, and the check builds no sample element",
    "MESSAGE_CREATE referenced_message.stickers": "Empty in the capture, and the check builds no sample element",
    "* member.user.id": "The client accepts only the acting user's own ID there, which no replacement can match",
}

type Pointer = readonly (string | number)[]
interface Leaf {
    readonly pointer: Pointer
    readonly path: string
}

/** Every scalar and empty container in a payload, with its location and its path using [] for array elements */
function leaves(value: unknown, pointer: Pointer = [], path = ""): Leaf[] {
    if (Array.isArray(value) && value.length > 0)
        return value.flatMap((item, index) => leaves(item, [...pointer, index], `${path}[]`))
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0)
        return Object.entries(value).flatMap(([key, item]) =>
            leaves(item, [...pointer, key], path ? `${path}.${key}` : key),
        )
    return [{ pointer, path }]
}

function withValue(payload: unknown, pointer: Pointer, replacement: unknown): unknown {
    const copy = structuredClone(payload) as Record<string | number, unknown>
    let cursor = copy
    for (const step of pointer.slice(0, -1)) cursor = cursor[step] as Record<string | number, unknown>
    cursor[pointer[pointer.length - 1]!] = replacement
    return copy
}

const snowflake = /^[0-9]{16,20}$/
const clock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Other values of the same kind as a captured one. A null stands for any nullable kind, so it tries each */
function probesFor(original: unknown): unknown[] {
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

const cacheKinds: readonly CacheKind[] = [
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

let harness: TestClient
let delivered: unknown[] = []

beforeAll(async () => {
    harness = createTestClient({
        cache: Object.fromEntries(cacheKinds.map((kind) => [kind, true])),
    })
    for (const name of Object.keys(eventDispatchTypes))
        harness.client.on(name as EventName, (value: unknown) => void delivered.push({ name, value }))
    await harness.ready()
})
afterAll(() => harness.shutdown())

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

/** What the client delivered and cached after replaying the first `count` captures, with `replaced` standing in for the last */
async function outcome(captures: readonly Capture[], count: number, replaced?: unknown) {
    harness.client.cache.clear()
    delivered = []
    for (const [index, capture] of captures.slice(0, count).entries())
        harness.emit(capture.event, index === count - 1 && replaced !== undefined ? replaced : capture.payload)
    await harness.idle()
    const value = {
        delivered,
        cached: cacheKinds.map((kind) => harness.client.cache.entries(kind, { limit: 1000 })),
    }
    return {
        deliveries: delivered.length,
        shape: shape(
            JSON.parse(JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? `${item}n` : item))),
        ),
        text: JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? `${item}n` : item)),
    }
}
type Outcome = Awaited<ReturnType<typeof outcome>>

/** Whether a replacement was accepted, and whether it changed anything the unchanged replay delivered or cached */
function compare(baseline: Outcome, replaced: Outcome) {
    if (replaced.deliveries !== baseline.deliveries || [...baseline.shape].some((path) => !replaced.shape.has(path)))
        return "rejected"
    return replaced.text === baseline.text ? "unchanged" : "changed"
}

type Verdict = "read" | "unread" | "unprobed"

/**
 * The fields no accepted replacement makes any difference to, and the fields that rejected every replacement so that
 * nothing could be concluded, each as `<event> <path>` over all captures of the event
 */
async function classify(captures: readonly Capture[]) {
    const verdicts = new Map<string, Verdict>()
    for (const [index, capture] of captures.entries()) {
        const baseline = await outcome(captures, index + 1)
        expect((await outcome(captures, index + 1)).text, `${capture.label} replays differently`).toBe(baseline.text)
        for (const { pointer, path } of leaves(capture.payload)) {
            const key = `${capture.event} ${path}`
            if (verdicts.get(key) === "read") continue
            let original: unknown = capture.payload
            for (const step of pointer) original = (original as Record<string | number, unknown>)[step]
            let accepted = 0
            let changed = false
            for (const probe of probesFor(original)) {
                const result = compare(
                    baseline,
                    await outcome(captures, index + 1, withValue(capture.payload, pointer, probe)),
                )
                if (result === "rejected") continue
                accepted++
                if (result === "changed") {
                    changed = true
                    break
                }
            }
            const verdict: Verdict = changed ? "read" : accepted > 0 ? "unread" : "unprobed"
            if (verdict !== "unprobed" || !verdicts.has(key)) verdicts.set(key, verdict)
        }
    }
    // An empty container is read when its elements are, which another capture of the event may have shown
    for (const [key, verdict] of verdicts) {
        const [event, path] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)]
        if (
            verdict === "unprobed" &&
            [...verdicts].some(([other, v]) => v !== "unprobed" && other.startsWith(`${event} ${path}[`))
        )
            verdicts.delete(key)
    }
    const fields = (wanted: Verdict) => [...verdicts].filter(([, verdict]) => verdict === wanted).map(([key]) => key)
    return { unread: fields("unread"), unprobed: fields("unprobed") }
}

// The fixture is probed once and both lists are judged against that one result
let fixtureProbed: ReturnType<typeof classify> | undefined
const fixtureVerdicts = () => (fixtureProbed ??= classify(fixture.captures))

/** Whether an ignored-on-purpose entry names this unread field, directly or as a parent of it */
function names(entry: string, field: string) {
    const [entryEvent, entryPath] = [entry.slice(0, entry.indexOf(" ")), entry.slice(entry.indexOf(" ") + 1)]
    const [event, path] = [field.slice(0, field.indexOf(" ")), field.slice(field.indexOf(" ") + 1)]
    if (entryEvent !== "*" && entryEvent !== event) return false
    return path === entryPath || path.startsWith(`${entryPath}.`) || path.startsWith(`${entryPath}[`)
}

test("every captured event delivers something to the application", async () => {
    for (const [index, capture] of fixture.captures.entries()) {
        const before = (await outcome(fixture.captures, index)).deliveries
        const after = (await outcome(fixture.captures, index + 1)).deliveries
        expect(after, `${capture.label} delivered nothing`).toBeGreaterThan(before)
    }
})

test("the check reports a field the client never reads, and not one it reads", async () => {
    const captures = fixture.captures.filter((capture) => capture.event === "MESSAGE_CREATE")
    const first = captures[0]!
    const extended = [{ ...first, payload: { ...(first.payload as object), invented_field: "x" } }]
    const { unread } = await classify(extended)
    expect(unread).toContain("MESSAGE_CREATE invented_field")
    expect(unread).not.toContain("MESSAGE_CREATE content")
})

test("the client reads every captured field apart from those ignored on purpose", async () => {
    const { unread } = await fixtureVerdicts()
    const entries = Object.keys(ignoredOnPurpose)
    expect(unread.filter((field) => !entries.some((entry) => names(entry, field)))).toEqual([])
    // An entry that names no unread field is out of date
    expect(entries.filter((entry) => !unread.some((field) => names(entry, field)))).toEqual([])
})

test("every field the check could not probe is listed with the reason", async () => {
    const { unprobed } = await fixtureVerdicts()
    const entries = Object.keys(unprobedOnPurpose)
    expect(unprobed.filter((field) => !entries.some((entry) => names(entry, field)))).toEqual([])
    expect(entries.filter((entry) => !unprobed.some((field) => names(entry, field)))).toEqual([])
})
