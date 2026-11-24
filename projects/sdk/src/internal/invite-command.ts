/**
 * Runs `fluxerly invite <applicationId> [--permissions <names-or-decimal>]`: Builds a Fluxer bot installation URL
 * offline using the SDK's own link and permission-bit helpers
 */

import { Permissions } from "../guilds.js"
import { HelperError, links, permissionBits, type PermissionName } from "../helpers.js"
import { createCliTheme, type CliStreamLike } from "./cli-theme.js"
import { closestMatch } from "./suggest.js"

export interface InviteEnvironment {
    readonly output: NodeJS.WritableStream & CliStreamLike
    readonly errorOutput: NodeJS.WritableStream & CliStreamLike
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly platform?: NodeJS.Platform
}

const permissionCandidates: readonly (readonly [string, string])[] = Object.keys(Permissions).map(
    (name) => [name.toLowerCase(), name] as const,
)

interface PermissionParseError {
    readonly error: string
    readonly hint: string
}

function parsePermissions(raw: string): bigint | PermissionParseError {
    const trimmed = raw.trim()
    if (!trimmed)
        return {
            error: "Permissions value cannot be empty",
            hint: "Pass comma-separated permission names such as --permissions ViewChannel,SendMessages or a decimal bitfield",
        }
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed)
    const names = trimmed
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    if (names.length === 0)
        return {
            error: "Permissions list cannot be empty",
            hint: "Pass comma-separated permission names such as --permissions ViewChannel,SendMessages or a decimal bitfield",
        }
    const unknown = names.filter((name) => !Object.hasOwn(Permissions, name))
    if (unknown.length > 0) {
        const suggestions = unknown.flatMap((name) => {
            const match = name.length > 64 ? undefined : closestMatch(name.toLowerCase(), permissionCandidates)
            return match ? [`${JSON.stringify(match)} for ${JSON.stringify(name)}`] : []
        })
        const didYouMean =
            suggestions.length === 1 && unknown.length === 1
                ? `Did you mean ${suggestions[0]!.split(" for ")[0]}? `
                : suggestions.length > 0
                  ? `Did you mean ${suggestions.join(", ")}? `
                  : ""
        return {
            error: `Unknown permission names: ${unknown.join(", ")}`,
            hint: `${didYouMean}Example: --permissions ViewChannel,SendMessages,ReadMessageHistory`,
        }
    }
    return permissionBits.from(names as PermissionName[])
}

function parseInviteArguments(
    args: readonly string[],
): { readonly applicationId: string; readonly rawPermissions?: string } | { readonly error: string } {
    let applicationId: string | undefined
    let rawPermissions: string | undefined
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (arg === "--permissions") {
            if (rawPermissions !== undefined) return { error: "The --permissions option was passed more than once" }
            const next = args[index + 1]
            if (next === undefined)
                return {
                    error: "Missing value for --permissions. Pass comma-separated permission names such as ViewChannel,SendMessages or a decimal bitfield",
                }
            rawPermissions = next
            index++
        } else if (arg !== undefined && arg.startsWith("-")) return { error: `Unknown option "${arg}" for invite` }
        else if (arg !== undefined && applicationId === undefined) applicationId = arg
        else return { error: `Unexpected argument "${arg ?? ""}". Pass only one <applicationId>` }
    }
    if (applicationId === undefined) return { error: "Missing required <applicationId> argument" }
    return rawPermissions === undefined ? { applicationId } : { applicationId, rawPermissions }
}

/** Run `fluxerly invite` and return its exit code or "usage" */
export function runInvite(args: readonly string[], environment: InviteEnvironment): 0 | 1 | "usage" {
    const outTheme = createCliTheme(environment.output, { env: environment.env, platform: environment.platform })
    const errTheme = createCliTheme(environment.errorOutput, { env: environment.env, platform: environment.platform })
    const writeError = (message: string, hint?: string) => {
        if (errTheme.capabilities.color === "none") {
            environment.errorOutput.write(`${message}\n`)
            if (hint !== undefined) environment.errorOutput.write(`Hint: ${hint}\n`)
            return
        }
        environment.errorOutput.write(`${errTheme.error(`${errTheme.symbols.fail} ${message}`)}\n`)
        if (hint !== undefined) environment.errorOutput.write(`  ${errTheme.muted(`Hint: ${hint}`)}\n`)
    }

    const parsedArgs = parseInviteArguments(args)
    if ("error" in parsedArgs) {
        writeError(parsedArgs.error)
        return "usage"
    }

    let permissions: bigint | undefined
    if (parsedArgs.rawPermissions !== undefined) {
        const parsed = parsePermissions(parsedArgs.rawPermissions)
        if (typeof parsed !== "bigint") {
            writeError(parsed.error, parsed.hint)
            return 1
        }
        permissions = parsed
    }

    try {
        const url =
            permissions === undefined
                ? links.installation(parsedArgs.applicationId)
                : links.installation(parsedArgs.applicationId, { permissions })
        environment.output.write(`${outTheme.capabilities.color === "none" ? url : outTheme.cyan(url)}\n`)
        return 0
    } catch (error) {
        if (!(error instanceof HelperError)) throw error
        writeError(error.message, error.hint)
        return 1
    }
}
