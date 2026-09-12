/** A named, own-enumerable registration-ordered set of opt-in command argument descriptors */
export type CommandArgumentSchema = Readonly<Record<string, CommandArgumentDescriptor>>

/** A safe schema summary retained in command metadata for application-owned help generation */
export interface CommandArgumentMetadata {
    /** Registration-order argument name */
    readonly name: string
    /** Built-in conversion selected by the command */
    readonly type: CommandArgumentType
    /** Whether an omitted trailing value becomes undefined */
    readonly optional: boolean
    /** Whether this final text argument receives every remaining parsed positional argument */
    readonly rest: boolean
    /** Accepted literal values for a choice argument, when applicable */
    readonly choices?: readonly string[]
}

/** Built-in synchronous command argument conversions */
export type CommandArgumentType =
    "text" | "integer" | "number" | "boolean" | "id" | "user" | "channel" | "role" | "choice"

/**
 * One explicit user candidate. IDs use base-10 decimal digits, candidates are limited to 100 per descriptor and router registration snapshots this projection.
 * Conversion reads only this snapshot, so it neither searches a cache or network nor observes later candidate changes
 */
export interface CommandArgumentUser {
    /** Base-10 decimal user ID, matching `0` or a nonzero digit followed by digits, accepted directly or in an anchored user mention */
    readonly id: string
    /** Exact user name accepted in addition to its decimal ID or anchored user mention */
    readonly username: string
}

/**
 * One explicit channel candidate. IDs use base-10 decimal digits, candidates are limited to 100 per descriptor and router registration snapshots this projection.
 * Conversion reads only this snapshot, so it neither searches a cache or network nor observes later candidate changes
 */
export interface CommandArgumentChannel {
    /** Base-10 decimal channel ID, matching `0` or a nonzero digit followed by digits, accepted directly or in an anchored channel mention */
    readonly id: string
    /** Exact channel name accepted in addition to its decimal ID or anchored channel mention */
    readonly name: string
}

/**
 * One explicit role candidate. IDs use base-10 decimal digits, candidates are limited to 100 per descriptor and router registration snapshots this projection.
 * Conversion reads only this snapshot, so it neither searches a cache or network nor observes later candidate changes
 */
export interface CommandArgumentRole {
    /** Base-10 decimal role ID, matching `0` or a nonzero digit followed by digits, accepted directly or in an anchored role mention */
    readonly id: string
    /** Exact role name accepted in addition to its decimal ID or anchored role mention */
    readonly name: string
}

/** Built-in descriptor selected by a schema entry */
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

/** One nonempty parsed text token, or all remaining parsed text when rest is true. A supplied empty token is invalid, not omitted */
export interface CommandArgumentText {
    /** Select parsed text */
    readonly type: "text"
    /** Allow this trailing value to be omitted */
    readonly optional?: true
    /** Join all remaining parsed positional arguments with spaces */
    readonly rest?: true
}

/** One base-10 safe integer matching an optional `-` followed by `0` or a nonzero digit and digits. Decimal points and exponent notation are invalid */
export interface CommandArgumentInteger {
    /** Select base-10 integer conversion */
    readonly type: "integer"
    /** Allow this trailing value to be omitted */
    readonly optional?: true
}

/** One finite base-10 number with an optional `-`, integer part `0` or a nonzero digit and digits, optional fractional digits, and optional exponent. Leading zeroes, Infinity and NaN are invalid */
export interface CommandArgumentNumber {
    /** Select finite base-10 number conversion */
    readonly type: "number"
    /** Allow this trailing value to be omitted */
    readonly optional?: true
}

/** The exact lowercase token true or false */
export interface CommandArgumentBoolean {
    /** Select exact true or false conversion */
    readonly type: "boolean"
    /** Allow this trailing value to be omitted */
    readonly optional?: true
}

/** One base-10 decimal ID matching `0` or a nonzero digit followed by digits, retained as a string and never converted to a JavaScript number */
export interface CommandArgumentId {
    /** Select decimal ID conversion without numeric coercion */
    readonly type: "id"
    /** Allow this trailing value to be omitted */
    readonly optional?: true
}

/** One nonempty literal selected from an explicit list of one to 100 choices */
export interface CommandArgumentChoice<C extends readonly string[] = readonly string[]> {
    /** Select literal choice conversion */
    readonly type: "choice"
    /** Explicit one to 100 unique nonempty accepted literals */
    readonly choices: C
    /** Allow this trailing value to be omitted */
    readonly optional?: true
}

/** One user selected from one to 100 explicit candidates by exact name, base-10 decimal ID or anchored mention */
export interface CommandArgumentUserSelection<
    C extends readonly CommandArgumentUser[] = readonly CommandArgumentUser[],
> {
    /** Select explicit user candidate conversion */
    readonly type: "user"
    /** Explicit one to 100 candidates projected to id and username */
    readonly candidates: C
    /** Allow this trailing value to be omitted */
    readonly optional?: true
}

/** One channel selected from one to 100 explicit candidates by exact name, base-10 decimal ID or anchored mention */
export interface CommandArgumentChannelSelection<
    C extends readonly CommandArgumentChannel[] = readonly CommandArgumentChannel[],
> {
    /** Select explicit channel candidate conversion */
    readonly type: "channel"
    /** Explicit one to 100 candidates projected to id and name */
    readonly candidates: C
    /** Allow this trailing value to be omitted */
    readonly optional?: true
}

/** One role selected from one to 100 explicit candidates by exact name, base-10 decimal ID or anchored mention */
export interface CommandArgumentRoleSelection<
    C extends readonly CommandArgumentRole[] = readonly CommandArgumentRole[],
> {
    /** Select explicit role candidate conversion */
    readonly type: "role"
    /** Explicit one to 100 candidates projected to id and name */
    readonly candidates: C
    /** Allow this trailing value to be omitted */
    readonly optional?: true
}

type OptionalArgumentValue<D extends CommandArgumentDescriptor, V> = D extends { readonly optional: true }
    ? V | undefined
    : V

/** Converted values exposed only to execute and cooldown callbacks */
export type CommandArgumentValues<S extends CommandArgumentSchema> = {
    readonly [K in keyof S]: CommandArgumentValue<S[K]>
}

/** Converted value for one built-in descriptor */
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

/** Safe reason for a conversion rejection. Raw command tokens and converter defects are never reported */
export type CommandArgumentRejectionReason = "Missing" | "Invalid" | "Ambiguous" | "Unexpected"
