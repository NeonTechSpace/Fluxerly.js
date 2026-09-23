/**
 * Describe positional arguments by name, such as `{ text: { type: "text" }, count: { type: "integer" } }`.
 * The router reads the schema's own enumerable properties in order, ignoring inherited and non-enumerable properties.
 * Converted values keep those property names.
 * Names must begin with an ASCII letter and use only ASCII letters, digits or `_`.
 * Required arguments must precede optional arguments, and only the final text argument may use `rest`.
 * Registration validates and freezes a copy, including choices and resource candidates.
 * Omit the schema to accept any unconverted arguments. Use an empty schema to reject all supplied arguments
 */
export type CommandArgumentSchema = Readonly<Record<string, CommandArgumentDescriptor>>

/** Frozen description of an argument for help generation, without resource candidate data */
export interface CommandArgumentMetadata {
    /** Schema property name, which also names its converted value */
    readonly name: string
    /** Conversion applied to this positional token, such as `integer` or `user` */
    readonly type: CommandArgumentType
    /** True when a missing argument produces undefined instead of an error */
    readonly optional: boolean
    /** True when this final text argument joins all remaining tokens with spaces */
    readonly rest: boolean
    /** Additional mention kind accepted by an `id` descriptor, if configured. Generated usage still shows the argument name */
    readonly mention?: CommandArgumentMention
    /** Frozen accepted strings for a `choice` descriptor. Absent for other types */
    readonly choices?: readonly string[]
}

/**
 * Supported positional conversions, performed locally after the guard allows the command.
 * `text`, `id` and `choice` produce strings, numeric types produce numbers and `boolean` produces a boolean.
 * `user`, `channel` and `role` select a frozen object from explicitly supplied candidates, without a lookup request
 */
export type CommandArgumentType =
    "text" | "integer" | "number" | "boolean" | "id" | "user" | "channel" | "role" | "choice"

/**
 * Additional complete-token mention form accepted by an `id` descriptor.
 * User mentions are `<@123>` or `<@!123>`, channel mentions are `<#123>` and role mentions are `<@&123>`.
 * Mention IDs must start with a nonzero decimal digit, and surrounding text is not accepted
 */
export type CommandArgumentMention = "user" | "channel" | "role"

/**
 * User data that a `user` argument can match.
 * Registration copies only `id` and `username`, and conversion returns that frozen copy.
 * No cache or network search occurs, and later changes to the original candidate do not affect selection
 */
export interface CommandArgumentUser {
    /** Decimal ID string, either `0` or digits beginning with a nonzero digit. May be selected directly or by a complete user mention with a nonzero ID */
    readonly id: string
    /** Nonempty username matched exactly, including case. Decimal tokens try IDs first, then usernames. Complete user mentions try IDs only */
    readonly username: string
}

/**
 * Channel data that a `channel` argument can match.
 * Registration copies only `id` and `name`, and conversion returns that frozen copy.
 * The router does not fetch channels or observe later changes to the supplied data
 */
export interface CommandArgumentChannel {
    /** Decimal ID string without leading zeroes except `0` itself. Complete channel mentions accept nonzero IDs only */
    readonly id: string
    /** Nonempty channel name matched exactly. Decimal tokens try IDs before names, while complete channel mentions try IDs only */
    readonly name: string
}

/**
 * Role data that a `role` argument can match.
 * Registration copies only `id` and `name`, and conversion returns that frozen copy.
 * Selection does not fetch roles or verify the invoking user's permissions or role hierarchy
 */
export interface CommandArgumentRole {
    /** Decimal ID string without leading zeroes except `0` itself. Complete role mentions accept nonzero IDs only */
    readonly id: string
    /** Nonempty role name matched exactly. Decimal tokens try IDs before names, while complete role mentions try IDs only */
    readonly name: string
}

/** One argument's conversion settings, selected by its `type` field and validated when the command is registered */
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

/**
 * Keep one nonempty parsed token as a string, or join the remaining tokens when `rest` is true.
 * For example, a final rest argument converts `["hello", "world"]` to `"hello world"`.
 * This uses parsed tokens, not `rawArgs`, so original quotes and separator whitespace are not retained.
 * A supplied empty token is invalid even when the argument is optional
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
 */
export interface CommandArgumentInteger {
    /** Require decimal integer syntax and a safe integer result */
    readonly type: "integer"
    /** Set to true to return undefined when omitted. Otherwise this argument is required and must precede optional arguments */
    readonly optional?: true
}

/**
 * Convert decimal text such as `1.25`, `-2` or `3e2` to a finite JavaScript number.
 * Requires an integer part without leading zeroes, with optional minus sign, fraction and exponent.
 * Rejects `.5`, `1.`, a leading plus sign, `Infinity`, `NaN` and values that overflow to infinity.
 * Normal JavaScript number rounding still applies, unlike the safe-integer check for `integer`
 */
export interface CommandArgumentNumber {
    /** Accept decimal and exponent syntax when conversion produces a finite number */
    readonly type: "number"
    /** Set to true to produce undefined when omitted. Leaving this unset requires a token */
    readonly optional?: true
}

/** Convert only the exact lowercase strings `true` and `false` to booleans, rejecting other spellings and numeric substitutes */
export interface CommandArgumentBoolean {
    /** Require `true` or `false` and return the corresponding boolean */
    readonly type: "boolean"
    /** Set to true to permit omission and return undefined. A supplied invalid token still rejects */
    readonly optional?: true
}

/**
 * Keep a decimal resource ID as a string without losing digits through JavaScript number conversion.
 * Accepts `0` or digits beginning with a nonzero digit, with no sign or leading zeroes.
 * Optionally accepts one selected complete mention form and returns only its ID.
 * Does not fetch a resource, check whether it exists or authorize an action against it
 */
export interface CommandArgumentId {
    /** Return the accepted decimal ID string rather than a number or resource object */
    readonly type: "id"
    /** Also accept this mention kind as a complete token. Omitted means accept decimal ID strings only */
    readonly mention?: CommandArgumentMention
    /** Set to true to return undefined when omitted. Supplied malformed IDs or mentions still reject */
    readonly optional?: true
}

/** Match one of the configured nonempty strings exactly, returning that string rather than its list position */
export interface CommandArgumentChoice<C extends readonly string[] = readonly string[]> {
    /** Compare the token to the configured strings without case folding */
    readonly type: "choice"
    /** One to 100 unique nonempty strings, copied at registration. A literal tuple preserves the allowed-string union in `values` */
    readonly choices: C
    /** Set to true to allow omission and produce undefined. An unlisted supplied token is invalid */
    readonly optional?: true
}

/**
 * Select a user from the supplied candidates by decimal ID, complete user mention or exact username.
 * Decimal text tries IDs before usernames, while a complete mention never falls back to a username.
 * Exactly one match returns a frozen `id` and `username` copy.
 * No match is invalid, and multiple matches are ambiguous, even when candidate IDs are duplicated
 */
export interface CommandArgumentUserSelection<
    C extends readonly CommandArgumentUser[] = readonly CommandArgumentUser[],
> {
    /** Resolve a token against these user candidates only */
    readonly type: "user"
    /** One to 100 users with nonempty usernames and decimal IDs. Registration copies only `id` and `username` */
    readonly candidates: C
    /** Set to true to return undefined when omitted, without choosing a default candidate */
    readonly optional?: true
}

/**
 * Select a channel from supplied candidates by decimal ID, complete channel mention or exact name.
 * Decimal text falls back to a name only when no ID matches, while a complete mention selects IDs only.
 * Returns the one matching frozen `id` and `name` copy, rejecting absent or ambiguous matches.
 * Channel selection does not fetch current state or check permissions
 */
export interface CommandArgumentChannelSelection<
    C extends readonly CommandArgumentChannel[] = readonly CommandArgumentChannel[],
> {
    /** Resolve the token against these channel candidates only */
    readonly type: "channel"
    /** One to 100 channels with decimal IDs and nonempty names, copied to `id` and `name` at registration */
    readonly candidates: C
    /** Set to true to permit omission and return undefined. Supplied unmatched or ambiguous text still rejects */
    readonly optional?: true
}

/**
 * Select a role from supplied candidates by decimal ID, complete role mention or exact name.
 * Decimal text tries IDs first and falls back to names only when no ID matches.
 * Complete role mentions select IDs only, with no name fallback.
 * Returns the one matching frozen `id` and `name` copy, rejecting absent or ambiguous matches
 */
export interface CommandArgumentRoleSelection<
    C extends readonly CommandArgumentRole[] = readonly CommandArgumentRole[],
> {
    /** Resolve the token against these role candidates only, without a permission or hierarchy check */
    readonly type: "role"
    /** One to 100 roles with decimal IDs and nonempty names. Registration copies only `id` and `name` */
    readonly candidates: C
    /** Set to true to allow omission and return undefined, rather than selecting any role implicitly */
    readonly optional?: true
}

type OptionalArgumentValue<D extends CommandArgumentDescriptor, V> = D extends { readonly optional: true }
    ? V | undefined
    : V

/**
 * Frozen converted values keyed by the command's argument names, such as `values.count`.
 * Available to execution and cooldown-key callbacks only after the entire schema converts successfully.
 * Optional descriptors add undefined to their value type. Guards and rejection callbacks receive raw context instead
 */
export type CommandArgumentValues<S extends CommandArgumentSchema> = {
    readonly [K in keyof S]: CommandArgumentValue<S[K]>
}

/**
 * TypeScript result type for one descriptor, including undefined when `optional: true` is selected.
 * Text, IDs and choices return strings, numeric descriptors return numbers and boolean descriptors return booleans.
 * Resource descriptors return only the candidate's documented fields, not extra fields from the original object
 */
export type CommandArgumentValue<D extends CommandArgumentDescriptor> = D extends CommandArgumentText
    ? OptionalArgumentValue<D, string>
    : D extends CommandArgumentInteger | CommandArgumentNumber
      ? OptionalArgumentValue<D, number>
      : D extends CommandArgumentBoolean
        ? OptionalArgumentValue<D, boolean>
        : D extends CommandArgumentId
          ? OptionalArgumentValue<D, string>
          : D extends CommandArgumentChoice<infer C>
            ? OptionalArgumentValue<D, C[number]>
            : D extends CommandArgumentUserSelection
              ? OptionalArgumentValue<D, CommandArgumentUser>
              : D extends CommandArgumentChannelSelection
                ? OptionalArgumentValue<D, CommandArgumentChannel>
                : D extends CommandArgumentRoleSelection
                  ? OptionalArgumentValue<D, CommandArgumentRole>
                  : never

/**
 * Argument rejection classification without the rejected token.
 * `Missing` means a required token was absent, `Invalid` means conversion failed and `Ambiguous` means multiple candidates matched.
 * `Unexpected` means positional tokens remained after the schema was consumed
 */
export type CommandArgumentRejectionReason = "Missing" | "Invalid" | "Ambiguous" | "Unexpected"
