import { readFileSync } from "node:fs"
import { afterAll, beforeAll, expect, test } from "vitest"
import { channelEvents } from "../../src/internal/channel-decode.js"
import { dispatchEvent, handledDispatchTypes } from "../../src/internal/gateway/dispatch-table.js"
import { AuditLogActions } from "../../src/index.js"
import type { Fixtures } from "../../src/testing.js"
import {
    compare,
    leaves,
    openReplay,
    probesFor,
    withValue,
    type Leaf,
    type Outcome,
    type Pointer,
    type Replay,
    type Step,
} from "../support/gateway-replay.js"

// Fluxer documents the fields of every gateway Dispatch, and a decoder that ignores a documented field goes unnoticed
// until someone needs it. The captures check (gateway-captures.test.ts) sees only the fields its recorded samples
// carried. This check covers every field the documentation lists for every Dispatch the SDK handles, offline.
//
// The generator in scripts/gateway-docs.js reads the field tables of the gateway documents at the upstream pin into
// fixtures/gateway-docs.json. For each handled Dispatch the check builds a valid body that carries every documented
// field, replays it through the real client, then replays it again with one field replaced by another valid value of
// its own kind. A field is exposed when that changes an event the client delivers, however the decoder reaches it.
// A change that shows only in the contents of a cache does not count, because the application cannot see the field in
// the event. Every handled Dispatch must deliver the events the dispatch table names for it, apart from the few listed
// as silent, which are judged by their cache. Only an accepted replacement says anything, as in the captures check.
//
// Every field gets one verdict, and all but "exposed" need a ledger entry with a category and a specific reason:
// - unexposed: Some replacement was accepted and none changed anything
// - cache-only: The change shows in a cache but not in the delivered event
// - coupled: The client rejects a replacement of the field alone, because it checks the field against another field
//   that holds the same value, and replacing both changes the outcome. That cannot say which of the two is exposed,
//   unless the partner sits under an optional field. The field is then replaced alone with that field left out, and
//   the result of that replacement is the verdict
// - dependent: The field is exposed in the full body but not in its minimal body, where every other optional field is
//   left out and every array the documents allow to be empty is emptied. The event then takes the value from another
//   field, such as a guild ID read from a member. A few fields only exist beside another, which the minimal body keeps
// - rejected: The client rejects every replacement
// - absent: The body has no value for the field, which is a defect of the body and cannot be listed
// Bodies give every ID a value of its own, apart from the pairs a decoder requires to be equal (ties below), so a
// field is coupled only where the decoder demands it.
//
// Limits of what is compared:
// - A table row typed as an object of the HTTP API (a message, a channel, a guild member) is one documented field. The
//   fields inside it are replaced too, so the row counts as exposed when any of them is, but the HTTP API's own field
//   lists are not read here
// - An event whose payload is described in prose ("the complete channel object with guild_id added") has no table.
//   The overlay in fixtures/gateway-docs-overlay.json lists the fields such a description adds, from the same
//   documents, and the fields a footnote adds inside a table row. Each name must appear in backticks in the event's
//   prose in the fixture. An event the documents describe as a complete HTTP API object, with nothing added, has an
//   empty entry
// - Dispatches that only answer a request are validated by the request that waits for them, so they are listed in the
//   ledger as a whole
//
// The ledger in fixtures/gateway-docs-ledger.json holds one entry per documented field the client does not expose and
// per event that is not compared. An entry that no longer applies fails, so the ledger shrinks as gaps close

interface Shape {
    readonly kind: string
    readonly nullable?: true
    readonly object?: string
    readonly item?: Shape
    readonly key?: Shape
    readonly value?: Shape
    readonly link?: string
}
interface Field {
    readonly name: string
    readonly optional: boolean
    readonly shape: Shape
}
interface Docs {
    readonly source: { readonly commit: string; readonly sha256: string }
    readonly events: Readonly<
        Record<string, { readonly scope: string; readonly prose: string; readonly fields: readonly Field[] }>
    >
    readonly objects: Readonly<Record<string, { readonly fields: readonly Field[] }>>
}
interface Overlay {
    readonly object?: string
    readonly like?: string
    readonly without?: readonly string[]
    readonly fields?: readonly Field[]
    /** Fields a footnote adds to each element of a table row, keyed by the row */
    readonly within?: Readonly<Record<string, readonly Field[]>>
}
interface Entry {
    readonly category: string
    readonly reason: string
}

const read = <T>(path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T
const docs = read<Docs>("./fixtures/gateway-docs.json")
const overlay = read<Record<string, Overlay>>("./fixtures/gateway-docs-overlay.json")
const ledger = read<Record<string, Entry>>("./fixtures/gateway-docs-ledger.json")
const manifest = read<{ commit: string; gatewayDocs: { sha256: string } }>("../../../release/upstream/manifest.json")

type Status = "exposed" | "dependent" | "unexposed" | "cache-only" | "coupled" | "rejected" | "absent"

/** Categories of a field entry, with the verdicts each one can explain */
const fieldCategories: Readonly<Record<string, readonly Status[]>> = {
    "known gap not yet exposed": ["unexposed"],
    "intentionally dropped": ["unexposed"],
    "always empty, null or false here": ["unexposed", "rejected"],
    "cache-only": ["cache-only"],
    "paired with another field": ["coupled"],
    "exposed only while other data is present": ["dependent"],
}

/** Dispatches the table hands to the owner of a pending request, which validates the body and delivers no event */
const answersRequest = new Set([
    "GUILD_MEMBERS_CHUNK",
    "RATE_LIMITED",
    "GUILD_COUNTS_UPDATE",
    "CHANNEL_MEMBER_COUNTS_UPDATE",
])
/** Dispatches that deliver no event on purpose, so a cache is the only place their fields can show */
const silent: Readonly<Record<string, string>> = {
    THREAD_MEMBER_UPDATE:
        "The bot's own thread membership has no public event, and the update only evicts a cached thread",
}
const handled = new Set(handledDispatchTypes)

/** The public events the built body of a Dispatch delivers, which is none for a silent one */
const expectedEvents = (type: string): readonly string[] =>
    type === "GUILD_CREATE"
        ? ["guildCreate", "voiceStateSnapshot"]
        : [dispatchEvent(type) ?? channelEvents[type as keyof typeof channelEvents]].filter(
              (name) => name !== undefined,
          )
const userSessionScopes = new Set([
    "Member list subscription",
    "Passive session",
    "Command response",
    "Guild connection",
])

/** Categories of an event entry, each with the events it can describe */
const eventCategories: Readonly<Record<string, (event: string) => boolean>> = {
    "unhandled user-account event": (event) => !handled.has(event) && docs.events[event]?.scope === "Current user",
    "unhandled user-session event": (event) =>
        !handled.has(event) && userSessionScopes.has(docs.events[event]?.scope ?? ""),
    "unhandled voice event": (event) =>
        !handled.has(event) && event.startsWith("VOICE_") && docs.events[event]?.scope === "Current session",
    "session control outside the dispatch table": (event) =>
        !handled.has(event) && docs.events[event]?.scope === "Session lifecycle",
    "answers a request, checked through the request": (event) =>
        handled.has(event) && answersRequest.has(event) && docs.events[event]?.scope === "Command response",
    "handled but not documented": (event) => handled.has(event) && !(event in docs.events),
}

// Documented fields

interface Row {
    readonly path: string
    readonly optional: boolean
    readonly shape: Shape
}

/** The fields an event lists, with those a prose description adds from the overlay */
function eventFields(event: string): readonly Field[] {
    const added = overlay[event]
    const own = docs.events[event]?.fields ?? []
    if (!added) return own
    return [
        ...own,
        ...(added.object ? docs.objects[added.object]!.fields : []),
        ...(added.like ? eventFields(added.like).filter((field) => !added.without?.includes(field.name)) : []),
        ...(added.fields ?? []),
    ]
}

/** Every documented field, with the fields of the documented objects below it using [] for array elements */
function rows(fields: readonly Field[], prefix = "", chain: readonly string[] = []): Row[] {
    return fields.flatMap(({ name, optional, shape }) => {
        const path = `${prefix}${name}`
        let inner = shape
        let step = "."
        while (inner.kind === "array") {
            inner = inner.item!
            step = "[]."
        }
        const below =
            inner.kind === "ref" && !chain.includes(inner.object!)
                ? rows(docs.objects[inner.object!]!.fields, `${path}${step}`, [...chain, inner.object!])
                : []
        return [{ path, optional, shape }, ...below]
    })
}

/** The rows of an event, including the fields a footnote adds inside one of its rows */
function eventRows(event: string): Row[] {
    const list = rows(eventFields(event))
    for (const [key, fields] of Object.entries(overlay[event]?.within ?? {}))
        list.push(
            ...rows(fields, `${key}${list.find((row) => row.path === key)!.shape.kind === "array" ? "[]." : "."}`),
        )
    return list
}

// Valid bodies

const timestamp = "2026-01-01T00:00:00.000Z"
const anchor = (link: string) => link.slice(link.indexOf("#") + 1)

const memberRead = (f: Fixtures) => {
    const { guild_id: _guild, ...member } = f.member({
        roles: [f.nextId()],
        nick: "Nick",
        avatar: "avatar-hash",
        accent_color: 0x224466,
    })
    return member
}
/** The member Fluxer attaches to a message or deletion, which leaves out the account the message names */
const memberWithoutUser = (f: Fixtures) => {
    const { user: _user, ...member } = memberRead(f)
    return member
}
const voiceStateFields = () => docs.objects["voice-state-object"]!.fields
const threadMember = (f: Fixtures, thread = f.nextId()) => ({
    id: thread,
    user_id: f.ids.bot,
    join_timestamp: timestamp,
    flags: 1,
})

/** Values for documented objects of the HTTP API, in the form the gateway sends them */
const objects: Readonly<Record<string, (f: Fixtures) => unknown>> = {
    "guild-member-object": memberRead,
    "partial-user-object": (f) => f.user(),
    "user-object": (f) => f.user(),
    "guild-object": (f) => f.guild(),
    "guild-role-object": (f) => f.role(),
    "channel-object": (f) => f.channel(),
    "thread-object": (f) => f.thread(),
    "thread-member-object": (f) => threadMember(f),
    "guild-emoji-object": (f) => ({ id: f.nextId(), name: "party", animated: false }),
    "guild-sticker-object": (f) => ({ id: f.nextId(), name: "Fixture", animated: false, description: "", tags: [] }),
}

/** Fixed values for documented fields where a plain placeholder would not describe the field */
const named: Readonly<Record<string, unknown>> = {
    url: "https://example.com/resource",
    emoji_name: "party",
    status: "idle",
}

/** A value of the documented kind, with one element for each array and map */
function synthesize(shape: Shape, name: string, f: Fixtures): unknown {
    switch (shape.kind) {
        case "snowflake":
            return f.nextId()
        case "string":
            return named[name] ?? `${name}-value`
        case "integer":
            return 1
        case "number":
            return 1.5
        case "boolean":
            return true
        case "timestamp":
            return timestamp
        case "object":
            return { key: "value" }
        case "any":
            return "value"
        case "array":
            return [synthesize(shape.item!, name, f)]
        case "map":
            return { [String(synthesize(shape.key!, name, f))]: synthesize(shape.value!, name, f) }
        case "ref":
            return complete({}, docs.objects[shape.object!]!.fields, f)
        case "rest": {
            const build = objects[anchor(shape.link!)]
            if (!build) throw new Error(`No synthetic value for the documented object ${shape.link}`)
            return build(f)
        }
        default:
            throw new Error(`No synthetic value for the documented type ${shape.kind} of ${name}`)
    }
}

/** The body with every documented field it lacks added, and the documented objects inside it completed the same way */
function complete(body: Record<string, unknown>, fields: readonly Field[], f: Fixtures): Record<string, unknown> {
    for (const { name, shape } of fields) {
        if (!Object.hasOwn(body, name)) {
            body[name] = synthesize(shape, name, f)
            continue
        }
        let inner = shape
        while (inner.kind === "array") inner = inner.item!
        const items = Array.isArray(body[name]) ? body[name] : [body[name]]
        if (inner.kind === "ref")
            for (const item of items)
                if (item !== null && typeof item === "object")
                    complete(item as Record<string, unknown>, docs.objects[inner.object!]!.fields, f)
    }
    return body
}

/** Bodies for events whose payload is a complete object of the HTTP API, or that need values the types do not give */
const starts: Readonly<Record<string, (f: Fixtures) => Record<string, unknown>>> = {
    CHANNEL_CREATE: (f) => ({ ...f.channel() }),
    CHANNEL_UPDATE: (f) => ({ ...f.channel() }),
    CHANNEL_DELETE: (f) => ({ ...f.channel() }),
    GUILD_UPDATE: (f) => ({ ...f.guild() }),
    GUILD_MEMBER_ADD: (f) => ({ ...f.member() }),
    GUILD_MEMBER_UPDATE: (f) => ({ ...f.member() }),
    GUILD_CREATE: (f) => ({ id: f.ids.guild, unavailable: false, presences: [] }),
    CALL_CREATE: (f) => ({ voice_states: [callVoiceState(f)] }),
    CALL_UPDATE: (f) => ({ voice_states: [callVoiceState(f)] }),
    GUILD_AUDIT_LOG_ENTRY_CREATE: (f) => ({
        id: f.nextId(),
        action_type: AuditLogActions.RoleUpdate,
        user_id: f.ids.user,
        target_id: f.nextId(),
        reason: "Updated role",
        changes: [{ key: "name", old_value: "Before", new_value: "After" }],
    }),
    GUILD_BAN_ADD: (f) => ({ user: { id: f.nextId() } }),
    GUILD_BAN_REMOVE: (f) => ({ user: { id: f.nextId() } }),
    GUILD_MEMBER_REMOVE: (f) => ({ user: { id: f.nextId() } }),
    INVITE_CREATE: (f) => ({
        code: "invite-code",
        type: 0,
        channel: { id: f.ids.channel, type: 0, name: "general" },
        guild: { id: f.ids.guild, name: "Fixture Guild" },
        inviter: { id: f.ids.user },
        member_count: 3,
        presence_count: 1,
        temporary: false,
        expires_at: timestamp,
        created_at: timestamp,
        uses: 0,
        max_uses: 0,
        max_age: 0,
    }),
    GUILD_DELETE: (f) => ({ id: f.ids.guild, guild_id: f.ids.guild, unavailable_hidden: false }),
    MESSAGE_CREATE: (f) => ({ ...f.message({ member: memberWithoutUser(f) }) }),
    MESSAGE_UPDATE: (f) => ({ ...f.message({ member: memberWithoutUser(f) }) }),
    MESSAGE_DELETE: (f) => ({ member: memberWithoutUser(f) }),
    THREAD_DELETE: () => ({ type: 11 }),
    THREAD_LIST_SYNC: (f) => {
        const thread = f.thread()
        return { threads: [thread], members: [threadMember(f, thread.id)] }
    },
    THREAD_MEMBERS_UPDATE: (f) => {
        const id = f.nextId()
        // Each added member also carries the guild member and presence, as the documents' footnote states
        return { id, added_members: [{ ...threadMember(f, id), member: memberRead(f), presence: null }] }
    },
    THREAD_CREATE: (f) => ({ ...f.thread() }),
    THREAD_UPDATE: (f) => ({ ...f.thread() }),
    THREAD_MEMBER_UPDATE: (f) => ({ ...threadMember(f), muted: false, mute_config: null }),
    USER_UPDATE: (f) => ({ ...f.user() }),
}

/**
 * Pairs of fields the decoder requires to hold the same value, by path with [] for array elements. Every other ID in a
 * body is distinct, so a field the client checks against nothing can be replaced alone
 */
const ties: Readonly<Record<string, readonly (readonly string[])[]>> = {
    CHANNEL_UPDATE_BULK: [["guild_id", "channels[].guild_id"]],
    GUILD_CREATE: [["id", "properties.id", "voice_states[].guild_id", "channels[].guild_id", "threads[].guild_id"]],
    GUILD_DELETE: [["id", "guild_id"]],
    GUILD_UPDATE: [["id", "guild_id"]],
    MESSAGE_REACTION_ADD: [["user_id", "member.user.id"]],
    MESSAGE_REACTION_ADD_MANY: [["reactions[].user_id", "reactions[].member.user.id"]],
    MESSAGE_REACTION_REMOVE: [["user_id", "member.user.id"]],
    TYPING_START: [["user_id", "member.user.id"]],
    PRESENCE_UPDATE_BULK: [["guild_id", "presences[].guild_id"]],
    THREAD_LIST_SYNC: [
        ["guild_id", "threads[].guild_id"],
        ["threads[].id", "members[].id"],
    ],
    THREAD_MEMBERS_UPDATE: [["id", "added_members[].id"]],
}

/** Dispatches that must have reached the client first, for fields that act on what it already holds */
const setups: Readonly<Record<string, (body: Record<string, any>, f: Fixtures) => Step[]>> = {
    // The update evicts the cached thread it names, so the thread must be cached for the fields that name it to matter
    THREAD_MEMBER_UPDATE: (body, f) => [
        { event: "THREAD_CREATE", payload: f.thread({ id: body.id, guild_id: body.guild_id }) },
    ],
}

/** A participant of a call, whose voice state has neither a guild nor a member */
const callVoiceState = (f: Fixtures) => complete({ guild_id: null, member: null }, voiceStateFields(), f)

const valueAt = (body: unknown, pointer: Pointer) =>
    pointer.reduce<unknown>((value, step) => (value as Record<string | number, unknown>)[step], body)

const setAt = (body: unknown, pointer: Pointer, value: unknown) =>
    Object.assign(valueAt(body, pointer.slice(0, -1)) as object, { [pointer.at(-1)!]: value })

/** Gives every repeated ID a value of its own, then restores the pairs the decoder requires to be equal */
function distinct(event: string, body: Record<string, unknown>, f: Fixtures) {
    const all = leaves(body)
    const seen = new Set<string>()
    for (const { pointer } of all) {
        const value = valueAt(body, pointer)
        if (typeof value !== "string" || !/^[0-9]{16,20}$/.test(value)) continue
        if (seen.has(value)) setAt(body, pointer, f.nextId())
        else seen.add(value)
    }
    for (const group of ties[event] ?? []) {
        const pointers = group.map((path) => all.find((leaf) => leaf.path === path)!.pointer)
        const first = valueAt(body, pointers[0]!)
        for (const pointer of pointers.slice(1)) setAt(body, pointer, first)
    }
}

function bodyFor(event: string, f: Fixtures) {
    const body = complete(starts[event]?.(f) ?? {}, eventFields(event), f)
    for (const [key, fields] of Object.entries(overlay[event]?.within ?? {}))
        for (const item of [body[key]].flat())
            if (item !== null && typeof item === "object") complete(item as Record<string, unknown>, fields, f)
    distinct(event, body, f)
    return body
}

// Verdicts

type Probed = "changed" | "cache-only" | "coupled" | "unchanged" | "rejected"
/** Strongest first. A leaf takes the strongest result over its replacements */
const strength: readonly Probed[] = ["changed", "cache-only", "coupled", "unchanged", "rejected"]
const strongest = (results: readonly Probed[]): Probed =>
    strength.find((result) => results.includes(result)) ?? "rejected"
const statusOf: Readonly<Record<Probed, Status>> = {
    changed: "exposed",
    "cache-only": "cache-only",
    coupled: "coupled",
    unchanged: "unexposed",
    rejected: "rejected",
}

/** Other valid values of fields whose kind alone does not say which strings are accepted */
const alternatives: Readonly<Record<string, readonly unknown[]>> = { status: ["dnd", "online"] }

function withoutKey(body: unknown, pointer: Pointer): unknown {
    const copy = structuredClone(body)
    delete (valueAt(copy, pointer.slice(0, -1)) as Record<string | number, unknown>)[pointer.at(-1)!]
    return copy
}

/** Arrays the documents say are never sent empty, which the minimal body of a field keeps filled */
const neverEmpty: Readonly<Record<string, string>> = {
    "CHANNEL_UPDATE_BULK channels": "The document says an empty result produces no Dispatch",
    "PRESENCE_UPDATE_BULK presences": "The document says a batch that would be empty produces no Dispatch",
    "MESSAGE_REACTION_ADD_MANY reactions": "The event merges additions, so a window without any sends nothing",
}

/** Fields that only make sense beside another field, which the minimal body of the first keeps */
const keptWith: Readonly<Record<string, { readonly keeps: readonly string[]; readonly why: string }>> = {
    "GUILD_DELETE unavailable_hidden": {
        keeps: ["unavailable"],
        why: "It hides an unavailable guild, so it needs unavailable",
    },
    "MESSAGE_CREATE member": { keeps: ["guild_id"], why: "The member is present in a guild channel" },
    "MESSAGE_UPDATE member": { keeps: ["guild_id"], why: "The member is present in a guild channel" },
    "MESSAGE_REACTION_ADD member": { keeps: ["guild_id"], why: "The member is present in a guild channel" },
    "MESSAGE_REACTION_ADD_MANY reactions[].member": {
        keeps: ["guild_id"],
        why: "The member is present in a guild channel",
    },
    "MESSAGE_REACTION_REMOVE member": { keeps: ["guild_id"], why: "The member is present in a guild channel" },
    "TYPING_START member": { keeps: ["guild_id"], why: "The member is present in a guild channel" },
    "MESSAGE_REACTION_ADD emoji.animated": {
        keeps: ["emoji.id"],
        why: "Only a custom emoji has animated, and a Unicode reaction omits both",
    },
    "MESSAGE_REACTION_ADD_MANY reactions[].emoji.animated": {
        keeps: ["reactions[].emoji.id"],
        why: "Only a custom emoji has animated, and a Unicode reaction omits both",
    },
    "MESSAGE_REACTION_REMOVE emoji.animated": {
        keeps: ["emoji.id"],
        why: "Only a custom emoji has animated, and a Unicode reaction omits both",
    },
    "MESSAGE_REACTION_REMOVE_EMOJI emoji.animated": {
        keeps: ["emoji.id"],
        why: "Only a custom emoji has animated, and a Unicode reaction omits both",
    },
    "THREAD_LIST_SYNC members": {
        keeps: ["threads"],
        why: "A membership must name a listed thread",
    },
}

const rowDepth = (path: string) => path.split(".").length + (path.match(/\[\]/g)?.length ?? 0)
const under = (path: string, row: string) =>
    path === row || (/^[.[]/.test(path.slice(row.length)) && path.startsWith(row))

/**
 * The body cut down to what the probed field needs: every other optional field is left out, and every array the
 * documents allow to be empty is emptied, apart from those the field sits in. Undefined when nothing could be cut
 */
function minimal(event: string, body: unknown, documented: readonly Row[], probed: Row): unknown {
    const bodyLeaves = leaves(body)
    const cuts: { readonly path: string; readonly pointer: Pointer; readonly empties: boolean }[] = []
    const keeps = keptWith[`${event} ${probed.path}`]?.keeps ?? []
    for (const row of documented) {
        if (under(probed.path, row.path) || cuts.some((cut) => under(row.path, cut.path))) continue
        if (keeps.some((kept) => under(kept, row.path))) continue
        const leaf = bodyLeaves.find((item) => under(item.path, row.path))
        if (!leaf) continue
        const empties =
            !row.optional && row.shape.kind === "array" && !Object.hasOwn(neverEmpty, `${event} ${row.path}`)
        if (!row.optional && !empties) continue
        cuts.push({ path: row.path, pointer: leaf.pointer.slice(0, rowDepth(row.path)), empties })
    }
    if (cuts.length === 0) return undefined
    const copy = structuredClone(body)
    for (const { pointer, empties } of cuts) {
        const holder = valueAt(copy, pointer.slice(0, -1)) as Record<string | number, unknown>
        if (empties) holder[pointer.at(-1)!] = []
        else delete holder[pointer.at(-1)!]
    }
    return copy
}

interface Setting {
    readonly replay: Replay
    readonly steps: (payload: unknown) => Step[]
    /** Whether the Dispatch delivers an event. One that delivers nothing can only be judged by what it leaves in a cache */
    readonly delivers: boolean
    readonly documented: readonly Row[]
    readonly body: unknown
    readonly baseline: Outcome
}

/**
 * Judges documented fields against one body. A field's leaves are every value of the body at its path or below it. It
 * takes the strongest verdict among them, from exposed down to rejected, with the meanings in the header of this file.
 * An optional field is also probed by leaving it out. A replacement the client rejects alone is retried with every
 * other leaf that holds the same value, which gives the verdict coupled, not exposed, when that changes the outcome
 */
function judge({ replay, steps, delivers, documented, body, baseline }: Setting) {
    const probe = async (payload: unknown, against = baseline): Promise<Probed> => {
        const result = compare(against, await replay.outcome(steps(payload)))
        return result === "event" ? "changed" : result === "cache" ? (delivers ? "cache-only" : "changed") : result
    }
    const leafStatus = new Map<string, Probed>()
    const bodyLeaves = leaves(body)
    // The documents promise some arrays are always empty, so their element fields have nothing to replace
    const empty = bodyLeaves.filter(({ pointer }) => {
        const value = valueAt(body, pointer)
        return Array.isArray(value) && value.length === 0
    })

    /**
     * The result of replacing a leaf alone once every partner it is paired with is left out, or undefined when some
     * partner is not under an optional field or the body without the partners is not accepted. A drop of the leaf then
     * shows, instead of hiding behind the partner that the pair replacement also changed
     */
    async function alone(leaf: Leaf, partners: readonly Leaf[], value: unknown): Promise<Probed | undefined> {
        const trimmed: Pointer[] = []
        for (const partner of partners.filter((other) => other.path !== leaf.path)) {
            const row = documented.find((item) => item.optional && under(partner.path, item.path))
            if (!row) return undefined
            trimmed.push(partner.pointer.slice(0, rowDepth(row.path)))
        }
        const without = trimmed.reduce((copy, pointer) => withoutKey(copy, pointer), body)
        const reference = await replay.outcome(steps(without))
        if (reference.malformed > 0) return undefined
        const result = await probe(withValue(without, leaf.pointer, value), reference)
        return result === "rejected" ? undefined : result
    }

    /** The strongest result of replacing a leaf, over the values its kind and name allow */
    async function replaced(leaf: Leaf): Promise<Probed> {
        const original = valueAt(body, leaf.pointer)
        const name = leaf.path.split(/[.[]/).at(-1)!
        const partners = bodyLeaves.filter((other) => valueAt(body, other.pointer) === original)
        const verdicts: Probed[] = []
        for (const value of alternatives[name] ?? probesFor(original)) {
            let result = await probe(withValue(body, leaf.pointer, value))
            if (result === "rejected" && typeof original === "string" && partners.length > 1) {
                const both = await probe(partners.reduce((copy, other) => withValue(copy, other.pointer, value), body))
                result = both === "changed" ? ((await alone(leaf, partners, value)) ?? "coupled") : both
            }
            verdicts.push(result)
            if (result === "changed") break
        }
        return strongest(verdicts)
    }

    /** The verdict for a field, or undefined when the documents promise an array it sits in is empty */
    return async ({ path, optional }: Row): Promise<Status | undefined> => {
        if (empty.some((leaf) => path.startsWith(`${leaf.path}[]`))) return undefined
        const inside = bodyLeaves.filter((leaf) => under(leaf.path, path))
        const verdicts: Probed[] = []
        for (const leaf of inside) {
            if (!leafStatus.has(leaf.path)) leafStatus.set(leaf.path, await replaced(leaf))
            verdicts.push(leafStatus.get(leaf.path)!)
        }
        if (optional && inside.length > 0)
            verdicts.push(await probe(withoutKey(body, inside[0]!.pointer.slice(0, rowDepth(path)))))
        return inside.length === 0 ? "absent" : statusOf[strongest(verdicts)]
    }
}

/**
 * How each documented field of an event fares against the full body. A field that is exposed there is judged again
 * against its minimal body, and one that is not exposed there is dependent on the data cut from it
 */
async function survey(
    replay: Replay,
    event: string,
    body: unknown,
    documented: readonly Row[],
    before: readonly Step[] = [],
) {
    const steps = (payload: unknown): Step[] => [...before, { event, payload }]
    const delivering = before.length === 0 ? 0 : (await replay.outcome(before)).deliveries
    const logged = replay.harness.logs().length
    const baseline = await replay.outcome(steps(body))
    const rejections = replay.harness
        .logs()
        .slice(logged)
        .filter((record) => record.code === "gateway.dispatchRejected")
        .map((record) => String(record.fields?.field))
    const repeat = await replay.outcome(steps(body))
    const delivers = baseline.deliveries > delivering
    const names = baseline.names.slice(delivering)
    const full = judge({ replay, steps, delivers, documented, body, baseline })
    const results = new Map<string, Status>()
    for (const row of documented) {
        const status = await full(row)
        if (status !== undefined) results.set(row.path, status)
    }
    const unusable: string[] = []
    for (const row of documented.filter((item) => ["exposed", "coupled"].includes(results.get(item.path) ?? ""))) {
        const reduced = minimal(event, body, documented, row)
        if (reduced === undefined) continue
        const reference = await replay.outcome(steps(reduced))
        if (reference.malformed > 0 || (delivers && reference.deliveries <= delivering)) {
            unusable.push(`${row.path} (${reference.malformed > 0 ? "rejected as malformed" : "delivered nothing"})`)
            continue
        }
        const status = await judge({ replay, steps, delivers, documented, body: reduced, baseline: reference })(row)
        // A coupled field may stand alone once the data it is paired with is cut, which settles it
        if (results.get(row.path) === "coupled") {
            if (status === "exposed") results.set(row.path, "exposed")
            else if (status !== "coupled" && status !== "rejected") results.set(row.path, "dependent")
        } else if (status !== "exposed") results.set(row.path, "dependent")
    }
    return { baseline, repeat, rejections, delivers, names, unusable, results }
}

let replay: Replay
const surveyed = new Map<string, Awaited<ReturnType<typeof survey>>>()
const handledEvents = handledDispatchTypes.filter((type) => type in docs.events && !answersRequest.has(type))

beforeAll(async () => {
    replay = await openReplay()
    const f = replay.harness.fixtures
    for (const event of handledEvents) {
        const body = bodyFor(event, f)
        surveyed.set(event, await survey(replay, event, body, eventRows(event), setups[event]?.(body, f)))
    }
}, 120_000)
afterAll(() => replay.shutdown())

// Checks

test("the fixture is generated from the pinned gateway documents", () => {
    expect(docs.source).toMatchObject({ commit: manifest.commit, sha256: manifest.gatewayDocs.sha256 })
})

test("the overlay adds only fields the documents' prose names", () => {
    for (const [event, added] of Object.entries(overlay)) {
        const documented = docs.events[event]
        expect(documented, `${event} is no documented event`).toBeDefined()
        if (documented!.fields.length > 0)
            expect(Object.keys(added), `${event} has a table, so only fields inside its rows can be added`).toEqual([
                "within",
            ])
        if (added.object) expect(docs.objects[added.object], `${event} names a missing object`).toBeDefined()
        if (added.like) expect(docs.events[added.like], `${event} names a missing event`).toBeDefined()
        for (const key of Object.keys(added.within ?? {}))
            expect(
                documented!.fields.map((field) => field.name),
                `${event} adds fields inside ${key}, which it does not list`,
            ).toContain(key)
        // A field the prose no longer names has drifted away from the documents
        const names = [...(added.fields ?? []), ...Object.values(added.within ?? {}).flat()].map((field) => field.name)
        for (const name of names)
            expect(documented!.prose, `${event} no longer names ${name} in backticks`).toContain(`\`${name}\``)
    }
    const bare = handledEvents.filter((event) => eventFields(event).length === 0 && !(event in overlay))
    expect(bare, "handled events that list no fields").toEqual([])
})

test("every documented event is handled or listed, and every handled event is documented or listed", () => {
    const listed = Object.keys(ledger).filter((key) => !key.includes(" "))
    const unlisted = Object.keys(docs.events).filter((event) => !handled.has(event) && !listed.includes(event))
    const undocumented = handledDispatchTypes.filter((type) => !(type in docs.events) && !listed.includes(type))
    const unlistedRequests = [...answersRequest].filter((event) => !listed.includes(event))
    expect({ unlisted, undocumented, unlistedRequests }).toEqual({
        unlisted: [],
        undocumented: [],
        unlistedRequests: [],
    })
    const misfiled = listed.filter((event) => !eventCategories[ledger[event]!.category]?.(event))
    expect(misfiled, "event entries whose category does not describe the event").toEqual([])
})

test("the body built for every compared event is delivered, unchanged on replay", () => {
    const failures = [...surveyed].flatMap(([event, { baseline, repeat, rejections, delivers, names }]) => [
        ...(baseline.malformed > 0 ? [`${event} was rejected as malformed at ${rejections.join(", ")}`] : []),
        ...(baseline.text !== repeat.text ? [`${event} replays differently`] : []),
        ...(!delivers && !(event in silent) ? [`${event} delivered no event`] : []),
        ...(delivers && event in silent ? [`${event} is listed as silent but delivered an event`] : []),
        // The events a Dispatch may deliver come from the dispatch table, so a body cannot pass by delivering another
        ...(names.toSorted().join() !== expectedEvents(event).toSorted().join()
            ? [`${event} delivered ${names.join() || "nothing"}, not ${expectedEvents(event).join() || "nothing"}`]
            : []),
    ])
    expect(failures).toEqual([])
})

test("the settings of the minimal bodies name documented fields", () => {
    const paths = (key: string) => eventRows(key.slice(0, key.indexOf(" "))).map((row) => row.path)
    const unknown = [
        ...Object.keys(neverEmpty).filter((key) => !paths(key).includes(key.slice(key.indexOf(" ") + 1))),
        ...Object.entries(keptWith).flatMap(([key, { keeps }]) =>
            [key.slice(key.indexOf(" ") + 1), ...keeps]
                .filter((path) => !paths(key).includes(path))
                .map((path) => `${key} ${path}`),
        ),
    ]
    expect(unknown).toEqual([])
})

test("the minimal body of every exposed field is accepted", () => {
    const unusable = [...surveyed].flatMap(([event, { unusable }]) => unusable.map((why) => `${event} ${why}`))
    expect(unusable).toEqual([])
})

test("the client exposes every documented field apart from those listed", () => {
    const missing: string[] = []
    const absent: string[] = []
    for (const [event, { results }] of surveyed)
        for (const [path, status] of results) {
            const key = `${event} ${path}`
            if (status === "absent") absent.push(key)
            else if (status !== "exposed" && !Object.hasOwn(ledger, key)) missing.push(`${key} (${status})`)
        }
    expect({ absent, missing }).toEqual({ absent: [], missing: [] })
})

test("every field entry in the ledger still applies", () => {
    const stale: string[] = []
    for (const [key, { category, reason }] of Object.entries(ledger)) {
        if (!key.includes(" ")) {
            if (!(category in eventCategories) || reason.trim() === "") stale.push(key)
            continue
        }
        const [event, path] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)]
        const status = surveyed.get(event)?.results.get(path)
        if (status === undefined || !fieldCategories[category]?.includes(status) || reason.trim() === "")
            stale.push(`${key} (${category}, ${status})`)
    }
    expect(stale).toEqual([])
})

test("the check reports a documented field the client never reads, and not one it reads", async () => {
    const f = replay.harness.fixtures
    const fields: Field[] = [
        ...eventFields("TYPING_START"),
        { name: "invented_field", optional: false, shape: { kind: "string" } },
    ]
    const body = complete({ invented_field: "x" }, fields, f)
    distinct("TYPING_START", body, f)
    const { results } = await survey(replay, "TYPING_START", body, rows(fields))
    expect(results.get("invented_field")).toBe("unexposed")
    expect(results.get("timestamp")).toBe("exposed")
})
