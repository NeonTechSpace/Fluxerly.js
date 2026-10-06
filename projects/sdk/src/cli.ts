#!/usr/bin/env node
/**
 * The `fluxerly` command installed with the package.
 * `fluxerly init` writes a JavaScript, TypeScript or Effect starter bot project into the current folder without
 * replacing any file.
 * `fluxerly agents` adds the SDK's rules for coding agents to the current project's AGENTS.md, or refreshes them
 */

import "./internal/node-version.js"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { AgentsSectionError, writeAgentsSection } from "./internal/agents-section.js"
import { selectStarterTemplate } from "./internal/init-command.js"
import { StarterConflictError, writeStarterProject, type StarterTemplate } from "./internal/starter-project.js"

const usage = [
    "Usage: fluxerly <command>",
    "",
    "Commands:",
    "  init    Writes a starter bot into the current folder without replacing any file",
    "  agents  Adds the Fluxerly rules for coding agents to AGENTS.md in the current folder, or refreshes them",
    "",
    "Options for init:",
    "  --template js|ts|effect  Writes the JavaScript, TypeScript or Effect starter without asking. Without this",
    "                           option, init asks in a terminal and writes the JavaScript starter otherwise",
].join("\n")
const messages = {
    created: "Created AGENTS.md with the Fluxerly section",
    added: "Added the Fluxerly section to AGENTS.md",
    updated: "Updated the Fluxerly section in AGENTS.md",
    current: "The Fluxerly section in AGENTS.md is already current",
}
const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const { version, peerDependencies } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
    peerDependencies: { effect: string }
}
// Install the version that wrote the starter. A prerelease's API can change between versions, so it is pinned exactly
const exact = version.includes("-")
// The lowest Effect release in the SDK's peer range, which the documentation recommends and the SDK is tested against
const effect = `effect@${peerDependencies.effect.replace(/^\^/, "")}`
const managers = [
    { add: "npm install", exact: "--save-exact", dev: "--save-dev" },
    { add: "pnpm add", exact: "--save-exact", dev: "--save-dev" },
    { add: "bun add", exact: "--exact", dev: "--dev" },
]
const installed = {
    js: "the SDK",
    ts: "the SDK and the Node.js types",
    effect: "the SDK, Effect and the Node.js types",
}

function nextSteps(template: StarterTemplate) {
    return [
        "",
        "Next steps:",
        `1. Install ${installed[template]} with npm, pnpm or Bun:`,
        ...managers.flatMap((manager) => [
            `   ${manager.add}${exact ? ` ${manager.exact}` : ""} @neontechspace/fluxerly@${version}`,
            ...(template === "effect" ? [`   ${manager.add} ${effect}`] : []),
            // The editor and TypeScript read the SDK's types, which use the Node.js types
            ...(template === "js" ? [] : [`   ${manager.add} ${manager.dev} @types/node`]),
        ]),
        "2. Copy .env.example to .env and set FLUXER_BOT_TOKEN to the bot's token",
        "3. Check the bot without a token: npm test, pnpm test or bun run test",
        "4. Start the bot: npm start, pnpm start or bun run start",
    ].join("\n")
}

const [command, ...rest] = process.argv.slice(2)
if (command === "init") {
    const template = await selectStarterTemplate(rest, { input: process.stdin, output: process.stdout })
    if (template === "invalid") {
        console.error(usage)
        process.exitCode = 1
    } else if (template === "cancelled") {
        console.error("fluxerly init was cancelled and wrote nothing")
        process.exitCode = 1
    } else {
        try {
            const written = writeStarterProject(process.cwd(), packageRoot, template)
            console.log(`Created ${written.join(", ")}`)
            console.log(nextSteps(template))
        } catch (error) {
            if (!(error instanceof StarterConflictError)) throw error
            console.error(
                `${error.message}, so fluxerly init wrote nothing. Run it in an empty folder, or move these files away first`,
            )
            process.exitCode = 1
        }
    }
} else if (command === "agents" && rest.length === 0) {
    try {
        const result = writeAgentsSection(process.cwd(), packageRoot)
        console.log(messages[result.status])
        for (const note of result.notes) console.log(note)
    } catch (error) {
        if (!(error instanceof AgentsSectionError)) throw error
        console.error(`${error.message}. AGENTS.md was not changed`)
        process.exitCode = 1
    }
} else if (command === "--help" || command === "-h") console.log(usage)
else {
    console.error(usage)
    process.exitCode = 1
}
