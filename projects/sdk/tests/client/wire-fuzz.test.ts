/*
 * Seeded fuzzing of the wire decoders through the public test clients of both APIs.
 * Every case starts from a valid Fluxer wire payload and applies one to three random mutations: A deleted field, a value
 * of another JSON type, out-of-range numbers and IDs, very long strings, lone surrogates, deep self-nesting, unknown enum
 * values, duplicated or emptied lists and extra unknown keys, including __proto__ and constructor.
 * A REST read must return a typed failure with reason response or input, or a value that passes the shape check below.
 * A gateway dispatch must be delivered with such a value, or skipped with the malformed-dispatch counter and one
 * gateway.dispatchRejected record, while the client stays connected under the default skip setting. Neither may raise a
 * defect, an Error record or a change to Object.prototype. A hang fails through the test timeout
 *
 * FLUXERLY_FUZZ_SEED sets the unsigned 32-bit seed, default 1. A failure names the seed, API, target and case, and the
 * same seed with at least as many iterations replays it exactly, because each target draws its own sequence.
 * FLUXERLY_FUZZ_ITERATIONS sets the cases per target and API, default 12, which keeps the file within a few seconds.
 * A deeper local run uses a few thousand, for example from projects/sdk:
 * FLUXERLY_FUZZ_ITERATIONS=3000 pnpm exec vitest run tests/client/wire-fuzz.test.ts --maxWorkers=1
 */
import { inspect } from "node:util"
import { Cause, Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { AuditLogActions, type Client, type EventName, type LogRecord } from "../../src/index.js"
import {
    createTestClient as createDefaultTestClient,
    type Fixtures,
    type TestClientOptions,
} from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"

function setting(name: string, fallback: number, minimum: number, maximum: number): number {
    const text = process.env[name]
    if (text === undefined || text === "") return fallback
    const value = Number(text)
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`)
    return value
}

const seed = setting("FLUXERLY_FUZZ_SEED", 1, 0, 0xffff_ffff)
const iterations = setting("FLUXERLY_FUZZ_ITERATIONS", 12, 1, 1_000_000)
/** Gateway cases emitted before one idle wait, which costs several timer turns */
const batchSize = 32
/** Bounds a run that hangs, sized from the case count rather than from decoding speed */
const timeoutMs = 30_000 + iterations * 40

// Random generation

/** FNV-1a over the seed and a target name, so every target draws its own sequence and both APIs see the same cases */
function streamSeed(name: string): number {
    let hash = (0x811c9dc5 ^ seed) >>> 0
    for (const char of name) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0
    return hash
}

/** Mulberry32, a small seeded generator */
function generator(start: number) {
    let state = start >>> 0
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0
        let value = state
        value = Math.imul(value ^ (value >>> 15), value | 1)
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
    }
    const below = (count: number) => Math.floor(next() * count)
    return { below, pick: <T>(items: readonly T[]): T => items[below(items.length)]! }
}

type Random = ReturnType<typeof generator>

// Mutation

type Container = unknown[] | Record<string, unknown>

/** Raw JSON text spliced into a REST response, for nesting deeper than JSON.stringify can encode */
class RawJson {
    /** Splices created since the last render, which the next render expands */
    static readonly pending = new Map<string, string>()
    static #next = 0
    readonly placeholder = `fuzz-raw-${RawJson.#next++}`
    constructor(text: string) {
        RawJson.pending.set(this.placeholder, text)
    }
    toJSON() {
        return this.placeholder
    }
}

/** One position in a payload tree. The parent index leads back to the root for describing the path */
interface Slot {
    readonly parent: Container
    readonly key: string | number
    readonly value: unknown
    readonly up: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof RawJson)

/** Every position in the tree under holder.body, breadth first and bounded for deeply nested trees */
function slots(holder: Record<string, unknown>): Slot[] {
    const found: Slot[] = [{ parent: holder, key: "body", value: holder.body, up: -1 }]
    const seen = new Set<object>()
    for (let index = 0; index < found.length && found.length < 20_000; index++) {
        const { value } = found[index]!
        if (typeof value !== "object" || value === null || value instanceof RawJson || seen.has(value)) continue
        seen.add(value)
        if (Array.isArray(value))
            value.forEach((item, key) => found.push({ parent: value, key, value: item, up: index }))
        else
            for (const [key, item] of Object.entries(value))
                found.push({ parent: value as Container, key, value: item, up: index })
    }
    return found
}

/** The path of a slot from the payload root, shortened to its last 12 keys inside deep nesting */
function pathOf(all: readonly Slot[], index: number): string {
    const keys: (string | number)[] = []
    let at = index
    for (; at > 0 && keys.length < 12; at = all[at]!.up) keys.unshift(all[at]!.key)
    const path = keys.map((key) => (typeof key === "number" ? `[${key}]` : `.${key}`)).join("")
    return at > 0 ? `$...${path}` : `$${path}`
}

/** Set a field as an own data property, so a key such as __proto__ never changes a prototype */
function place(parent: Container, key: string | number, value: unknown) {
    Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true })
}

const otherTypes: readonly (() => unknown)[] = [
    () => "fuzz",
    () => "",
    () => "0",
    () => -1,
    () => 0,
    () => 1.5,
    () => true,
    () => false,
    () => null,
    () => [],
    () => ({}),
    () => ["fuzz"],
    () => ({ fuzz_value: 1 }),
]
const outOfRange: readonly number[] = [-1, 1e308, -1e308, 2 ** 53, 2 ** 31, 2 ** 32, 0.5, -2_147_483_649]
const badIds: readonly string[] = [
    "0",
    "-1",
    "01",
    "1e3",
    "18446744073709551616",
    "9223372036854775808",
    " 1",
    "1.0",
    "",
]
const unknownEnums: readonly unknown[] = [999, -7, 255, 65_535, "fuzz_unknown_value"]
const surrogates: readonly string[] = ["\uD800", "a\uDC00b", "\uDBFF\uDBFF", "\uDFFF"]
/** Keys no public value may carry. Finding one in a delivered value means wire keys leaked through */
const injectedKeys: readonly string[] = [
    "fuzz_extra",
    "__proto__",
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
]
const injectedValues: readonly (() => unknown)[] = [
    () => "fuzz",
    () => 1,
    () => null,
    () => [],
    () => ({ fuzz_polluted: true }),
]

interface Operator {
    readonly name: string
    /** Apply the mutation at one slot and return true, or return false when it does not apply there */
    readonly apply: (slot: Slot, random: Random) => boolean
}

/** Repeat an object inside one of its own object or array fields, as a reply chain or nested embed would */
function nest(slot: Slot, random: Random, depths: readonly number[]): boolean {
    const node = slot.value
    if (!isRecord(node)) return false
    const keys = Object.keys(node).filter((key) => typeof node[key] === "object" && node[key] !== null)
    if (keys.length === 0) return false
    const key = random.pick(keys)
    const inArray = Array.isArray(node[key])
    const depth = random.pick(depths)
    if (depth > 3_000) {
        // Splice the repeated text, since JSON.stringify cannot encode this depth
        const marker = "fuzz-nest-marker"
        let inner: string
        let shell: string
        try {
            inner = JSON.stringify(node)
            shell = JSON.stringify({ ...node, [key]: inArray ? [marker] : marker })
        } catch {
            // A node already nested beyond JSON.stringify's limit is not nested further
            return false
        }
        const [left, right] = shell.split(JSON.stringify(marker)) as [string, string]
        // Keep the text within a few tens of megabytes when the repeated object is large
        const levels = Math.min(depth, Math.floor(20_000_000 / (left.length + right.length)))
        place(slot.parent, slot.key, new RawJson(left.repeat(levels) + inner + right.repeat(levels)))
        return true
    }
    let nested: unknown = node
    for (let level = 0; level < depth; level++) nested = { ...node, [key]: inArray ? [nested] : nested }
    place(slot.parent, slot.key, nested)
    return true
}

function operators(rest: boolean): readonly Operator[] {
    return [
        {
            name: "delete",
            apply: ({ parent, key }) => {
                if (Array.isArray(parent)) parent.splice(key as number, 1)
                else delete parent[key]
                return true
            },
        },
        {
            name: "retype",
            apply: ({ parent, key, value }, random) => {
                const replacement = random.pick(otherTypes)()
                if (typeof replacement === typeof value && Array.isArray(replacement) === Array.isArray(value))
                    return false
                place(parent, key, replacement)
                return true
            },
        },
        {
            name: "range",
            apply: ({ parent, key, value }, random) => {
                if (typeof value === "number") place(parent, key, random.pick(outOfRange))
                else if (typeof value === "string" && /^\d+$/.test(value)) place(parent, key, random.pick(badIds))
                else return false
                return true
            },
        },
        {
            name: "long string",
            apply: ({ parent, key }, random) => {
                place(parent, key, random.pick(["x", "€"]).repeat(random.pick([4_097, 100_000])))
                return true
            },
        },
        {
            name: "lone surrogate",
            apply: ({ parent, key, value }, random) => {
                const surrogate = random.pick(surrogates)
                place(parent, key, typeof value === "string" ? value + surrogate : surrogate)
                return true
            },
        },
        {
            name: "nest",
            // REST responses carry raw text, so they also reach depths JSON.stringify cannot encode
            apply: (slot, random) => nest(slot, random, rest ? [64, 1_000, 100_000] : [64, 1_000, 3_000]),
        },
        {
            name: "enum",
            apply: ({ parent, key, value }, random) => {
                if (typeof value !== "number" && typeof value !== "string") return false
                place(parent, key, random.pick(unknownEnums))
                return true
            },
        },
        {
            name: "duplicate",
            apply: ({ value }, random) => {
                if (!Array.isArray(value) || value.length === 0) return false
                value.push(value[random.below(value.length)])
                return true
            },
        },
        {
            name: "empty",
            apply: ({ parent, key, value }) => {
                if (Array.isArray(value)) place(parent, key, [])
                else if (isRecord(value)) place(parent, key, {})
                else if (typeof value === "string") place(parent, key, "")
                else return false
                return true
            },
        },
        {
            name: "extra key",
            apply: ({ value }, random) => {
                if (!isRecord(value)) return false
                place(value, random.pick(injectedKeys), random.pick(injectedValues)())
                return true
            },
        },
    ]
}

const gatewayOperators = operators(false)
const restOperators = operators(true)

/** A mutated copy of a base payload and the steps that produced it */
function mutate(base: unknown, random: Random, ops: readonly Operator[]): { body: unknown; steps: string } {
    const holder: Record<string, unknown> = { body: structuredClone(base) }
    const steps: string[] = []
    const count = 1 + random.below(3)
    for (let attempt = 0; steps.length < count && attempt < 100; attempt++) {
        const all = slots(holder)
        const index = random.below(all.length)
        const operator = random.pick(ops)
        if (operator.apply(all[index]!, random)) steps.push(`${operator.name} at ${pathOf(all, index)}`)
    }
    return { body: holder.body, steps: steps.join(", ") }
}

/** JSON text with every RawJson splice expanded, or undefined for an absent body */
function render(body: unknown): string | undefined {
    let text = JSON.stringify(body)
    for (const [placeholder, raw] of RawJson.pending) text = text?.replace(JSON.stringify(placeholder), () => raw)
    RawJson.pending.clear()
    return text
}

/** Whether the test gateway, which encodes payloads with JSON.stringify, can send this body */
function sendable(body: unknown): boolean {
    try {
        JSON.stringify(body)
        return true
    } catch {
        return false
    }
}

// Checks

const prototypeKeys = Object.getOwnPropertyNames(Object.prototype).join()

function prototypeIntact(): boolean {
    return (
        Object.getOwnPropertyNames(Object.prototype).join() === prototypeKeys &&
        ({} as Record<string, unknown>).fuzz_polluted === undefined
    )
}

/** Public fields named like IDs that hold opaque strings rather than snowflakes */
const opaqueIds: ReadonlySet<string> = new Set(["sessionId", "connectionId", "targetId"])
const injected: ReadonlySet<string> = new Set(injectedKeys)
const snowflake = /^(0|[1-9][0-9]*)$/

/** Shape problems in a value the SDK returned or delivered: Leaked wire keys, invalid IDs, dates or numbers */
function shapeProblems(value: unknown): string[] {
    const problems: string[] = []
    const pending: { readonly value: unknown; readonly key: string; readonly path: string }[] = [
        { value, key: "", path: "" },
    ]
    const seen = new Set<object>()
    while (pending.length > 0 && problems.length < 5) {
        const { value: item, key, path } = pending.pop()!
        if (typeof item === "number" && !Number.isFinite(item)) problems.push(`${path} is ${item}`)
        if (typeof item === "string" && /Ids?$/.test(key) && !opaqueIds.has(key) && !snowflake.test(item))
            problems.push(`${path} is not a snowflake: ${JSON.stringify(item.slice(0, 40))}`)
        if (typeof item !== "object" || item === null || seen.has(item)) continue
        seen.add(item)
        if (item instanceof Date) {
            if (Number.isNaN(item.getTime())) problems.push(`${path} is an invalid Date`)
            continue
        }
        const prototype: unknown = Object.getPrototypeOf(item)
        if (prototype !== Object.prototype && prototype !== null && !Array.isArray(item)) continue
        for (const own of Reflect.ownKeys(item)) {
            if (typeof own === "symbol") continue
            if (injected.has(own)) problems.push(`unknown wire key ${own} reached ${path || "the value"}`)
            const child = (item as Record<string, unknown>)[own]
            // An array named like an ID list checks its items as IDs
            const childKey = Array.isArray(item) ? key : own
            pending.push({ value: child, key: childKey, path: path.length > 200 ? path : `${path}.${own}` })
        }
    }
    return problems
}

// Test clients

const recordedEvents: readonly EventName[] = [
    "messageCreate",
    "messageUpdate",
    "messageReactionAdd",
    "guildCreate",
    "voiceStateSnapshot",
    "guildChannelCreate",
    "guildChannelUpdate",
    "guildChannelDelete",
    "directMessageCreate",
    "directMessageUpdate",
    "directMessageDelete",
    "threadCreate",
    "threadUpdate",
    "threadDelete",
    "threadListSync",
    "threadMembersUpdate",
    "presenceUpdate",
    "voiceStateUpdate",
    "guildMemberAdd",
    "guildMemberUpdate",
    "guildMemberRemove",
]

/** One test client of either API with every cache enabled, so mutated data also reaches cache intake */
async function open(mode: Mode) {
    const records: LogRecord[] = []
    const delivered: { readonly event: EventName; readonly value: unknown }[] = []
    const options: TestClientOptions = {
        gateway: { ignoredEvents: [] },
        cache: {
            users: true,
            directMessages: true,
            guilds: true,
            members: true,
            roles: true,
            emojis: true,
            stickers: true,
            channels: true,
            messages: true,
        },
        logging: { dedupe: false, sink: (record) => void records.push(record) },
    }
    const queue = { maxPendingMessages: 100_000, maxPendingBytes: 2 ** 40 }
    const scope = Scope.makeUnsafe()
    const defaultTest = mode === "default" ? createDefaultTestClient(options) : undefined
    const nativeTest =
        mode === "native"
            ? await Effect.runPromise(createNativeTestClient(options as never).pipe(Scope.provide(scope)))
            : undefined
    onTestFinished(async () => {
        // Shutdown fails the test when a handler failure went unreported
        if (defaultTest) await defaultTest.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    for (const event of recordedEvents)
        if (defaultTest) defaultTest.client.on(event, (value) => void delivered.push({ event, value }), queue)
        else
            await Effect.runPromise(
                nativeTest!.client
                    .on(event, (value) => Effect.sync(() => void delivered.push({ event, value })), queue)
                    .pipe(Scope.provide(scope)),
            )
    const test = (defaultTest ?? nativeTest)!
    return {
        records,
        delivered,
        fixtures: test.fixtures,
        rest: test.rest,
        /** Both clients expose the same member names, and outcome() settles either result type */
        client: (defaultTest?.client ?? nativeTest!.client) as unknown as Client,
        state: () => test.client.state,
        counters: () => test.counters(),
        ready: () => (defaultTest ? defaultTest.ready() : Effect.runPromise(nativeTest!.ready())),
        idle: () => (defaultTest ? defaultTest.idle() : Effect.runPromise(nativeTest!.idle())),
        emit: (type: string, body: unknown) =>
            defaultTest ? defaultTest.emit(type, body) : Effect.runSync(nativeTest!.emit(type, body)),
    }
}

type Outcome = { readonly value: unknown } | { readonly error: unknown } | { readonly defect: string }

/** Settle a default ResultAsync or run a native Effect, separating typed failures from defects */
async function outcome(operation: unknown): Promise<Outcome> {
    if (Effect.isEffect(operation)) {
        const exit = await Effect.runPromiseExit(operation as Effect.Effect<unknown, unknown>)
        if (Exit.isSuccess(exit)) return { value: exit.value }
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag !== "Fail" || exit.cause.reasons.some((reason) => reason._tag !== "Fail"))
            return { defect: Cause.pretty(exit.cause) }
        return { error: failure.error }
    }
    try {
        const result = (await operation) as { isOk(): boolean; readonly value?: unknown; readonly error?: unknown }
        return result.isOk() ? { value: result.value } : { error: result.error }
    } catch (defect) {
        return { defect: inspect(defect) }
    }
}

// Valid wire payloads

const joinedAt = "2026-01-02T00:00:00.000Z"

/** Valid payloads sharing one fixture set's IDs, richer than the fixture defaults so mutations reach nested decoders */
function wire(f: Fixtures) {
    const { guild, channel, user, bot } = f.ids
    const roleId = f.nextId()
    const mentioned = f.user({ id: f.nextId(), username: "mentioned", global_name: "Mentioned", bot: true })
    const media = {
        url: "https://example.com/media.png",
        proxy_url: "https://example.com/proxy.png",
        content_type: "image/png",
        content_hash: "fixture-hash",
        width: 640,
        height: 480,
        description: "Media",
        placeholder: "fixture-base64",
        duration: 12,
        flags: 8,
    }
    const embed = {
        type: "rich",
        title: "Title",
        description: "Description",
        url: "https://example.com/build",
        color: 0x3d66b8,
        timestamp: "2026-09-08T14:30:00.000Z",
        author: {
            name: "Author",
            url: "https://example.com/author",
            icon_url: "https://example.com/author.png",
            proxy_icon_url: "https://example.com/proxy-author",
        },
        footer: {
            text: "Footer",
            icon_url: "https://example.com/footer.png",
            proxy_icon_url: "https://example.com/proxy-footer",
        },
        image: media,
        thumbnail: media,
        video: media,
        provider: { name: "Provider", url: "https://example.com" },
        fields: [{ name: "Status", value: "Passed", inline: true }],
        nsfw: false,
        children: [{ type: "image", image: media }],
    }
    const attachment = {
        id: f.nextId(),
        filename: "fixture.png",
        size: 4,
        flags: 8,
        url: "https://example.com/fixture.png",
        proxy_url: "https://example.com/proxy-fixture.png",
        content_type: "image/png",
        width: 2,
        height: 2,
    }
    const replied = f.message({ content: "reply context", author: mentioned })
    const message = f.message({
        type: 19,
        content: "Rich fixture message",
        mentions: [mentioned],
        mention_roles: [roleId],
        mention_channels: [{ id: channel, name: "general", type: 0 }],
        embeds: [embed],
        attachments: [attachment],
        reactions: [{ emoji: { id: null, name: "👍", animated: null }, count: 2, me: null }],
        message_reference: { message_id: replied.id, channel_id: channel, guild_id: guild, type: 0 },
        referenced_message: replied,
    })
    const forward = f.message({
        content: "",
        message_reference: { message_id: replied.id, channel_id: channel, guild_id: guild, type: 1 },
        message_snapshots: [
            {
                content: "Forwarded source",
                timestamp: joinedAt,
                type: 0,
                flags: 0,
                attachments: [attachment],
                embeds: [embed],
            },
        ],
    })
    const { guild_id: _directGuild, ...direct } = f.message({ content: "Direct message" })
    const member = f.member({
        roles: [roleId],
        nick: "Nick",
        avatar: "avatar-hash",
        accent_color: 0x224466,
        communication_disabled_until: "2099-01-01T00:00:00.000Z",
    })
    const { guild_id: _memberGuild, ...memberRead } = member
    const { guild_id: _botGuild, ...botMember } = f.member({ user: f.botUser() })
    const everyone = f.role({ id: guild, name: "@everyone", position: 0, permissions: "104324673" })
    const role = f.role({
        id: roleId,
        name: "Moderator",
        color: 0x3d66b8,
        hoist_position: 1,
        permissions: "8",
        hoist: true,
        mentionable: true,
        unicode_emoji: "🛡️",
    })
    const text = f.channel({
        topic: "Topic",
        last_message_id: message.id,
        rate_limit_per_user: 5,
        permission_overwrites: [
            { id: guild, type: 0, allow: "1024", deny: "0" },
            { id: user, type: 1, allow: "0", deny: "2048" },
        ],
    })
    const tagId = f.nextId()
    const forum = f.forumChannel({
        available_tags: [
            { id: tagId, name: "bug", moderated: false, emoji_id: null, emoji_name: "🐛" },
            { id: f.nextId(), name: "staff", moderated: true, emoji_id: f.nextId(), emoji_name: null },
        ],
        default_reaction_emoji: { emoji_id: null, emoji_name: "👍" },
        default_sort_order: 1,
        default_auto_archive_duration: 1440,
    })
    const ownMember = (id: string) => ({ id, user_id: bot, join_timestamp: joinedAt, flags: 1 })
    const thread = f.thread({ member: { join_timestamp: joinedAt, flags: 1 }, message_count: 3, total_message_sent: 4 })
    const post = f.thread({ parent_id: forum.id, applied_tags: [tagId], flags: 2 })
    const privateThread = f.thread({ type: 12 })
    const voiceState = {
        guild_id: guild,
        channel_id: channel,
        user_id: user,
        connection_id: "voice-connection",
        session_id: "voice-session",
        mute: false,
        deaf: true,
        self_mute: true,
        self_deaf: false,
        is_mobile: true,
        suppress: false,
        self_video: true,
        self_stream: true,
        viewer_stream_keys: [`${guild}:${channel}:remote-connection`],
        e2ee_capable: true,
        version: 3,
        member: memberRead,
    }
    const presence = {
        guild_id: guild,
        user: { id: user, username: "fixture-user" },
        status: "idle",
        mobile: true,
        afk: false,
        custom_status: {
            text: "Reviewing",
            expires_at: "2099-01-01T00:00:00.000Z",
            emoji_id: f.nextId(),
            emoji_name: "party",
            emoji_animated: true,
        },
    }
    const guildCreate = f.guildCreate({
        guild: { features: ["ANIMATED_ICON", "INVITE_SPLASH"], icon: "icon-hash" },
        roles: [everyone, role],
        channels: [text, forum],
        threads: [thread, post],
        members: [botMember, memberRead],
        voice_states: [voiceState],
        emojis: [{ id: f.nextId(), name: "party", animated: false }],
        stickers: [{ id: f.nextId(), name: "Fixture", animated: false, description: "", tags: [] }],
    })
    const incoming = {
        id: f.nextId(),
        guild_id: guild,
        channel_id: channel,
        type: 1,
        name: "Deployments",
        avatar: null,
        token: "fixture-only-webhook-token",
        user: f.user(),
    }
    const follower = {
        id: f.nextId(),
        guild_id: guild,
        channel_id: channel,
        type: 2,
        name: "Follower",
        avatar: "avatar-hash",
        source_guild: { id: f.nextId(), name: "Source", icon: null },
        source_channel: { id: f.nextId(), name: "announcements" },
    }
    const audit = {
        audit_log_entries: [
            {
                id: f.nextId(),
                action_type: AuditLogActions.RoleUpdate,
                user_id: user,
                target_id: roleId,
                reason: "Updated role",
                changes: [
                    { key: "name", old_value: "Before", new_value: "After" },
                    { key: "permissions_diff", new_value: { added: ["MANAGE_ROLES"], removed: ["VIEW_CHANNEL"] } },
                ],
            },
        ],
        users: [f.user()],
        webhooks: [],
    }
    return {
        ids: { guild, channel, user, bot, roleId },
        mentioned,
        message,
        forward,
        direct,
        member,
        memberRead,
        botMember,
        everyone,
        role,
        text,
        forum,
        thread,
        post,
        privateThread,
        ownMember,
        voiceState,
        presence,
        guildCreate,
        incoming,
        follower,
        audit,
    }
}

// Targets

interface GatewayTarget {
    readonly type: string
    readonly bases: (w: ReturnType<typeof wire>) => readonly unknown[]
    /** Events a valid body delivers, default 1. Zero for a body the SDK deliberately ignores */
    readonly deliveries?: (body: unknown) => number
}

const privateChannel = (body: unknown) =>
    isRecord(body) && (body.guild_id === undefined || body.guild_id === null) && body.type === 999 ? 0 : 1

const gatewayTargets: readonly GatewayTarget[] = [
    { type: "MESSAGE_CREATE", bases: (w) => [w.message, w.forward, w.direct] },
    { type: "MESSAGE_UPDATE", bases: (w) => [w.message] },
    {
        type: "MESSAGE_REACTION_ADD",
        bases: (w) =>
            [{ name: "👍" }, { id: w.mentioned.id, name: "party", animated: true }].map((emoji) => ({
                user_id: w.ids.user,
                channel_id: w.ids.channel,
                message_id: w.message.id,
                guild_id: w.ids.guild,
                emoji,
            })),
    },
    {
        type: "GUILD_CREATE",
        bases: (w) => [w.guildCreate],
        // The voice-state snapshot follows the guild as its own event
        deliveries: (body) => (isRecord(body) && Object.hasOwn(body, "voice_states") ? 2 : 1),
    },
    ...["CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE"].map((type) => ({
        type,
        bases: (w: ReturnType<typeof wire>) => [w.text, w.forum],
        deliveries: privateChannel,
    })),
    {
        type: "THREAD_CREATE",
        bases: (w) => [{ ...w.thread, newly_created: true, member: w.ownMember(w.thread.id) }, w.post, w.privateThread],
    },
    { type: "THREAD_UPDATE", bases: (w) => [w.thread, w.post] },
    {
        type: "THREAD_DELETE",
        bases: (w) => [{ id: w.thread.id, guild_id: w.ids.guild, parent_id: w.ids.channel, type: 11 }],
    },
    {
        type: "THREAD_LIST_SYNC",
        bases: (w) => [
            {
                guild_id: w.ids.guild,
                channel_ids: [w.ids.channel],
                threads: [w.thread, w.privateThread],
                members: [w.ownMember(w.thread.id)],
            },
        ],
    },
    {
        type: "THREAD_MEMBERS_UPDATE",
        bases: (w) => [
            {
                id: w.thread.id,
                guild_id: w.ids.guild,
                member_count: 2,
                added_members: [
                    {
                        id: w.thread.id,
                        user_id: w.ids.user,
                        join_timestamp: joinedAt,
                        flags: 2,
                        member: w.memberRead,
                        presence: null,
                    },
                ],
                removed_member_ids: [w.mentioned.id],
            },
        ],
    },
    {
        // The bot's own thread membership has no public event and only updates the channel cache
        type: "THREAD_MEMBER_UPDATE",
        bases: (w) => [{ ...w.ownMember(w.thread.id), muted: false, mute_config: null, guild_id: w.ids.guild }],
        deliveries: () => 0,
    },
    { type: "PRESENCE_UPDATE", bases: (w) => [w.presence] },
    {
        type: "VOICE_STATE_UPDATE",
        bases: (w) => [w.voiceState],
        // Private calls use the same dispatch with a null guild ID, which the SDK does not deliver
        deliveries: (body) => (isRecord(body) && body.guild_id === null ? 0 : 1),
    },
    { type: "GUILD_MEMBER_ADD", bases: (w) => [w.member] },
    { type: "GUILD_MEMBER_UPDATE", bases: (w) => [w.member] },
    { type: "GUILD_MEMBER_REMOVE", bases: (w) => [{ guild_id: w.ids.guild, user: w.mentioned }] },
]

interface RestCase {
    readonly route: string
    readonly body: unknown
    readonly call: (client: Client) => unknown
}

interface RestTarget {
    readonly name: string
    readonly cases: (w: ReturnType<typeof wire>) => readonly RestCase[]
}

const restTargets: readonly RestTarget[] = [
    {
        name: "messages.fetch",
        cases: (w) =>
            [w.message, w.forward].map((message) => ({
                route: "GET /channels/:id/messages/:id",
                body: message,
                call: (client) => client.messages.fetch({ id: message.id, channelId: message.channel_id }),
            })),
    },
    {
        name: "messages.fetchHistory",
        cases: (w) => [
            {
                route: "GET /channels/:id/messages",
                // History pages are newest first
                body: [w.forward, w.message],
                call: (client) => client.messages.fetchHistory(w.ids.channel),
            },
        ],
    },
    {
        name: "messages.search",
        cases: (w) => [
            {
                route: "POST /search/messages",
                body: {
                    messages: [w.message],
                    channels: [{ id: w.ids.channel, guild_id: w.ids.guild, name: "general", type: 0 }],
                    total: 1,
                    hits_per_page: 25,
                    page: 1,
                },
                call: (client) => client.messages.search({ guildId: w.ids.guild, channelId: w.ids.channel }),
            },
        ],
    },
    {
        name: "messages.fetchPins",
        cases: (w) => [
            {
                route: "GET /channels/:id/messages/pins",
                body: { items: [{ message: { ...w.message, pinned: true }, pinned_at: joinedAt }], has_more: false },
                call: (client) => client.messages.fetchPins(w.ids.channel),
            },
        ],
    },
    {
        name: "messages.fetchReactionUsers",
        cases: (w) => [
            {
                route: "GET /channels/:id/messages/:id/reactions/:emoji/users",
                body: {
                    items: [
                        { id: w.ids.user, username: "fixture-user" },
                        { id: w.mentioned.id, username: "mentioned", bot: true },
                    ],
                    has_more: false,
                    next_after: null,
                },
                call: (client) =>
                    client.messages.fetchReactionUsers({ id: w.message.id, channelId: w.ids.channel }, "👍"),
            },
        ],
    },
    {
        name: "channels.fetch",
        cases: (w) =>
            [w.text, w.forum, w.thread, w.post].map((channel) => ({
                route: "GET /channels/:id",
                body: channel,
                call: (client) => client.channels.fetch(channel.id),
            })),
    },
    {
        name: "channels.fetchAll",
        cases: (w) => [
            {
                route: "GET /guilds/:id/channels",
                body: [w.text, w.forum],
                call: (client) => client.channels.fetchAll(w.ids.guild),
            },
        ],
    },
    {
        name: "threads.fetchActive",
        cases: (w) => [
            {
                route: "GET /guilds/:id/threads/active",
                body: { threads: [w.thread, w.privateThread], members: [w.ownMember(w.thread.id)] },
                call: (client) => client.threads.fetchActive(w.ids.guild),
            },
        ],
    },
    {
        name: "threads.fetchArchived",
        cases: (w) => [
            {
                route: "GET /channels/:id/threads/archived/public",
                body: { threads: [w.thread], members: [w.ownMember(w.thread.id)], has_more: true },
                call: (client) => client.threads.fetchArchived(w.ids.channel),
            },
        ],
    },
    {
        name: "guilds.fetch",
        cases: (w) => [
            {
                route: "GET /guilds/:id",
                body: w.guildCreate.properties,
                call: (client) => client.guilds.fetch(w.ids.guild),
            },
        ],
    },
    {
        name: "members.fetch",
        cases: (w) => [
            {
                route: "GET /guilds/:id/members/:id",
                body: w.memberRead,
                call: (client) => client.members.fetch({ guildId: w.ids.guild, userId: w.ids.user }),
            },
        ],
    },
    {
        name: "members.fetchPage",
        cases: (w) => [
            {
                route: "GET /guilds/:id/members",
                // Member pages are in ascending user ID order
                body: [w.memberRead, w.botMember],
                call: (client) => client.members.fetchPage(w.ids.guild),
            },
        ],
    },
    {
        name: "roles.fetchAll",
        cases: (w) => [
            {
                route: "GET /guilds/:id/roles",
                body: [w.everyone, w.role],
                call: (client) => client.roles.fetchAll(w.ids.guild),
            },
        ],
    },
    {
        name: "webhooks.fetch",
        cases: (w) =>
            [w.incoming, w.follower].map((webhook) => ({
                route: "GET /webhooks/:id",
                body: webhook,
                call: (client) => client.webhooks.fetch(webhook.id),
            })),
    },
    {
        name: "webhooks.fetchForChannel",
        cases: (w) => [
            {
                route: "GET /channels/:id/webhooks",
                body: [w.incoming, w.follower],
                call: (client) => client.webhooks.fetchForChannel(w.ids.channel),
            },
        ],
    },
    {
        name: "auditLogs.fetchPage",
        cases: (w) => [
            {
                route: "GET /guilds/:id/audit-logs",
                body: w.audit,
                call: (client) => client.auditLogs.fetchPage(w.ids.guild, { actionType: AuditLogActions.RoleUpdate }),
            },
        ],
    },
]

// Runs

const both = <T extends { readonly type?: string; readonly name?: string }>(targets: readonly T[]) =>
    modes.flatMap((mode) => targets.map((target) => [mode, target.type ?? target.name!, target] as const))

const where = (mode: Mode, target: string) => `seed ${seed}, ${mode} ${target}`

test.each(both(gatewayTargets))(
    "%s %s dispatches are delivered valid or skipped with a record",
    async (mode, type, target) => {
        const api = await open(mode)
        const bases = target.bases(wire(api.fixtures))
        const deliveries = target.deliveries ?? (() => 1)
        await api.ready()
        const random = generator(streamSeed(type))

        /** Emit a batch, then check every delivery, rejection record and the connection once the client is idle */
        const run = async (cases: readonly { readonly body: unknown; readonly label: string }[], valid: boolean) => {
            let expected = 0
            let rejected = 0
            const sent: string[] = []
            for (const { body, label } of cases) {
                const before = api.counters().eventsDropped.malformed
                try {
                    api.emit(type, body)
                } catch (error) {
                    // A dispatch that crashes the session closes it at once, so the next emit is the first to notice
                    expect.fail(`The connection ended after one of these cases:\n${sent.join("\n")}\n${inspect(error)}`)
                }
                sent.push(label)
                const skipped = api.counters().eventsDropped.malformed - before
                expect(skipped, `${label}: one dispatch skipped ${skipped} times`).toBeLessThanOrEqual(valid ? 0 : 1)
                if (skipped === 1) rejected++
                else expected += deliveries(body)
            }
            await api.idle()
            const labels = cases.map(({ label }) => label).join("\n")
            expect(api.state(), `client left Connected during:\n${labels}`).toBe("Connected")
            // Each batch takes the records and deliveries collected since the previous one, so a long run retains none
            const records = api.records.splice(0)
            expect(
                records.filter((record) => record.level === "error" || record.level === "fatal"),
                `Error records during:\n${labels}`,
            ).toEqual([])
            expect(
                records.filter(
                    (record) => record.code === "gateway.dispatchRejected" && record.fields?.dispatch === type,
                ).length,
                `skipped dispatches without one gateway.dispatchRejected record each during:\n${labels}`,
            ).toBe(rejected)
            const values = api.delivered.splice(0)
            expect(values.length, `accepted dispatches without their events during:\n${labels}`).toBe(expected)
            for (const { event, value } of values)
                expect(shapeProblems(value), `${event} value delivered during:\n${labels}`).toEqual([])
            expect(api.counters().eventsDropped.overflow, "events dropped by queue overflow").toBe(0)
            expect(prototypeIntact(), `Object.prototype changed during:\n${labels}`).toBe(true)
        }

        // Every unmutated base must be delivered, otherwise mutations would only ever meet a rejection
        await run(
            bases.map((body, index) => ({ body, label: `${where(mode, type)} base ${index}` })),
            true,
        )
        for (let start = 0; start < iterations; start += batchSize) {
            const cases: { body: unknown; label: string }[] = []
            for (let index = start; index < Math.min(iterations, start + batchSize); index++) {
                const { body, steps } = mutate(random.pick(bases), random, gatewayOperators)
                // JSON.stringify's own depth limit bounds what the test gateway can send
                if (!sendable(body)) continue
                cases.push({ body, label: `${where(mode, type)} case ${index}: ${steps}` })
            }
            await run(cases, false)
        }
    },
    timeoutMs,
)

test.each(both(restTargets))(
    "%s %s returns a typed failure or a valid value",
    async (mode, name, target) => {
        const api = await open(mode)
        const cases = target.cases(wire(api.fixtures))
        let text: string | undefined
        for (const route of new Set(cases.map((item) => item.route)))
            api.rest.respond(
                route,
                () =>
                    new Response(text ?? null, {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
            )
        const random = generator(streamSeed(name))

        const check = async (item: RestCase, body: unknown, label: string, base: boolean) => {
            text = render(body)
            const result = await outcome(item.call(api.client))
            if ("defect" in result) expect.fail(`${label}: defect ${result.defect}`)
            if ("error" in result) {
                expect(base, `${label}: the unmutated response failed: ${inspect(result.error)}`).toBe(false)
                const { reason } = result.error as { readonly reason?: unknown }
                expect(result.error, `${label}: untyped failure`).toBeInstanceOf(Error)
                expect(["response", "input"], `${label}: reason ${String(reason)}`).toContain(reason)
            } else expect(shapeProblems(result.value), `${label}: returned value`).toEqual([])
            expect(prototypeIntact(), `${label}: Object.prototype changed`).toBe(true)
        }

        // Every unmutated base must succeed, otherwise mutations would only ever meet a failure
        for (const [index, item] of cases.entries())
            await check(item, item.body, `${where(mode, name)} base ${index}`, true)
        for (let index = 0; index < iterations; index++) {
            const item = random.pick(cases)
            const { body, steps } = mutate(item.body, random, restOperators)
            // Repeated object nesting can pass JSON.stringify's own depth limit, which bounds what this test can send
            if (!sendable(body)) continue
            await check(item, body, `${where(mode, name)} case ${index}: ${steps}`, false)
        }
        await api.idle()
        expect(
            api.records.filter((record) => record.level === "error" || record.level === "fatal"),
            `${where(mode, name)}: Error records`,
        ).toEqual([])
    },
    timeoutMs,
)
