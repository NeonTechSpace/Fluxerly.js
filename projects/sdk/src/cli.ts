#!/usr/bin/env node
/**
 * The `fluxerly` command installed with the package.
 * `fluxerly init` writes a JavaScript, TypeScript or Effect starter bot project into the current folder without
 * replacing any file, then installs its dependencies with the package manager that ran it.
 * `fluxerly agents` adds the SDK's rules for coding agents to the current project's AGENTS.md, or refreshes them
 */

import "./internal/node-version.js"
import { fileURLToPath } from "node:url"
import { AgentsSectionError, writeAgentsSection } from "./internal/agents-section.js"
import { runInit } from "./internal/init-command.js"

const usage = [
    "Usage: fluxerly <command>",
    "",
    "Commands:",
    "  init    Writes a starter bot into the current folder without replacing any file, and installs its dependencies",
    "  agents  Adds the Fluxerly rules for coding agents to AGENTS.md in the current folder, or refreshes them",
    "",
    "Options for init:",
    "  --template js|ts|effect  Writes the JavaScript, TypeScript or Effect starter without asking. Without this",
    "                           option, init asks in a terminal and writes the JavaScript starter otherwise",
    "  --no-install             Skips the install and prints the install commands, for offline or CI use",
].join("\n")
const messages = {
    created: "Created AGENTS.md with the Fluxerly section",
    added: "Added the Fluxerly section to AGENTS.md",
    updated: "Updated the Fluxerly section in AGENTS.md",
    current: "The Fluxerly section in AGENTS.md is already current",
}
const packageRoot = fileURLToPath(new URL("../", import.meta.url))

const [command, ...rest] = process.argv.slice(2)
if (command === "init") {
    const outcome = await runInit(rest, {
        input: process.stdin,
        output: process.stdout,
        errorOutput: process.stderr,
        project: process.cwd(),
        packageRoot,
        userAgent: process.env.npm_config_user_agent,
    })
    if (outcome === "usage") console.error(usage)
    process.exitCode = outcome === 0 ? 0 : 1
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
