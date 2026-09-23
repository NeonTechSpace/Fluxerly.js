import type { PrefixCommandMetadata } from "./commands.js"

/**
 * Choose the text prefix, page length and visible entries for `router.help`.
 * Help reads registered metadata only, without connecting a client, executing commands or sending messages.
 * The caller decides which returned pages to send and how to handle mentions
 */
export interface CommandHelpOptions {
    /** Nonempty well-formed prefix to display, such as `!`. This can differ from dispatch prefixes and does not call the prefix resolver */
    readonly prefix: string
    /** Required maximum page length, measured in UTF-16 code units. Use a positive safe integer. There is no default or provider-limit lookup */
    readonly maxLength: number
    /** Choose a group by its registered names, not aliases, such as `["admin"]`.
     * Omit or use `[]` for root entries.
     * A selected group shows itself and its immediate children, not deeper descendants.
     * Missing groups fail with ConfigurationError
     */
    readonly group?: readonly string[]
    /**
     * Return true to show an entry or false to hide it, for example `(entry) => entry.name !== "internal"`.
     * Omitted means show each considered entry. Receives frozen metadata, with `kind: "group"` identifying groups
     *
     * Root help checks immediate entries once each in sibling registration order.
     * A group selection checks ancestors first, then the selected group and its immediate children, at most once per entry.
     * A hidden ancestor or selected group returns `[]` without inspecting later entries.
     * An included empty group remains visible, even if its children are hidden
     *
     * Hiding an entry from help does not prevent the command from running. Help does not run guards or check cooldowns
     *
     * Throws or non-boolean returns fail with fixed ConfigurationError details that omit the callback's thrown value.
     * Promises are not supported or awaited. Keep this synchronous callback short because it cannot be interrupted while running
     */
    readonly include?: (command: PrefixCommandMetadata) => boolean
}
