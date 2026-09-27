import type { MemberReference } from "./guilds.js"

/**
 * Describe positional arguments by name, such as `{ text: { type: "text" }, count: { type: "integer" } }`.
 * The router reads the schema's own enumerable properties in order, ignoring inherited and non-enumerable properties.
 * Converted values keep those property names.
 * Names must begin with an ASCII letter and use only ASCII letters, digits or `_`.
 * Required arguments must precede optional arguments, including arguments with a `default`, and only the final text or custom argument may use `rest`.
 * Registration validates and freezes a copy, including choices and resource candidates.
 * Omit the schema to accept any unconverted arguments. Use an empty schema to reject all supplied arguments
 *
 * @category Commands
 */
export type CommandArgumentSchema = Readonly<Record<string, CommandArgumentDescriptor>>

/**
 * Frozen description of an argument for help generation, without resource candidate data
 *
 * @category Commands
 */
export interface CommandArgumentMetadata {
    /** Schema property name, which also names its converted value */
    readonly name: string
    /** Conversion applied to this positional token, such as `integer` or `user` */
    readonly type: CommandArgumentType
    /** True when the argument can be omitted, producing undefined or its default instead of an error */
    readonly optional: boolean
    /** True when this final text argument joins all remaining tokens with spaces */
    readonly rest: boolean
    /** Additional mention kind accepted by an `id` descriptor, if configured. Generated usage still shows the argument name */
    readonly mention?: CommandArgumentMention
    /** Frozen accepted strings for a `choice` descriptor. Absent for other types */
    readonly choices?: readonly string[]
    /** Inclusive lower bound of an `integer`, `number` or `duration` descriptor, in milliseconds for a duration. Absent without a bound */
    readonly min?: number
    /** Inclusive upper bound of an `integer`, `number` or `duration` descriptor, in milliseconds for a duration. Absent without a bound */
    readonly max?: number
    /** Value used when the argument is omitted, for descriptors that declare one */
    readonly default?: number
    /** True for a `duration` descriptor that rejects a millisecond part. Absent otherwise */
    readonly wholeSeconds?: true
    /** Short description of the expected value for a `custom` descriptor, used in rejection replies. Absent for other types */
    readonly expected?: string
}

/**
 * Supported positional conversions, performed locally after the guard allows the command.
 * The `text`, `id` and `choice` types produce strings, numeric types and `duration` produce numbers and `boolean` produces a boolean.
 * The `member` type produces a member reference in the message's community, and `custom` produces whatever its synchronous parse function returns.
 * The `userChoice`, `channelChoice` and `roleChoice` types select a frozen object from a fixed list of candidates supplied at
 * registration, without a lookup request. For any user, channel or role, use `id` with a `mention` form, or `member` for a
 * member of the message's community
 *
 * @category Commands
 */
export type CommandArgumentType =
    | "text"
    | "integer"
    | "number"
    | "boolean"
    | "id"
    | "userChoice"
    | "channelChoice"
    | "roleChoice"
    | "choice"
    | "member"
    | "duration"
    | "custom"

/**
 * Additional complete-token mention form accepted by an `id` descriptor.
 * User mentions are `<@123>` or `<@!123>`, channel mentions are `<#123>` and role mentions are `<@&123>`.
 * Mention IDs follow the same rules as plain `id` tokens: Nonzero, without leading zeroes and no larger than `9223372036854775807`.
 * Surrounding text is not accepted
 *
 * @category Commands
 */
export type CommandArgumentMention = "user" | "channel" | "role"

/**
 * User data that a `userChoice` argument can match.
 * Registration copies only `id` and `username`, and conversion returns that frozen copy.
 * No cache or network search occurs, and later changes to the original candidate do not affect selection
 *
 * @category Commands
 */
export interface CommandArgumentUser {
    /** Decimal ID string, either `0` or digits beginning with a nonzero digit. May be selected directly or by a complete user mention with a nonzero ID */
    readonly id: string
    /** Nonempty username matched exactly, including case. Decimal tokens try IDs first, then usernames. Complete user mentions try IDs only */
    readonly username: string
}

/**
 * Channel data that a `channelChoice` argument can match.
 * Registration copies only `id` and `name`, and conversion returns that frozen copy.
 * The router does not fetch channels or observe later changes to the supplied data
 *
 * @category Commands
 */
export interface CommandArgumentChannel {
    /** Decimal ID string without leading zeroes except `0` itself. Complete channel mentions accept nonzero IDs only */
    readonly id: string
    /** Nonempty channel name matched exactly. Decimal tokens try IDs before names, while complete channel mentions try IDs only */
    readonly name: string
}

/**
 * Role data that a `roleChoice` argument can match.
 * Registration copies only `id` and `name`, and conversion returns that frozen copy.
 * Selection does not fetch roles or verify the invoking user's permissions or role hierarchy
 *
 * @category Commands
 */
export interface CommandArgumentRole {
    /** Decimal ID string without leading zeroes except `0` itself. Complete role mentions accept nonzero IDs only */
    readonly id: string
    /** Nonempty role name matched exactly. Decimal tokens try IDs before names, while complete role mentions try IDs only */
    readonly name: string
}

/**
 * One argument's conversion settings, selected by its `type` field and validated when the command is registered
 *
 * @category Commands
 */
export type CommandArgumentDescriptor =
    | CommandArgumentText
    | CommandArgumentInteger
    | CommandArgumentNumber
    | CommandArgumentBoolean
    | CommandArgumentId
    | CommandArgumentChoice
    | CommandArgumentUserSelection
    | CommandArgumentChannelSelection
    | CommandArgumentRoleSelection
    | CommandArgumentMember
    | CommandArgumentDuration
    | CommandArgumentCustom

/**
 * Keep one nonempty parsed token as a string, or join the remaining tokens when `rest` is true.
 * For example, a final rest argument converts `["hello", "world"]` to `"hello world"`.
 * This uses parsed tokens, not `rawArgs`, so original quotes and separator whitespace are not retained.
 * A supplied empty token is invalid even when the argument is optional
 *
 * @category Commands
 */
export interface CommandArgumentText {
    /** Keep parsed text without numeric or resource conversion */
    readonly type: "text"
    /** Set to true to produce undefined when no token remains. Omitted means required, and false is not a supported option */
    readonly optional?: true
    /** Set to true to join remaining tokens with single spaces. This descriptor must be last. Omitted means consume one token */
    readonly rest?: true
}

/**
 * Convert a decimal token such as `3` or `-2` to a JavaScript safe integer.
 * Accepts an optional minus sign and digits without leading zeroes, except `0` itself.
 * Rejects fractions, exponent notation, a leading plus sign and numbers outside the safe-integer range
 *
 * @category Commands
 */
export interface CommandArgumentInteger {
    /** Require decimal integer syntax and a safe integer result */
    readonly type: "integer"
    /** Set to true to return undefined when omitted. Otherwise this argument is required and must precede optional arguments */
    readonly optional?: true
    /** Smallest accepted value, inclusive. A smaller value is rejected as Invalid */
    readonly min?: number
    /** Largest accepted value, inclusive. A larger value is rejected as Invalid */
    readonly max?: number
    /** Safe integer used when the argument is omitted, which makes it optional without adding undefined to its value */
    readonly default?: number
}

/**
 * Convert decimal text such as `1.25`, `-2` or `3e2` to a finite JavaScript number.
 * Requires an integer part without leading zeroes, with optional minus sign, fraction and exponent.
 * Rejects `.5`, `1.`, a leading plus sign, `Infinity`, `NaN` and values that overflow to infinity.
 * Normal JavaScript number rounding still applies, unlike the safe-integer check for `integer`
 *
 * @category Commands
 */
export interface CommandArgumentNumber {
    /** Accept decimal and exponent syntax when conversion produces a finite number */
    readonly type: "number"
    /** Set to true to produce undefined when omitted. Leaving this unset requires a token */
    readonly optional?: true
    /** Smallest accepted value, inclusive. A smaller value is rejected as Invalid */
    readonly min?: number
    /** Largest accepted value, inclusive. A larger value is rejected as Invalid */
    readonly max?: number
    /** Finite number used when the argument is omitted, which makes it optional without adding undefined to its value */
    readonly default?: number
}

/**
 * Convert a duration such as `90s`, `5m`, `1h30m` or `2d` to whole milliseconds.
 * Units are `ms`, `s`, `m`, `h`, `d` and `w`, each after a whole number, combined from largest to smallest without spaces.
 * A bare number is not accepted, so `10` is rejected rather than guessed as seconds or minutes
 *
 * @category Commands
 */
export interface CommandArgumentDuration {
    /** Produce whole milliseconds, a safe integer, from unit-suffixed duration text */
    readonly type: "duration"
    /** Set to true to produce undefined when omitted */
    readonly optional?: true
    /** Shortest accepted duration in milliseconds, inclusive */
    readonly min?: number
    /** Longest accepted duration in milliseconds, inclusive */
    readonly max?: number
    /** Milliseconds used when the argument is omitted, which makes it optional without adding undefined to its value */
    readonly default?: number
    /**
     * Set to true to reject a duration with a millisecond part, such as `1m500ms`, for a destination that takes whole
     * seconds, such as a ban's durationMs
     */
    readonly wholeSeconds?: true
}

/**
 * Select a member of the message's community by complete user mention or decimal user ID, without a roster lookup.
 * The ID must be nonzero, without leading zeroes and no larger than `9223372036854775807`, the largest 64-bit ID. Other tokens are rejected as Invalid.
 * The value is a frozen `{ guildId, userId }` reference that member operations such as members.kick accept directly.
 * Whether that user is still a member is not checked. A message outside a community rejects this argument as Invalid
 *
 * @category Commands
 */
export interface CommandArgumentMember {
    /** Produce a member reference from a user mention or ID */
    readonly type: "member"
    /** Set to true to produce undefined when omitted */
    readonly optional?: true
}

/**
 * Convert one token, or the remaining tokens with `rest`, through an application parse function.
 * Return the converted value, or undefined to reject the token as Invalid.
 * A parse function that throws or returns an Err result fails the command without running it, and that error is reported with the command name like a failed handler.
 * Parsing is synchronous in both APIs. Returning a Promise or Effect is misuse: The command does not run, and a ConfigurationError with field `command` is reported the same way.
 * The outcome of a returned Promise is not awaited or reported
 *
 * @category Commands
 */
export interface CommandArgumentCustom<T = unknown> {
    /** Convert with the supplied parse function */
    readonly type: "custom"
    /** Convert the token synchronously, returning undefined for input that should be rejected. Throw or return an Err to fail the command */
    readonly parse: (token: string) => T | undefined
    /** Short description of the expected value, such as `a hex color`, used in rejection replies */
    readonly expected?: string
    /** Set to true to produce undefined when omitted */
    readonly optional?: true
    /** Set to true to pass the remaining tokens joined with single spaces. This descriptor must be last */
    readonly rest?: true
}

/**
 * Convert only the exact lowercase strings `true` and `false` to booleans, rejecting other spellings and numeric substitutes
 *
 * @category Commands
 */
export interface CommandArgumentBoolean {
    /** Require `true` or `false` and return the corresponding boolean */
    readonly type: "boolean"
    /** Set to true to permit omission and return undefined. A supplied invalid token still rejects */
    readonly optional?: true
}

/**
 * Keep a decimal resource ID as a string without losing digits through JavaScript number conversion.
 * Accepts digits beginning with a nonzero digit, with no sign or leading zeroes, up to `9223372036854775807`, the largest 64-bit ID.
 * Rejects `0` and larger values as Invalid.
 * Optionally accepts one selected complete mention form and returns only its ID.
 * Does not fetch a resource, check whether it exists or authorize an action against it
 *
 * @category Commands
 */
export interface CommandArgumentId {
    /** Return the accepted nonzero decimal ID string rather than a number or resource object */
    readonly type: "id"
    /** Also accept this mention kind as a complete token. Omitted means accept decimal ID strings only */
    readonly mention?: CommandArgumentMention
    /** Set to true to return undefined when omitted. Supplied malformed IDs or mentions still reject */
    readonly optional?: true
}

/**
 * Match one of the configured nonempty strings exactly, returning that string rather than its list position
 *
 * @category Commands
 */
export interface CommandArgumentChoice<C extends readonly string[] = readonly string[]> {
    /** Compare the token to the configured strings without case folding */
    readonly type: "choice"
    /** One to 100 unique nonempty strings, copied at registration. A literal tuple preserves the allowed-string union in `values` */
    readonly choices: C
    /** Set to true to allow omission and produce undefined. An unlisted supplied token is invalid */
    readonly optional?: true
}

/**
 * Select a user from a fixed list of candidates by decimal ID, complete user mention or exact username.
 * For any user, use `{ type: "id", mention: "user" }` or `{ type: "member" }` instead.
 * Decimal text tries IDs before usernames, while a complete mention never falls back to a username.
 * Exactly one match returns a frozen `id` and `username` copy.
 * No match is invalid, and multiple matches are ambiguous, even when candidate IDs are duplicated
 *
 * @category Commands
 */
export interface CommandArgumentUserSelection<
    C extends readonly CommandArgumentUser[] = readonly CommandArgumentUser[],
> {
    /** Resolve a token against these user candidates only */
    readonly type: "userChoice"
    /** One to 100 users with nonempty usernames and decimal IDs. Registration copies only `id` and `username` */
    readonly candidates: C
    /** Set to true to return undefined when omitted, without choosing a default candidate */
    readonly optional?: true
}

/**
 * Select a channel from a fixed list of candidates by decimal ID, complete channel mention or exact name.
 * For any channel, use `{ type: "id", mention: "channel" }` instead.
 * Decimal text falls back to a name only when no ID matches, while a complete mention selects IDs only.
 * Returns the one matching frozen `id` and `name` copy, rejecting absent or ambiguous matches.
 * Channel selection does not fetch current state or check permissions
 *
 * @category Commands
 */
export interface CommandArgumentChannelSelection<
    C extends readonly CommandArgumentChannel[] = readonly CommandArgumentChannel[],
> {
    /** Resolve the token against these channel candidates only */
    readonly type: "channelChoice"
    /** One to 100 channels with decimal IDs and nonempty names, copied to `id` and `name` at registration */
    readonly candidates: C
    /** Set to true to permit omission and return undefined. Supplied unmatched or ambiguous text still rejects */
    readonly optional?: true
}

/**
 * Select a role from a fixed list of candidates by decimal ID, complete role mention or exact name.
 * For any role, use `{ type: "id", mention: "role" }` instead.
 * Decimal text tries IDs first and falls back to names only when no ID matches.
 * Complete role mentions select IDs only, with no name fallback.
 * Returns the one matching frozen `id` and `name` copy, rejecting absent or ambiguous matches
 *
 * @category Commands
 */
export interface CommandArgumentRoleSelection<
    C extends readonly CommandArgumentRole[] = readonly CommandArgumentRole[],
> {
    /** Resolve the token against these role candidates only, without a permission or hierarchy check */
    readonly type: "roleChoice"
    /** One to 100 roles with decimal IDs and nonempty names. Registration copies only `id` and `name` */
    readonly candidates: C
    /** Set to true to allow omission and return undefined, rather than selecting any role implicitly */
    readonly optional?: true
}

/**
 * The converted value type V, with undefined added when descriptor D sets `optional: true`
 *
 * @category Commands
 */
export type CommandArgumentOptionalValue<D extends CommandArgumentDescriptor, V> = D extends {
    /** A value used when the argument is omitted, so the value is never undefined */
    readonly default: number
}
    ? V
    : D extends {
            /** Set when the descriptor allows the argument to be omitted */
            readonly optional: true
        }
      ? V | undefined
      : V

/**
 * Frozen converted values keyed by the command's argument names, such as `values.count`.
 * Available to execution and cooldown-key callbacks only after the entire schema converts successfully.
 * Optional descriptors add undefined to their value type. Guards and rejection callbacks receive raw context instead
 *
 * @category Commands
 */
export type CommandArgumentValues<S extends CommandArgumentSchema> = {
    readonly [K in keyof S]: CommandArgumentValue<S[K]>
}

/**
 * TypeScript result type for one descriptor, including undefined when `optional: true` is selected without a `default`.
 * Text, IDs and choices return strings, numeric and duration descriptors return numbers and boolean descriptors return booleans.
 * Member descriptors return a MemberReference and custom descriptors return their parse function's value type.
 * Resource descriptors return only the candidate's documented fields, not extra fields from the original object
 *
 * @category Commands
 */
export type CommandArgumentValue<D extends CommandArgumentDescriptor> = D extends CommandArgumentText
    ? CommandArgumentOptionalValue<D, string>
    : D extends CommandArgumentInteger | CommandArgumentNumber
      ? CommandArgumentOptionalValue<D, number>
      : D extends CommandArgumentBoolean
        ? CommandArgumentOptionalValue<D, boolean>
        : D extends CommandArgumentId
          ? CommandArgumentOptionalValue<D, string>
          : D extends CommandArgumentChoice<infer C>
            ? CommandArgumentOptionalValue<D, C[number]>
            : D extends CommandArgumentUserSelection
              ? CommandArgumentOptionalValue<D, CommandArgumentUser>
              : D extends CommandArgumentChannelSelection
                ? CommandArgumentOptionalValue<D, CommandArgumentChannel>
                : D extends CommandArgumentRoleSelection
                  ? CommandArgumentOptionalValue<D, CommandArgumentRole>
                  : D extends CommandArgumentMember
                    ? CommandArgumentOptionalValue<D, MemberReference>
                    : D extends CommandArgumentDuration
                      ? CommandArgumentOptionalValue<D, number>
                      : D extends CommandArgumentCustom<infer T>
                        ? CommandArgumentOptionalValue<D, T>
                        : never

/**
 * Argument rejection classification without the rejected token.
 * `Missing` means a required token was absent, `Invalid` means conversion failed and `Ambiguous` means multiple candidates matched.
 * `Unexpected` means positional tokens remained after the schema was consumed
 *
 * @category Commands
 */
export type CommandArgumentRejectionReason = "Missing" | "Invalid" | "Ambiguous" | "Unexpected"
