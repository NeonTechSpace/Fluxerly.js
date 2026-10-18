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
 *
 * @category Commands
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
    /**
     * Leave this command out of generated help and unknown-name suggestions, for example for owner-only tools. Defaults to false.
     * A hidden command still runs when invoked by name or alias, so pair it with a guard to restrict who can use it
     */
    readonly hidden?: boolean
}

/**
 * Frozen command information for inspection and help generation.
 * Contains no callbacks, cooldown store or resource candidates.
 * Help visibility callbacks also receive group entries, identified by `kind: "group"`
 *
 * @category Commands
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
 *
 * @category Commands
 */
export interface PrefixCommandGroupDefinition {
    /** Group name using command-name syntax. It must not collide with sibling command or group names and aliases */
    readonly name: string
    /** Alternative names for entering this group, matched with the router's `caseSensitive` setting */
    readonly aliases?: readonly string[]
    /** Description shown below this group's help entry, without markup escaping or automatic delivery */
    readonly description?: string
    /**
     * Leave this group and everything inside it out of generated help and unknown-name suggestions. Defaults to false.
     * Help treats a hidden group like a missing one. Its commands still run when invoked by name, so guard each one that needs it
     */
    readonly hidden?: boolean
}

/**
 * Frozen group information copied at registration, including its registered-name path for adding children or selecting help
 *
 * @category Commands
 */
export interface PrefixCommandGroupMetadata extends PrefixCommandGroupDefinition {
    /** Distinguishes this non-executable group from a command in help visibility callbacks */
    readonly kind: "group"
    /** Registered names from the outermost group to this one, such as `["admin", "users"]`, even if the message used aliases */
    readonly path: readonly string[]
}

/**
 * Choose the existing parent group for a new command or child group
 *
 * @category Commands
 */
export interface PrefixCommandRegistrationOptions {
    /** Registered parent names, not aliases, such as `["admin", "users"]`. Omit or use `[]` for root. Missing parents are not created */
    readonly group?: readonly string[]
}

/**
 * Why a known command did not execute, passed as a frozen value to its optional `onReject` callback.
 * Inspect `_tag` to distinguish a denied guard, cooldown or invalid arguments.
 * The router replies only when `onReject: "reply"` is selected, and it schedules no retry.
 * That reply is limited: An active cooldown key is answered once until its `retryAtMs`, and a guard denial once per user
 * and command every 5 seconds. Argument rejections are always answered
 *
 * @category Commands
 */
export type PrefixCommandRejection =
    | {
          /** A guard returned false or `{ deny }`, so the handler did not run */
          readonly _tag: "CommandGuardRejected"
          /** The text a guard returned with `{ deny }`, suitable for a reply. Absent when a guard returned false */
          readonly reason?: string
      }
    | {
          /** This command's cooldown key is still active */
          readonly _tag: "CommandCooldownActive"
          /** Unix epoch milliseconds when this key can claim again, not a wait duration */
          readonly retryAtMs: number
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
 *
 * @category Commands
 */
export type PrefixCommandUnmatched =
    | {
          /** The parser returned a valid name absent from this router's selected parent group or root */
          readonly _tag: "CommandUnknownName"
          /** Name exactly as returned by the parser, before case-insensitive lookup */
          readonly name: string
          /**
           * The closest registered command or group name in the same parent, within a small edit distance, such as `ping` for `pong`.
           * Absent when no name is close enough
           */
          readonly suggestion?: string
          /** Registered parent group names where lookup missed. Absent at root and does not include the unknown name */
          readonly path?: readonly string[]
      }
    | {
          /** The parser returned undefined, for example for prefix-only input, or reported a syntax mistake with a `reason` */
          readonly _tag: "CommandParserRejected"
          /**
           * The parser's explanation of the syntax mistake, suitable for a reply, such as the quoted parser's note about a quote that never closes.
           * Absent when the parser returned undefined, which is also the result for ordinary chat that merely starts with the prefix
           */
          readonly reason?: string
          /**
           * The command name the parser read before it declined, exactly as returned and before case-insensitive lookup, such as `say` for a quote that never closes in `!say "hi`.
           * It may name a command that is not registered. Absent when the parser returned undefined or a rejection without a name
           */
          readonly name?: string
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
 * Prefix text selected for one message: One prefix, a list of accepted prefixes, or undefined to ignore the message
 *
 * @category Commands
 */
export type PrefixCommandPrefixValue = string | readonly string[] | undefined

/**
 * Text that starts a command invocation, such as `!`, or a list of accepted prefixes.
 * A resolver can choose prefixes from each message, for example from per-community settings, and may return a promise.
 * Return undefined to ignore the message.
 * Prefixes must be nonempty strings, and arrays must be nonempty and contain no holes.
 * Matching is exact at the start of message content, with the longest matching prefix selected
 *
 * @category Commands
 */
export type PrefixCommandPrefix<M extends MessageCore = Message> =
    string | readonly string[] | ((message: M) => PrefixCommandPrefixValue | PromiseLike<PrefixCommandPrefixValue>)

/**
 * Frozen input given to a custom parser after prefix matching and any group lookup
 *
 * @category Commands
 */
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

/**
 * Parser result copied and frozen by the router before command callbacks run
 *
 * @category Commands
 */
export interface PrefixCommandParse {
    /** Command name or alias using command-name syntax in the selected parent. A returned group name does not enter that group */
    readonly name: string
    /** Positional string tokens in input order, without array holes. A custom parser defines how these tokens are split */
    readonly args: readonly string[]
    /** Argument text retained for callbacks. The default parser removes whitespace between name and arguments but preserves the remaining text */
    readonly rawArgs: string
}

/**
 * A parser result that reports a syntax mistake in text that was meant as a command, such as a quote that never closes.
 * Return it instead of undefined so `onUnmatched` receives the explanation as `reason` of `CommandParserRejected`.
 * The router sends nothing by itself, so the application decides whether to turn the reason into a reply.
 * The router passes the reason on unchanged and logs it at Debug, so keep it fixed text that is safe to show in a channel and leaves the sender's input out.
 * Return undefined instead when the text is probably not a command, such as ordinary chat that begins with the prefix
 *
 * @category Commands
 */
export interface PrefixCommandParseRejection {
    /** Nonempty explanation, such as `A double quote was opened but never closed`. Any other value is reported as a parser failure */
    readonly reason: string
    /**
     * The command name the parser read before the mistake, in command-name syntax, which `onUnmatched` receives as `name` so a reply can say which command the mistake was for.
     * Omit it when no name was read. Any other value is reported as a parser failure
     */
    readonly name?: string
}

/**
 * Whether a single-quoted span ends at the single quote at this index. It does unless a letter or digit follows, because
 * then the quote is an apostrophe inside a word. The end of the input, whitespace, quotes and punctuation all end the span
 */
const endsSingleQuotedSpan = (text: string, index: number): boolean => {
    const next = text.codePointAt(index + 1)
    return next === undefined || !/[\p{L}\p{N}]/u.test(String.fromCodePoint(next))
}

/**
 * Split arguments while keeping quoted words together, such as `repeat "hello world" 3`.
 * Single and double quotes delimit text, and a backslash escapes the next character inside or outside quotes.
 * A double quote opens a span anywhere and closes at the next double quote, and text that touches a span joins its word, so `a"b c"` is `ab c`, `"a""b"` is `ab` and `key="a b"` is `key=a b`.
 * A single quote opens a span only at the start of a word, which is the start of the input, after whitespace or right after a closed span.
 * Inside a single-quoted span a single quote closes it unless the next character is a letter or digit, so the end of the input, whitespace, quotes and punctuation all close it. A single quote anywhere else in a word is an apostrophe and stays literal, so `say don't` is `don't`, `it's Ada's` is `it's` and `Ada's`, `'it's fine'` is `it's fine`, `'don't'` is `don't` and `'Yes', 'No'` is `Yes,` and `No`.
 * Quotes and escapes are removed from `args`, but `rawArgs` retains the text after command-name separator whitespace.
 * Empty quotes produce an empty token, which a text argument descriptor rejects.
 * Returns undefined for empty input or an invalid command name.
 * For a quote that never closes or a trailing backslash, it returns a `PrefixCommandParseRejection` with a fixed `reason` and the command `name`, which `onUnmatched` receives.
 * When an unclosed single-quoted span held a single quote followed by a letter or digit, as in `'a'b`, the `reason` adds that such a quote does not close the span and suggests a space after it or double quotes.
 * A word that begins with an apostrophe, such as `'twas`, opens a span, so write it as `\'twas` to keep the apostrophe literal.
 * This synchronous helper does not inspect the message or change the router's whitespace-only default.
 * Use the public `commands.parseQuoted` helper as the router's `parse` option to opt in
 */
export function parseQuotedPrefixCommand<M extends MessageCore = Message>(
    input: PrefixCommandParseInput<M>,
): PrefixCommandParse | PrefixCommandParseRejection | undefined {
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
    // Index of the quote that last closed a span, so a single quote right after it can open the next span
    let closedAt = -1
    // Whether the open single-quoted span held a single quote that a letter or digit kept literal
    let heldApostrophe = false
    for (let index = 0; index < rawArgs.length; index += 1) {
        const character = rawArgs[index]!
        if (character === "\\") {
            if (index + 1 === rawArgs.length) return { reason: "A backslash at the end has nothing to escape", name }
            current += rawArgs[index + 1]!
            started = true
            index += 1
        } else if (quote !== undefined) {
            // A single quote is also an apostrophe, so it stays literal when a letter or digit follows it
            if (character === quote && (quote === '"' || endsSingleQuotedSpan(rawArgs, index))) {
                quote = undefined
                closedAt = index
            } else {
                current += character
                if (character === "'") heldApostrophe = true
            }
        } else if (character === '"' || (character === "'" && (!started || closedAt === index - 1))) {
            quote = character
            heldApostrophe = false
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
    if (quote === '"') return { reason: "A double quote was opened but never closed", name }
    if (quote === "'")
        return {
            reason: heldApostrophe
                ? "A single quote was opened but never closed. If a single quote before a letter or digit was meant to close it, put a space after that quote or use double quotes"
                : "A single quote was opened but never closed",
            name,
        }
    if (started) args.push(current)
    return { name, rawArgs, args }
}

/**
 * Configure how an attached router recognizes command messages, without connecting or subscribing during construction
 *
 * @category Commands
 */
export interface PrefixCommandsOptions<M extends MessageCore = Message> extends PrefixCommandParsing<M> {
    /** Prefix text, accepted-prefix list or per-message resolver, which may return a promise. If several prefixes match, the longest wins */
    readonly prefix: PrefixCommandPrefix<M>
}

/**
 * Parsing and cooldown settings shared by both API styles, apart from the prefix, which each API resolves in its own way
 *
 * @category Commands
 */
export interface PrefixCommandParsing<M extends MessageCore = Message> {
    /**
     * Also accept a mention of the bot, such as `@bot ping`, as a prefix. Defaults to false.
     * Both mention forms, `<@id>` and `<@!id>`, are accepted.
     * The bot's user ID comes from the user in the gateway's READY, so normally no request is needed.
     * When READY did not supply a valid ID, the first message that starts with a mention triggers one users.fetchSelf
     * read, which concurrent messages share. A failed read is logged at Warn in the commands category, and mentions are then treated
     * as ordinary text without a new read for a backoff that starts at 5 seconds and doubles per consecutive failure up to
     * 5 minutes, unless READY supplies the ID first
     */
    readonly mentionPrefix?: boolean
    /**
     * Split the command name and arguments, optionally using `commands.parseQuoted` for quoted words.
     * By default, leading whitespace is trimmed, the name must use command-name syntax and trimmed arguments are split on whitespace.
     * The default preserves `rawArgs` after removing the command-name separator whitespace.
     * Groups are consumed first using fixed whitespace separators, then this parser runs once on the remaining command text.
     * A custom parser cannot enter another group by returning its name.
     * Return undefined to decline parsing and call optional `onUnmatched` feedback.
     * Return a `PrefixCommandParseRejection` instead to decline with a `reason` that `onUnmatched` receives, as `commands.parseQuoted` does for an unclosed quote.
     * A group with no following name reports `CommandMissingSubcommand` without calling the parser.
     * Throws and malformed results use the attached subscription's error reporting, with no automatic response or retry
     */
    readonly parse?: (input: PrefixCommandParseInput<M>) => PrefixCommandParse | PrefixCommandParseRejection | undefined
    /** Skip messages whose author has `isBot` set, before prefix resolution. Defaults to true */
    readonly ignoreBots?: boolean
    /** Require matching letter case for command and group names and aliases. Defaults to false. This does not change prefix or argument matching */
    readonly caseSensitive?: boolean
    /**
     * Size the router's own memory cooldown store, used by commands whose cooldown supplies no `store`, such as
     * `{ maxEntries: 50_000 }`. Defaults to 10,000 keys, shared by every router derived from the same create.
     * A full store never denies a new key: It removes expired keys first, then the reservation that expires soonest,
     * which lets that key run again early.
     * The same limit bounds the rejections `onReject: "reply"` remembers so that it does not repeat itself.
     * Invalid options throw ConfigurationError when the router is created
     */
    readonly cooldowns?: MemoryCooldownOptions
}

/**
 * Request to reserve a cooldown after successful guard and argument conversion, before command execution
 *
 * @category Commands
 */
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
 *
 * @category Commands
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

/**
 * Whose invocations share one cooldown: The invoking user, the channel, or the guild.
 * A guild cooldown in a direct message applies to that conversation
 *
 * @category Commands
 */
export type CommandCooldownPer = "user" | "channel" | "guild"

/**
 * A guard's decision: `true` allows the command, `false` denies it without an automatic reply, and `{ deny }` denies it
 * with a reason that `onReject: "reply"` sends to the user.
 * Both denials are counted and logged at Debug. A custom onReject callback receives either denial
 *
 * @category Commands
 */
export type PrefixCommandGuardResult =
    | boolean
    | {
          /** The reason the command was denied, sent to the user when rejection feedback is `"reply"` */
          readonly deny: string
      }

/**
 * Limit the cooldown keys held by one memory store in one process. Keys are not saved or shared with other processes
 *
 * @category Commands
 */
export interface MemoryCooldownOptions {
    /**
     * Positive safe integer key limit, defaulting to 10,000. A claim for a new key never fails for lack of space:
     * A full store removes expired keys first, then the reservation that expires soonest, whose key can then claim again early
     */
    readonly maxEntries?: number
}
