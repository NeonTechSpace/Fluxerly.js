#!/usr/bin/env node
/**
 * The `fluxerly` command installed with the package.
 * `fluxerly init` writes a JavaScript, TypeScript or Effect starter bot project without replacing existing files,
 * then installs its dependencies.
 * `fluxerly agents` adds or checks the SDK's rules for coding agents in AGENTS.md, skills or tool rule files.
 * `fluxerly doctor` verifies a bot project's Node.js, ESM, TypeScript, Effect and hygiene settings offline.
 * `fluxerly invite` builds a Fluxer bot installation URL offline
 */

import "./internal/node-version.js"
import { fileURLToPath } from "node:url"
import { runAgentsCommand } from "./internal/agents-section.js"
import { runDoctor } from "./internal/doctor-command.js"
import { runInit } from "./internal/init-command.js"
import { runInvite } from "./internal/invite-command.js"

const usage = [
    "Usage: fluxerly <command>",
    "",
    "Commands:",
    "  init    Writes a starter bot without replacing existing files, and installs its dependencies",
    "  agents  Adds, refreshes or checks Fluxerly rules for coding agents",
    "  doctor  Verifies Node.js, ESM, TypeScript, Effect, AGENTS.md and .gitignore offline",
    "  invite  Builds a Fluxer bot installation URL offline from an application ID",
    "",
    "Options for init:",
    "  --template js|ts|effect  Writes the JavaScript, TypeScript or Effect starter without asking. Without this",
    "                           option, init asks in a terminal and writes the JavaScript starter otherwise",
    "  --dir <folder>           Writes the starter into <folder>, creating it if needed",
    "  --pm npm|pnpm|bun        Selects the package manager instead of detecting the launcher",
    "  --no-install             Skips the install and prints the install commands, for offline or CI use",
    "",
    "Options for agents:",
    "  --target agents|skill|cursor|claude|gemini|all  Chooses which agent instruction files to write",
    "  --check                  Exits non-zero when AGENTS.md is missing or out of date",
    "  --print                  Prints the Fluxerly rules section without modifying files",
    "",
    "Options for doctor:",
    "  --json                   Prints structured JSON check results",
    "",
    "Options for invite:",
    "  <applicationId>          Decimal Fluxer application ID",
    "  --permissions <value>    Comma-separated permission names or a decimal bitfield",
].join("\n")
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
} else if (command === "agents") {
    const outcome = runAgentsCommand(rest, {
        project: process.cwd(),
        packageRoot,
        output: process.stdout,
        errorOutput: process.stderr,
    })
    if (outcome === "usage") console.error(usage)
    process.exitCode = outcome === 0 ? 0 : 1
} else if (command === "doctor") {
    const outcome = runDoctor(rest, {
        project: process.cwd(),
        packageRoot,
        output: process.stdout,
        errorOutput: process.stderr,
    })
    if (outcome === "usage") console.error(usage)
    process.exitCode = outcome === 0 ? 0 : 1
} else if (command === "invite") {
    const outcome = runInvite(rest, {
        output: process.stdout,
        errorOutput: process.stderr,
    })
    if (outcome === "usage") console.error(usage)
    process.exitCode = outcome === 0 ? 0 : 1
} else if (command === "--help" || command === "-h") console.log(usage)
else {
    console.error(usage)
    process.exitCode = 1
}
