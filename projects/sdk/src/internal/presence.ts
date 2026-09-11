import type { PresenceUpdate, PresenceUpdateBulk } from "#sdk/events"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import type { CustomStatusEmoji, PresenceInput, PresenceStatus } from "#sdk/presence"
import { identifier, record } from "./message.js"

const statuses = new Set<PresenceStatus>(["online", "idle", "dnd", "invisible"])
const presenceIntervalMs = 4_000
const memberSelectionIntervalMs = 125
const maxSelectedGuilds = 100
const maxSelectedMemberIds = 10_000
const maxMembersPerGuild = 1_000
const maxGatewayPayloadBytes = 4_096

export interface FrozenCustomStatus {
    readonly text?: string
    readonly emoji?: Readonly<CustomStatusEmoji>
    readonly expiresAt?: string
}

export interface FrozenPresence extends Omit<PresenceInput, "customStatus"> {
    readonly customStatus?: FrozenCustomStatus | null
}

export interface GatewayPresenceUpdate {
    readonly status: PresenceStatus
    readonly afk: false
    readonly mobile: false
    readonly custom_status?: {
        readonly text?: string
        readonly emoji_id?: string
        readonly emoji_name?: string
        readonly expires_at?: string
    } | null
}

export interface GatewayPresenceMemberSubscriptions {
    readonly subscriptions: Readonly<Record<string, Readonly<{ readonly members: readonly string[] }>>>
}

export interface PresenceGatewayOwner {
    attach(
        send: (update: GatewayPresenceUpdate) => void,
        sendMemberSubscriptions?: (subscriptions: GatewayPresenceMemberSubscriptions) => void,
        mode?: "identify" | "resume",
    ): void
    detach(): void
    guildCreate(guildId: string): void
}

export interface PresenceTimer {
    readonly now: () => number
    readonly set: (callback: () => void, delay: number) => unknown
    readonly clear: (handle: unknown) => void
}

/** Decode the stable subset of an inbound provider presence without retaining it */
export function decodePresenceUpdate(value: unknown): PresenceUpdate | undefined {
    if (!record(value)) return undefined
    const guildId = value.guild_id
    if (
        (guildId !== undefined && !identifier(guildId)) ||
        !record(value.user) ||
        !identifier(value.user.id) ||
        typeof value.status !== "string" ||
        value.status.length < 1 ||
        !value.status.isWellFormed() ||
        typeof value.mobile !== "boolean" ||
        typeof value.afk !== "boolean"
    )
        return undefined
    const presence = {
        userId: value.user.id,
        status: value.status,
        mobile: value.mobile,
        afk: value.afk,
    }
    return Object.freeze(guildId === undefined ? presence : { guildId, ...presence })
}

/** Decode one provider recovery batch without flattening it into individual notifications or retaining current presence */
export function decodePresenceUpdateBulk(value: unknown): PresenceUpdateBulk | undefined {
    if (
        !record(value) ||
        !identifier(value.guild_id) ||
        !Array.isArray(value.presences) ||
        value.presences.length < 1 ||
        value.presences.length > 500
    )
        return undefined
    const presences: PresenceUpdate[] = []
    for (const entry of value.presences) {
        if (!record(entry) || (entry.guild_id !== undefined && entry.guild_id !== value.guild_id)) return undefined
        const presence = decodePresenceUpdate({ ...entry, guild_id: value.guild_id })
        if (presence === undefined) return undefined
        presences.push(presence)
    }
    return Object.freeze({ guildId: value.guild_id, presences: Object.freeze(presences) })
}

const clock: PresenceTimer = {
    now: () => performance.now(),
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (handle) => clearTimeout(handle as number),
}

function customStatus(value: unknown): FrozenCustomStatus | InputValidationFailure {
    if (!record(value)) return inputValidationFailure("customStatus", "type", "Must be an object when supplied")
    if (Object.keys(value).some((key) => key !== "text" && key !== "emoji" && key !== "expiresAt"))
        return inputValidationFailure("customStatus", "allowedFields", "Only text, emoji, and expiresAt are accepted")
    const text = value.text
    if (text !== undefined && typeof text !== "string")
        return inputValidationFailure("customStatus.text", "type", "Must be a string when supplied")
    if (typeof text === "string" && (text.length < 1 || text.length > 128))
        return inputValidationFailure(
            "customStatus.text",
            "length",
            "Must contain from 1 through 128 UTF-16 code units",
        )
    if (typeof text === "string" && !text.isWellFormed())
        return inputValidationFailure("customStatus.text", "format", "Must be a well-formed Unicode string")
    const emoji = value.emoji
    const frozenEmoji = emoji === undefined ? undefined : customStatusEmoji(emoji)
    if (frozenEmoji instanceof InputValidationFailure) return frozenEmoji
    const expiresAt = value.expiresAt
    if (expiresAt !== undefined && typeof expiresAt !== "string")
        return inputValidationFailure("customStatus.expiresAt", "type", "Must be an ISO-8601 timestamp when supplied")
    if (typeof expiresAt === "string" && (!iso8601(expiresAt) || !Number.isFinite(Date.parse(expiresAt))))
        return inputValidationFailure("customStatus.expiresAt", "format", "Must be a valid ISO-8601 timestamp")
    if (typeof expiresAt === "string" && Date.parse(expiresAt) <= Date.now())
        return inputValidationFailure("customStatus.expiresAt", "range", "Must be a future timestamp")
    return Object.freeze({
        ...(text === undefined ? {} : { text }),
        ...(frozenEmoji === undefined ? {} : { emoji: frozenEmoji }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
    })
}

function customStatusEmoji(value: unknown): Readonly<CustomStatusEmoji> | InputValidationFailure {
    if (!record(value)) return inputValidationFailure("customStatus.emoji", "type", "Must be an emoji object")
    if (Object.keys(value).length !== 1)
        return inputValidationFailure(
            "customStatus.emoji",
            "allowedFields",
            "Must provide exactly one field named id or name",
        )
    if (Object.hasOwn(value, "id")) {
        if (typeof value.id !== "string")
            return inputValidationFailure("customStatus.emoji.id", "type", "Must be a decimal ID string")
        return identifier(value.id)
            ? Object.freeze({ id: value.id })
            : inputValidationFailure("customStatus.emoji.id", "format", "Must be a canonical decimal ID string")
    }
    if (Object.hasOwn(value, "name")) {
        if (typeof value.name !== "string")
            return inputValidationFailure("customStatus.emoji.name", "type", "Must be a Unicode emoji string")
        if (value.name.length < 1 || value.name.length > 32)
            return inputValidationFailure(
                "customStatus.emoji.name",
                "length",
                "Must contain from 1 through 32 UTF-16 code units",
            )
        return value.name.isWellFormed()
            ? Object.freeze({ name: value.name })
            : inputValidationFailure("customStatus.emoji.name", "format", "Must be a well-formed Unicode string")
    }
    return inputValidationFailure(
        "customStatus.emoji",
        "allowedFields",
        "Must provide exactly one field named id or name",
    )
}

function iso8601(value: string) {
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
}

/** Returns an independent immutable snapshot, so later caller mutation cannot alter an accepted presence intent */
export function validatePresenceInput(value: unknown): FrozenPresence | undefined {
    const validated = presenceInput(value)
    return validated instanceof InputValidationFailure ? undefined : validated
}

function presenceInput(value: unknown): FrozenPresence | InputValidationFailure {
    if (!record(value)) return inputValidationFailure("input", "type", "Must be a presence input object")
    if (Object.keys(value).some((key) => key !== "status" && key !== "customStatus"))
        return inputValidationFailure("input", "allowedFields", "Only status and customStatus are accepted")
    if (typeof value.status !== "string")
        return inputValidationFailure("status", "type", "Must be one of online, idle, dnd, or invisible")
    if (!statuses.has(value.status as PresenceStatus))
        return inputValidationFailure("status", "allowedValue", "Must be one of online, idle, dnd, or invisible")
    const status = value.status as PresenceStatus
    if (!Object.hasOwn(value, "customStatus")) return Object.freeze({ status })
    if (value.customStatus === null) return Object.freeze({ status, customStatus: null })
    const frozenCustomStatus = customStatus(value.customStatus)
    return frozenCustomStatus instanceof InputValidationFailure
        ? frozenCustomStatus
        : Object.freeze({ status, customStatus: frozenCustomStatus })
}

export function presenceUpdate(value: FrozenPresence): GatewayPresenceUpdate {
    const customStatus = value.customStatus
    return Object.freeze({
        status: value.status,
        afk: false,
        mobile: false,
        ...(customStatus === undefined
            ? {}
            : {
                  custom_status:
                      customStatus === null
                          ? null
                          : Object.freeze({
                                ...(customStatus.text === undefined ? {} : { text: customStatus.text }),
                                ...(customStatus.expiresAt === undefined ? {} : { expires_at: customStatus.expiresAt }),
                                ...(customStatus.emoji === undefined
                                    ? {}
                                    : "id" in customStatus.emoji
                                      ? { emoji_id: customStatus.emoji.id }
                                      : { emoji_name: customStatus.emoji.name }),
                            }),
              }),
    })
}

function memberSubscriptions(guildId: string, members: readonly string[]): GatewayPresenceMemberSubscriptions {
    return Object.freeze({
        subscriptions: Object.freeze({
            [guildId]: Object.freeze({ members }),
        }),
    })
}

function frozenMemberIds(value: unknown): readonly string[] | InputValidationFailure {
    if (!Array.isArray(value))
        return inputValidationFailure("memberIds", "type", "Must be an array of decimal member IDs")
    if (!Array.from(value).every(identifier))
        return inputValidationFailure("memberIds", "format", "Each ID must be a canonical decimal string")
    const members = Object.freeze([...value])
    return new Set(members).size === members.length
        ? members
        : inputValidationFailure("memberIds", "unique", "Must not contain duplicate member IDs")
}

function fitsGatewayMemberPayload(guildId: string, members: readonly string[]) {
    return (
        Buffer.byteLength(JSON.stringify({ op: 14, d: memberSubscriptions(guildId, members) })) <=
        maxGatewayPayloadBytes
    )
}

type MemberSelection = { readonly members: readonly string[]; readonly shardId: number }

type PresenceSession = {
    readonly shardId: number
    readonly send: (update: GatewayPresenceUpdate) => void
    readonly sendMemberSubscriptions: ((subscriptions: GatewayPresenceMemberSubscriptions) => void) | undefined
    sentVersion: number
    nextSendAt: number
    timer: unknown
    readonly memberDirty: Set<string>
    nextMemberSendAt: number
    memberTimer: unknown
}

/**
 * Owns one desired bot presence and bounded caller-selected member subscriptions across ready gateway shards.
 * Status and member-write spacing are per ready connection. Member selections and uncertain clears retain their owning shard
 */
export class PresenceOwner implements PresenceGatewayOwner {
    #intent: FrozenPresence | undefined
    #version = 0
    #sessions = new Map<number, PresenceSession>()
    #memberSelections = new Map<string, MemberSelection>()
    #memberCount = 0
    #memberTouched = new Map<string, number>()
    #closed = false

    constructor(
        private readonly timer: PresenceTimer = clock,
        private readonly routeGuild: (guildId: string) => number | undefined = () => 0,
    ) {}

    /** Accept, freeze and coalesce an intent, returning only SDK-authored validation detail for invalid input */
    set(value: unknown): InputValidationFailure | false | undefined {
        if (this.#closed) return false
        const next = presenceInput(value)
        if (next instanceof InputValidationFailure) return next
        this.#intent =
            next.customStatus === undefined && this.#intent?.customStatus !== undefined
                ? Object.freeze({ status: next.status, customStatus: this.#intent.customStatus })
                : next
        this.#version += 1
        for (const session of this.#sessions.values()) this.#schedule(session)
        return undefined
    }

    /**
     * Attaches one ready gateway shard. A replacement detaches only that shard's timers and does not affect other shards.
     * A fresh identify drops its prior clear intents, while a resume retries the latest attempted clear on the owning shard
     */
    attach(
        send: (update: GatewayPresenceUpdate) => void,
        sendMemberSubscriptions?: (subscriptions: GatewayPresenceMemberSubscriptions) => void,
        mode: "identify" | "resume" = "identify",
        shardId = 0,
    ): void {
        if (this.#closed || !validShard(shardId)) return
        this.detach(shardId)
        const session: PresenceSession = {
            shardId,
            send,
            sendMemberSubscriptions,
            sentVersion: 0,
            nextSendAt: 0,
            timer: undefined,
            memberDirty: new Set(),
            nextMemberSendAt: 0,
            memberTimer: undefined,
        }
        this.#sessions.set(shardId, session)
        this.#schedule(session)
        if (mode === "identify") {
            for (const [guildId, ownerShard] of this.#memberTouched)
                if (ownerShard === shardId) this.#memberTouched.delete(guildId)
        }
        for (const [guildId, selection] of this.#memberSelections)
            if (selection.shardId === shardId) session.memberDirty.add(guildId)
        if (mode === "resume")
            for (const [guildId, ownerShard] of this.#memberTouched)
                if (ownerShard === shardId) session.memberDirty.add(guildId)
        this.#scheduleMembers(session)
    }

    /** Detach one shard or all currently attached shards without releasing global presence intent */
    detach(shardId?: number): void {
        if (shardId === undefined) {
            for (const session of [...this.#sessions.values()]) this.#detachSession(session)
            return
        }
        const session = this.#sessions.get(shardId)
        if (session) this.#detachSession(session)
    }

    /** Release retained presence and member-selection intent with outstanding timers during client shutdown */
    close(): void {
        if (this.#closed) return
        this.#closed = true
        this.detach()
        this.#intent = undefined
        this.#memberSelections.clear()
        this.#memberCount = 0
        this.#memberTouched.clear()
    }

    /**
     * Replaces one guild's caller-selected member presence subscriptions. Empty input requests an unsubscribe.
     * A successful return means bounded local acceptance only; provider acceptance and presence delivery remain unknown.
     * Returns only SDK-authored input detail. Limits remain a distinct local policy failure
     */
    setMembers(guildId: unknown, memberIds: unknown): InputValidationFailure | "limit" | false | undefined {
        if (this.#closed) return false
        if (!identifier(guildId))
            return inputValidationFailure("guildId", "format", "Must be a canonical decimal guild ID string")
        if (Array.isArray(memberIds) && memberIds.length > maxMembersPerGuild) return "limit"
        const members = frozenMemberIds(memberIds)
        if (members instanceof InputValidationFailure) return members
        if (!fitsGatewayMemberPayload(guildId, members)) return "limit"
        const routedShard = this.routeGuild(guildId)
        if (!validShard(routedShard))
            return inputValidationFailure("guildId", "relationship", "Must route to a shard assigned to this client")

        const previous = this.#memberSelections.get(guildId)
        if (
            members.length > 0 &&
            this.#memberCount - (previous?.members.length ?? 0) + members.length > maxSelectedMemberIds
        )
            return "limit"
        if (
            members.length > 0 &&
            previous === undefined &&
            !this.#memberTouched.has(guildId) &&
            this.#trackedGuilds() >= maxSelectedGuilds
        )
            return "limit"

        if (members.length === 0) {
            if (previous !== undefined) {
                this.#memberSelections.delete(guildId)
                this.#memberCount -= previous.members.length
            }
            const ownerShard = previous?.shardId ?? this.#memberTouched.get(guildId) ?? routedShard
            if (this.#memberTouched.has(guildId)) this.#markMemberDirty(ownerShard, guildId)
            else this.#sessions.get(ownerShard)?.memberDirty.delete(guildId)
        } else {
            this.#memberSelections.set(guildId, { members, shardId: routedShard })
            this.#memberCount += members.length - (previous?.members.length ?? 0)
            this.#markMemberDirty(routedShard, guildId)
        }
        return undefined
    }

    /** Replays the latest selected or cleared guild intent after its gateway snapshot becomes available without retaining a guild inventory */
    guildCreate(guildId: string): void {
        const shardId = this.#memberSelections.get(guildId)?.shardId ?? this.#memberTouched.get(guildId)
        if (shardId !== undefined) this.#markMemberDirty(shardId, guildId)
    }

    /** Drops intent only after an independently confirmed membership departure */
    forgetMembers(guildId: string): void {
        const selection = this.#memberSelections.get(guildId)
        const touchedShard = this.#memberTouched.get(guildId)
        if (selection !== undefined) {
            this.#memberSelections.delete(guildId)
            this.#memberCount -= selection.members.length
            this.#sessions.get(selection.shardId)?.memberDirty.delete(guildId)
        }
        if (touchedShard !== undefined) {
            this.#memberTouched.delete(guildId)
            this.#sessions.get(touchedShard)?.memberDirty.delete(guildId)
        }
    }

    #detachSession(session: PresenceSession) {
        this.#cancel(session)
        this.#cancelMemberTimer(session)
        if (this.#sessions.get(session.shardId) === session) this.#sessions.delete(session.shardId)
    }

    #schedule(session: PresenceSession) {
        if (
            this.#sessions.get(session.shardId) !== session ||
            !this.#intent ||
            session.sentVersion === this.#version ||
            session.timer !== undefined
        )
            return
        const delay = Math.max(0, session.nextSendAt - this.timer.now())
        session.timer = this.timer.set(() => {
            session.timer = undefined
            this.#flush(session)
        }, delay)
    }

    #flush(session: PresenceSession) {
        const intent = this.#intent
        if (this.#sessions.get(session.shardId) !== session || !intent || session.sentVersion === this.#version) return
        session.send(presenceUpdate(activePresence(intent)))
        session.sentVersion = this.#version
        session.nextSendAt = this.timer.now() + presenceIntervalMs
        this.#schedule(session)
    }

    #cancel(session: PresenceSession) {
        if (session.timer === undefined) return
        this.timer.clear(session.timer)
        session.timer = undefined
    }

    #trackedGuilds() {
        return new Set([...this.#memberSelections.keys(), ...this.#memberTouched.keys()]).size
    }

    #markMemberDirty(shardId: number, guildId: string) {
        const session = this.#sessions.get(shardId)
        if (!session) return
        session.memberDirty.add(guildId)
        this.#scheduleMembers(session)
    }

    #scheduleMembers(session: PresenceSession) {
        if (
            this.#sessions.get(session.shardId) !== session ||
            !session.sendMemberSubscriptions ||
            session.memberDirty.size === 0 ||
            session.memberTimer !== undefined
        )
            return
        const delay = Math.max(0, session.nextMemberSendAt - this.timer.now())
        session.memberTimer = this.timer.set(() => {
            session.memberTimer = undefined
            this.#flushMembers(session)
        }, delay)
    }

    #flushMembers(session: PresenceSession) {
        const guildId = session.memberDirty.values().next().value as string | undefined
        if (
            this.#sessions.get(session.shardId) !== session ||
            !session.sendMemberSubscriptions ||
            guildId === undefined
        )
            return
        session.memberDirty.delete(guildId)
        this.#memberTouched.set(guildId, session.shardId)
        session.sendMemberSubscriptions(
            memberSubscriptions(guildId, this.#memberSelections.get(guildId)?.members ?? []),
        )
        session.nextMemberSendAt = this.timer.now() + memberSelectionIntervalMs
        this.#scheduleMembers(session)
    }

    #cancelMemberTimer(session: PresenceSession) {
        if (session.memberTimer === undefined) return
        this.timer.clear(session.memberTimer)
        session.memberTimer = undefined
    }
}

function validShard(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function activePresence(intent: FrozenPresence): FrozenPresence {
    if (
        intent.customStatus === null ||
        intent.customStatus === undefined ||
        intent.customStatus.expiresAt === undefined
    )
        return intent
    return Date.parse(intent.customStatus.expiresAt) > Date.now() ? intent : Object.freeze({ status: intent.status })
}
