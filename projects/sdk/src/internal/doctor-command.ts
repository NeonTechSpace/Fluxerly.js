/**
 * Runs `fluxerly doctor [--json]`: An offline environment and project verifier for Fluxerly bots.
 * Checks Node.js version, ESM module setup, installed SDK/TypeScript/Effect versions, AGENTS.md freshness,
 * .gitignore protection and .env key presence without reading or exposing secret values or contacting Fluxer
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { checkAgentsSection } from "./agents-section.js"

export type DoctorStatus = "pass" | "warn" | "fail"

export interface DoctorCheck {
    readonly id: string
    readonly status: DoctorStatus
    readonly message: string
    readonly fix?: string
}

export interface DoctorReport {
    readonly ok: boolean
    readonly checks: readonly DoctorCheck[]
}

export interface DoctorEnvironment {
    readonly project: string
    readonly packageRoot: string
    readonly nodeVersion?: string
    readonly output: NodeJS.WritableStream
    readonly errorOutput: NodeJS.WritableStream
}

const minimumNode = { major: 24, minor: 15 } as const

function parseVersionPair(version: string): readonly [number, number] | undefined {
    const cleaned = version.replace(/^[v^~>=<\s]+/, "")
    const [major = Number.NaN, minor = Number.NaN] = cleaned.split(".").map(Number)
    if (!Number.isInteger(major) || !Number.isInteger(minor)) return undefined
    return [major, minor]
}

function readJson(path: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined
    } catch {
        // allow-silent: Doctor reports unreadable or malformed JSON through its own structured check
        return undefined
    }
}

function dependencyRange(manifest: Record<string, unknown>, name: string): string | undefined {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const group = manifest[field]
        if (typeof group === "object" && group !== null && !Array.isArray(group)) {
            const value = (group as Record<string, unknown>)[name]
            if (typeof value === "string") return value
        }
    }
    return undefined
}

function hasTypeScriptSources(project: string): boolean {
    if (existsSync(join(project, "tsconfig.json"))) return true
    try {
        return readdirSync(project).some((name) => name.endsWith(".ts") || name.endsWith(".mts"))
    } catch {
        // allow-silent: An unreadable folder is reported by the manifest check below
        return false
    }
}

function hasEnvToken(project: string): "missing" | "empty" | "set" {
    const envPath = join(project, ".env")
    if (!existsSync(envPath)) return "missing"
    const text = readFileSync(envPath, "utf8")
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith("#")) continue
        const match = /^(?:export\s+)?FLUXER_BOT_TOKEN\s*=\s*(.*)$/.exec(line)
        if (!match) continue
        const rawValue = (match[1] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2")
        return rawValue.length > 0 ? "set" : "empty"
    }
    return "empty"
}

function checkNode(nodeVersion: string): DoctorCheck {
    const parsed = parseVersionPair(nodeVersion)
    if (!parsed) return { id: "node", status: "warn", message: `Could not parse Node.js version ${nodeVersion}` }
    const [major, minor] = parsed
    if (major > minimumNode.major || (major === minimumNode.major && minor >= minimumNode.minor))
        return {
            id: "node",
            status: "pass",
            message: `Node.js ${nodeVersion} meets >=${minimumNode.major}.${minimumNode.minor}.0`,
        }
    return {
        id: "node",
        status: "fail",
        message: `Node.js ${nodeVersion} is below the required ${minimumNode.major}.${minimumNode.minor}.0`,
        fix: `Install Node.js ${minimumNode.major}.${minimumNode.minor} or newer from https://nodejs.org`,
    }
}

function checkTypeScript(project: string, manifest: Record<string, unknown>): readonly DoctorCheck[] {
    if (!hasTypeScriptSources(project)) return []
    const checks: DoctorCheck[] = []
    const tsRange = dependencyRange(manifest, "typescript")
    const tsMajor = tsRange ? parseVersionPair(tsRange)?.[0] : undefined
    if (tsRange === undefined)
        checks.push({
            id: "typescript",
            status: "warn",
            message:
                "TypeScript is not listed in package.json (Node.js runs .ts files, but type checking needs TypeScript 7)",
            fix: "Install typescript@7 and @types/node as development dependencies",
        })
    else if (tsMajor !== undefined && tsMajor < 7)
        checks.push({
            id: "typescript",
            status: "fail",
            message: `TypeScript range ${tsRange} targets TypeScript ${tsMajor}, while Fluxerly requires TypeScript 7`,
            fix: "Upgrade typescript to TypeScript 7",
        })
    else checks.push({ id: "typescript", status: "pass", message: `TypeScript ${tsRange} is declared` })

    const typesNode = dependencyRange(manifest, "@types/node")
    if (typesNode === undefined)
        checks.push({
            id: "types-node",
            status: "fail",
            message:
                "@types/node is missing from package.json (required for AbortSignal and AsyncDisposable in SDK types)",
            fix: "Install @types/node as a development dependency",
        })
    else checks.push({ id: "types-node", status: "pass", message: `@types/node ${typesNode} is declared` })

    return checks
}

function checkEffectPeer(
    manifest: Record<string, unknown>,
    sdkManifest: Record<string, unknown> | undefined,
): DoctorCheck | undefined {
    const effectRange = dependencyRange(manifest, "effect")
    if (effectRange === undefined) return undefined
    const rawPeer =
        typeof sdkManifest?.peerDependencies === "object" && sdkManifest.peerDependencies !== null
            ? (sdkManifest.peerDependencies as Record<string, unknown>).effect
            : undefined
    const peerRange = typeof rawPeer === "string" ? rawPeer : "^4"
    const installedMajor = parseVersionPair(effectRange)?.[0]
    if (installedMajor !== undefined && installedMajor !== 4)
        return {
            id: "effect",
            status: "fail",
            message: `Effect range ${effectRange} does not match Fluxerly's Effect 4 peer requirement (${peerRange})`,
            fix: `Install effect matching ${peerRange}`,
        }
    return { id: "effect", status: "pass", message: `Effect ${effectRange} is declared` }
}

function checkGitignore(project: string): DoctorCheck {
    const gitignorePath = join(project, ".gitignore")
    if (!existsSync(gitignorePath))
        return {
            id: "gitignore",
            status: "warn",
            message: ".gitignore is missing",
            fix: "Add node_modules and .env to .gitignore so secrets stay out of version control",
        }
    const lines = readFileSync(gitignorePath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
    const missing = ["node_modules", ".env"].filter((entry) => !lines.includes(entry))
    if (missing.length > 0)
        return {
            id: "gitignore",
            status: "warn",
            message: `.gitignore does not list ${missing.join(" and ")}`,
            fix: `Add ${missing.join(" and ")} to .gitignore`,
        }
    return { id: "gitignore", status: "pass", message: ".gitignore covers node_modules and .env" }
}

function checkAgents(project: string, packageRoot: string): DoctorCheck {
    const status = checkAgentsSection(project, packageRoot)
    if (status === "current") return { id: "agents", status: "pass", message: "AGENTS.md Fluxerly section is current" }
    if (status === "broken")
        return {
            id: "agents",
            status: "fail",
            message: "AGENTS.md has malformed Fluxerly markers",
            fix: "Repair the <!-- fluxerly:start --> and <!-- fluxerly:end --> markers and run fluxerly agents",
        }
    return {
        id: "agents",
        status: "warn",
        message:
            status === "missing" ? "AGENTS.md has no Fluxerly section" : "AGENTS.md Fluxerly section is out of date",
        fix: "Run fluxerly agents to sync the installed SDK's rules into AGENTS.md",
    }
}

/** Collect all offline doctor checks for one project folder */
export function inspectProject(
    project: string,
    packageRoot: string,
    nodeVersion = process.versions.node,
): DoctorReport {
    const checks: DoctorCheck[] = [checkNode(nodeVersion)]
    const sdkManifest = readJson(join(packageRoot, "package.json"))
    const manifestPath = join(project, "package.json")
    const manifest = existsSync(manifestPath) ? readJson(manifestPath) : undefined

    if (!existsSync(manifestPath))
        checks.push({
            id: "package-json",
            status: "fail",
            message: "package.json was not found in the current folder",
            fix: 'Run fluxerly init or create a package.json with "type": "module"',
        })
    else if (!manifest)
        checks.push({
            id: "package-json",
            status: "fail",
            message: "package.json could not be parsed as a JSON object",
            fix: "Fix the JSON syntax in package.json",
        })
    else {
        if (manifest.type === "module")
            checks.push({ id: "esm", status: "pass", message: 'package.json enables ESM ("type": "module")' })
        else
            checks.push({
                id: "esm",
                status: "fail",
                message: 'package.json does not set "type": "module" (Fluxerly is ESM-only)',
                fix: 'Set "type": "module" in package.json',
            })

        const sdkRange = dependencyRange(manifest, "@neontechspace/fluxerly")
        if (sdkRange === undefined)
            checks.push({
                id: "sdk-dependency",
                status: "warn",
                message: "@neontechspace/fluxerly is not listed in package.json",
                fix: "Install @neontechspace/fluxerly in this project",
            })
        else
            checks.push({
                id: "sdk-dependency",
                status: "pass",
                message: `@neontechspace/fluxerly ${sdkRange} is declared`,
            })

        checks.push(...checkTypeScript(project, manifest))
        const effectCheck = checkEffectPeer(manifest, sdkManifest)
        if (effectCheck) checks.push(effectCheck)
    }

    checks.push(checkAgents(project, packageRoot))
    checks.push(checkGitignore(project))

    const tokenState = hasEnvToken(project)
    if (tokenState === "set")
        checks.push({ id: "env-token", status: "pass", message: "FLUXER_BOT_TOKEN is set in .env" })
    else
        checks.push({
            id: "env-token",
            status: "warn",
            message:
                tokenState === "missing"
                    ? ".env was not found (not needed for createTestBot tests, required to connect)"
                    : "FLUXER_BOT_TOKEN is empty in .env (not needed for createTestBot tests, required to connect)",
            fix: "Set FLUXER_BOT_TOKEN in .env before running the bot against Fluxer",
        })

    return { ok: checks.every((check) => check.status !== "fail"), checks }
}

/** Run `fluxerly doctor [--json]` and return its exit code or "usage" */
export function runDoctor(args: readonly string[], environment: DoctorEnvironment): 0 | 1 | "usage" {
    let asJson = false
    for (const arg of args) {
        if (arg === "--json" && !asJson) asJson = true
        else return "usage"
    }
    const report = inspectProject(environment.project, environment.packageRoot, environment.nodeVersion)
    if (asJson) {
        environment.output.write(`${JSON.stringify(report, null, 2)}\n`)
        return report.ok ? 0 : 1
    }
    const labels: Record<DoctorStatus, string> = { pass: "OK  ", warn: "WARN", fail: "FAIL" }
    for (const check of report.checks) {
        environment.output.write(`[${labels[check.status]}] ${check.message}\n`)
        if (check.fix) environment.output.write(`       Fix: ${check.fix}\n`)
    }
    return report.ok ? 0 : 1
}
