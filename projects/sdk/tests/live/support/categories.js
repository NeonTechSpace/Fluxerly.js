// Live check categories, and the selection of categories from changed files. Work on the SDK runs the categories that
// cover a change, each about three minutes or less at the safe pace with both APIs, and the full suite runs only before
// a release. A category lists checks by name, or one API mode of a check as `<check>@default` or `<check>@effect` when
// the whole check takes longer than a category may. The times below were measured from the request logs of a full run
// at 80 requests a minute and replayed with the runner's two lanes, see the live check guide

import { readFileSync, readdirSync } from "node:fs"

/** Every category with its checks, in run order. Checks may appear in more than one category */
export const categories = Object.freeze({
    // A quick confidence check of sending, receiving, event waits, discovery, rate-limit handling and a forced resume
    smoke: ["rate-limits", "messages", "event-waits", "instance", "recovery"],
    messages: ["messages", "nonce", "management", "batch-delete", "events", "typing"],
    "message-content": ["message-fields", "embeds", "optional-tools", "search"],
    // Forwarding, file metadata, flags and profiles
    "consumer-features": ["consumer-features"],
    history: ["history", "pagination", "pins"],
    // Two batches of 101 messages per API mode do not fit one category, so each mode has its own
    cleanup: ["cleanup@default"],
    "cleanup-effect": ["cleanup@effect"],
    "own-history": ["own-history", "text-validation"],
    // Reactor pages need about 145 requests per API mode
    reactions: ["reactions@default"],
    "reactions-effect": ["reactions@effect"],
    channels: ["channels", "gateway-capture", "guild-events", "voice"],
    threads: ["threads", "voice-notes"],
    roles: ["guilds", "administration", "message-members"],
    "server-settings": ["consumer-operations", "guild-features"],
    members: ["member-search", "member-chunks", "guild-lifecycle"],
    webhooks: ["webhooks", "announcements"],
    uploads: ["attachments", "attachment-sources"],
    "cache-collectors": ["cache", "collectors"],
    commands: ["command-arguments", "command-help", "command-groups", "event-waits"],
    connection: ["sandbox", "sdk", "application", "diagnostics", "bot-runner", "recovery-window-session-restart"],
    recovery: ["recovery", "recovery:cancel"],
    // Each API mode observes for at least 165 seconds, so both modes run at once
    "recovery-window": ["recovery-window@default", "recovery-window@effect"],
    sharding: ["sharding", "supervisor"],
    oauth: ["oauth:no-consent", "application"],
    "rate-limits": ["rate-limits"],
    expressions: ["expressions"],
    "discovery-invites": ["discovery", "invites", "vanity"],
    // client.rest.call on representative routes and the documented raw event
    "typed-raw": ["typed-raw"],
})

/**
 * Where a changed path leads, first match wins. SDK source files are matched by their file or folder name, wherever
 * they sit under src/, src/internal/ or src/api/<binding>/. An SDK source file no rule names runs the smoke category
 */
const sourceRules = [
    [/^(reactions?|reaction-pages|reaction-collector)$/, ["reactions", "reactions-effect"]],
    [/^(message-cleanup|cleanup-owner)$/, ["cleanup", "cleanup-effect", "own-history"]],
    [/^(message-search|message-search-workflow)$/, ["message-content"]],
    [/^(messages?|message-errors|message-fields|nonce|text|field-text|field-rules)$/, ["messages", "message-content"]],
    [/^(embeds|builders|colors)$/, ["message-content", "consumer-features"]],
    [/^(pagination|pins)$/, ["history"]],
    [
        /^(channels|channel-cache|channel-decode|permissions|permission-labels|permission-requirements|audit-logs|audit)$/,
        ["channels", "roles"],
    ],
    [/^(threads|thread-events|voice-notes)$/, ["threads"]],
    [
        /^(guilds|guild-cache|guild-settings|roles|role-hierarchy|role-hierarchy-workflow|moderation|timeout-state|counts)$/,
        ["roles", "server-settings"],
    ],
    [
        /^(members|member-chunks|member-search|member-search-workflow|guild-lifecycle|user-cache|users|direct-messages)$/,
        ["members", "consumer-features"],
    ],
    [/^(webhooks|webhook-client)$/, ["webhooks", "threads"]],
    [/^(attachments|attachment-refresh|uploads|multipart|assets|transfer-source)$/, ["uploads"]],
    [/^(cache|cache-changes|expiry-queue|retention-age|collectors?)$/, ["cache-collectors"]],
    [
        /^(commands|command-arguments|command-help|command-guards|default-commands|native-commands|observer)$/,
        ["commands", "messages"],
    ],
    // Declares the raw event beside the typed ones
    [/^events$/, ["commands", "messages", "typed-raw"]],
    // The typed raw event: its documented payload types, the documented dispatch list and the event's declaration
    [/^(gateway-payloads|documented-dispatches)$/, ["typed-raw", "recovery", "connection"]],
    [
        /^(gateway|gateway-requests|presence|calls|retryable-connection|clock|logical-scheduler)$/,
        ["recovery", "connection"],
    ],
    [/^(sharding|supervisor|default-supervisor|native-supervisor|bot-runner)$/, ["sharding", "connection"]],
    [/^(oauth|application)$/, ["oauth"]],
    [/^(rest|rest-routes)$/, ["typed-raw", "rate-limits", "smoke"]],
    [/^(rate-limits|rate-limit-templates)$/, ["rate-limits", "smoke"]],
    [/^(expressions|emojis|stickers)$/, ["expressions"]],
    [/^(discovery|guild-discovery|invites|vanity-url|instance|instance-badges)$/, ["discovery-invites", "connection"]],
    [/^(scheduled-tasks|typing)$/, ["messages"]],
]

/** Folders of src/internal whose files belong to one area as a whole */
const sourceFolders = {
    gateway: ["recovery", "connection", "smoke"],
    transport: ["recovery", "connection", "smoke"],
    rest: ["rate-limits", "smoke"],
}

/** Live harness files whose checks span so many categories that a change to them runs the smoke category only */
const broadHarnesses = new Set(["messages.js", "command-conveniences.js"])

// These helpers run only in one scenario of a broad harness, so select that scenario instead of its smoke fallback
const helperCategories = { "attachment-sources.mjs": ["uploads"] }

const liveFolder = new URL("../", import.meta.url)

/**
 * The files in tests/live that import `file`, directly or through other files there, such as the harnesses that use a
 * shared fixture. Offline tests are left out
 */
export function liveImporters(file) {
    const files = readdirSync(liveFolder).filter((name) => /^[a-z0-9-]+\.m?js$/.test(name) && !name.includes(".test."))
    const sources = new Map(files.map((name) => [name, readFileSync(new URL(name, liveFolder), "utf8")]))
    const importers = new Set()
    const pending = [file]
    while (pending.length > 0) {
        const target = pending.pop()
        for (const [name, source] of sources)
            if (name !== file && !importers.has(name) && source.includes(`"./${target}"`)) {
                importers.add(name)
                pending.push(name)
            }
    }
    return importers
}

/** The categories holding a check that one of the harness files runs */
function categoriesOfHarnesses(harnesses, checks) {
    return Object.entries(categories)
        .filter(([, members]) =>
            members.some((member) =>
                checks.get(member.split("@")[0])?.commands.some((command) => harnesses.has(command.harness)),
            ),
        )
        .map(([name]) => name)
}

/**
 * The categories a set of changed repository paths needs, with a reason for each path that selected something. SDK
 * source files select by area, a live harness file selects the categories that hold its checks, the live support,
 * runner and SDK package manifest select smoke. Everything else, such as documentation, the website, release tooling
 * and offline tests, selects nothing
 */
export function categoriesForChanges(paths, checks) {
    const selected = new Set()
    const reasons = []
    const add = (path, names) => {
        for (const name of names) selected.add(name)
        reasons.push({ path, categories: names })
    }
    for (const path of paths) {
        const sdk = /^projects\/sdk\/(.+)$/.exec(path)?.[1]
        if (sdk === undefined) continue
        if (sdk === "package.json") {
            add(path, ["smoke"])
            continue
        }
        const source = /^src\/(?:internal\/|api\/(?:default|effect)\/)?(?:([a-z-]+)\/)?([a-z0-9-]+)\.ts$/.exec(sdk)
        if (source) {
            const [, folder, file] = source
            const rule = sourceRules.find(([pattern]) => pattern.test(file) || (folder && pattern.test(folder)))
            add(path, rule?.[1] ?? sourceFolders[folder] ?? ["smoke"])
            continue
        }
        const harness = /^tests\/live\/([a-z0-9-]+\.m?js)$/.exec(sdk)?.[1]
        if (harness && !harness.includes(".test.") && !broadHarnesses.has(harness)) {
            const direct = categoriesOfHarnesses(new Set([harness]), checks)
            // A shared fixture or helper runs no check itself, so it selects the categories of the harnesses importing it
            const importers = [...liveImporters(harness)].filter((name) => !broadHarnesses.has(name))
            const helpers = [harness, ...importers].flatMap((name) => helperCategories[name] ?? [])
            const names = [
                ...new Set([
                    ...(direct.length > 0 ? direct : categoriesOfHarnesses(new Set(importers), checks)),
                    ...helpers,
                ]),
            ]
            add(path, names.length > 0 ? names : ["smoke"])
            continue
        }
        if (/^tests\/live\/(support\/[^/]+|run-all\.js|messages\.js|command-conveniences\.js)$/.test(sdk))
            add(path, ["smoke"])
    }
    return { categories: Object.keys(categories).filter((name) => selected.has(name)), reasons }
}

/**
 * The runnable units of a selection of category and check names, in order and without repeats: Each is a check, or
 * one API mode of it named `<check>@<mode>`, with the commands it runs. When a selection needs both modes of a check
 * that cannot run its modes at once, or the whole check, it runs the whole check, so its modes never share a lock
 */
export function selectionUnits(names, checks) {
    const members = names.flatMap((name) => {
        if (Object.hasOwn(categories, name)) return categories[name]
        if (checks.has(name.split("@")[0])) return [name]
        throw new Error(`Unknown live category or check: ${name}`)
    })
    const modes = new Map()
    for (const member of members) {
        const [name, mode] = member.split("@")
        const check = checks.get(name)
        if (!check.sdkWork) throw new Error(`${name} needs per-run authorization or a person present`)
        if (mode !== undefined && !check.commands.some((command) => command.args[0] === mode))
            throw new Error(`${name} has no ${mode} mode`)
        modes.set(name, (modes.get(name) ?? new Set()).add(mode ?? "whole"))
    }
    const units = new Map()
    for (const member of members) {
        const [name, mode] = member.split("@")
        const check = checks.get(name)
        const wanted = modes.get(name)
        const whole = wanted.has("whole") || (!check.parallelModes && wanted.has("default") && wanted.has("effect"))
        if (whole) units.set(name, check)
        else
            units.set(member, {
                ...check,
                name: member,
                commands: check.commands.filter((command) => command.args[0] === mode),
            })
    }
    return [...units.values()]
}
