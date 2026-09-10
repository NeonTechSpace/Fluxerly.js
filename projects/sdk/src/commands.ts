import type { Message } from "./messages.js"

/** Static command identity used to register one prefix-command handler */
export interface PrefixCommandDefinition {
    /** ASCII command name, starting with an alphanumeric character and containing only letters, numbers, `_` or `-` */
    readonly name: string
    /** Additional names for the same command. Aliases share the command’s case-sensitivity setting and cannot collide with another command */
    readonly aliases?: readonly string[]
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

/** Local configuration for a prefix-command router. Creating a router neither subscribes nor connects a client */
export interface PrefixCommandsOptions {
    /** Static prefixes or a synchronous caller-owned lookup. If several match, the longest prefix wins */
    readonly prefix: PrefixCommandPrefix
    /**
     * Optional parser after prefix matching. The default trims leading whitespace, accepts only registered ASCII command-shaped names, preserves rawArgs and splits trimmed positional arguments on whitespace.
     * Use this boundary for quoted arguments or another grammar. Custom-parser failures are reported through the attached event subscription’s safe handler-error path
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
