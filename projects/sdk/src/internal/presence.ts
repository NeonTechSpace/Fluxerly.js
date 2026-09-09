import type { CustomStatusEmoji, PresenceInput, PresenceStatus } from "#sdk/presence"
import { identifier, record } from "./message.js"

const statuses = new Set<PresenceStatus>(["online", "idle", "dnd", "invisible"])
const presenceIntervalMs = 4_000

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

export interface PresenceGatewayOwner {
    attach(send: (update: GatewayPresenceUpdate) => void): void
    detach(): void
}

export interface PresenceTimer {
    readonly now: () => number
    readonly set: (callback: () => void, delay: number) => unknown
    readonly clear: (handle: unknown) => void
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

/**
 * One client-process presence intent and at most one scheduled write. The latest valid input replaces earlier unsent input.
 * A connection receives an immediate restore, then writes are separated by 4,000 ms to remain within Fluxer's five accepted updates per 20 seconds
 */
export class PresenceOwner implements PresenceGatewayOwner {
    #intent: FrozenPresence | undefined
    #version = 0
    #sentVersion = 0
    #nextSendAt = 0
    #send: ((update: GatewayPresenceUpdate) => void) | undefined
    #timer: unknown
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

    attach(send: (update: GatewayPresenceUpdate) => void): void {
        if (this.#closed) return
        this.#cancel()
        this.#send = send
        this.#sentVersion = 0
        this.#nextSendAt = 0
        this.#schedule()
    }

    detach(): void {
        this.#cancel()
        this.#send = undefined
        this.#nextSendAt = 0
    }

    /** Release the retained requested status and the only outstanding timer during client shutdown */
    close(): void {
        if (this.#closed) return
        this.#closed = true
        this.detach()
        this.#intent = undefined
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
