/**
 * Runs `fluxerly invite <applicationId> [--permissions <names-or-decimal>]`: Builds a Fluxer bot installation URL
 * offline using the SDK's own link and permission-bit helpers
 */

import { Permissions } from "../guilds.js"
import { HelperError, links, permissionBits, type PermissionName } from "../helpers.js"

export interface InviteEnvironment {
    readonly output: NodeJS.WritableStream
    readonly errorOutput: NodeJS.WritableStream
}

function parsePermissions(raw: string): bigint | string {
    const trimmed = raw.trim()
    if (!trimmed) return "Permissions value cannot be empty"
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed)
    const names = trimmed
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    if (names.length === 0) return "Permissions list cannot be empty"
    const unknown = names.filter((name) => !Object.hasOwn(Permissions, name))
    if (unknown.length > 0) return `Unknown permission names: ${unknown.join(", ")}`
    return permissionBits.from(names as PermissionName[])
}

/** Run `fluxerly invite` and return its exit code or "usage" */
export function runInvite(args: readonly string[], environment: InviteEnvironment): 0 | 1 | "usage" {
    let applicationId: string | undefined
    let rawPermissions: string | undefined
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (arg === "--permissions" && rawPermissions === undefined) {
            const next = args[index + 1]
            if (next === undefined) return "usage"
            rawPermissions = next
            index++
        } else if (arg !== undefined && !arg.startsWith("-") && applicationId === undefined) applicationId = arg
        else return "usage"
    }
    if (applicationId === undefined) return "usage"

    let permissions: bigint | undefined
    if (rawPermissions !== undefined) {
        const parsed = parsePermissions(rawPermissions)
        if (typeof parsed === "string") {
            environment.errorOutput.write(`${parsed}\n`)
            return 1
        }
        permissions = parsed
    }

    try {
        const url =
            permissions === undefined
                ? links.installation(applicationId)
                : links.installation(applicationId, { permissions })
        environment.output.write(`${url}\n`)
        return 0
    } catch (error) {
        if (!(error instanceof HelperError)) throw error
        environment.errorOutput.write(`${error.message}\n`)
        return 1
    }
}
