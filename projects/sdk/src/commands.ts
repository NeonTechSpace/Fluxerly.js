import type { Message, MessageCore } from "./messages.js"
import type {
    CommandArgumentMetadata,
    CommandArgumentRejectionReason,
    CommandArgumentSchema,
} from "./command-arguments.js"

/**
 * Names, help text and positional arguments for a command such as `!repeat hello 3`.
 * Each API's command type adds the callback that runs when this name or an alias matches.
 * Registration copies this data, so later edits do not change an existing router.
 * Individual and batch command registration read recognized fields once, including inherited and non-enumerable fields
 */
export interface PrefixCommandDefinition {
    /** Name without the prefix, such as `repeat`, beginning with an ASCII letter or digit and using only ASCII letters, digits, `_` or `-` */
    readonly name: string
    /** Other names that run the same command, such as `r`. Names and aliases must not collide with a command or group in the same parent group */
    readonly aliases?: readonly string[]
    /** Text placed below the invocation in generated help. The router neither escapes markup nor sends the text */
    readonly description?: string
    /** Help text after the command name, such as `<text> <count>`. Overrides argument-derived syntax, including when set to an empty string */
    readonly usage?: string
    /** Named argument descriptors read in property order after the guard allows execution. Omit this to leave `args` unconverted and expose empty `values` */
    readonly arguments?: CommandArgumentSchema
}

/**
 * Frozen command information for inspection and help generation.
 * Contains no callbacks, cooldown store or resource candidates.
 * Help visibility callbacks also receive group entries, identified by `kind: "group"`
 */
export interface PrefixCommandMetadata extends Omit<PrefixCommandDefinition, "arguments"> {
    /** Present for groups supplied to help visibility callbacks. Executable commands omit this property */
    readonly kind?: "group"
    /** Registered names from the outer group through this entry, such as `["admin", "inspect"]`. Root commands omit this property */
    readonly path?: readonly string[]
    /** Frozen argument descriptions used to generate usage text, without candidate objects */
    readonly arguments?: readonly CommandArgumentMetadata[]
}

/**
 * A named parent for commands, such as `admin` in `!admin inspect`.
 * Register the group before adding children to its canonical path.
 * Groups organize lookup and help only, with no handler, argument conversion, guard or cooldown.
 * Each protected command needs its own guard
 */
export interface PrefixCommandGroupDefinition {
    /** Group name using command-name syntax. It must not collide with sibling command or group names and aliases */
    readonly name: string
    /** Alternative names for entering this group, matched with the router's `caseSensitive` setting */
    readonly aliases?: readonly string[]
    /** Description shown below this group's help entry, without markup escaping or automatic delivery */
    readonly description?: string
}

/** Frozen group information copied at registration, including its registered-name path for adding children or selecting help */
export interface PrefixCommandGroupMetadata extends PrefixCommandGroupDefinition {
    /** Distinguishes this non-executable group from a command in help visibility callbacks */
    readonly kind: "group"
    /** Registered names from the outermost group to this one, such as `["admin", "users"]`, even if the message used aliases */
    readonly path: readonly string[]
}

/** Choose the existing parent group for a new command or child group */
export interface PrefixCommandRegistrationOptions {
    /** Registered parent names, not aliases, such as `["admin", "users"]`. Omit or use `[]` for root. Missing parents are not created */
    readonly group?: readonly string[]
}

/**
 * Why a known command did not execute, passed as a frozen value to its optional `onReject` callback.
 * Inspect `_tag` to distinguish a denied guard, cooldown or invalid arguments.
 * The router sends no response and schedules no retry
 */
export type PrefixCommandRejection =
    | {
          /** The command's guard returned false, so its handler did not run */
          readonly _tag: "CommandGuardRejected"
      }
    | {
          /** This command's cooldown key is still active */
          readonly _tag: "CommandCooldownActive"
          /** Unix epoch milliseconds when this key can claim again, not a wait duration */
          readonly retryAtMs: number
      }
    | {
          /** The bounded cooldown store could not retain another key */
          readonly _tag: "CommandCooldownCapacity"
          /** Earliest known Unix epoch milliseconds that may free a store entry, or null if unknown. This is not a reserved retry */
          readonly retryAtMs: number | null
      }
    | {
          /** Argument conversion rejected before a cooldown was claimed. This value does not include the rejected token */
          readonly _tag: "CommandArgumentRejected"
          /** Descriptor name that rejected, or `arguments` when extra positional tokens remained */
          readonly argument: string
          /** Missing, invalid, ambiguous or extra input, without its private text */
          readonly reason: CommandArgumentRejectionReason
          /** Absent because argument rejection has no retry time. Declared only to permit optional retry-time access in shared handling */
          readonly retryAtMs?: never
      }

/**
 * A prefix matched but no executable command was selected.
 * Passed as a frozen value to the router's optional `onUnmatched` callback, without an automatic response.
 * Ignored bot messages and messages without a matching prefix do not produce this callback
 */
export type PrefixCommandUnmatched =
    | {
          /** The parser returned a valid name absent from this router's selected parent group or root */
          readonly _tag: "CommandUnknownName"
          /** Name exactly as returned by the parser, before case-insensitive lookup */
          readonly name: string
          /** Registered parent group names where lookup missed. Absent at root and does not include the unknown name */
          readonly path?: readonly string[]
      }
    | {
          /** The parser returned undefined, for example for prefix-only input. No custom-parser rejection reason is inferred */
          readonly _tag: "CommandParserRejected"
          /** Registered parent group names already consumed before the parser declined. Absent at root */
          readonly path?: readonly string[]
      }
    | {
          /** A group matched with no following name. The leaf parser, guard, cooldown and handler did not run */
          readonly _tag: "CommandMissingSubcommand"
          /** Registered names through the group that needs a subcommand */
          readonly path: readonly string[]
      }

/**
 * Text that starts a command invocation, such as `!`, or a list of accepted prefixes.
 * A synchronous resolver can choose prefixes from each message and return undefined to ignore it.
 * Prefixes must be nonempty strings, and arrays must be nonempty and contain no holes.
 * Matching is exact at the start of message content, with the longest matching prefix selected
 */
export type PrefixCommandPrefix<M extends MessageCore = Message> =
    string | readonly string[] | ((message: M) => string | readonly string[] | undefined)

/** Frozen input given to a custom parser after prefix matching and any group lookup */
export interface PrefixCommandParseInput<M extends MessageCore = Message> {
    /** Incoming message with the attached client's selected fields. The router does not fetch omitted fields */
    readonly message: M
    /** Matched prefix as written, such as `!!` when both `!` and `!!` match */
    readonly prefix: string
    /** Text after the prefix at root, or after consumed group names and their separator whitespace. Remaining text is not rewritten */
    readonly source: string
    /** Registered parent group names already selected. Absent at root. Returning another name cannot change this parent */
    readonly path?: readonly string[]
}

/** Parser result copied and frozen by the router before command callbacks run */
export interface PrefixCommandParse {
    /** Command name or alias using command-name syntax in the selected parent. A returned group name does not enter that group */
    readonly name: string
    /** Positional string tokens in input order, without array holes. A custom parser defines how these tokens are split */
    readonly args: readonly string[]
    /** Argument text retained for callbacks. The default parser removes whitespace between name and arguments but preserves the remaining text */
    readonly rawArgs: string
}

/**
 * Split arguments while keeping quoted words together, such as `repeat "hello world" 3`.
 * Single and double quotes delimit text, and a backslash escapes the next character inside or outside quotes.
 * Quotes and escapes are removed from `args`, but `rawArgs` retains the text after command-name separator whitespace.
 * Empty quotes produce an empty token, which a text argument descriptor rejects.
 * Returns undefined for empty input, invalid command names, unclosed quotes or a trailing backslash.
 * This synchronous helper does not inspect the message or change the router's whitespace-only default.
 * Use the public `commands.parseQuoted` helper as the router's `parse` option to opt in
 */
export function parseQuotedPrefixCommand<M extends MessageCore = Message>(
    input: PrefixCommandParseInput<M>,
): PrefixCommandParse | undefined {
    const source = input.source.trimStart()
    if (source.length === 0) return undefined
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(source)
    const name = match?.[1]
    if (name === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return undefined
    const rawArgs = match?.[2] ?? ""
    const args: string[] = []
    let current = ""
    let quote: "'" | '"' | undefined
    let started = false
    for (let index = 0; index < rawArgs.length; index += 1) {
        const character = rawArgs[index]!
        if (character === "\\") {
            if (index + 1 === rawArgs.length) return undefined
            current += rawArgs[index + 1]!
            started = true
            index += 1
        } else if (quote !== undefined) {
            if (character === quote) quote = undefined
            else current += character
        } else if (character === "'" || character === '"') {
            quote = character
            started = true
        } else if (/\s/.test(character)) {
            if (started) {
                args.push(current)
                current = ""
                started = false
            }
        } else {
            current += character
            started = true
        }
    }
    if (quote !== undefined) return undefined
    if (started) args.push(current)
    return { name, rawArgs, args }
}

/** Configure how an attached router recognizes command messages, without connecting or subscribing during construction */
export interface PrefixCommandsOptions<M extends MessageCore = Message> {
    /** Prefix text, accepted-prefix list or synchronous per-message resolver. If several prefixes match, the longest wins */
    readonly prefix: PrefixCommandPrefix<M>
    /**
     * Split the command name and arguments, optionally using `commands.parseQuoted` for quoted words.
     * By default, leading whitespace is trimmed, the name must use command-name syntax and trimmed arguments are split on whitespace.
     * The default preserves `rawArgs` after removing the command-name separator whitespace.
     * Groups are consumed first using fixed whitespace separators, then this parser runs once on the remaining command text.
     * A custom parser cannot enter another group by returning its name.
     * Return undefined to decline parsing and call optional `onUnmatched` feedback.
     * A group with no following name reports `CommandMissingSubcommand` without calling the parser.
     * Throws and malformed results use the attached subscription's error reporting, with no automatic response or retry
     */
    readonly parse?: (input: PrefixCommandParseInput<M>) => PrefixCommandParse | undefined
    /** Skip messages whose author has `isBot` set, before prefix resolution. Defaults to true */
    readonly ignoreBots?: boolean
    /** Require matching letter case for command and group names and aliases. Defaults to false. This does not change prefix or argument matching */
    readonly caseSensitive?: boolean
}

/** Request to reserve a cooldown after successful guard and argument conversion, before command execution */
export interface CommandCooldownRequest {
    /** Nonempty key combining command identity with the configured key suffix. Use the complete string as the store key */
    readonly key: string
    /** Whole milliseconds to reserve, from 1 through 2,147,483,647 */
    readonly durationMs: number
}

/**
 * Outcome of reserving a cooldown, selected by `_tag`.
 * Only `CooldownAcquired` permits execution.
 * A denied claim may call `onReject`, but the router does not wait or retry.
 * Retry times are millisecond timestamps since 1970-01-01 UTC, not wait durations
 */
export type CommandCooldownClaim =
    | {
          /** The store reserved this key and permits this invocation to execute */
          readonly _tag: "CooldownAcquired"
          /** Unix epoch milliseconds when the reservation expires */
          readonly retryAtMs: number
      }
    | {
          /** An existing reservation for this key has not expired */
          readonly _tag: "CooldownActive"
          /** Unix epoch milliseconds when this key can be claimed again */
          readonly retryAtMs: number
      }
    | {
          /** The store has no room for a new key. The built-in store does not evict active reservations */
          readonly _tag: "CooldownCapacity"
          /** Earliest known expiry in Unix epoch milliseconds, or null when unknown. Capacity is not reserved for a later attempt */
          readonly retryAtMs: number | null
      }

/** Limit the cooldown keys held by one memory store in one process. Keys are not saved or shared with other processes */
export interface MemoryCooldownOptions {
    /** Positive safe integer key limit, defaulting to 1,024. Claims sweep expired keys before checking space and never evict active keys */
    readonly maxEntries?: number
}
