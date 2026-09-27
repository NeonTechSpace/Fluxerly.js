import assert from "node:assert/strict"
import test from "node:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { evaluate } from "./search-precision.js"
import { rankResults } from "../src/lib/search-options.ts"

// Public builds contain retained release snapshots, whose reference text this query set does not describe
const directory = fileURLToPath(new URL("../dist/api/search/", import.meta.url))
const previewIndex = (await readdir(directory).catch(() => [])).find((name) => /^preview\.[0-9a-f]{16}\.json$/.test(name))

test("Search finds every query target at least as well as the full-text index it replaced", { skip: !previewIndex && "No source preview search index was built" }, async () => {
    const results = await evaluate(join(directory, previewIndex))
    const regressions = results
        .filter((result) => result.before !== null && (result.rank === null || result.rank > result.before))
        .map((result) => `${result.query}: ${result.before} -> ${result.rank ?? "missing"} (${result.urls.join(" ")})`)
    assert.deepEqual(regressions, [])
    const found = results.filter((result) => result.rank !== null).length
    console.log(`Search precision: ${found}/${results.length} query targets in the top five`)
})

test("Reference symbols contribute names and first sentences, not full reference text", { skip: !previewIndex && "No source preview search index was built" }, async () => {
    const index = JSON.parse(await readFile(join(directory, previewIndex), "utf8"))
    const documents = Object.values(index.docs.docs)
    const reference = documents.filter((document) => /\/api\/(?:interfaces|classes|enums|modules)\//.test(document.url))
    assert.ok(reference.length > 0)
    // A first sentence with parameter names and error tags stays short. Full remarks or tables do not
    const longest = Math.max(...reference.map((document) => document.content.length))
    assert.ok(longest < 1_000, `Longest reference search text has ${longest} characters`)
    assert.ok(!reference.some((document) => /```|<details|\|\s*---/.test(document.content)))
    // Guides keep their full text
    const guide = documents.filter((document) => !document.url.includes("/api/"))
    assert.ok(guide.some((document) => document.type === "text" && document.content.length > 200))
})

const docs = "/docs/preview"
const page = (path, title, label) => ({ type: "page", content: title, url: `${docs}/${path}`, ...(label ? { breadcrumbs: [label] } : {}) })
const heading = (path, text, anchor = text.toLowerCase().replaceAll(" ", "-")) => ({ type: "heading", content: text, url: `${docs}/${path}#${anchor}` })
const text = (path, content) => ({ type: "text", content, url: `${docs}/${path}` })
const pages = (results) => results.filter((result) => result.type === "page").map((result) => result.url.slice(docs.length + 1))

test("Testing entry point results follow application results unless their title matches exactly", () => {
    const group = (url, title) => [{ type: "page", content: title, url }, { type: "heading", content: "shutdown", url: `${url}#shutdown` }]
    const testing = group("/docs/preview/api/interfaces/Effect-testing.TestClient", "TestClient")
    const client = group("/docs/preview/api/interfaces/Effect.Client", "Client")
    const guide = [{ type: "page", content: "Run a bot", url: "/docs/preview/starter-lifetime" }, { type: "text", content: "Shutdown waits for handlers", url: "/docs/preview/starter-lifetime" }]
    assert.deepEqual(rankResults("shutdown", [...testing, ...client, ...guide]), [...client, ...guide, ...testing])
    assert.deepEqual(rankResults("TestClient", [...client, ...testing]), [...testing, ...client])
})

test("A page whose sidebar label equals the query comes first without repeating the label", () => {
    const changelog = [page("changelog", "Changelog"), text("changelog", "Mention the troubleshooting guide")]
    const guide = [page("troubleshooting", "Diagnose a bot that is not behaving as expected", "Troubleshooting"), text("troubleshooting", "Troubleshooting")]
    assert.deepEqual(rankResults("troubleshooting", [...changelog, ...guide]), [guide[0], ...changelog])
})

test("Hub pages follow the dedicated page even when their headings name the query", () => {
    const glossary = [page("glossary", "Glossary"), heading("glossary", "Prefix command")]
    const tasks = [page("where-do-i", "Where do I…?"), text("where-do-i", "Add a prefix command")]
    const symbol = [page("api/interfaces/js-ts.PrefixCommandsOptions", "PrefixCommandsOptions")]
    const guide = [page("commands", "Add prefix commands to a bot", "Commands"), text("commands", "Commands")]
    assert.deepEqual(pages(rankResults("prefix command", [...glossary, ...tasks, ...symbol, ...guide])),
        ["commands", "api/interfaces/js-ts.PrefixCommandsOptions", "glossary", "where-do-i"])
    // An exact hub title still opens the hub
    assert.deepEqual(pages(rankResults("glossary", [...guide, ...glossary])), ["glossary", "commands"])
})

test("Identifier titles answer their words after guide titles and exact member headings", () => {
    const glossary = [page("glossary", "Glossary"), heading("glossary", "Rate limit")]
    const error = [page("api/classes/js-ts.RateLimitError", "RateLimitError")]
    const client = [page("api/interfaces/js-ts.Client", "Client"), heading("api/interfaces/js-ts.Client", "connect")]
    const options = [page("api/modules/js-ts#connectoptions", "ConnectOptions")]
    const guide = [page("reliability", "Handle rate limits")]
    assert.deepEqual(pages(rankResults("rate limit", [...error, ...guide])), ["reliability", "api/classes/js-ts.RateLimitError"])
    assert.deepEqual(pages(rankResults("rate limit", [...glossary, ...error])), ["api/classes/js-ts.RateLimitError", "glossary"])
    assert.deepEqual(pages(rankResults("connect", [...options, ...client])), ["api/interfaces/js-ts.Client", "api/modules/js-ts#connectoptions"])
})

test("Effect guides follow default guides of equal strength unless the query names Effect", () => {
    const effect = [page("effect-first-bot", "Learn Effect with a bot"), heading("effect-first-bot", "Install the matching version")]
    const start = [page("quick-start", "Start a bot"), heading("quick-start", "1. Install the SDK", "1-install-the-sdk")]
    assert.deepEqual(pages(rankResults("install", [...effect, ...start])), ["quick-start", "effect-first-bot"])
    assert.deepEqual(pages(rankResults("install effect", [...effect, ...start])), ["effect-first-bot", "quick-start"])
})

test("The default API form of a symbol takes its Effect twin's place", () => {
    const effect = [page("api/modules/Effect#permissionname", "PermissionName")]
    const other = [page("api/interfaces/js-ts.PermissionHelpers", "PermissionHelpers")]
    const main = [page("api/modules/js-ts#permissionname", "PermissionName")]
    assert.deepEqual(pages(rankResults("PermissionName", [...effect, ...other, ...main])),
        ["api/modules/js-ts#permissionname", "api/modules/Effect#permissionname", "api/interfaces/js-ts.PermissionHelpers"])
})

test("A default command type takes the place of its Effect Native twin", () => {
    const member = (path, title) => [page(path, title), heading(path, "cooldown")]
    const native = member("api/interfaces/Effect.NativePrefixCommand", "NativePrefixCommand")
    const other = member("api/interfaces/js-ts.PrefixCommandMetadata", "PrefixCommandMetadata")
    const main = member("api/interfaces/js-ts.DefaultPrefixCommand", "DefaultPrefixCommand")
    assert.deepEqual(pages(rankResults("cooldown", [...native, ...other, ...main])),
        ["api/interfaces/js-ts.DefaultPrefixCommand", "api/interfaces/js-ts.PrefixCommandMetadata", "api/interfaces/Effect.NativePrefixCommand"])
    const moduleNative = [page("api/modules/Effect#nativeprefixcommandcooldown", "NativePrefixCommandCooldown")]
    const moduleMain = [page("api/modules/js-ts#defaultprefixcommandcooldown", "DefaultPrefixCommandCooldown")]
    assert.deepEqual(pages(rankResults("command cooldown", [...moduleNative, ...moduleMain])),
        ["api/modules/js-ts#defaultprefixcommandcooldown", "api/modules/Effect#nativeprefixcommandcooldown"])
})

test("A guide section naming every word of a task query comes before reference symbols of equal strength", () => {
    const webhook = [page("api/interfaces/js-ts.WebhookClient", "WebhookClient"), heading("api/interfaces/js-ts.WebhookClient", "editMessage", "editmessage")]
    const guide = [page("messages", "Send messages, embeds and files", "Messages"), heading("messages", "Send, then edit the returned message", "send-then-edit-the-returned-message")]
    assert.deepEqual(pages(rankResults("edit message", [...webhook, ...guide])), ["messages", "api/interfaces/js-ts.WebhookClient"])
    // One word names a symbol, so an exact member heading keeps its place ahead of a guide that only mentions the word
    const client = [page("api/interfaces/js-ts.Client", "Client"), heading("api/interfaces/js-ts.Client", "shutdown")]
    const small = [page("small-bot", "Build a small bot"), heading("small-bot", "Clean shutdown", "clean-shutdown")]
    assert.deepEqual(pages(rankResults("shutdown", [...client, ...small])), ["api/interfaces/js-ts.Client", "small-bot"])
})

test("An Owner.member query opens the owner's page with that member", () => {
    const input = [page("api/modules/js-ts#replyinput", "ReplyInput"), text("api/modules/js-ts#replyinput", "Content for messages.reply")]
    const messages = [page("api/interfaces/js-ts.Messages", "Messages"), { ...text("api/interfaces/js-ts.Messages", "Messages.reply. Send a reply"), url: `${docs}/api/interfaces/js-ts.Messages#reply` }]
    assert.deepEqual(pages(rankResults("Messages.reply", [...input, ...messages])), ["api/interfaces/js-ts.Messages", "api/modules/js-ts#replyinput"])
})
