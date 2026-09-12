import type { Message } from "./messages.js"
import type {
    CommandArgumentMetadata,
    CommandArgumentRejectionReason,
    CommandArgumentSchema,
} from "./command-arguments.js"

/** Static command identity used to register one prefix-command handler */
export interface PrefixCommandDefinition {
    /** ASCII command name, starting with an alphanumeric character and containing only letters, numbers, `_` or `-` */
    readonly name: string
    /** Additional names for the same command. Aliases share the command’s case-sensitivity setting and cannot collide with another command */
    readonly aliases?: readonly string[]
    /** Optional concise text for help generation. The router copies it without interpreting markup or sending it */
    readonly description?: string
    /** Optional invocation syntax after the command name in generated help. Overrides the schema-derived signature, including when explicitly empty */
    readonly usage?: string
    /** Optional registration-ordered local argument schema. It converts parsed positional arguments only after a guard allows this command */
    readonly arguments?: CommandArgumentSchema
}

/** Immutable command identity and help text exposed by a router without handlers, guards, cooldown stores or parser state */
export interface PrefixCommandMetadata extends Omit<PrefixCommandDefinition, "arguments"> {
    /** Frozen safe argument signature metadata. Resource candidates are intentionally omitted */
    readonly arguments?: readonly CommandArgumentMetadata[]
}

/** Why a matched command did not reach its handler. Rejection callbacks receive a frozen value and never trigger an automatic response */
export type PrefixCommandRejection =
    | { readonly _tag: "CommandGuardRejected" }
    | {
          readonly _tag: "CommandCooldownActive"
          /** Unix epoch milliseconds when this key can acquire again */
          readonly retryAtMs: number
      }
    | {
          readonly _tag: "CommandCooldownCapacity"
          /** Earliest known Unix epoch milliseconds that may release capacity, or null when the store cannot provide one */
          readonly retryAtMs: number | null
      }
    | {
          /** Parsed arguments did not satisfy this command's local schema. Raw tokens and converter defects are never exposed */
          readonly _tag: "CommandArgumentRejected"
          /** Schema entry that rejected, or arguments when parsed arguments remained after conversion */
          readonly argument: string
          /** Safe conversion classification without rejected private input */
          readonly reason: CommandArgumentRejectionReason
          /** Always absent for argument conversion rejection, retained only so existing cooldown-rejection handling can read one common optional field */
          readonly retryAtMs?: never
      }

/** A prefix matched but no command handler will run. Unmatched callbacks receive a frozen value and never trigger an automatic response */
export type PrefixCommandUnmatched =
    | {
          /** The parser returned a valid command name that is not registered on this router snapshot */
          readonly _tag: "CommandUnknownName"
          /** Parser-supplied command name, before the router’s case-normalized lookup */
          readonly name: string
      }
    | {
          /** The parser declined the suffix, including prefix-only input. This does not classify a custom parser’s reason for declining */
          readonly _tag: "CommandParserRejected"
      }

/** Prefix selection for one incoming message. Resolver work is synchronous and caller-owned */
export type PrefixCommandPrefix =
    string | readonly string[] | ((message: Message) => string | readonly string[] | undefined)

/** Input supplied to a custom prefix-command parser after a prefix matched */
export interface PrefixCommandParseInput {
    /** Frozen gateway message that matched the prefix */
    readonly message: Message
    /** Exact prefix selected for this message */
    readonly prefix: string
    /** Exact message suffix after the selected prefix, before parser-specific trimming or tokenization */
    readonly source: string
}

/** Parsed command name and arguments. The router copies this data before invoking user code */
export interface PrefixCommandParse {
    /** Registered command name or alias selected by this parser */
    readonly name: string
    /** Positional arguments in caller-defined order */
    readonly args: readonly string[]
    /** Remaining text after the command name. The default parser removes separator whitespace but does not parse quotes */
    readonly rawArgs: string
}

/**
 * Parse a command suffix with quoted positional arguments. It removes separator whitespace after the command name, preserves `rawArgs` exactly like the default parser, supports single or double quotes and lets `\\` escape the next character.
 * Unterminated quotes and a trailing escape return undefined rather than a configuration error, so a custom parser or application policy can choose whether to provide feedback. The default router parser remains whitespace-only
 */
export function parseQuotedPrefixCommand(input: PrefixCommandParseInput): PrefixCommandParse | undefined {
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

/** Local configuration for a prefix-command router. Creating a router neither subscribes nor connects a client */
export interface PrefixCommandsOptions {
    /** Static prefixes or a synchronous caller-owned lookup. If several match, the longest prefix wins */
    readonly prefix: PrefixCommandPrefix
    /**
     * Optional parser after prefix matching. The default trims leading whitespace, accepts only registered ASCII command-shaped names, preserves rawArgs and splits trimmed positional arguments on whitespace.
     * Use this boundary for quoted arguments or another grammar. Returning undefined is a parser decline, reported to an optional facade-specific onUnmatched callback without naming a cause. Thrown parser defects use the attached event subscription’s safe handler-error path
     */
    readonly parse?: (input: PrefixCommandParseInput) => PrefixCommandParse | undefined
    /** Ignore messages whose supplied author projection identifies a bot. Defaults to true */
    readonly ignoreBots?: boolean
    /** Match registered ASCII names and aliases exactly. Defaults to false, which uses ASCII case-insensitive matching */
    readonly caseSensitive?: boolean
}

/** One atomic cooldown claim made immediately before command execution */
export interface CommandCooldownRequest {
    /** Router-generated command namespace plus the caller-selected key. Treat it as opaque when sharing one store */
    readonly key: string
    /** Positive cooldown duration in milliseconds */
    readonly durationMs: number
}

/** Result of one cooldown-store claim. Rejected claims never invoke the command handler automatically */
export type CommandCooldownClaim =
    | {
          /** This key acquired the cooldown until retryAtMs */
          readonly _tag: "CooldownAcquired"
          /** Epoch milliseconds when another acquisition can succeed */
          readonly retryAtMs: number
      }
    | {
          /** This key is still inside an existing cooldown */
          readonly _tag: "CooldownActive"
          /** Epoch milliseconds when this key can acquire again */
          readonly retryAtMs: number
      }
    | {
          /** A bounded local store has no space for a new key. Existing active claims remain intact */
          readonly _tag: "CooldownCapacity"
          /** Earliest observed expiry that may release capacity, or null when unavailable */
          readonly retryAtMs: number | null
      }

/** Options for the optional process-local bounded cooldown store */
export interface MemoryCooldownOptions {
    /** Maximum active or not-yet-swept keys. Defaults to 1,024. The store does not evict active keys to make room */
    readonly maxEntries?: number
}
