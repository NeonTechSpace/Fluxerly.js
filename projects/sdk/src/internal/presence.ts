/**
 * Presence: The requested bot presence, bounded member presence selections and presence gateway projections.
 * Invariant: The owner keeps callers' requested presence and a bounded member selection, each shard sends its own paced updates,
 * and no roster is retained. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { ObservedPresenceStatus, PresenceUpdate, PresenceUpdateBulk } from "#sdk/events"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import type { CustomStatusEmoji, PresenceInput, PresenceStatus } from "#sdk/presence"
import { gatewayIdentifier, identifier, record, snapshotArray } from "./decode/primitives.js"
import { readCaller } from "./defects.js"
import { validCalendarTimestamp } from "./decode/timestamp.js"
import { Opcode } from "./protocol/gateway.js"
import type { InternalSubmission, QueuedCommand } from "./gateway/commands.js"

type PresenceSend = (update: GatewayPresenceUpdate, settled?: (sent: boolean) => void) => InternalSubmission
type MemberSubscriptionSend = (
    subscriptions: GatewayPresenceMemberSubscriptions,
    settled?: (sent: boolean) => void,
) => InternalSubmission

const statuses = new Set<PresenceStatus>(["online", "idle", "dnd", "invisible"])
const presenceIntervalMs = 4_000
const memberSelectionIntervalMs = 125
const maxSelectedGuilds = 100
const maxSelectedMemberIds = 10_000
const maxMembersPerGuild = 1_000
const maxGatewayPayloadBytes = 4_096

interface FrozenCustomStatus {
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
    attach(send: PresenceSend, sendMemberSubscriptions?: MemberSubscriptionSend, mode?: "identify" | "resume"): void
    detach(): void
    guildCreate(guildId: string): void
}

export interface PresenceTimer {
    readonly now: () => number
    readonly set: (callback: () => void, delay: number) => unknown
    readonly clear: (handle: unknown) => void
}

const knownStatuses: ReadonlySet<string> = new Set(["online", "idle", "dnd", "offline", "invisible"])

/** Map a provider status to the observed-status union, keeping unrecognized values readable as unknown */
function observedStatus(status: string): ObservedPresenceStatus {
    return knownStatuses.has(status) ? (status as ObservedPresenceStatus) : "unknown"
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
        status: observedStatus(value.status),
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
    if (!record(value))
        return inputValidationFailure("customStatus", "type", "Custom status must be an object, or null to clear it")
    const unsupported = unsupportedKeyFailure(
        value,
        ["text", "emoji", "expiresAt"],
        "customStatus",
        "the custom status",
    )
    if (unsupported) return unsupported
    const text = value.text
    if (text !== undefined && typeof text !== "string")
        return inputValidationFailure("customStatus.text", "type", "Custom status text must be a string")
    if (typeof text === "string" && (text.length < 1 || text.length > 128))
        return inputValidationFailure(
            "customStatus.text",
            "length",
            "Custom status text must contain 1 through 128 UTF-16 code units",
        )
    if (typeof text === "string" && !text.isWellFormed())
        return inputValidationFailure(
            "customStatus.text",
            "format",
            "Custom status text must be well-formed Unicode without unpaired surrogates",
        )
    const emoji = value.emoji
    const frozenEmoji = emoji === undefined ? undefined : customStatusEmoji(emoji)
    if (frozenEmoji instanceof InputValidationFailure) return frozenEmoji
    const expiresAt = value.expiresAt
    if (expiresAt !== undefined && typeof expiresAt !== "string")
        return inputValidationFailure(
            "customStatus.expiresAt",
            "type",
            "Custom status expiresAt must be an ISO 8601 timestamp string",
        )
    if (typeof expiresAt === "string" && (!iso8601(expiresAt) || !validCalendarTimestamp(expiresAt)))
        return inputValidationFailure(
            "customStatus.expiresAt",
            "format",
            "Custom status expiresAt must be a valid ISO 8601 timestamp with a Z or ±hh:mm offset",
        )
    if (typeof expiresAt === "string" && Date.parse(expiresAt) <= Date.now())
        return inputValidationFailure(
            "customStatus.expiresAt",
            "range",
            "Custom status expiresAt must be in the future",
        )
    return Object.freeze({
        ...(text === undefined ? {} : { text }),
        ...(frozenEmoji === undefined ? {} : { emoji: frozenEmoji }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
    })
}

function customStatusEmoji(value: unknown): Readonly<CustomStatusEmoji> | InputValidationFailure {
    if (!record(value))
        return inputValidationFailure("customStatus.emoji", "type", "Custom status emoji must be an object")
    if (Object.keys(value).length !== 1)
        return inputValidationFailure(
            "customStatus.emoji",
            "allowedFields",
            "Custom status emoji must contain exactly one of id or name",
        )
    if (Object.hasOwn(value, "id")) {
        const id = value.id
        if (typeof id !== "string")
            return inputValidationFailure(
                "customStatus.emoji.id",
                "type",
                "Custom status emoji IDs must be decimal strings",
            )
        return identifier(id)
            ? Object.freeze({ id })
            : inputValidationFailure(
                  "customStatus.emoji.id",
                  "format",
                  "Custom status emoji IDs must be decimal strings",
              )
    }
    if (Object.hasOwn(value, "name")) {
        const name = value.name
        if (typeof name !== "string")
            return inputValidationFailure(
                "customStatus.emoji.name",
                "type",
                "Custom status emoji name must be a Unicode emoji string",
            )
        if (name.length < 1 || name.length > 32)
            return inputValidationFailure(
                "customStatus.emoji.name",
                "length",
                "Custom status emoji name must contain 1 through 32 UTF-16 code units",
            )
        return name.isWellFormed()
            ? Object.freeze({ name })
            : inputValidationFailure(
                  "customStatus.emoji.name",
                  "format",
                  "Custom status emoji name must be well-formed Unicode without unpaired surrogates",
              )
    }
    return inputValidationFailure(
        "customStatus.emoji",
        "allowedFields",
        "Custom status emoji must contain exactly one of id or name",
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

/**
 * Validate and freeze one presence input, returning SDK-authored detail for invalid input.
 * Each field is read once, so the validated value is the one retained
 */
export function presenceInput(value: unknown): FrozenPresence | InputValidationFailure {
    if (!record(value)) return inputValidationFailure("input", "type", "Presence input must be an object")
    const unsupported = unsupportedKeyFailure(value, ["status", "customStatus"], "input", "the presence input")
    if (unsupported) return unsupported
    const statusInput = value.status
    if (typeof statusInput !== "string")
        return inputValidationFailure("status", "type", "Presence status must be online, idle, dnd, or invisible")
    if (!statuses.has(statusInput as PresenceStatus))
        return inputValidationFailure(
            "status",
            "allowedValue",
            "Presence status must be online, idle, dnd, or invisible",
        )
    const status = statusInput as PresenceStatus
    if (!Object.hasOwn(value, "customStatus")) return Object.freeze({ status })
    const custom = value.customStatus
    if (custom === null) return Object.freeze({ status, customStatus: null })
    const frozenCustomStatus = customStatus(custom)
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

/** Copy caller member IDs once, then validate the copy, so the validated IDs are the ones subscribed */
function frozenMemberIds(value: unknown): readonly string[] | InputValidationFailure | "limit" {
    if (!Array.isArray(value))
        return inputValidationFailure("memberIds", "type", "Member IDs must be an array of decimal strings")
    const members = snapshotArray(value, maxMembersPerGuild)
    if (members === undefined) return "limit"
    if (!members.every(gatewayIdentifier))
        return inputValidationFailure(
            "memberIds",
            "format",
            "Member IDs must be positive canonical decimal strings no greater than 9223372036854775807",
        )
    return new Set(members).size === members.length
        ? (members as readonly string[])
        : inputValidationFailure("memberIds", "unique", "Member IDs must be unique")
}

function fitsGatewayMemberPayload(guildId: string, members: readonly string[]) {
    return (
        Buffer.byteLength(
            JSON.stringify({ op: Opcode.memberSubscriptions, d: memberSubscriptions(guildId, members) }),
        ) <= maxGatewayPayloadBytes
    )
}

type MemberSelection = { readonly members: readonly string[]; readonly shardId: number }

type PresenceSession = {
    readonly shardId: number
    readonly send: PresenceSend
    readonly sendMemberSubscriptions: MemberSubscriptionSend | undefined
    pending: QueuedCommand | undefined
    memberPending: QueuedCommand | undefined
    memberPendingGuild: string | undefined
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
        // Reading the caller input is application code, reported by the calling operation
        const next = readCaller(() => presenceInput(value))
        if (next instanceof InputValidationFailure) return next
        this.#intent =
            next.customStatus === undefined && this.#intent?.customStatus !== undefined
                ? Object.freeze({ status: next.status, customStatus: this.#intent.customStatus })
                : next
        this.#version += 1
        for (const session of this.#sessions.values()) {
            if (session.pending) this.#flush(session)
            else this.#schedule(session)
        }
        return undefined
    }

    /**
     * Attaches one ready gateway shard. A replacement detaches only that shard's timers and does not affect other shards.
     * A fresh identify drops its prior clear intents, while a resume retries the latest attempted clear on the owning shard
     */
    attach(
        send: PresenceSend,
        sendMemberSubscriptions?: MemberSubscriptionSend,
        mode: "identify" | "resume" = "identify",
        shardId = 0,
    ): void {
        if (this.#closed || !validShard(shardId)) return
        this.detach(shardId)
        const session: PresenceSession = {
            shardId,
            send,
            sendMemberSubscriptions,
            pending: undefined,
            memberPending: undefined,
            memberPendingGuild: undefined,
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

    /**
     * The presence a new session's Identify carries: The latest accepted intent with an expired custom status removed,
     * or undefined when there is none. Fluxer may prefer the account's saved status to an Identify presence, so the
     * intent is still published by Presence Update after READY
     */
    identifyPresence(): GatewayPresenceUpdate | undefined {
        return this.#intent === undefined ? undefined : presenceUpdate(activePresence(this.#intent))
    }

    /** Detach one shard or all currently attached shards without releasing global presence intent */
    detach(shardId?: number): void {
        if (shardId === undefined) {
            // oxlint-disable-next-line unicorn/no-useless-spread -- snapshots the sessions that detaching removes from the map
            for (const session of [...this.#sessions.values()]) this.#detachSession(session)
            return
        }
        const session = this.#sessions.get(shardId)
        if (session) this.#detachSession(session)
    }

    /**
     * Move member selections to the shards that route their guilds after an automatic plan moved to a larger one.
     * Every shard then starts a new session, which drops earlier clear intents as a fresh Identify does
     */
    reroute(): void {
        if (this.#closed) return
        this.detach()
        this.#memberTouched.clear()
        for (const [guildId, selection] of this.#memberSelections) {
            const shardId = this.routeGuild(guildId)
            if (validShard(shardId)) this.#memberSelections.set(guildId, { members: selection.members, shardId })
            else {
                this.#memberSelections.delete(guildId)
                this.#memberCount -= selection.members.length
            }
        }
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
     * A successful return means bounded local acceptance only. Provider acceptance and presence delivery remain unknown.
     * Returns only SDK-authored input detail. Limits remain a distinct local policy failure
     */
    setMembers(guildId: unknown, memberIds: unknown): InputValidationFailure | "limit" | false | undefined {
        if (this.#closed) return false
        if (!gatewayIdentifier(guildId))
            return inputValidationFailure(
                "guildId",
                "format",
                "Guild IDs must be positive canonical decimal strings no greater than 9223372036854775807",
            )
        // Reading the caller IDs is application code, reported by the calling operation
        const members = readCaller(() => frozenMemberIds(memberIds))
        if (members === "limit" || members instanceof InputValidationFailure) return members
        if (!fitsGatewayMemberPayload(guildId, members)) return "limit"
        const routedShard = this.routeGuild(guildId)
        if (!validShard(routedShard))
            return inputValidationFailure(
                "guildId",
                "relationship",
                "The community must belong to a shard this client runs",
            )

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
            else {
                const session = this.#sessions.get(ownerShard)
                if (session) this.#withdrawMemberSelection(session, guildId)
                session?.memberDirty.delete(guildId)
                if (session) this.#scheduleMembers(session)
            }
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
            const session = this.#sessions.get(selection.shardId)
            if (session) this.#withdrawMemberSelection(session, guildId)
            session?.memberDirty.delete(guildId)
            if (session) this.#scheduleMembers(session)
        }
        if (touchedShard !== undefined) {
            this.#memberTouched.delete(guildId)
            const session = this.#sessions.get(touchedShard)
            if (session) this.#withdrawMemberSelection(session, guildId)
            session?.memberDirty.delete(guildId)
            if (session) this.#scheduleMembers(session)
        }
    }

    #detachSession(session: PresenceSession) {
        this.#cancel(session)
        this.#cancelMemberTimer(session)
        session.pending?.cancel()
        session.memberPending?.cancel()
        session.pending = undefined
        session.memberPending = undefined
        session.memberPendingGuild = undefined
        if (this.#sessions.get(session.shardId) === session) this.#sessions.delete(session.shardId)
    }

    #schedule(session: PresenceSession) {
        if (
            this.#sessions.get(session.shardId) !== session ||
            !this.#intent ||
            session.sentVersion === this.#version ||
            session.pending !== undefined ||
            session.timer !== undefined
        )
            return
        const delay = Math.max(0, session.nextSendAt - this.timer.now())
        let fired = false
        const timer = this.timer.set(() => {
            fired = true
            session.timer = undefined
            this.#flush(session)
        }, delay)
        // A zero-delay logical timer may run before set returns, so do not retain an already-fired handle
        if (!fired) session.timer = timer
    }

    #flush(session: PresenceSession) {
        const intent = this.#intent
        if (this.#sessions.get(session.shardId) !== session || !intent || session.sentVersion === this.#version) return
        const version = this.#version
        const update = presenceUpdate(activePresence(intent))
        let completed = false
        const settled = (sent: boolean) => {
            completed = true
            session.pending = undefined
            if (!sent || this.#sessions.get(session.shardId) !== session) return
            session.sentVersion = version
            session.nextSendAt = this.timer.now() + presenceIntervalMs
            this.#schedule(session)
        }
        if (session.pending) {
            session.pending.replace(update, settled)
            return
        }
        const submission = session.send(update, settled)
        if (typeof submission === "string") {
            // Preserve intent under queue pressure and retry without creating another queued command
            session.nextSendAt = this.timer.now() + presenceIntervalMs
            this.#schedule(session)
        } else if (!submission) settled(true)
        else if (!completed) session.pending = submission
    }

    #cancel(session: PresenceSession) {
        if (session.timer === undefined) return
        this.timer.clear(session.timer)
        session.timer = undefined
    }

    #trackedGuilds() {
        return new Set([...this.#memberSelections.keys(), ...this.#memberTouched.keys()]).size
    }

    #withdrawMemberSelection(session: PresenceSession, guildId: string) {
        if (session.memberPendingGuild !== guildId) return
        session.memberPending?.cancel()
        session.memberPending = undefined
        session.memberPendingGuild = undefined
    }

    #markMemberDirty(shardId: number, guildId: string) {
        const session = this.#sessions.get(shardId)
        if (!session) return
        this.#withdrawMemberSelection(session, guildId)
        session.memberDirty.add(guildId)
        this.#scheduleMembers(session)
    }

    #scheduleMembers(session: PresenceSession) {
        if (
            this.#sessions.get(session.shardId) !== session ||
            !session.sendMemberSubscriptions ||
            session.memberDirty.size === 0 ||
            session.memberPending !== undefined ||
            session.memberTimer !== undefined
        )
            return
        const delay = Math.max(0, session.nextMemberSendAt - this.timer.now())
        let fired = false
        const timer = this.timer.set(() => {
            fired = true
            session.memberTimer = undefined
            this.#flushMembers(session)
        }, delay)
        if (!fired) session.memberTimer = timer
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
        let completed = false
        const settled = (sent: boolean) => {
            completed = true
            session.memberPending = undefined
            session.memberPendingGuild = undefined
            if (!sent || this.#sessions.get(session.shardId) !== session) return
            this.#memberTouched.set(guildId, session.shardId)
            session.nextMemberSendAt = this.timer.now() + memberSelectionIntervalMs
            this.#scheduleMembers(session)
        }
        const submission = session.sendMemberSubscriptions(
            memberSubscriptions(guildId, this.#memberSelections.get(guildId)?.members ?? []),
            settled,
        )
        if (typeof submission === "string") {
            session.memberDirty.add(guildId)
            session.nextMemberSendAt = this.timer.now() + memberSelectionIntervalMs
            this.#scheduleMembers(session)
        } else if (!submission) settled(true)
        else if (!completed) {
            session.memberPending = submission
            session.memberPendingGuild = guildId
        }
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
