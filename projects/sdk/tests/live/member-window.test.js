import { expect, test } from "vitest"
import { createWindowGuard, inconclusiveMessage } from "./support/member-window.js"

// A new session sends the guild again with the bot's member, which refills the cache without any message intake

const guild = "100"
const guard = () => createWindowGuard(guild)

test("a window with no guild snapshot and no new session stays conclusive", () => {
    const window = guard()
    window.guildCreate(guild)
    window.open([3])
    expect(() => window.check([3])).not.toThrow()
})

test("the startup snapshot is awaited before the window opens, and then does not count", () => {
    const window = guard()
    expect(window.started).toBe(false)
    window.guildCreate("200")
    expect(window.started).toBe(false)
    window.guildCreate(guild)
    expect(window.started).toBe(true)
    window.open([3])
    expect(() => window.check([3])).not.toThrow()
})

test("a snapshot of the sandbox guild inside the window makes the run inconclusive", () => {
    const window = guard()
    window.open([3])
    window.guildCreate(guild)
    expect(() => window.check([3])).toThrow(inconclusiveMessage)
})

test("a snapshot of another guild inside the window is not this check's concern", () => {
    const window = guard()
    window.open([3])
    window.guildCreate("200")
    expect(() => window.check([3])).not.toThrow()
})

test("a guild cache store for the sandbox guild inside the window counts as a snapshot", () => {
    const stored = guard()
    stored.open([3])
    stored.change({ kind: "guilds", op: "set", key: guild })
    expect(() => stored.check([3])).toThrow(inconclusiveMessage)
    // Only a store refills the cache, so removals and other guilds or categories do not count
    const window = guard()
    window.open([3])
    window.change({ kind: "guilds", op: "set", key: "200" })
    window.change({ kind: "members", op: "set", key: `${guild}:5` })
    window.change({ kind: "guilds", op: "delete", key: guild })
    window.change({ kind: "guilds", op: "clear", key: null })
    expect(() => window.check([3])).not.toThrow()
    // A store before the window opened is the startup one
    const early = guard()
    early.change({ kind: "guilds", op: "set", key: guild })
    early.open([3])
    expect(() => early.check([3])).not.toThrow()
})

test("a new session inside the window makes the run inconclusive, even without a snapshot yet", () => {
    const window = guard()
    window.open([3, 0])
    expect(() => window.check([4, 0])).toThrow(inconclusiveMessage)
    expect(() => window.check([3, 1])).toThrow(inconclusiveMessage)
    expect(() => window.check([3])).toThrow(inconclusiveMessage)
})

test("a snapshot after the window closed does not count", () => {
    const window = guard()
    window.open([3])
    window.close()
    window.guildCreate(guild)
    window.change({ kind: "guilds", op: "set", key: guild })
    expect(() => window.check([3])).not.toThrow()
})
