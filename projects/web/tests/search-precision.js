import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { staticClient } from "fumadocs-core/search/client/orama-static"
import { rankResults, searchOptions } from "../src/lib/search-options.ts"

/**
 * Realistic search queries with their acceptable destinations.
 * `guide:<slug>` names a guide page. `api:<module>.<Symbol>` names a reference symbol, wherever the
 * layout places it: its own page or a section of its entry point page. `#member` requires that member.
 * `before` records the rank a query must keep: the top-five rank measured with the full-text reference index
 * this gate replaced, or the rank reached when a ranking fix recorded the query. Null guarantees no rank.
 * Targets are the pages that answer the query. Hub pages such as the task index and glossary only route there
 */
export const queries = [
    { query: "createClient", targets: ["api:js-ts.createClient", "api:Effect.createClient"], before: 1 },
    { query: "Messages.reply", targets: ["api:js-ts.Messages#reply", "api:Effect.Messages#reply"], before: null },
    { query: "reply", targets: ["api:js-ts.Messages#reply", "api:Effect.Messages#reply", "guide:messages"], before: 2 },
    { query: "client.messages.send", targets: ["api:js-ts.Messages#send", "api:Effect.Messages#send"], before: null },
    { query: "send a message", targets: ["guide:messages", "api:js-ts.Messages#send", "api:Effect.Messages#send"], before: 1 },
    { query: "fetchHistory", targets: ["api:js-ts.Messages#fetchhistory", "api:Effect.Messages#fetchhistory", "guide:history-and-cache"], before: 2 },
    { query: "iterateHistory", targets: ["api:js-ts.Messages#iteratehistory", "api:Effect.Messages#iteratehistory", "guide:history-and-cache"], before: 2 },
    { query: "addReaction", targets: ["api:js-ts.Messages#addreaction", "api:Effect.Messages#addreaction"], before: 2 },
    { query: "deleteMany", targets: ["api:js-ts.Messages#deletemany", "api:Effect.Messages#deletemany"], before: 2 },
    { query: "keepTyping", targets: ["api:js-ts.Messages#keeptyping", "api:Effect.Messages#keeptyping"], before: 2 },
    { query: "waitForClose", targets: ["api:js-ts.Client#waitforclose", "api:Effect.Client#waitforclose"], before: 2 },
    { query: "connect", targets: ["api:js-ts.Client#connect", "api:Effect.Client#connect", "guide:quick-start"], before: 2 },
    { query: "shutdown", targets: ["api:js-ts.Client#shutdown", "api:Effect.Client#shutdown", "guide:starter-lifetime", "guide:reliability"], before: 2 },
    { query: "runBot", targets: ["api:js-ts.runBot", "api:Effect.runBot", "guide:starter-lifetime"], before: 1 },
    { query: "EmbedBuilder", targets: ["api:js-ts.EmbedBuilder"], before: 1 },
    { query: "MessageBuilder", targets: ["api:js-ts.MessageBuilder"], before: 1 },
    { query: "embed", targets: ["guide:messages", "api:js-ts.EmbedBuilder"], before: null },
    { query: "permissions", targets: ["guide:guilds-and-permissions", "api:js-ts.PermissionHelpers", "api:Effect.PermissionHelpers"], before: null },
    { query: "PermissionName", targets: ["api:js-ts.PermissionName"], before: null },
    { query: "permissionBits", targets: ["api:js-ts.permissionBits", "api:Effect.permissionBits"], before: 5 },
    { query: "rate limit", targets: ["api:js-ts.RateLimitError", "api:Effect.RateLimitError", "guide:reliability"], before: 1 },
    { query: "RateLimitError", targets: ["api:js-ts.RateLimitError"], before: 1 },
    { query: "cooldown", targets: ["guide:commands", "api:js-ts.DefaultPrefixCommand"], before: 1 },
    { query: "arguments", targets: ["guide:commands", "api:js-ts.DefaultPrefixCommand"], before: 1 },
    { query: "maxPendingMessages", targets: ["api:js-ts.CollectorOptions#maxpendingmessages", "api:Effect.CollectorOptions#maxpendingmessages", "api:js-ts.DefaultCollectorOptions#maxpendingmessages"], before: null },
    { query: "allowInsecure", targets: ["api:js-ts.InstanceOptions#allowinsecure"], before: null },
    { query: "totalShards", targets: ["api:js-ts.ShardingOptions#totalshards", "api:js-ts.SupervisorOptions#totalshards"], before: null },
    { query: "messageFields", targets: ["api:js-ts.ClientOptions#messagefields", "api:Effect.ClientOptions#messagefields", "api:js-ts.MessageFields"], before: null },
    { query: "MessageError", targets: ["api:js-ts.MessageError"], before: 1 },
    { query: "ConfigurationError", targets: ["api:js-ts.ConfigurationError"], before: 1 },
    { query: "SdkDefect", targets: ["api:js-ts.SdkDefect"], before: 1 },
    { query: "CancelledError", targets: ["api:js-ts.CancelledError"], before: 1 },
    { query: "ConnectionError", targets: ["api:js-ts.ConnectionError"], before: 1 },
    { query: "GuildOperationFailure", targets: ["api:js-ts.GuildOperationFailure"], before: null },
    { query: "webhook", targets: ["guide:webhooks-and-oauth", "api:js-ts.WebhookClient", "api:js-ts.Webhooks"], before: null },
    { query: "createWebhookClient", targets: ["api:js-ts.createWebhookClient", "api:Effect.createWebhookClient"], before: 1 },
    { query: "oauth", targets: ["guide:webhooks-and-oauth", "api:js-ts.OAuthClient"], before: null },
    { query: "sharding", targets: ["guide:sharding", "api:js-ts.ShardingOptions", "api:js-ts.ClientOptions#sharding"], before: null },
    { query: "supervisor", targets: ["guide:application-supervision", "api:js-ts.supervisor", "api:js-ts.SupervisorOptions"], before: null },
    { query: "cache", targets: ["guide:history-and-cache", "api:js-ts.ClientCache", "api:js-ts.Client#cache"], before: null },
    { query: "collector", targets: ["guide:events-and-collectors", "api:js-ts.Messages#collect", "api:js-ts.CollectorOptions"], before: null },
    { query: "logging", targets: ["guide:logging"], before: null },
    { query: "describeError", targets: ["api:js-ts.describeError", "api:Effect.describeError"], before: null },
    { query: "createTestClient", targets: ["api:testing.createTestClient", "api:Effect-testing.createTestClient"], before: null },
    { query: "emoji", targets: ["guide:emoji-and-stickers", "api:js-ts.Emojis"], before: null },
    { query: "stickers", targets: ["guide:emoji-and-stickers", "api:js-ts.Stickers"], before: null },
    { query: "prefix command", targets: ["guide:commands", "api:js-ts.DefaultPrefixCommandRouter"], before: 1 },
    { query: "ping", targets: ["guide:quick-start", "guide:small-bot"], before: 1 },
    { query: "install", targets: ["guide:quick-start", "guide:create-a-bot"], before: 1 },
    { query: "Effect bot", targets: ["guide:effect-first-bot"], before: null },
    { query: "troubleshooting", targets: ["guide:troubleshooting"], before: 1 },
    { query: "ban", targets: ["api:js-ts.Members#ban", "api:js-ts.Guilds#ban", "guide:guilds-and-permissions"], before: null },
    { query: "creatClient", targets: ["api:js-ts.createClient", "api:Effect.createClient"], before: null },
    { query: "shutdwon", targets: ["api:js-ts.Client#shutdown", "guide:starter-lifetime"], before: null },
    { query: "permisions", targets: ["guide:guilds-and-permissions", "api:js-ts.PermissionHelpers"], before: null },
    { query: "embded", targets: ["guide:messages", "api:js-ts.EmbedBuilder"], before: null },
    { query: "reply to message", targets: ["guide:messages"], before: 1 },
    { query: "edit message", targets: ["guide:messages"], before: 1 },
    { query: "direct message", targets: ["guide:messages"], before: 1 },
    { query: "file upload", targets: ["guide:messages"], before: 1 },
    { query: "slash command", targets: ["guide:commands"], before: 1 },
    { query: "token", targets: ["guide:create-a-bot", "guide:configuration"], before: 1 },
]

// Earlier layouts gave functions, type aliases and variables their own pages
const ownPageKinds = ["classes", "interfaces", "enums", "functions", "types", "variables"]

export function matchesTarget(url, target, version) {
    const [rawPath, rawHash = ""] = url.split("#")
    const path = rawPath.replace(/\/$/, "")
    const hash = decodeURIComponent(rawHash).toLowerCase()
    const docs = `/docs/${version}`
    if (target.startsWith("guide:")) return path === `${docs}/${target.slice("guide:".length)}`
    const match = /^api:([^.#]+)\.([^#]+)(?:#(.+))?$/.exec(target)
    if (!match) throw new Error(`Invalid search target: ${target}`)
    const [, module, name, member] = match
    const owned = ownPageKinds.some((kind) => path === `${docs}/api/${kind}/${module}.${name}`)
    if (member) return owned && hash === member.toLowerCase()
    if (owned) return true
    return path === `${docs}/api/modules/${module}` && hash === name.toLowerCase()
}

/** Run a query through Fumadocs' static client exactly as the search dialog does */
export async function searchIndex(json, { limit = 5 } = {}) {
    const from = `precision:${randomUUID()}`
    const client = staticClient({ from, search: searchOptions })
    // The client loads its index once through the global fetch, so the substitute lasts only for that load
    const original = globalThis.fetch
    globalThis.fetch = async (input) => input === from ? new Response(json) : original(input)
    try {
        await client.search("index")
    } finally {
        globalThis.fetch = original
    }
    return async (query) => {
        const results = rankResults(query, await client.search(query))
        return results.slice(0, limit).map((item) => item.url)
    }
}

export async function evaluate(indexPath, { version = "preview" } = {}) {
    const search = await searchIndex(await readFile(indexPath, "utf8"))
    const results = []
    for (const entry of queries) {
        const urls = await search(entry.query)
        const index = urls.findIndex((url) => entry.targets.some((target) => matchesTarget(url, target, version)))
        results.push({ ...entry, rank: index < 0 ? null : index + 1, urls })
    }
    return results
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
    const [indexPath, version = "preview"] = process.argv.slice(2)
    const results = await evaluate(indexPath, { version })
    for (const result of results) console.log(`${result.rank ?? "-"}\t${result.query}${result.rank === null ? `\t${result.urls.join(" ")}` : ""}`)
    const found = results.filter((result) => result.rank !== null)
    console.log(`Found in top five: ${found.length}/${results.length}, mean rank ${(found.reduce((sum, result) => sum + result.rank, 0) / found.length).toFixed(2)}`)
}
