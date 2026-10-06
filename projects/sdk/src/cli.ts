#!/usr/bin/env node
/**
 * The `fluxerly` command installed with the package.
 * `fluxerly init` writes a starter bot project into the current folder without replacing any file.
 * `fluxerly agents` adds the SDK's rules for coding agents to the current project's AGENTS.md, or refreshes them
 */

import "./internal/node-version.js"
import { fileURLToPath } from "node:url"
import { AgentsSectionError, writeAgentsSection } from "./internal/agents-section.js"
import { StarterConflictError, writeStarterProject } from "./internal/starter-project.js"

const usage = [
    "Usage: fluxerly <command>",
    "",
    "Commands:",
    "  init    Writes a starter bot into the current folder without replacing any file",
    "  agents  Adds the Fluxerly rules for coding agents to AGENTS.md in the current folder, or refreshes them",
].join("\n")
const messages = {
    created: "Created AGENTS.md with the Fluxerly section",
    added: "Added the Fluxerly section to AGENTS.md",
    updated: "Updated the Fluxerly section in AGENTS.md",
    current: "The Fluxerly section in AGENTS.md is already current",
}
const nextSteps = [
    "",
    "Next steps:",
    "1. Install the SDK with npm, pnpm or Bun:",
    "   npm install @neontechspace/fluxerly",
    "   pnpm add @neontechspace/fluxerly",
    "   bun add @neontechspace/fluxerly",
    "2. Copy .env.example to .env and set FLUXER_BOT_TOKEN to the bot's token",
    "3. Check the bot without a token: npm test, pnpm test or bun run test",
    "4. Start the bot: npm start, pnpm start or bun run start",
].join("\n")
const packageRoot = fileURLToPath(new URL("../", import.meta.url))

const [command, ...rest] = process.argv.slice(2)
if (command === "init" && rest.length === 0) {
    try {
        const written = writeStarterProject(process.cwd(), packageRoot)
        console.log(`Created ${written.join(", ")}`)
        console.log(nextSteps)
    } catch (error) {
        if (!(error instanceof StarterConflictError)) throw error
        console.error(
            `${error.message}, so fluxerly init wrote nothing. Run it in an empty folder, or move these files away first`,
        )
        process.exitCode = 1
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
