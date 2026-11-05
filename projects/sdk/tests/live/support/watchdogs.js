// Process watchdogs and request-bounded deadlines of the live harnesses, sized from the shared pacer in live-pacing.js. A watchdog is a hang guard,
// so it is sized from the work's own limits: The base time the harness had before pacing, which covers its event
// waits, sleeps and network latency, plus every HTTP request the scenario can start, each waiting for its paced slot.
// Request counts are upper bounds read from the harness source, from process start through cleanup, including
// identity reads, discovery, polls at their maximum attempts and a repeated cleanup, as noted for each entry.
// run-all.js stops a harness process only after its watchdog, so pacing can trip neither
import { maximumPauseWaitMs, paceIntervalMs } from "./live-pacing.js"

/** Extra share of the paced time, for requests a count may have missed */
export const pacingMargin = 1.25
/**
 * Requests another live process can hold reserved ahead of this one at a time: four SDK REST slots for one shard and
 * one raw helper request. Checks that run together interleave their requests in the shared pacer
 */
export const reservationsPerProcess = 5
/** Bootstrap redirects a discovery may follow, each one more request, as maximumBootstrapRedirects in the SDK */
export const discoveryRedirects = 3
/** Time run-all.js gives a harness after its own watchdog, so the harness reports its timeout itself */
export const runnerMarginMs = 60_000
/** Longest single timer delay */
const maximumTimerMs = 2_147_483_647

/**
 * Base time, request upper bound and SDK client count of each harness scenario that has a process watchdog, keyed like
 * check-classes.js: The harness file, then its scenario arguments without the mode, sorted and joined with spaces.
 * Each client's discovery may follow redirects, which pacedWatchdogMs adds on top of the count
 */
export const harnessWatchdogs = Object.freeze({
    // 3 identity, 1 discovery, 1 channel, 8 scenario requests and 5 cleanup, plus 5 for a repeated cleanup
    "gateway-capture.js": {
        "": { baseMs: 220_000, requests: 23, clients: 1 },
        "--write": { baseMs: 220_000, requests: 23, clients: 1 },
    },
    // 3 identity, and per client 1 discovery and 1 self read for the cancellation and simple runs
    "bot-runner.js": { "": { baseMs: 120_000, requests: 7, clients: 2 } },
    // 3 identity, 1 channel, 1 discovery, 2 raw reads and writes, and 5 cleanup plus 5 when it repeats
    "message-members.js": { "": { baseMs: 120_000, requests: 17, clients: 1 } },
    // 3 identity, 1 channel, 1 discovery, 26 scenario requests with uploads as plan, two PUTs and the send, and 5
    // cleanup plus 5 when it repeats
    "consumer-features.js": { "": { baseMs: 180_000, requests: 41, clients: 1 } },
    // 3 identity, 1 discovery, a self and a role-list read, and with --voice a raw and an SDK member read
    "guild-events.js": {
        "": { baseMs: 60_000, requests: 6, clients: 1 },
        "--voice": { baseMs: 60_000, requests: 8, clients: 1 },
    },
    // 3 identity and 1 discovery in every variant. --instance runs its own discovery of up to 4 reads, and
    // --rate-limits makes 3 reads and 4 bucket-learning reads. The injected 429 sends nothing
    "sdk.js": {
        "": { baseMs: 120_000, requests: 5, clients: 1 },
        "--application": { baseMs: 120_000, requests: 6, clients: 1 },
        "--cancel-recovery": { baseMs: 120_000, requests: 4, clients: 1 },
        "--diagnostics": { baseMs: 120_000, requests: 7, clients: 1 },
        "--instance": { baseMs: 120_000, requests: 9, clients: 1 },
        "--quality": { baseMs: 120_000, requests: 8, clients: 1 },
        "--rate-limits": { baseMs: 120_000, requests: 11, clients: 1 },
    },
    // 3 identity, 3 setup, 2 banner reads, 21 attachment requests counting a multipart completion for each send,
    // 17 role requests and up to 13 cleanup requests when the bot's roles drifted
    "consumer-operations.js": { "": { baseMs: 240_000, requests: 59, clients: 1 } },
    // 3 identity, 1 bot member, 1 discovery and a self read per cycle. --session-restart uses two clients
    "recovery-window.js": {
        "": { baseMs: 240_000, requests: 8, clients: 1 },
        "--session-restart": { baseMs: 120_000, requests: 6, clients: 2 },
    },
    // 3 identity, 1 bot member, 1 member list and 1 discovery. Member chunk requests go over the gateway
    "member-chunks.js": { "": { baseMs: 240_000, requests: 6, clients: 1 } },
    // 3 identity and 1 bot member in the parent, and a discovery and self read in each of two children. A failing
    // child may restart up to 3 times, each with another discovery and self read
    "supervisor.js": { "": { baseMs: 120_000, requests: 20, clients: 8 } },
    // 3 identity, 1 bot member and a discovery for each of two clients
    "sharding.js": { "": { baseMs: 120_000, requests: 6, clients: 2 } },
    // 3 identity, 1 discovery, three channels, follows, publishing, edits, unfollows and 13 cleanup, plus a follower a
    // failed run left
    "announcements.js": { "": { baseMs: 300_000, requests: 48, clients: 1 } },
    // 3 identity, 1 discovery, edits and reads, up to 8 audit pages, 3 history pages and 3 cleanup
    "administration.js": { "": { baseMs: 180_000, requests: 30, clients: 1 } },
    // 3 identity, 1 discovery, the channel, 20 invite requests and 10 cleanup, plus invites a failed run left
    "invites.js": { "": { baseMs: 180_000, requests: 32, clients: 1 } },
    // 3 identity, 2 discoveries, 15 requests per expression kind, the webhook section and 14 cleanup
    "expressions.js": { "": { baseMs: 240_000, requests: 59, clients: 2 } },
    // 3 identity, 2 discoveries, the webhook, message, edit, delete and lost-send sections, a CDN read and 7 cleanup,
    // plus a webhook a failed run left, and the empty-body forwards of 3 requests for each API
    "webhooks.js": { "": { baseMs: 180_000, requests: 58, clients: 2 } },
    // 3 identity, 1 discovery, a feature read, 4 requests for each of 5 edits and 3 cleanup
    "guild-feature-toggles.js": { "": { baseMs: 180_000, requests: 28, clients: 1 } },
    // 3 identity, 1 discovery, and up to 20 raw membership pages and 20 SDK pages for a bot in up to 4,000 servers.
    // Leaving adds 2 reads, one DELETE and up to 2 pages
    "guild-lifecycle.js": {
        "": { baseMs: 90_000, requests: 45, clients: 1 },
        "--leave": { baseMs: 90_000, requests: 50, clients: 1 },
        "--leave --lose-response": { baseMs: 90_000, requests: 50, clients: 1 },
    },
    // 3 identity, 1 discovery, a role POST and lost PATCH with up to 3 attempts each, a roles read and 3 cleanup
    "text-validation.js": { "": { baseMs: 180_000, requests: 14, clients: 1 } },
    // 3 identity, the channel, 1 discovery, up to 2 reads the gateway connection makes, 5 typed calls and 4 cleanup,
    // plus 4 when cleanup repeats
    "typed-raw.js": { "": { baseMs: 120_000, requests: 19, clients: 1 } },
    // 3 identity, 1 discovery and the instance reads with their real retries. --mutate adds edits and 4 cleanup
    "discovery.js": {
        "": { baseMs: 120_000, requests: 13, clients: 1 },
        "--mutate": { baseMs: 120_000, requests: 26, clients: 1 },
    },
    // 3 identity, 1 discovery and the vanity state reads. --mutate adds two codes, their removal and 5 cleanup
    "vanity-url.js": {
        "": { baseMs: 120_000, requests: 11, clients: 1 },
        "--mutate": { baseMs: 120_000, requests: 36, clients: 1 },
    },
    // 5 identity, 1 discovery, permission and channel reads, and search polls while the provider keeps indexing
    "member-search.js": { "": { baseMs: 90_000, requests: 60, clients: 1 } },
    // 3 identity, 1 member, profile, direct message, group and lost-send sections with up to 5 scan pages, and
    // cleanup. Without a group direct message 51, and --latest-only 18
    "users.js": {
        "": { baseMs: 180_000, requests: 65, clients: 1 },
        "--latest-only": { baseMs: 180_000, requests: 18, clients: 1 },
        "--without-group": { baseMs: 180_000, requests: 51, clients: 1 },
    },
    // 4 identity and 1 discovery. Presence changes go over the gateway
    "presence.js": { "": { baseMs: 480_000, requests: 5, clients: 1 } },
    // 3 identity, the target, a preflight, discovery and read, the lost PATCH and restore with reads, and 3 cleanup
    "members.js": { "": { baseMs: 90_000, requests: 14, clients: 1 } },
    // 3 identity, roles, 2 creates, discovery, 6 requests for each of 2 roles, 6 cleanup and a final roles read
    "role-display-reset.js": { "": { baseMs: 120_000, requests: 26, clients: 1 } },
    // 4 identity, the channel, per mode a discovery and up to 25 typing requests, and 5 cleanup
    "typing-interactive.js": { "": { baseMs: 480_000, requests: 62, clients: 2 } },
    // 4 identity, discovery, preflight, up to 8 mutations of 5 requests, moves, disconnect, rejoin and restore. A
    // fresh client reads the state after each change
    "voice-controls.js": {
        "": { baseMs: 330_000, requests: 80, clients: 3 },
        "--flags-only": { baseMs: 330_000, requests: 57, clients: 2 },
        "--no-move": { baseMs: 330_000, requests: 66, clients: 3 },
    },
    // The operation and cleanup deadlines of these four harnesses are sized with pacedDeadlineMs from the same
    // counts. Each watchdog adds both bases, both counts and room for two more pauses, so it outlasts their sum
    "threads.js": { "": { baseMs: 220_000 + 90_000 + 20_000, requests: 91 + 34, clients: 2 } },
    "voice-notes.js": { "": { baseMs: 90_000 + 90_000 + 20_000, requests: 30 + 18, clients: 2 } },
    "own-history.js": {
        "": { baseMs: 150_000 + 30_000 + 20_000, requests: 58 + 18, clients: 1 },
        "--guild": { baseMs: 150_000 + 30_000 + 20_000, requests: 58 + 18, clients: 1 },
    },
    "command-conveniences.js": Object.fromEntries(
        ["arguments", "fields", "groups", "help", "waits"].map((feature) => [
            feature,
            { baseMs: 150_000 + 30_000 + 20_000, requests: 28 + 5, clients: 1 },
        ]),
    ),
    // Every scenario has up to 14 common requests: 3 identity, the main channel, 1 discovery, a ping and its reply, two
    // readbacks and up to 5 main-channel cleanup requests. Audit lookups count at 8 reads each, uploads with a multipart
    // completion and parts of at least 5 MiB, and time-bound polls at one paced read per slot. --cleanup sends 104
    // messages before its previews, and --channels and --guilds wait for 13 and 9 audit entries
    "messages.js": {
        "": { baseMs: 120_000, requests: 19, clients: 1 },
        "--recover": { baseMs: 120_000, requests: 14, clients: 1 },
        "--manage": { baseMs: 120_000, requests: 27, clients: 1 },
        "--events": { baseMs: 120_000, requests: 24, clients: 1 },
        // Two between-cursor pages of 2 requests each, and the stored embed read of up to 7 requests
        "--history": { baseMs: 120_000, requests: 46, clients: 1 },
        "--pagination": { baseMs: 120_000, requests: 44, clients: 1 },
        "--cache": { baseMs: 120_000, requests: 74, clients: 1 },
        "--collectors": { baseMs: 120_000, requests: 35, clients: 1 },
        // The existing attachment edit: an upload of up to 4 requests, the edit and its readback, and the URL host and
        // padded ID checks of 3 requests
        "--embeds": { baseMs: 120_000, requests: 36, clients: 1 },
        "--attachments": { baseMs: 240_000, requests: 45, clients: 1 },
        "--attachments-small": { baseMs: 240_000, requests: 36, clients: 1 },
        "--attachment-sources": { baseMs: 240_000, requests: 68, clients: 1 },
        "--reactions": { baseMs: 120_000, requests: 162, clients: 1 },
        "--pins": { baseMs: 120_000, requests: 40, clients: 1 },
        "--guilds": { baseMs: 120_000, requests: 150, clients: 1 },
        "--channels": { baseMs: 120_000, requests: 180, clients: 1 },
        "--batch-delete": { baseMs: 120_000, requests: 29, clients: 1 },
        "--cleanup": { baseMs: 120_000, requests: 142, clients: 1 },
        "--moderation": { baseMs: 240_000, requests: 72, clients: 1 },
        "--search": { baseMs: 240_000, requests: 32, clients: 1 },
        "--optional-tools": { baseMs: 120_000, requests: 29, clients: 1 },
        "--nonce-only": { baseMs: 120_000, requests: 25, clients: 1 },
        "--typing": { baseMs: 60_000, requests: 19, clients: 1 },
    },
})

/** How many times longer a paced request can wait when `concurrency` checks share the pacer */
export function contentionFactor(concurrency = 1) {
    return 1 + Math.max(0, concurrency - 1) * reservationsPerProcess
}

/**
 * A watchdog for `entry`: its base time, plus each request's paced slot, counting possible discovery redirects, under
 * the given concurrency with the margin, plus one longest pause a sender waits out before it stops
 */
export function pacedWatchdogMs(entry, { intervalMs = paceIntervalMs(), concurrency = 1 } = {}) {
    const requests = entry.requests + entry.clients * discoveryRedirects
    const paced = requests * intervalMs * contentionFactor(concurrency) * pacingMargin
    return Math.min(maximumTimerMs, Math.ceil(entry.baseMs + paced + maximumPauseWaitMs))
}

/**
 * A deadline whose span starts `requests` paced HTTP requests, sized like a watchdog: `baseMs`, the time the work had
 * before pacing, plus each request's paced slot under this run's concurrency with the margin, plus one longest pause.
 * `clients` counts SDK clients whose discovery starts inside the span and may follow redirects. Deadlines that measure
 * the SDK itself, such as a wait for an event the SDK must deliver in time, keep their own fixed value instead
 */
export function pacedDeadlineMs(baseMs, requests, { clients = 0, intervalMs, concurrency = liveConcurrency() } = {}) {
    return pacedWatchdogMs(
        { baseMs, requests, clients },
        intervalMs === undefined ? { concurrency } : { intervalMs, concurrency },
    )
}

/** The watchdog entry of a harness scenario, or undefined for a harness without a process watchdog */
export function watchdogEntry(harness, args) {
    const file = harness.replace(/\.mjs$/, ".js")
    const scenario = args
        .filter((argument) => argument !== "default" && argument !== "effect")
        .sort()
        .join(" ")
    const scenarios = Object.hasOwn(harnessWatchdogs, file) ? harnessWatchdogs[file] : undefined
    return scenarios && Object.hasOwn(scenarios, scenario) ? scenarios[scenario] : undefined
}

/** Concurrent checks of this live run, which run-all.js passes to each harness process */
export function liveConcurrency(env = process.env) {
    const concurrency = Number(env.FLUXERLY_LIVE_CONCURRENCY)
    return Number.isSafeInteger(concurrency) && concurrency >= 1 ? concurrency : 1
}

/**
 * The process watchdog of the running harness scenario, found from the process arguments like its lock declaration.
 * It fails for an undeclared scenario, so a harness cannot run with an unsized watchdog
 */
export function harnessWatchdogMs(
    harness = process.argv[1]?.split(/[\\/]/).at(-1) ?? "",
    args = process.argv.slice(2),
) {
    const entry = watchdogEntry(harness, args)
    if (!entry) throw new Error(`The live scenario ${harness} ${args.join(" ")} has no sized watchdog`)
    return pacedWatchdogMs(entry, { concurrency: liveConcurrency() })
}
