#!/usr/bin/env node
/**
 * The `fluxerly` command installed with the package.
 * `fluxerly agents` adds the SDK's rules for coding agents to the current project's AGENTS.md, or refreshes them
 */

import "./internal/node-version.js"
import { fileURLToPath } from "node:url"
import { AgentsSectionError, writeAgentsSection } from "./internal/agents-section.js"

const usage =
    "Usage: fluxerly agents\n\nAdds the Fluxerly rules for coding agents to AGENTS.md in the current folder, or refreshes them"
const messages = {
    created: "Created AGENTS.md with the Fluxerly section",
    added: "Added the Fluxerly section to AGENTS.md",
    updated: "Updated the Fluxerly section in AGENTS.md",
    current: "The Fluxerly section in AGENTS.md is already current",
}

const [command, ...rest] = process.argv.slice(2)
if (command === "agents" && rest.length === 0) {
    try {
        const result = writeAgentsSection(process.cwd(), fileURLToPath(new URL("../", import.meta.url)))
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
