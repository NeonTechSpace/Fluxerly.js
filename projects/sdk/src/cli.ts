#!/usr/bin/env node
/**
 * The `fluxerly` command installed with the package.
 * `fluxerly init` writes a JavaScript, TypeScript or Effect starter bot project without replacing existing files,
 * then installs its dependencies.
 * `fluxerly agents` adds or checks the SDK's rules for coding agents in AGENTS.md, skills or tool rule files.
 * `fluxerly doctor` verifies a bot project's Node.js, ESM, TypeScript, Effect and hygiene settings offline.
 * `fluxerly triage` starts a coding agent with redacted project facts and Fluxerly's triage playbook.
 * `fluxerly invite` builds a Fluxer bot installation URL offline
 */

import "./internal/node-version.js"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { CliStreamLike } from "./internal/cli-theme.js"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

function readPackageVersion(): string | undefined {
    try {
        const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown }
        return typeof parsed.version === "string" ? parsed.version : undefined
    } catch {
        // allow-silent: CLI help still prints cleanly if package metadata cannot be read
        return undefined
    }
}

const commandRows = [
    ["init", "Writes a starter bot without replacing existing files, and installs its dependencies"],
    ["agents", "Adds, refreshes or checks Fluxerly rules for coding agents"],
    ["doctor", "Runs offline static checks on Node.js, ESM, tsconfig.json, Effect, AGENTS.md and .gitignore"],
    ["triage", "Investigates a bot or SDK issue with your coding agent (or prints a redacted triage brief)"],
    ["invite", "Builds a Fluxer bot installation URL offline from an application ID"],
] as const

const optionGroups: readonly {
    readonly heading: string
    readonly rows: readonly (readonly [flag: string, description: string, continuation?: string])[]
}[] = [
    {
        heading: "Options for init:",
        rows: [
            [
                "--template js|ts|effect",
                "Writes the JavaScript, TypeScript or Effect starter without asking. Without this",
                "option, init asks in a terminal and writes the JavaScript starter otherwise",
            ],
            ["--dir <folder>", "Writes the starter into <folder>, creating it if needed"],
            ["--pm npm|pnpm|bun", "Selects the package manager instead of detecting the launcher"],
            ["--no-install", "Skips the install and prints the install commands, for offline or CI use"],
        ],
    },
    {
        heading: "Options for agents:",
        rows: [
            ["--target agents|skill|cursor|claude|gemini|all", "Chooses which agent instruction files to write"],
            ["--check", "Exits non-zero when AGENTS.md is missing or out of date"],
            ["--print", "Prints the Fluxerly rules section without modifying files"],
        ],
    },
    {
        heading: "Options for doctor:",
        rows: [["--json", "Prints structured JSON check results"]],
    },
    {
        heading: "Options for triage:",
        rows: [
            ["[problem]", "Optional short description of what went wrong to pass into triage context"],
            ["--agent claude|codex|antigravity", "Chooses which installed coding agent CLI to start"],
            ["--model <id>", "Passes a model identifier through to the chosen agent CLI"],
            ["--dir <folder>", "Targets a bot project folder other than the current directory"],
            ["--log <file>", "Includes a redacted tail (up to 16 KB) of a local log file in triage context"],
            ["--run <command>", "Runs <command> once with FLUXERLY_DEBUG=rest,gateway and attaches redacted output"],
            ["--print", "Prints the triage playbook and redacted context without starting an agent"],
        ],
    },
    {
        heading: "Options for invite:",
        rows: [
            ["<applicationId>", "Decimal Fluxer application ID"],
            ["--permissions <value>", "Comma-separated permission names or a decimal bitfield"],
        ],
    },
]

async function formatUsage(stream: NodeJS.WritableStream & CliStreamLike): Promise<string> {
    const { createCliTheme } = await import("./internal/cli-theme.js")
    const theme = createCliTheme(stream)
    const plain = theme.capabilities.color === "none"
    const section = (title: string) => (plain ? title : theme.bold(theme.violet(title)))
    const cmd = (name: string) => (plain ? name : theme.cyan(name))
    const opt = (name: string) => (plain ? name : theme.cyanLight(name))
    const lines: string[] = []

    if (!plain) {
        const banner = theme.renderBanner({
            version: readPackageVersion(),
            subtitle: "Fluxer-native bot SDK CLI",
        })
        if (banner) lines.push(banner.trimEnd(), "")
    }

    lines.push(plain ? "Usage: fluxerly <command>" : `${section("Usage:")} ${cmd("fluxerly")} ${opt("<command>")}`, "")
    lines.push(section("Commands:"))
    for (const [name, description] of commandRows) lines.push(`  ${cmd(name.padEnd(6))}  ${description}`)

    for (const group of optionGroups) {
        lines.push("", section(group.heading))
        for (const row of group.rows) {
            const flag = row[0]
            const description = row[1]
            const continuation = row[2]
            const padded = flag.length < 23 ? flag.padEnd(23) : flag
            lines.push(`  ${opt(padded)}  ${description}`)
            if (continuation) lines.push(`  ${" ".repeat(23)}  ${continuation}`)
        }
    }
    return lines.join("\n")
}

async function writeCliError(message: string): Promise<void> {
    const { createCliTheme } = await import("./internal/cli-theme.js")
    const theme = createCliTheme(process.stderr)
    process.stderr.write(
        theme.capabilities.color === "none" ? `${message}\n` : `${theme.error(`${theme.symbols.fail} ${message}`)}\n`,
    )
}

const [command, ...rest] = process.argv.slice(2)
if (command === "init") {
    const { runInit } = await import("./internal/init-command.js")
    const outcome = await runInit(rest, {
        input: process.stdin,
        output: process.stdout,
        errorOutput: process.stderr,
        project: process.cwd(),
        packageRoot,
        userAgent: process.env.npm_config_user_agent,
    })
    if (outcome === "usage") process.stderr.write(`\n${await formatUsage(process.stderr)}\n`)
    process.exitCode = outcome === 0 ? 0 : 1
} else if (command === "agents") {
    const { runAgentsCommand } = await import("./internal/agents-section.js")
    const outcome = runAgentsCommand(rest, {
        project: process.cwd(),
        packageRoot,
        output: process.stdout,
        errorOutput: process.stderr,
    })
    if (outcome === "usage") process.stderr.write(`\n${await formatUsage(process.stderr)}\n`)
    process.exitCode = outcome === 0 ? 0 : 1
} else if (command === "doctor") {
    const { runDoctor } = await import("./internal/doctor-command.js")
    const outcome = runDoctor(rest, {
        project: process.cwd(),
        packageRoot,
        output: process.stdout,
        errorOutput: process.stderr,
    })
    if (outcome === "usage") process.stderr.write(`\n${await formatUsage(process.stderr)}\n`)
    process.exitCode = outcome === 0 ? 0 : 1
} else if (command === "triage") {
    const { runTriage } = await import("./internal/triage-command.js")
    const outcome = await runTriage(rest, {
        project: process.cwd(),
        packageRoot,
        input: process.stdin,
        output: process.stdout,
        errorOutput: process.stderr,
    })
    if (outcome === "usage") process.stderr.write(`\n${await formatUsage(process.stderr)}\n`)
    process.exitCode = outcome === 0 ? 0 : 1
} else if (command === "invite") {
    const { runInvite } = await import("./internal/invite-command.js")
    const outcome = runInvite(rest, {
        output: process.stdout,
        errorOutput: process.stderr,
    })
    if (outcome === "usage") process.stderr.write(`\n${await formatUsage(process.stderr)}\n`)
    process.exitCode = outcome === 0 ? 0 : 1
} else if (command === "--help" || command === "-h") {
    process.stdout.write(`${await formatUsage(process.stdout)}\n`)
} else if (command === "--version" || command === "-v") {
    const version = readPackageVersion()
    process.stdout.write(`${version ?? "unknown"}\n`)
} else {
    const message =
        command === undefined
            ? "Missing command. Supported commands are init, agents, doctor, triage and invite"
            : `Unknown command "${command}". Supported commands are init, agents, doctor, triage and invite`
    await writeCliError(message)
    process.stderr.write(`\n${await formatUsage(process.stderr)}\n`)
    process.exitCode = 1
}
