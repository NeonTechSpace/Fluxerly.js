import type { PrefixCommandMetadata } from "./commands.js"

/**
 * Choose the text prefix, page length and visible entries for `router.help`.
 * Help reads registered metadata only, without connecting a client, executing commands or sending messages.
 * The caller decides which returned pages to send and how to handle mentions
 *
 * @category Commands
 */
export interface CommandHelpOptions {
    /** Nonempty well-formed prefix to display, such as `!`. This can differ from dispatch prefixes and does not call the prefix resolver */
    readonly prefix: string
    /** Required maximum page length, measured in UTF-16 code units. Use a positive safe integer. There is no default or provider-limit lookup */
    readonly maxLength: number
    /** Choose a group by its registered names, not aliases, such as `["admin"]`.
     * Omit or use `[]` for root entries.
     * A selected group shows itself and its immediate children, not deeper descendants.
     * Missing groups fail with ConfigurationError, and so do hidden groups and groups inside them, so help does not reveal them
     */
    readonly group?: readonly string[]
    /**
     * Return true to show an entry or false to exclude it, for example `(entry) => entry.name !== "internal"`.
     * Omitted means show each considered entry. Receives frozen metadata, with `kind: "group"` identifying groups.
     * Entries registered with `hidden: true`, and everything inside a hidden group, are left out before this callback runs
     *
     * Root help checks immediate entries once each in sibling registration order.
     * A group selection checks ancestors first, then the selected group and its immediate children, at most once per entry.
     * An ancestor or selected group that include rejects returns `[]` without inspecting later entries.
     * An included empty group remains visible, even if none of its children appear
     *
     * Excluding an entry from help does not prevent the command from running. Help does not run guards or check cooldowns
     *
     * A throw fails with ConfigurationError whose cause is the thrown value. A non-boolean or asynchronous return fails with ConfigurationError.
     * Promises are not supported or awaited. Keep this synchronous callback short because it cannot be interrupted while running
     */
    readonly include?: (command: PrefixCommandMetadata) => boolean
}

/**
 * Choose help pages for the `help` function of a command context.
 * Every setting is optional: The prefix defaults to the one that matched the invoking message and the page length
 * defaults to 2,000 UTF-16 code units, which fits one message
 *
 * @category Commands
 */
export interface CommandContextHelpOptions {
    /** Prefix to display, default the prefix that matched the invoking message, such as `!` */
    readonly prefix?: string
    /** Maximum page length in UTF-16 code units, a positive safe integer, default 2,000 */
    readonly maxLength?: number
    /** Registered names of the group to describe, such as `["admin"]`. Omit for root entries, as in `router.help` */
    readonly group?: readonly string[]
    /** Return false to leave an entry out, as in `router.help`. Hidden entries never appear */
    readonly include?: (command: PrefixCommandMetadata) => boolean
}
