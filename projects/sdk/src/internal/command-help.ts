import type { CommandHelpOptions } from "#sdk/command-help"
import type { PrefixCommandMetadata } from "#sdk/commands"
import { ConfigurationError } from "#sdk/errors"
import { text } from "#sdk/text"

/** Render only snapshotted metadata. Facades own immediate versus lazy execution and defect translation */
export function commandHelp(
    commands: readonly PrefixCommandMetadata[],
    options: CommandHelpOptions,
): readonly string[] {
    if (typeof options !== "object" || options === null || Array.isArray(options))
        throw new ConfigurationError("help", "Help options must be an object")
    for (const key of Reflect.ownKeys(options))
        if (typeof key !== "string" || !["prefix", "maxLength", "include"].includes(key))
            throw new ConfigurationError("help", "Help options contain an unsupported field")
    const { prefix, maxLength, include } = options
    if (typeof prefix !== "string" || prefix.length === 0 || !prefix.isWellFormed())
        throw new ConfigurationError("help", "Help prefix must be nonempty well-formed text")
    if (!Number.isSafeInteger(maxLength) || maxLength <= 0)
        throw new ConfigurationError("help", "Help maxLength must be a positive safe integer in UTF-16 code units")
    if (include !== undefined && typeof include !== "function")
        throw new ConfigurationError("help", "Help include must be a synchronous boolean predicate")
    const entries: string[] = []
    for (const command of commands) {
        if (include !== undefined && !included(include, command)) continue
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
            ? ` (Aliases: ${command.aliases.map((alias) => prefix + alias).join(", ")})`
            : ""
        entries.push(
            prefix +
                command.name +
                (usage ? " " + usage : "") +
                aliases +
                (command.description ? "\n" + command.description : ""),
        )
    }
    const pages = text.split(entries.join("\n\n"), { maxLength })
    if (pages.isErr())
        throw new ConfigurationError(
            "help",
            "Help text must be well-formed and maxLength must fit each Unicode code point",
        )
    // Fluxer trims message edges. Return sendable pages rather than whitespace-only separator pieces
    return Object.freeze(pages.value.map((page) => page.trim()).filter((page) => page.length > 0))
}

function included(include: NonNullable<CommandHelpOptions["include"]>, command: PrefixCommandMetadata): boolean {
    let accepted: unknown
    try {
        accepted = include(command)
    } catch {
        throw new ConfigurationError("help", "Help include threw. Handle callback errors in application code")
    }
    if (typeof accepted === "boolean") return accepted
    // Observe an invalid asynchronous result without awaiting or retrying application work
    void Promise.resolve(accepted).catch(() => undefined)
    throw new ConfigurationError("help", "Help include must return a boolean synchronously")
}
