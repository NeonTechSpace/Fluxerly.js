import type { PresenceUpdate, PresenceUpdateBulk } from "#sdk/events"
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

function customStatus(value: unknown): FrozenCustomStatus | undefined {
    if (!record(value) || Object.keys(value).some((key) => key !== "text" && key !== "emoji" && key !== "expiresAt"))
        return undefined
    const text = value.text
    if (
        text !== undefined &&
        (typeof text !== "string" || text.length < 1 || text.length > 128 || !text.isWellFormed())
    )
        return undefined
    const emoji = value.emoji
    const frozenEmoji = emoji === undefined ? undefined : customStatusEmoji(emoji)
    if (emoji !== undefined && frozenEmoji === undefined) return undefined
    const expiresAt = value.expiresAt
    if (
        expiresAt !== undefined &&
        (typeof expiresAt !== "string" ||
            !iso8601(expiresAt) ||
            !Number.isFinite(Date.parse(expiresAt)) ||
            Date.parse(expiresAt) <= Date.now())
    )
        return undefined
    return Object.freeze({
        ...(text === undefined ? {} : { text }),
        ...(frozenEmoji === undefined ? {} : { emoji: frozenEmoji }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
    })
}

function customStatusEmoji(value: unknown): Readonly<CustomStatusEmoji> | undefined {
    if (!record(value)) return undefined
    if (Object.keys(value).length !== 1) return undefined
    if (Object.hasOwn(value, "id"))
        return typeof value.id === "string" && identifier(value.id) ? Object.freeze({ id: value.id }) : undefined
    if (Object.hasOwn(value, "name"))
        return typeof value.name === "string" &&
            value.name.length >= 1 &&
            value.name.length <= 32 &&
            value.name.isWellFormed()
            ? Object.freeze({ name: value.name })
            : undefined
    return undefined
}

function iso8601(value: string) {
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
}

/** Returns an independent immutable snapshot, so later caller mutation cannot alter an accepted presence intent */
export function validatePresenceInput(value: unknown): FrozenPresence | undefined {
    if (!record(value) || Object.keys(value).some((key) => key !== "status" && key !== "customStatus")) return undefined
    if (typeof value.status !== "string" || !statuses.has(value.status as PresenceStatus)) return undefined
    const status = value.status as PresenceStatus
    if (!Object.hasOwn(value, "customStatus")) return Object.freeze({ status })
    if (value.customStatus === null) return Object.freeze({ status, customStatus: null })
    const frozenCustomStatus = customStatus(value.customStatus)
    return frozenCustomStatus === undefined ? undefined : Object.freeze({ status, customStatus: frozenCustomStatus })
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

function frozenMemberIds(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value) || value.length > maxMembersPerGuild || !value.every(identifier)) return undefined
    const members = Object.freeze([...value])
    return new Set(members).size === members.length ? members : undefined
}

function fitsGatewayMemberPayload(guildId: string, members: readonly string[]) {
    return (
        Buffer.byteLength(JSON.stringify({ op: 14, d: memberSubscriptions(guildId, members) })) <=
        maxGatewayPayloadBytes
    )
}

/**
 * Owns outgoing bot status and bounded caller-selected member subscriptions, each with one coalescing timer.
 * Outgoing status writes are separated by 4,000 ms per connection; member replacement frames by 125 ms.
 * Touched guild IDs survive resumable gaps so an uncertain empty clear can be retried without retaining member snapshots
 */
export class PresenceOwner implements PresenceGatewayOwner {
    #intent: FrozenPresence | undefined
    #version = 0
    #sentVersion = 0
    #nextSendAt = 0
    #send: ((update: GatewayPresenceUpdate) => void) | undefined
    #timer: unknown
    #memberSelections = new Map<string, readonly string[]>()
    #memberCount = 0
    #memberTouched = new Set<string>()
    #memberDirty = new Set<string>()
    #sendMemberSubscriptions: ((subscriptions: GatewayPresenceMemberSubscriptions) => void) | undefined
    #memberTimer: unknown
    #nextMemberSendAt = 0
    #closed = false

    constructor(private readonly timer: PresenceTimer = clock) {}

    /** Accept, freeze and coalesce a valid local intent. False means invalid input or permanent owner closure */
    set(value: unknown): boolean {
        if (this.#closed) return false
        const next = validatePresenceInput(value)
        if (next === undefined) return false
        this.#intent =
            next.customStatus === undefined && this.#intent?.customStatus !== undefined
                ? Object.freeze({ status: next.status, customStatus: this.#intent.customStatus })
                : next
        this.#version += 1
        this.#schedule()
        return true
    }

    /**
     * Attaches one ready gateway session. A fresh identify has no retained provider subscriptions; a resumed session
     * conservatively replays previously attempted empty clears because local socket completion is not a provider acknowledgement
     */
    attach(
        send: (update: GatewayPresenceUpdate) => void,
        sendMemberSubscriptions?: (subscriptions: GatewayPresenceMemberSubscriptions) => void,
        mode: "identify" | "resume" = "identify",
    ): void {
        if (this.#closed) return
        this.#cancel()
        this.#cancelMemberTimer()
        this.#send = send
        this.#sentVersion = 0
        this.#nextSendAt = 0
        this.#schedule()
        this.#sendMemberSubscriptions = sendMemberSubscriptions
        this.#nextMemberSendAt = 0
        if (mode === "identify") this.#memberTouched.clear()
        this.#memberDirty.clear()
        for (const guildId of this.#memberSelections.keys()) this.#memberDirty.add(guildId)
        if (mode === "resume") for (const guildId of this.#memberTouched) this.#memberDirty.add(guildId)
        this.#scheduleMembers()
    }

    detach(): void {
        this.#cancel()
        this.#cancelMemberTimer()
        this.#send = undefined
        this.#sendMemberSubscriptions = undefined
        this.#nextSendAt = 0
        this.#nextMemberSendAt = 0
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
        this.#memberDirty.clear()
    }

    /**
     * Replaces one guild's caller-selected member presence subscriptions. Empty input requests an unsubscribe.
     * A successful return means bounded local acceptance only; provider acceptance and presence delivery remain unknown
     */
    setMembers(guildId: unknown, memberIds: unknown): "input" | "limit" | undefined {
        if (this.#closed || !identifier(guildId)) return "input"
        const members = frozenMemberIds(memberIds)
        if (members === undefined)
            return Array.isArray(memberIds) && memberIds.length > maxMembersPerGuild ? "limit" : "input"
        if (!fitsGatewayMemberPayload(guildId, members)) return "limit"

        const previous = this.#memberSelections.get(guildId)
        if (members.length > 0 && this.#memberCount - (previous?.length ?? 0) + members.length > maxSelectedMemberIds)
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
                this.#memberCount -= previous.length
            }
            if (this.#memberTouched.has(guildId)) this.#memberDirty.add(guildId)
            else this.#memberDirty.delete(guildId)
        } else {
            this.#memberSelections.set(guildId, members)
            this.#memberCount += members.length - (previous?.length ?? 0)
            this.#memberDirty.add(guildId)
        }
        this.#scheduleMembers()
        return undefined
    }

    /** Replays the latest selected or cleared guild intent after its gateway snapshot becomes available without retaining a guild inventory */
    guildCreate(guildId: string): void {
        if (!this.#memberSelections.has(guildId) && !this.#memberTouched.has(guildId)) return
        this.#memberDirty.add(guildId)
        this.#scheduleMembers()
    }

    /** Drops intent only after an independently confirmed membership departure */
    forgetMembers(guildId: string): void {
        const previous = this.#memberSelections.get(guildId)
        if (previous !== undefined) {
            this.#memberSelections.delete(guildId)
            this.#memberCount -= previous.length
        }
        this.#memberTouched.delete(guildId)
        this.#memberDirty.delete(guildId)
    }

    #schedule() {
        if (!this.#send || !this.#intent || this.#sentVersion === this.#version || this.#timer !== undefined) return
        const delay = Math.max(0, this.#nextSendAt - this.timer.now())
        this.#timer = this.timer.set(() => {
            this.#timer = undefined
            this.#flush()
        }, delay)
    }

    #flush() {
        const send = this.#send
        const intent = this.#intent
        if (!send || !intent || this.#sentVersion === this.#version) return
        const version = this.#version
        send(presenceUpdate(activePresence(intent)))
        this.#sentVersion = version
        this.#nextSendAt = this.timer.now() + presenceIntervalMs
        this.#schedule()
    }

    #cancel() {
        if (this.#timer === undefined) return
        this.timer.clear(this.#timer)
        this.#timer = undefined
    }

    #trackedGuilds() {
        return new Set([...this.#memberSelections.keys(), ...this.#memberTouched]).size
    }

    #scheduleMembers() {
        if (!this.#sendMemberSubscriptions || this.#memberDirty.size === 0 || this.#memberTimer !== undefined) return
        const delay = Math.max(0, this.#nextMemberSendAt - this.timer.now())
        this.#memberTimer = this.timer.set(() => {
            this.#memberTimer = undefined
            this.#flushMembers()
        }, delay)
    }

    #flushMembers() {
        const send = this.#sendMemberSubscriptions
        const guildId = this.#memberDirty.values().next().value as string | undefined
        if (!send || guildId === undefined) return
        this.#memberDirty.delete(guildId)
        this.#memberTouched.add(guildId)
        send(memberSubscriptions(guildId, this.#memberSelections.get(guildId) ?? []))
        this.#nextMemberSendAt = this.timer.now() + memberSelectionIntervalMs
        this.#scheduleMembers()
    }

    #cancelMemberTimer() {
        if (this.#memberTimer === undefined) return
        this.timer.clear(this.#memberTimer)
        this.#memberTimer = undefined
    }
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
