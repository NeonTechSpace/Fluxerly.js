import { expect, test } from "vitest"
import { PresenceOwner, type PresenceTimer } from "../src/internal/presence.js"

function timers() {
    let now = 0
    const scheduled = new Set<{ readonly at: number; readonly callback: () => void }>()
    const timer: PresenceTimer = {
        now: () => now,
        set: (callback, delay) => {
            const entry = { at: now + delay, callback }
            scheduled.add(entry)
            return entry
        },
        clear: (handle) => scheduled.delete(handle as { readonly at: number; readonly callback: () => void }),
    }
    return {
        timer,
        advance(milliseconds: number) {
            now += milliseconds
            for (;;) {
                const due = [...scheduled].filter((entry) => entry.at <= now).sort((left, right) => left.at - right.at)
                if (due.length === 0) return
                for (const entry of due) {
                    scheduled.delete(entry)
                    entry.callback()
                }
            }
        },
    }
}

test("presence shards keep independent status timers and route member selections to their owning ready transport", () => {
    const clock = timers()
    const statusZero: unknown[] = []
    const statusOne: unknown[] = []
    const membersZero: unknown[] = []
    const membersOne: unknown[] = []
    const owner = new PresenceOwner(clock.timer, (guildId) => (guildId === "40" ? 0 : guildId === "50" ? 1 : undefined))

    expect(owner.set({ status: "online" })).toBeUndefined()
    expect(owner.setMembers("40", ["30"])).toBeUndefined()
    expect(owner.setMembers("50", ["31"])).toBeUndefined()
    owner.attach(
        (update) => statusZero.push(update),
        (subscriptions) => membersZero.push(subscriptions),
        "identify",
        0,
    )
    owner.attach(
        (update) => statusOne.push(update),
        (subscriptions) => membersOne.push(subscriptions),
        "identify",
        1,
    )
    clock.advance(0)
    expect(statusZero).toEqual([{ status: "online", afk: false, mobile: false }])
    expect(statusOne).toEqual([{ status: "online", afk: false, mobile: false }])
    expect(membersZero).toEqual([{ subscriptions: { "40": { members: ["30"] } } }])
    expect(membersOne).toEqual([{ subscriptions: { "50": { members: ["31"] } } }])

    expect(owner.set({ status: "idle" })).toBeUndefined()
    clock.advance(3_999)
    expect(statusZero).toHaveLength(1)
    expect(statusOne).toHaveLength(1)
    owner.detach(0)
    clock.advance(1)
    expect(statusZero).toHaveLength(1)
    expect(statusOne).toEqual([
        { status: "online", afk: false, mobile: false },
        { status: "idle", afk: false, mobile: false },
    ])

    owner.attach(
        (update) => statusZero.push(update),
        (subscriptions) => membersZero.push(subscriptions),
        "resume",
        0,
    )
    clock.advance(0)
    expect(statusZero).toEqual([
        { status: "online", afk: false, mobile: false },
        { status: "idle", afk: false, mobile: false },
    ])
    expect(membersZero).toHaveLength(2)
    expect(membersZero.at(-1)).toEqual({ subscriptions: { "40": { members: ["30"] } } })
    expect(membersOne).toHaveLength(1)

    owner.detach()
    expect(owner.set({ status: "dnd" })).toBeUndefined()
    clock.advance(4_000)
    expect(statusZero).toHaveLength(2)
    expect(statusOne).toHaveLength(2)
})

test("a detached shard reconciles its own uncertain clear without cancelling another shard's member timer", () => {
    const clock = timers()
    const membersZero: unknown[] = []
    const membersOne: unknown[] = []
    const owner = new PresenceOwner(clock.timer, (guildId) => (guildId === "40" ? 0 : guildId === "50" ? 1 : undefined))

    expect(owner.setMembers("40", ["30"])).toBeUndefined()
    expect(owner.setMembers("50", ["31"])).toBeUndefined()
    owner.attach(
        () => undefined,
        (subscriptions) => membersZero.push(subscriptions),
        "identify",
        0,
    )
    owner.attach(
        () => undefined,
        (subscriptions) => membersOne.push(subscriptions),
        "identify",
        1,
    )
    clock.advance(0)

    expect(owner.setMembers("50", ["32"])).toBeUndefined()
    owner.detach(0)
    expect(owner.setMembers("40", [])).toBeUndefined()
    clock.advance(125)
    expect(membersZero).toEqual([{ subscriptions: { "40": { members: ["30"] } } }])
    expect(membersOne).toEqual([
        { subscriptions: { "50": { members: ["31"] } } },
        { subscriptions: { "50": { members: ["32"] } } },
    ])

    owner.attach(
        () => undefined,
        (subscriptions) => membersZero.push(subscriptions),
        "resume",
        0,
    )
    clock.advance(0)
    expect(membersZero.at(-1)).toEqual({ subscriptions: { "40": { members: [] } } })
    expect(membersOne).toHaveLength(2)

    owner.guildCreate("40")
    clock.advance(125)
    expect(membersZero.at(-1)).toEqual({ subscriptions: { "40": { members: [] } } })
    expect(membersZero).toHaveLength(3)
})

test("an unowned guild is rejected before it can consume selection capacity or queue a member command", () => {
    const clock = timers()
    const frames: unknown[] = []
    const owner = new PresenceOwner(clock.timer, () => undefined)

    expect(owner.setMembers("40", ["30"])).toMatchObject({ detail: { path: "guildId", constraint: "relationship" } })
    owner.attach(
        () => undefined,
        (subscriptions) => frames.push(subscriptions),
        "identify",
        0,
    )
    clock.advance(0)
    expect(frames).toEqual([])
})

test("clearing a selection before its first flush drops unsent intent without retaining a clear for resume", () => {
    const clock = timers()
    const frames: unknown[] = []
    const owner = new PresenceOwner(clock.timer, () => 1)
    const send = (subscriptions: unknown) => frames.push(subscriptions)
    owner.attach(() => undefined, send, "identify", 1)
    expect(owner.setMembers("40", ["30"])).toBeUndefined()
    expect(owner.setMembers("40", [])).toBeUndefined()
    clock.advance(0)
    expect(frames).toEqual([])
    owner.detach(1)
    owner.attach(() => undefined, send, "resume", 1)
    clock.advance(0)
    expect(frames).toEqual([])
    owner.close()
})
