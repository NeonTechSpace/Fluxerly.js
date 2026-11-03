import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { createPacer, defaultIntervalMs, maximumPauseWaitMs } from "./support/live-pacing.js"
import { pacedDeadlineMs, reservationsPerProcess } from "./support/watchdogs.js"

const liveDirectory = new URL("./", import.meta.url)
const parent = realpathSync(tmpdir())
const roots = []
afterEach(() => {
    for (const root of roots.splice(0)) {
        expect(dirname(root)).toBe(parent)
        rmSync(root, { recursive: true })
    }
})

/** A fixed deadline literal in harness source: a timeout signal, a deadline from the clock, or a timeout option */
const fixedDeadline =
    /AbortSignal\.timeout\(\d[\d_]*\)|performance\.now\(\) \+ \d[\d_]*|Date\.now\(\) \+ \d[\d_]*|[tT]imeoutMs(?::| =) \d[\d_]*|Effect\.timeout\(\d/

/**
 * Every fixed deadline left in the harnesses, by file and source line, with why pacing cannot trip it. Each one either
 * waits only for something the SDK or Fluxer must deliver after the request finished, runs on a controlled clock, or
 * is refused before any paced request. Deadlines that bound paced requests use pacedDeadlineMs instead
 */
const unpacedDeadlines = {
    "administration.js": {
        "const until = Date.now() + 10_000": [
            2,
            "Waits for audit-log and guild-update events after the write finished",
        ],
    },
    "attachment-sources.mjs": {
        "const timeoutMs = 1_000": [1, "Runs on the controlled Effect clock, while the pacer waits in real time"],
    },
    "command-conveniences.js": {
        '() => ops.wait("messageCreate", { ...options, timeoutMs: 50, filter: () => false }),': [
            1,
            "Must time out with no message sent",
        ],
    },
    "consumer-operations.js": {
        "const deadline = performance.now() + 15_000": [2, "Gateway count frames"],
        "const deadline = performance.now() + 45_000": [1, "Gateway recovery"],
        "const connectedDeadline = performance.now() + 35_000": [1, "Starts after connect finished its discovery"],
        "const pending = failure(client.guilds.fetchCounts([guildId], { timeoutMs: 10_000 }))": [
            1,
            "Count requests go over the gateway",
        ],
    },
    "expressions.js": { "const deadline = Date.now() + 10_000": [1, "Emoji and sticker update events"] },
    "guild-events.js": { "const deadline = performance.now() + 15_000": [2, "Gateway events after the awaited reads"] },
    "guild-lifecycle.js": {
        "const sandboxApi = createSandboxApi({ fetch: rawFetch, token: () => token, timeoutMs: 10_000 })": [
            1,
            "A raw helper attempt base, which the helper extends with paced slots",
        ],
        "const deadline = performance.now() + 15_000": [1, "Guild create and delete events and the client state"],
    },
    "invites.js": { "const until = Date.now() + 10_000": [1, "Invite gateway events"] },
    "member-chunks.js": {
        "const waitFor = async (predicate, timeoutMs = 15_000) => {": [1, "Gateway member chunks and state"],
        "let pending = outcome(consume({ userIds: [botId] }, { timeoutMs: 5_000 }))": [
            1,
            "Member requests go over the gateway",
        ],
    },
    "member-search.js": {
        "await value(client.members.search(guildId, searchFilters, { timeoutMs: 5_000 }))": [
            1,
            "Its first attempt fails above the pacer, and its read retry waits at most one slot in this exclusive check",
        ],
        "? client.members.search(guildId, searchFilters, { timeoutMs: 5_000, signal: controller.signal })": [
            1,
            "The wrapped fetch never sends and the call is cancelled",
        ],
        ": Effect.runPromiseExit(client.members.search(guildId, searchFilters, { timeoutMs: 5_000 }), {": [
            1,
            "The wrapped fetch never sends and the call is cancelled",
        ],
    },
    "message-members.js": {
        "const deadline = performance.now() + 20_000": [1, "Gateway and cache events after the awaited message"],
    },
    "messages.js": {
        "const deadline = performance.now() + 45_000": [1, "Gateway session resume"],
        "const sandboxApi = createSandboxApi({ fetch: rawFetch, token: () => token, accept: anyStatus, timeoutMs: 10_000 })":
            [1, "A raw helper attempt base, which the helper extends with paced slots"],
        "const deadline = performance.now() + 10_000": [
            9,
            "Gateway events, cache reads, bulk-delete, pin, member and role events and a local handler start, each after the request finished",
        ],
        "const deadline = performance.now() + 15_000": [
            1,
            "Channel events and cache after each create or edit finished",
        ],
        "const timed = await collect({ timeoutMs: 50 })": [1, "Must time out with no reaction"],
        "const progressDeadline = performance.now() + 10_000": [1, "A local handler flag"],
        "const until = performance.now() + 15_000": [1, "Change events after the raw mutation finished"],
    },
    "recovery-window.js": {
        "const recoveryTimeoutMs = 50_000": [1, "Gateway recovery"],
        "const options = { timeoutMs: 10_000 }": [1, "Member chunks over the gateway"],
    },
    "role-display-reset.js": {
        "const api = createSandboxApi({ fetch: rawFetch, token: () => token, timeoutMs: 10_000 })": [
            1,
            "A raw helper attempt base, which the helper extends with paced slots",
        ],
    },
    "sandbox.js": {
        "const api = createSandboxApi({ fetch, token: () => token, accept: anyStatus, timeoutMs: 10_000 })": [
            1,
            "A raw helper attempt base, which the helper extends with paced slots",
        ],
    },
    "sdk.js": {
        "const deadline = performance.now() + 5000": [1, "The gateway recovering state"],
        "const deadline = performance.now() + 65_000": [1, "Gateway heartbeats"],
        "const rejected = await fail(client.users.fetchSelf({ timeoutMs: 500 }))": [
            1,
            "Answered by the injected 429 above the pacer",
        ],
        "const queued = await fail(client.guilds.fetch(guildId, { timeoutMs: 100 }))": [
            1,
            "Refused unsent during the learned global pause",
        ],
        'const rawQueued = await fail(client.rest.request({ method: "GET", path: `/guilds/${guildId}`, timeoutMs: 100 }))':
            [1, "Refused unsent during the learned global pause"],
    },
    "sharding.js": {
        "const options = { timeoutMs: 10_000 }": [1, "Member chunks over the gateway"],
        "const counted = await value(client.guilds.fetchCounts([guildId], { timeoutMs: 10_000 }))": [
            1,
            "Count requests go over the gateway",
        ],
    },
    "supervisor-child.js": { "signal: AbortSignal.timeout(10_000),": [1, "A loopback proof request, not paced"] },
    "supervisor.js": {
        "const deadline = performance.now() + 5_000": [1, "Child process exit"],
        "startupTimeoutMs: 20_000,": [1, "Child assignment and configuration, which post only loopback proofs"],
        "shutdownTimeoutMs: 20_000,": [1, "Child shutdown sends no request"],
    },
    "support/bucket-learning.js": {
        "const rejected = await fail(client.guilds.fetch(guildId, { timeoutMs: 100 }))": [
            1,
            "Refused unsent while the learned bucket is empty",
        ],
    },
    "support/sandbox-api.js": {
        "async function send(fetch, token, method, path, body, { deadline, timeoutMs = 15_000, wait = sleep } = {}) {":
            [1, "The attempt base, which send extends with paced slots"],
    },
    "typing-interactive.js": {
        "const writeApi = createSandboxApi({ fetch: rawFetch, token: () => token, timeoutMs: 10_000 })": [
            1,
            "A raw helper attempt base, which the helper extends with paced slots",
        ],
        "const readApi = createSandboxApi({ fetch: rawFetch, token: () => token, timeoutMs: 10_000, accept: successOrNotFound })":
            [1, "A raw helper attempt base, which the helper extends with paced slots"],
        "const readinessDeadline = performance.now() + 15_000": [1, "Starts after connect finished its discovery"],
    },
    "users.js": {
        "const until = Date.now() + 15_000": [1, "Gateway frames"],
        "const until = Date.now() + 10_000": [1, "A gateway message event after the readback finished"],
        "const until = Date.now() + 6_000": [1, "Gateway frames"],
    },
    "voice-controls.js": {
        "const deadline = performance.now() + 15_000": [2, "Starts after connect, or waits for gateway voice events"],
    },
    "webhooks.js": { "const until = Date.now() + 10_000": [2, "Webhook update events and a local cache read"] },
}

/** Fixed deadline lines per harness file, counted by their trimmed source text */
function fixedDeadlines() {
    const files = [
        ...readdirSync(liveDirectory).filter((file) => /\.m?js$/.test(file)),
        ...readdirSync(new URL("support/", liveDirectory)).map((file) => `support/${file}`),
    ].filter(
        (file) =>
            file.endsWith("js") &&
            !file.includes(".test.") &&
            !["run-all.js", "support/live-pacing.js", "support/watchdogs.js"].includes(file),
    )
    const found = {}
    for (const file of files)
        for (const line of readFileSync(new URL(file, liveDirectory), "utf8").split("\n")) {
            if (!fixedDeadline.test(line)) continue
            const text = line.trim()
            found[file] ??= {}
            found[file][text] = (found[file][text] ?? 0) + 1
        }
    return found
}

test("every fixed deadline left in the harnesses is explained as not bounding paced requests", () => {
    const expected = Object.fromEntries(
        Object.entries(unpacedDeadlines).map(([file, lines]) => [
            file,
            Object.fromEntries(Object.entries(lines).map(([text, [count]]) => [text, count])),
        ]),
    )
    expect(fixedDeadlines()).toEqual(expected)
})

test.each([1, 2, 4])(
    "a paced deadline outlasts its requests' worst paced slots with %i checks running together",
    async (concurrency) => {
        const root = mkdtempSync(join(parent, "fluxerly-live-deadline-"))
        roots.push(root)
        for (const [baseMs, requests] of [
            [10_000, 1],
            [10_000, 5],
            [15_000, 2],
            [30_000, 16],
            [130_000, 27],
            [220_000, 91],
        ]) {
            let now = 0
            const options = { statePath: join(root, `pace-${baseMs}-${requests}.json`), now: () => now, lockWaitMs: 0 }
            const ours = createPacer({ ...options, sleep: async (milliseconds) => void (now += milliseconds) })
            const others = createPacer({ ...options, sleep: async () => {} })
            // Before each of this sender's requests, every other check holds its full share of reserved slots
            for (let request = 0; request < requests; request++) {
                for (let held = 0; held < (concurrency - 1) * reservationsPerProcess; held++) await others.admit()
                await ours.admit()
            }
            const deadline = pacedDeadlineMs(baseMs, requests, { intervalMs: defaultIntervalMs, concurrency })
            // The work keeps its whole unpaced base time, and one longest pause still fits
            expect(deadline - baseMs - maximumPauseWaitMs, `${baseMs} ms over ${requests}`).toBeGreaterThanOrEqual(now)
        }
    },
)

test("a deadline that starts discovery adds the redirects it may follow", () => {
    expect(pacedDeadlineMs(35_000, 1, { clients: 1, intervalMs: 1_500, concurrency: 1 })).toBe(
        Math.ceil(35_000 + 4 * 1_500 * 1.25 + maximumPauseWaitMs),
    )
})
