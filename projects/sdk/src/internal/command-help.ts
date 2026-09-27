/**
 * Prefix-command help rendering from snapshotted command metadata.
 * Invariant: Rendering reads only snapshotted metadata and never runs command handlers or sends messages.
 * Implements [SDK contracts: User-handler failures](/docs/SDK-CONTRACTS.md#user-handler-failures)
 */
import type { CommandContextHelpOptions, CommandHelpOptions } from "#sdk/command-help"
import type { PrefixCommandMetadata } from "#sdk/commands"
import { ConfigurationError } from "#sdk/errors"
import { readCaller } from "./defects.js"
import { splitText } from "#sdk/text"
import { copyCommandGroupPath, sameCommandPath } from "./commands.js"
import { unsupportedKeyHint } from "./suggest.js"

/** Default page length of a command context's help, which fits one message */
const contextHelpLength = 2_000

/**
 * Help options for a command context's help function, filling the matched prefix and one message's length.
 * Getters defer each read to commandHelp, so a throwing caller getter is still marked as application input there
 */
export function contextHelpOptions(options: CommandContextHelpOptions | undefined, prefix: string): CommandHelpOptions {
    // Malformed options and unknown fields go to commandHelp unchanged, which rejects them as router.help does
    if (
        options !== undefined &&
        (typeof options !== "object" ||
            options === null ||
            Reflect.ownKeys(options).some(
                (key) => typeof key !== "string" || !["prefix", "maxLength", "include", "group"].includes(key),
            ))
    )
        return options as never
    return {
        get prefix() {
            return options?.prefix ?? prefix
        },
        get maxLength() {
            return options?.maxLength ?? contextHelpLength
        },
        get group() {
            return options?.group
        },
        get include() {
            return options?.include
        },
    } as CommandHelpOptions
}

/** Render only snapshotted metadata. Facades own immediate versus lazy execution and defect translation */
export function commandHelp(
    commands: readonly PrefixCommandMetadata[],
    options: CommandHelpOptions,
): readonly string[] {
    // Only reading the caller options is marked as application input, not building the help pages
    const { prefix, maxLength, include, parent } = readCaller(() => helpOptions(options))
    const selected: PrefixCommandMetadata[] = []
    for (let depth = 1; depth <= parent.length; depth += 1) {
        const path = parent.slice(0, depth)
        const group = commands.find(
            (entry) => entry.kind === "group" && entry.path !== undefined && sameCommandPath(entry.path, path),
        )
        if (group === undefined)
            throw new ConfigurationError(
                "help",
                'The help option "group" must be the path of a registered group, using group names rather than aliases',
            )
        if (include !== undefined && !included(include, group)) return Object.freeze([])
        if (depth === parent.length) selected.push(group)
    }
    for (const entry of commands) {
        const path = entry.path ?? [entry.name]
        if (!sameCommandPath(path.slice(0, -1), parent)) continue
        if (include === undefined || included(include, entry)) selected.push(entry)
    }
    const entries: string[] = []
    for (const command of selected) {
        const path = command.path ?? [command.name]
        const namespace = path.slice(0, -1)
        const usage =
            command.usage ??
            command.arguments
                ?.map((argument) => {
                    const name = argument.name + (argument.rest ? "..." : "")
                    return argument.optional ? `[${name}]` : `<${name}>`
                })
                .join(" ") ??
            ""
        const aliases = command.aliases?.length
            ? ` (Aliases: ${command.aliases.map((alias) => prefix + [...namespace, alias].join(" ")).join(", ")})`
            : ""
        entries.push(
            prefix +
                path.join(" ") +
                (command.kind === "group" ? " (Group)" : "") +
                (usage ? " " + usage : "") +
                aliases +
                (command.description ? "\n" + command.description : ""),
        )
    }
    const pages = splitText(entries.join("\n\n"), { maxLength })
    if (pages.isErr())
        throw new ConfigurationError(
            "help",
            'Help text must be well-formed, and the help option "maxLength" must fit each Unicode code point',
        )
    // Fluxer trims message edges. Return sendable pages rather than whitespace-only separator pieces
    return Object.freeze(pages.value.map((page) => page.trim()).filter((page) => page.length > 0))
}

const helpKeys = ["prefix", "maxLength", "include", "group"]

/** Read and validate help options once, before any help text is built */
function helpOptions(options: CommandHelpOptions) {
    if (typeof options !== "object" || options === null || Array.isArray(options))
        throw new ConfigurationError("help", "Help options must be an object")
    for (const key of Reflect.ownKeys(options))
        if (typeof key !== "string" || !helpKeys.includes(key))
            throw new ConfigurationError(
                "help",
                typeof key === "string"
                    ? `Unsupported help option ${JSON.stringify(key)}`
                    : "Help options must not have symbol keys",
                { hint: unsupportedKeyHint(typeof key === "string" ? key : "", helpKeys) },
            )
    const { prefix, maxLength, include, group } = options
    if (typeof prefix !== "string" || prefix.length === 0 || !prefix.isWellFormed())
        throw new ConfigurationError("help", 'The help option "prefix" must be nonempty well-formed text')
    if (!Number.isSafeInteger(maxLength) || maxLength <= 0)
        throw new ConfigurationError(
            "help",
            'The help option "maxLength" must be a positive safe integer in UTF-16 code units',
        )
    if (include !== undefined && typeof include !== "function")
        throw new ConfigurationError("help", 'The help option "include" must be a function that returns true or false')
    const parent = group === undefined ? Object.freeze([]) : copyCommandGroupPath(group, "help")
    return { prefix, maxLength, include, parent }
}

function included(include: NonNullable<CommandHelpOptions["include"]>, command: PrefixCommandMetadata): boolean {
    let accepted: unknown
    try {
        accepted = include(command)
    } catch (error) {
        throw new ConfigurationError(
            "help",
            'The help option "include" threw. The thrown value is this error\'s cause',
            {
                cause: error,
            },
        )
    }
    if (typeof accepted === "boolean") return accepted
    // Observe an invalid asynchronous result without awaiting or retrying application work
    // allow-silent: The invalid asynchronous result already produced a ConfigurationError
    void Promise.resolve(accepted).catch(() => undefined)
    throw new ConfigurationError("help", 'The help option "include" must return true or false synchronously')
}
