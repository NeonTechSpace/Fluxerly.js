// The docs as plain text for AI tools and anything else that reads text: each guide as Markdown, an index of them, all guides in one file,
// a single-fetch skill cheatsheet and a condensed reference. A version's files describe that version, and their first lines name it
import { readFileSync } from "node:fs"
import { guideAsMarkdown } from "../../scripts/docs/remark-guides.mjs"
import inventory from "@content/guides/meta.json"
import { featurePages } from "./links"
import { siteOrigin } from "./site-address.mjs"
import { titleCase } from "./title-case"
import { model } from "./reference"
import { checkedText, referenceText as condensedText, referenceTextProblems, tasksMarkdown as tasksText } from "./reference-text.ts"

const raw = import.meta.glob<string>("@content/guides/*.md", { query: "?raw", import: "default", eager: true })
export const site = siteOrigin
const base = import.meta.env.PUBLIC_DOCS_BASE ?? "/docs/"
const version = process.env.DOCS_VERSION ?? (JSON.parse(readFileSync("../sdk/package.json", "utf8")) as { version: string }).version
const packageSpec = process.env.DOCS_PACKAGE_SPEC ?? "@neontechspace/fluxerly"
const about = `Fluxerly.js is a Fluxer-native bot SDK for JavaScript, TypeScript and Effect. Requires Node.js 24.15 or newer, ESM and TypeScript 7\n\nVoice: Fluxerly waits for Fluxer's new voice system and does not support voice over LiveKit. Fluxer is replacing LiveKit with its own voice system, which should arrive soon, and bot voice will come with it\n\nThese files describe SDK version ${version}`

export const guides = Object.entries(raw)
    .map(([path, source]) => ({
        slug: /([\w-]+)\.md$/.exec(path)![1]!,
        title: titleCase(/^title:\s*["']?(.+?)["']?$/m.exec(source)?.[1] ?? ""),
        source,
    }))
    .sort((a, b) => (a.slug === "index" ? -1 : b.slug === "index" ? 1 : a.slug.localeCompare(b.slug)))

export const asText = (body: string) => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } })
export const asMarkdown = (body: string) => new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8" } })

const guideSlugs = new Set(guides.map((guide) => guide.slug))

// Text is read away from the site, so every link is a full address in this version. A guide's link goes to its Markdown, which keeps a reader in text
const absolute = (url: string) => `${site}${url.replace(/^\/docs\//, base)}`
function linkOf(url: string): string {
    const match = /^\/docs\/(?:([\w-]+)\/)?(#.*)?$/.exec(url)
    const slug = match?.[1] ?? "index"
    return match && guideSlugs.has(slug) ? `${site}${base}${slug}.md${match[2] ?? ""}` : absolute(url)
}

export const guideMarkdown = (source: string) => guideAsMarkdown(source).replace(/\]\((\/docs\/[^)\s]*)\)/g, (_: string, url: string) => `](${linkOf(url)})`)

// One guide read on its own, away from the site, says which SDK version it describes. The combined export says so once, at its top
export const singleGuideMarkdown = (source: string) => guideMarkdown(source).replace(/^(?:# .*\n\n)?/, (title) => `${title}This guide describes SDK version ${version}\n\n`)

const entryOf = (item: string | { title: string; href: string }) => {
    // The docs menu links this index itself, which the index doesn't list
    if (typeof item !== "string" && item.href === "/docs/llms.txt") return undefined
    if (typeof item !== "string") return `- [${item.title}](${linkOf(item.href)})`
    const guide = guides.find((candidate) => candidate.slug === item)
    if (!guide) return undefined
    const description = /^description:\s*["']?(.+?)["']?$/m.exec(guide.source)?.[1]
    return `- [${guide.title}](${site}${base}${guide.slug}.md)${description ? `: ${description}` : ""}`
}

// Every version names the others, so a tool can match the version a project installed
function versionLines(): string[] {
    const listed = [...JSON.parse(process.env.DOCS_VERSIONS ?? "[]"), ...JSON.parse(process.env.DOCS_OLDER_VERSIONS ?? "[]")] as { label: string; version: string; base: string }[]
    return listed.filter((item) => item.base !== base).map((item) => `- [${item.label === item.version ? item.version : `${item.label} (${item.version})`}](${site}${item.base}llms.txt)`)
}

export function indexText(): string {
    const groups = inventory.groups.map((group) => {
        const entries = group.items.map(entryOf).filter(Boolean)
        return `## ${group.title}\n\n${entries.join("\n")}`
    })
    const versions = versionLines()
    // The root skill cheatsheet and feature pages describe the site's newest version, so only that version's index lists them
    const startHere =
        base === "/docs/"
            ? [
                  `## Quick skill for AI tools\n\n- [Single-file agent cheatsheet (SKILL.md)](${site}/SKILL.md): Install, starter bot, commands, events, Results, testing, Effect summary and patterns that do not exist`,
              ]
            : []
    const features = base === "/docs/" ? [`## What Fluxerly includes\n\n${featurePages.map((page) => `- [${page.title}](${site}/${page.slug}/): ${page.summary}`).join("\n")}`] : []
    const sections = [
        ...startHere,
        ...features,
        ...groups,
        `## Reference\n\n- [Client methods by task, JavaScript & TypeScript](${site}${base}api/tasks-js.md)\n- [Client methods by task, Effect API](${site}${base}api/tasks-effect.md)\n- [Every client method by task](${site}${base}api/tasks.md)\n- [The whole reference, condensed](${site}${base}llms-reference.txt): Every export with its signatures and members`,
        ...(versions.length ? [`## Other versions\n\n${versions.join("\n")}`] : []),
        `## Optional\n\n- [All guides in one file](${site}${base}llms-full.txt)`,
    ]
    return `# Fluxerly.js\n\n> ${about}\n\n${sections.join("\n\n")}\n`
}

export function fullText(): string {
    return `# Fluxerly.js guides\n\n> ${about}\n\n${guides.map((guide) => guideMarkdown(guide.source)).join("\n---\n\n")}`
}

export function skillMarkdown(): string {
    const install = packageSpec.includes("@", 1) ? `npm install --save-exact ${packageSpec}` : `npm install ${packageSpec}`
    return `# Fluxerly.js Agent Cheatsheet

> ${about}

## Requirements and install

- Package: \`@neontechspace/fluxerly\` (ESM-only, \`"type": "module"\` in \`package.json\`, Node.js 24.15 or newer)
- TypeScript: Node.js runs \`.ts\` directly without building. Typechecking requires TypeScript 7 and \`@types/node\`
- Entry points: \`@neontechspace/fluxerly\`, \`/effect\`, \`/testing\`, \`/effect/testing\`. Never import from \`dist\` or \`src\`

\`\`\`sh
${install}
npx ${packageSpec} init --template ts
npx --no fluxerly agents
\`\`\`

- Templates: \`js\`, \`ts\` or \`effect\`. Keep \`FLUXER_BOT_TOKEN\` in \`.env\` (never in code, logs or commits) and start with \`node --env-file-if-exists=.env bot.js\`

## Starter bot

Keep options in an exported \`defineBot\` object and start under \`import.meta.main\` so tests import \`bot\` without connecting

\`\`\`ts
import { defineBot, runBot } from "@neontechspace/fluxerly"

export const bot = defineBot({
    commands: {
        prefix: "!",
        commands: { ping: { execute: ({ reply }) => reply("Pong!") } },
    },
})

if (import.meta.main) await runBot({ token: process.env.FLUXER_BOT_TOKEN, ...bot })
\`\`\`

- \`runBot\` skips bot messages (\`ignoreBots: false\` disables), stops cleanly on SIGINT and SIGTERM (\`processSignals: false\` disables), logs fatal startup failures once and sets exit code 1
- Use \`createClient({ token })\` only for manual lifecycle control, registering handlers before \`connect()\` or \`run()\` and closing with \`await using\` or \`shutdown()\`

## Prefix commands, arguments, guards and cooldowns

\`\`\`ts
import { commands, defineBot, guards } from "@neontechspace/fluxerly"

export const bot = defineBot({
    commands: {
        prefix: "!",
        parse: commands.parseQuoted,
        commands: {
            purge: {
                description: "Delete recent messages",
                guard: [guards.guildOnly(), guards.requirePermissions(["ManageMessages"])],
                cooldown: { durationMs: 30_000, per: "channel" },
                arguments: { count: { type: "integer", min: 1, max: 100, default: 10 } },
                execute: ({ values, reply }) => reply(\`Deleting \${values.count} messages\`),
            },
            help: { execute: ({ sendHelp }) => sendHelp() },
        },
    },
})
\`\`\`

- Guards: \`guards.guildOnly()\`, \`guards.dmOnly()\`, \`guards.ownerOnly()\`, \`guards.ownerOnly(ids)\`, \`guards.requirePermissions(names)\`
- Cooldowns: \`{ durationMs, per: "user" | "channel" | "guild" }\`. \`hidden: true\` hides from help without blocking execution. Context also provides \`sendHelp()\`, \`paginate(pages)\`, \`client\` and \`signal\`

## Events, embeds, attachments and mentions

\`\`\`ts
import { EmbedBuilder, defineBot, format } from "@neontechspace/fluxerly"

export const bot = defineBot({
    events: {
        messageCreate: async ({ message, reply }) => {
            if (message.content !== "!info") return
            const embed = new EmbedBuilder().title("Channel").description(format.channelMention(message.channelId))
            return reply({ embeds: [embed] })
        },
    },
})
\`\`\`

- Outside handlers, call \`client.messages.send(channelId, content)\`. Wait for replies or reactions with \`client.messages.collect\` and \`client.messages.collectReactions\`
- Helpers: \`EmbedBuilder\`, \`MessageBuilder\`, \`format\`, \`links\`, \`text\`, \`colors\`. Keep IDs as decimal strings. Download attachments with \`client.attachments.download({ maxBytes })\` or \`client.attachments.stream\`
- Raw access: \`client.rest.call("METHOD /path/{param}", { params, query, body })\` (typed Fluxer names), \`client.rest.request\` (untyped) and \`client.on("raw", handler)\`

## Results, orThrow and onError

Network calls return \`ResultAsync\`. Await and check \`isErr()\` before reading \`.value\`, or unwrap with \`orThrow\`

\`\`\`ts
import { createClient, describeError, errors, orThrow } from "@neontechspace/fluxerly"

await using client = createClient({ token: process.env.FLUXER_BOT_TOKEN })
const sent = await client.messages.send(channelId, "Hello")
if (sent.isErr()) {
    if (errors.apiCode(sent.error) === "missingPermissions") return
    console.error(describeError(sent.error))
}
const message = await orThrow(client.messages.send(channelId, "Hello again"))
\`\`\`

- Return a \`Result\` from handlers so the SDK logs it or sends it to \`onError\`. Invalid local options throw \`ConfigurationError\` synchronously
- Before retrying, check \`errors.isRetryable(err)\`, wait \`errors.retryAfterMs(err)\`, and never retry an upload with \`details.streamUsed\`

## Zero-network testing

Test \`defineBot\` options with \`createTestBot\` from \`@neontechspace/fluxerly/testing\` (or \`createTestClient\`) against an in-memory Fluxer without a token or network

\`\`\`ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestBot } from "@neontechspace/fluxerly/testing"
import { bot } from "./bot.js"

test("replies to !ping", async () => {
    await using testBot = createTestBot(bot)
    await testBot.ready()
    const sent = await testBot.say("!ping")
    assert.deepEqual(sent.map((message) => message.content), ["Pong!"])
})
\`\`\`

- Controls: \`ready()\`, \`say()\`, \`emit()\`, \`fixtures\`, \`rest.respond()\`, \`requests()\`, \`logs()\`, \`failures()\`, \`idle()\` and \`clock: "manual"\` with \`advance(ms)\`
- Run tests with \`node --test --test-timeout=10000 --test-force-exit\`

## Effect entry point

Import \`@neontechspace/fluxerly/effect\` when using Effect 4 (within \`peerDependencies.effect\`). Compose with \`Effect.gen\` and \`yield*\`, keep clients in \`Effect.scoped\` or \`FluxerClient.layer\` / \`FluxerClient.layerConfig\`, pass \`processSignals: true\` to native \`runBot\` when not using \`NodeRuntime.runMain\`, and test with \`@neontechspace/fluxerly/effect/testing\`

## Patterns that do not exist in Fluxerly

- No \`new Client()\` or \`client.login(token)\`. Use \`runBot\` or \`createClient\` with \`client.run()\`
- No gateway intents. Presence updates for chosen members need \`client.presence.setMembers\`
- No slash commands or interactions yet. Commands are prefix commands under \`commands\`
- Messages are read-only data: No \`message.reply()\`, \`message.delete()\` or \`channel.send()\`. Use handler \`reply\` or \`client.messages.send\`
- A \`runBot\` event handler receives a context object such as \`({ message, reply })\`, not the message directly
- Bot authors check \`message.author.isBot\`, not \`message.author.bot\`
- Fluxer communities are named guilds in the SDK, as in \`guildId\`
- No voice channel connections over LiveKit yet (voice states, member voice controls, voice notes and audio or video attachments work)

## Deeper docs

- [Task index](${site}${base}where-do-i.md)
- [JS/TS client methods by task](${site}${base}api/tasks-js.md)
- [Effect client methods by task](${site}${base}api/tasks-effect.md)
- [Condensed API reference](${site}${base}llms-reference.txt)
- [Docs index](${site}/llms.txt) and [all guides](${site}/llms-full.txt)
`
}

export const tasksMarkdown = () => checkedText(tasksText(model.entries, { about, absolute }), referenceTextProblems(model.entries))

export const tasksMarkdownFor = (key: string) => {
    const entry = model.entries.find((candidate) => candidate.key === key)
    if (!entry) throw new Error(`Unknown reference entry point ${key}`)
    return checkedText(tasksText([entry], { about, absolute }), referenceTextProblems([entry]))
}

export const referenceText = () => checkedText(condensedText(model.entries, { about, absolute }), referenceTextProblems(model.entries))
