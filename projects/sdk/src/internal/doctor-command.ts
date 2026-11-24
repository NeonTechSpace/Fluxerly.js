/**
 * Runs `fluxerly doctor [--json]`: An offline environment and project verifier for Fluxerly bots.
 * Checks Node.js version, ESM module setup, installed SDK/TypeScript/Effect versions, AGENTS.md freshness,
 * .gitignore protection and .env key presence without reading or exposing secret values or contacting Fluxer
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { checkAgentsSection, localAgentsCommand } from "./agents-section.js"
import { createCliTheme, type CliStreamLike } from "./cli-theme.js"

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

export interface ProjectFacts {
    readonly cliVersion: string | undefined
    readonly installedSdkVersion: string | undefined
    readonly installedSdkPath: string | undefined
    readonly installedSdkSourcePath: string | undefined
    readonly installedAgentsGuidePath: string | undefined
    readonly installedEffectVersion: string | undefined
    readonly installedTypeScriptVersion: string | undefined
    readonly installedTypesNodeVersion: string | undefined
    readonly packageManager: "pnpm" | "bun" | "npm"
    readonly hasTsConfig: boolean
    readonly doctor: DoctorReport
}

export interface DoctorEnvironment {
    readonly project: string
    readonly packageRoot: string
    readonly nodeVersion?: string
    readonly output: NodeJS.WritableStream & CliStreamLike
    readonly errorOutput: NodeJS.WritableStream & CliStreamLike
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly platform?: NodeJS.Platform
}

const minimumNode = { major: 26, minor: 13 } as const

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

/** Parse JSON with // or /* comments and trailing commas (used by tsconfig.json) */
function readJsonc(path: string): Record<string, unknown> | undefined {
    try {
        const raw = readFileSync(path, "utf8")
        let stripped = ""
        let inString = false
        let escaped = false
        for (let index = 0; index < raw.length; index += 1) {
            const ch = raw[index]!
            const next = raw[index + 1]
            if (inString) {
                stripped += ch
                if (escaped) escaped = false
                else if (ch === "\\") escaped = true
                else if (ch === '"') inString = false
                continue
            }
            if (ch === '"') {
                inString = true
                stripped += ch
                continue
            }
            if (ch === "/" && next === "/") {
                while (index < raw.length && raw[index] !== "\n") index += 1
                stripped += "\n"
                continue
            }
            if (ch === "/" && next === "*") {
                index += 2
                while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) index += 1
                index += 1
                continue
            }
            stripped += ch
        }
        const withoutTrailingCommas = stripped.replace(/,\s*([}\]])/g, "$1")
        const parsed: unknown = JSON.parse(withoutTrailingCommas)
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined
    } catch {
        // allow-silent: Doctor reports malformed tsconfig.json through its own check
        return undefined
    }
}

function installedPackageVersion(project: string, packageName: string): string | undefined {
    const manifest = readJson(join(project, "node_modules", ...packageName.split("/"), "package.json"))
    return typeof manifest?.version === "string" ? manifest.version : undefined
}

function detectPackageManager(project: string): "pnpm" | "bun" | "npm" {
    if (existsSync(join(project, "pnpm-lock.yaml"))) return "pnpm"
    if (existsSync(join(project, "bun.lock")) || existsSync(join(project, "bun.lockb"))) return "bun"
    return "npm"
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

function hasEnvToken(project: string): "missing" | "empty" | "scheme" | "set" {
    const envPath = join(project, ".env")
    if (!existsSync(envPath)) return "missing"
    const text = readFileSync(envPath, "utf8")
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith("#")) continue
        const match = /^(?:export\s+)?FLUXER_BOT_TOKEN\s*=\s*(.*)$/.exec(line)
        if (!match) continue
        const rawValue = (match[1] ?? "")
            .trim()
            .replace(/^(['"])(.*)\1$/, "$2")
            .trim()
        if (rawValue.length === 0) return "empty"
        if (/^(?:bot|bearer)\s+/i.test(rawValue)) return "scheme"
        return "set"
    }
    return "empty"
}

function checkNode(nodeVersion: string): DoctorCheck {
    const parsed = parseVersionPair(nodeVersion)
    if (!parsed)
        return {
            id: "node",
            status: "warn",
            message: `Could not parse Node.js version ${nodeVersion}`,
            fix: `Verify node -v reports Node.js ${minimumNode.major}.${minimumNode.minor}.0 or newer`,
        }
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

function checkTsConfig(project: string): readonly DoctorCheck[] {
    const tsConfigPath = join(project, "tsconfig.json")
    if (!existsSync(tsConfigPath)) return []
    const parsed = readJsonc(tsConfigPath)
    if (!parsed)
        return [
            {
                id: "tsconfig",
                status: "fail",
                message: "tsconfig.json could not be parsed as JSON",
                fix: "Fix the syntax errors in tsconfig.json",
            },
        ]
    const options =
        typeof parsed.compilerOptions === "object" &&
        parsed.compilerOptions !== null &&
        !Array.isArray(parsed.compilerOptions)
            ? (parsed.compilerOptions as Record<string, unknown>)
            : undefined
    if (!options) return []

    const checks: DoctorCheck[] = []
    if (typeof options.module === "string" && options.module.toLowerCase() === "commonjs")
        checks.push({
            id: "tsconfig-module",
            status: "fail",
            message: "tsconfig.json sets compilerOptions.module to CommonJS, while Fluxerly is ESM-only",
            fix: 'Set compilerOptions.module to "NodeNext" in tsconfig.json',
        })
    if (Array.isArray(options.types) && !options.types.includes("node"))
        checks.push({
            id: "tsconfig-types",
            status: "fail",
            message: 'tsconfig.json sets compilerOptions.types without "node"',
            fix: 'Include "node" in compilerOptions.types so AbortSignal and AsyncDisposable resolve',
        })
    if (options.strict !== true)
        checks.push({
            id: "tsconfig-strict",
            status: "warn",
            message: "tsconfig.json does not enable compilerOptions.strict",
            fix: 'Set "strict": true in tsconfig.json so Result and Effect failure narrowing stays sound',
        })
    if (options.noEmit === true && options.erasableSyntaxOnly !== true)
        checks.push({
            id: "tsconfig-erasable",
            status: "warn",
            message:
                "tsconfig.json does not enable compilerOptions.erasableSyntaxOnly for direct Node.js TypeScript runs",
            fix: 'Set "erasableSyntaxOnly": true and "verbatimModuleSyntax": true in tsconfig.json',
        })
    if (checks.length === 0)
        checks.push({
            id: "tsconfig",
            status: "pass",
            message: "tsconfig.json settings match Fluxerly's ESM and Node.js defaults",
        })
    return checks
}

function checkInstalledVersions(
    project: string,
    manifest: Record<string, unknown>,
    sdkManifest: Record<string, unknown> | undefined,
): readonly DoctorCheck[] {
    const checks: DoctorCheck[] = []
    const declaresSdk = dependencyRange(manifest, "@neontechspace/fluxerly") !== undefined
    if (!existsSync(join(project, "node_modules"))) {
        if (declaresSdk) {
            const pm = detectPackageManager(project)
            checks.push({
                id: "installed-sdk",
                status: "warn",
                message: "Dependencies are not installed in node_modules yet",
                fix: `Run ${pm} install before running or type-checking the bot`,
            })
        }
        return checks
    }
    if (declaresSdk && installedPackageVersion(project, "@neontechspace/fluxerly") === undefined) {
        const pm = detectPackageManager(project)
        checks.push({
            id: "installed-sdk",
            status: "fail",
            message: "@neontechspace/fluxerly is declared in package.json but missing from node_modules",
            fix: `Run ${pm} install to populate node_modules/@neontechspace/fluxerly`,
        })
    }
    const installedEffect = installedPackageVersion(project, "effect")
    if (installedEffect !== undefined) {
        const major = parseVersionPair(installedEffect)?.[0]
        const rawPeer =
            typeof sdkManifest?.peerDependencies === "object" && sdkManifest.peerDependencies !== null
                ? (sdkManifest.peerDependencies as Record<string, unknown>).effect
                : undefined
        const peerRange = typeof rawPeer === "string" ? rawPeer : "^4"
        if (major !== undefined && major !== 4)
            checks.push({
                id: "installed-effect",
                status: "fail",
                message: `Installed node_modules/effect is ${installedEffect}, outside Fluxerly's Effect 4 peer range (${peerRange})`,
                fix: `Install effect matching ${peerRange} and refresh node_modules`,
            })
    }
    const installedTs = installedPackageVersion(project, "typescript")
    if (installedTs !== undefined) {
        const major = parseVersionPair(installedTs)?.[0]
        if (major !== undefined && major < 7)
            checks.push({
                id: "installed-typescript",
                status: "fail",
                message: `Installed node_modules/typescript is ${installedTs}, while Fluxerly requires TypeScript 7`,
                fix: "Upgrade typescript to TypeScript 7 and reinstall dependencies",
            })
    }
    return checks
}

const skippedSourceDirs = new Set(["node_modules", ".git", "dist", "build", "coverage", ".astro", ".next"])
const sourceFilePattern = /\.(?:[cm]?[jt]s)$/
const requireSdkPattern = /\brequire\s*\(\s*["']@neontechspace\/fluxerly(?:\/[^"']*)?["']\s*\)/
const deepSdkImportPattern = /["']@neontechspace\/fluxerly\/(?:dist|src)\/[^"']*["']/

function collectProjectSourceFiles(root: string, maxFiles = 100): readonly string[] {
    const found: string[] = []
    const queue: { readonly dir: string; readonly depth: number }[] = [{ dir: root, depth: 0 }]
    while (queue.length > 0 && found.length < maxFiles) {
        const current = queue.shift()!
        let entries
        try {
            entries = readdirSync(current.dir, { withFileTypes: true })
        } catch {
            // allow-silent: Unreadable folders are skipped during best-effort static import scan
            continue
        }
        for (const entry of entries) {
            if (found.length >= maxFiles) break
            if (entry.isDirectory()) {
                if (current.depth < 3 && !skippedSourceDirs.has(entry.name) && !entry.name.startsWith("."))
                    queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
                continue
            }
            if (entry.isFile() && sourceFilePattern.test(entry.name)) found.push(join(current.dir, entry.name))
        }
    }
    return found
}

function checkSourceImports(project: string): readonly DoctorCheck[] {
    const files = collectProjectSourceFiles(project)
    const requireMatches: string[] = []
    const deepMatches: string[] = []
    for (const file of files) {
        let content: string
        try {
            content = readFileSync(file, "utf8")
        } catch {
            // allow-silent: Unreadable files are skipped during best-effort static import scan
            continue
        }
        if (content.length > 256_000 || !content.includes("@neontechspace/fluxerly")) continue
        const rel = file.startsWith(project) ? file.slice(project.length).replace(/^[/\\]/, "") : file
        if (requireSdkPattern.test(content)) requireMatches.push(rel)
        if (deepSdkImportPattern.test(content)) deepMatches.push(rel)
    }
    const checks: DoctorCheck[] = []
    if (requireMatches.length > 0)
        checks.push({
            id: "source-require",
            status: "fail",
            message: `CommonJS require("@neontechspace/fluxerly") found in ${requireMatches.slice(0, 3).join(", ")} (Fluxerly is ESM-only)`,
            fix: 'Replace require() with import from "@neontechspace/fluxerly"',
        })
    if (deepMatches.length > 0)
        checks.push({
            id: "source-deep-import",
            status: "fail",
            message: `Deep internal SDK import (/dist/ or /src/) found in ${deepMatches.slice(0, 3).join(", ")}`,
            fix: 'Import only from "@neontechspace/fluxerly", "@neontechspace/fluxerly/effect", "@neontechspace/fluxerly/testing" or "@neontechspace/fluxerly/effect/testing"',
        })
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
    const command = localAgentsCommand(project)
    if (status === "broken")
        return {
            id: "agents",
            status: "fail",
            message: "AGENTS.md has malformed Fluxerly markers",
            fix: `Repair the <!-- fluxerly:start --> and <!-- fluxerly:end --> markers and run ${command}`,
        }
    return {
        id: "agents",
        status: "warn",
        message:
            status === "missing" ? "AGENTS.md has no Fluxerly section" : "AGENTS.md Fluxerly section is out of date",
        fix: `Run ${command} to sync the installed SDK's rules into AGENTS.md`,
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
        checks.push(...checkTsConfig(project))
        const effectCheck = checkEffectPeer(manifest, sdkManifest)
        if (effectCheck) checks.push(effectCheck)
        checks.push(...checkInstalledVersions(project, manifest, sdkManifest))
    }

    checks.push(...checkSourceImports(project))
    checks.push(checkAgents(project, packageRoot))
    checks.push(checkGitignore(project))

    const tokenState = hasEnvToken(project)
    if (tokenState === "set")
        checks.push({ id: "env-token", status: "pass", message: "FLUXER_BOT_TOKEN is set in .env" })
    else if (tokenState === "scheme")
        checks.push({
            id: "env-token",
            status: "fail",
            message: 'FLUXER_BOT_TOKEN in .env starts with a "Bot " or "Bearer " prefix',
            fix: "Store only the raw bot token in .env without a Bot or Bearer prefix",
        })
    else
        checks.push({
            id: "env-token",
            status: "warn",
            message:
                tokenState === "missing"
                    ? ".env was not found (not needed for createTestBot tests, required to connect)"
                    : "FLUXER_BOT_TOKEN is empty in .env (not needed for createTestBot tests, required to connect)",
            fix:
                tokenState === "missing"
                    ? "Create .env with FLUXER_BOT_TOKEN=... and run with node --env-file=.env"
                    : "Set FLUXER_BOT_TOKEN in .env before running the bot against Fluxer",
        })

    return { ok: checks.every((check) => check.status !== "fail"), checks }
}

/** Collect redacted static project facts and doctor findings for offline checks and `fluxerly triage` */
export function collectProjectFacts(
    project: string,
    packageRoot: string,
    nodeVersion = process.versions.node,
): ProjectFacts {
    const cliManifest = readJson(join(packageRoot, "package.json"))
    const cliVersion = typeof cliManifest?.version === "string" ? cliManifest.version : undefined
    const installedSdkDir = join(project, "node_modules", "@neontechspace", "fluxerly")
    const installedSdkExists = existsSync(join(installedSdkDir, "package.json"))
    const installedSdkVersion = installedSdkExists
        ? installedPackageVersion(project, "@neontechspace/fluxerly")
        : undefined
    const sdkRoot = installedSdkExists ? installedSdkDir : packageRoot
    const sourcePath = join(sdkRoot, "src")
    const agentsPath = join(sdkRoot, "agents", "AGENTS.md")
    return {
        cliVersion,
        installedSdkVersion,
        installedSdkPath: installedSdkExists ? installedSdkDir : undefined,
        installedSdkSourcePath: existsSync(sourcePath) ? sourcePath : undefined,
        installedAgentsGuidePath: existsSync(agentsPath) ? agentsPath : undefined,
        installedEffectVersion: installedPackageVersion(project, "effect"),
        installedTypeScriptVersion: installedPackageVersion(project, "typescript"),
        installedTypesNodeVersion: installedPackageVersion(project, "@types/node"),
        packageManager: detectPackageManager(project),
        hasTsConfig: existsSync(join(project, "tsconfig.json")),
        doctor: inspectProject(project, packageRoot, nodeVersion),
    }
}

/** Run `fluxerly doctor [--json]` and return its exit code or "usage" */
export function runDoctor(args: readonly string[], environment: DoctorEnvironment): 0 | 1 | "usage" {
    const errTheme = createCliTheme(environment.errorOutput, { env: environment.env, platform: environment.platform })
    const writeError = (message: string) =>
        environment.errorOutput.write(
            errTheme.capabilities.color === "none"
                ? `${message}\n`
                : `${errTheme.error(`${errTheme.symbols.fail} ${message}`)}\n`,
        )

    let asJson = false
    for (const arg of args) {
        if (arg === "--json") {
            if (asJson) {
                writeError("The --json option was passed more than once")
                return "usage"
            }
            asJson = true
        } else {
            writeError(`Unknown argument "${arg}" for doctor. Only --json is supported`)
            return "usage"
        }
    }
    const report = inspectProject(environment.project, environment.packageRoot, environment.nodeVersion)
    if (asJson) {
        environment.output.write(`${JSON.stringify(report, null, 2)}\n`)
        return report.ok ? 0 : 1
    }
    const theme = createCliTheme(environment.output, { env: environment.env, platform: environment.platform })
    if (theme.capabilities.color === "none") {
        const labels: Record<DoctorStatus, string> = { pass: "OK  ", warn: "WARN", fail: "FAIL" }
        for (const check of report.checks) {
            environment.output.write(`[${labels[check.status]}] ${check.message}\n`)
            if (check.fix) environment.output.write(`       Fix: ${check.fix}\n`)
        }
        return report.ok ? 0 : 1
    }

    const sdkManifest = readJson(join(environment.packageRoot, "package.json"))
    const version = typeof sdkManifest?.version === "string" ? sdkManifest.version : undefined
    const banner = theme.renderBanner({
        version,
        subtitle: "Offline project check",
        detail: environment.project,
        hint: "Offline only. No network calls and secrets stay hidden",
    })
    if (banner) environment.output.write(`${banner}\n`)

    const badges: Record<DoctorStatus, string> = {
        pass: theme.success(`${theme.symbols.pass} OK  `),
        warn: theme.gold(`${theme.symbols.warn} WARN`),
        fail: theme.error(`${theme.symbols.fail} FAIL`),
    }
    for (const check of report.checks) {
        environment.output.write(`${badges[check.status]}  ${check.message}\n`)
        if (check.fix) environment.output.write(`        ${theme.faint("Fix:")} ${theme.muted(check.fix)}\n`)
    }
    const passed = report.checks.filter((check) => check.status === "pass").length
    const warnings = report.checks.filter((check) => check.status === "warn").length
    const failed = report.checks.filter((check) => check.status === "fail").length
    const summaryParts = [
        theme.success(`${passed} passed`),
        warnings > 0 ? theme.gold(`${warnings} warning${warnings === 1 ? "" : "s"}`) : theme.faint("0 warnings"),
        failed > 0 ? theme.error(`${failed} failed`) : theme.faint("0 failed"),
    ]
    environment.output.write(`\n${summaryParts.join(theme.faint("  "))}\n`)
    return report.ok ? 0 : 1
}
