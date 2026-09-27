/**
 * Prefix-command argument metadata and conversion.
 * Invariant: Argument definitions are snapshotted once, and a conversion failure never runs the command handler.
 * Implements [SDK contracts: User-handler failures](/docs/SDK-CONTRACTS.md#user-handler-failures)
 */
import type {
    CommandArgumentChannel,
    CommandArgumentDescriptor,
    CommandArgumentMetadata,
    CommandArgumentMention,
    CommandArgumentRejectionReason,
    CommandArgumentRole,
    CommandArgumentSchema,
    CommandArgumentUser,
} from "#sdk/command-arguments"
import { ConfigurationError } from "#sdk/errors"
import { snowflakes } from "#sdk/helpers"
import * as Effect from "effect/Effect"
import { throwIfErr } from "./failures.js"
import { unsupportedKeyHint } from "./suggest.js"

const argumentName = /^[A-Za-z][A-Za-z0-9_]*$/
const decimalId = /^(?:0|[1-9]\d*)$/
const integer = /^-?(?:0|[1-9]\d*)$/
const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const maxCandidates = 100

export type CommandArgumentConversion =
    | { readonly _tag: "Converted"; readonly values: Readonly<Record<string, unknown>> }
    | { readonly _tag: "Rejected"; readonly argument: string; readonly reason: CommandArgumentRejectionReason }

/** Validate and snapshot one local argument schema before a router retains it */
export function snapshotCommandArguments(value: CommandArgumentSchema | undefined): CommandArgumentSchema | undefined {
    if (value === undefined) return undefined
    if (!isObject(value)) throw new ConfigurationError("command", 'The option "arguments" must be an object')
    const entries: Record<string, CommandArgumentDescriptor> = {}
    let optional = false
    const names = schemaNames(value)
    for (let index = 0; index < names.length; index += 1) {
        const name = names[index]!
        if (!argumentName.test(name))
            throw new ConfigurationError(
                "command",
                "Argument names must begin with a letter and contain only letters, numbers or `_`",
            )
        const descriptor = argumentDescriptor(name, value[name]!)
        if (optional && !omittable(descriptor))
            throw new ConfigurationError("command", "Required arguments cannot follow optional arguments")
        if (hasRest(descriptor) && descriptor.rest === true && index + 1 !== names.length)
            throw new ConfigurationError("command", "A rest argument must be the final argument")
        optional ||= omittable(descriptor)
        entries[name] = descriptor
    }
    return Object.freeze(entries)
}

/** Return metadata that describes a schema without retaining candidate objects or callbacks */
export function commandArgumentMetadata(
    schema: CommandArgumentSchema | undefined,
): readonly CommandArgumentMetadata[] | undefined {
    if (schema === undefined) return undefined
    const metadata = Object.keys(schema).map((name) => {
        const descriptor = schema[name]!
        return Object.freeze({
            name,
            type: descriptor.type,
            optional: omittable(descriptor),
            rest: hasRest(descriptor) && descriptor.rest === true,
            ...(descriptor.type === "id" && descriptor.mention !== undefined ? { mention: descriptor.mention } : {}),
            ...(descriptor.type === "choice" ? { choices: Object.freeze([...descriptor.choices]) } : {}),
            ...(hasBounds(descriptor) && descriptor.min !== undefined ? { min: descriptor.min } : {}),
            ...(hasBounds(descriptor) && descriptor.max !== undefined ? { max: descriptor.max } : {}),
            ...(hasBounds(descriptor) && descriptor.default !== undefined ? { default: descriptor.default } : {}),
            ...(descriptor.type === "duration" && descriptor.wholeSeconds === true
                ? { wholeSeconds: true as const }
                : {}),
            ...(descriptor.type === "custom" && descriptor.expected !== undefined
                ? { expected: descriptor.expected }
                : {}),
        })
    })
    return Object.freeze(metadata)
}

/** Message facts a conversion may use, such as the guild of a member argument */
export interface CommandArgumentContext {
    readonly guildId?: string | undefined
}

/**
 * Convert already parsed positional arguments without reading a cache or performing network work.
 * A custom parse function that throws or returns an Err propagates its error, so dispatch reports it as a command failure.
 * A parse function that returns a Promise or Effect throws ConfigurationError, reported the same way
 */
export function convertCommandArguments(
    schema: CommandArgumentSchema | undefined,
    args: readonly string[],
    context: CommandArgumentContext = {},
): CommandArgumentConversion {
    if (schema === undefined) return Object.freeze({ _tag: "Converted", values: Object.freeze({}) })
    const values: Record<string, unknown> = {}
    const names = Object.keys(schema)
    let position = 0
    for (const name of names) {
        const descriptor = schema[name]!
        const raw =
            hasRest(descriptor) && descriptor.rest === true
                ? position === args.length
                    ? undefined
                    : args.slice(position).join(" ")
                : args[position]
        if (raw === undefined) {
            if (hasBounds(descriptor) && descriptor.default !== undefined) {
                values[name] = descriptor.default
                continue
            }
            if (descriptor.optional === true) {
                values[name] = undefined
                continue
            }
            return rejected(name, "Missing")
        }
        const converted = convertDescriptor(descriptor, raw, context)
        if (converted._tag === "Rejected") return rejected(name, converted.reason)
        values[name] = converted.value
        position = hasRest(descriptor) && descriptor.rest === true ? args.length : position + 1
    }
    if (position < args.length) return rejected("arguments", "Unexpected")
    return Object.freeze({ _tag: "Converted", values: Object.freeze(values) })
}

/** Snapshot one descriptor, naming its argument in a configuration error */
function argumentDescriptor(name: string, value: unknown): CommandArgumentDescriptor {
    try {
        return snapshotDescriptor(value)
    } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error
        throw new ConfigurationError(error.field, `Argument ${name}: ${error.message}`, {
            hint: error.hint,
            cause: error.cause,
        })
    }
}

function snapshotDescriptor(value: unknown): CommandArgumentDescriptor {
    if (!isObject(value)) throw new ConfigurationError("command", "Each argument descriptor must be an object")
    const type = value.type
    if (typeof type !== "string")
        throw new ConfigurationError("command", "Each argument descriptor must select a type", {
            hint: `Set type to one of ${argumentTypes.join(", ")}`,
        })
    switch (type) {
        case "text":
            validateShape(value, ["type", "optional", "rest"])
            return Object.freeze({ type, ...optional(value), ...rest(value) })
        case "integer":
        case "number":
            validateShape(value, ["type", "optional", "min", "max", "default"])
            return Object.freeze({ type, ...optional(value), ...bounds(type, value) })
        case "duration":
            return durationDescriptor(value)
        case "boolean":
        case "member":
            validateShape(value, ["type", "optional"])
            return Object.freeze({ type, ...optional(value) })
        case "custom": {
            validateShape(value, ["type", "parse", "expected", "optional", "rest"])
            if (typeof value.parse !== "function")
                throw new ConfigurationError("command", "A custom argument requires a parse function")
            if (value.expected !== undefined && (typeof value.expected !== "string" || value.expected.length === 0))
                throw new ConfigurationError("command", "A custom argument's expected text must be a nonempty string")
            return Object.freeze({
                type,
                parse: value.parse as (token: string) => unknown,
                ...(value.expected === undefined ? {} : { expected: value.expected as string }),
                ...optional(value),
                ...rest(value),
            })
        }
        case "id":
            validateShape(value, ["type", "mention", "optional"])
            return Object.freeze({ type, ...mention(value), ...optional(value) })
        case "choice": {
            validateShape(value, ["type", "choices", "optional"])
            const choices = copyStrings(value.choices, "Choice arguments require one to 100 unique nonempty choices")
            if (new Set(choices).size !== choices.length)
                throw new ConfigurationError("command", "Choice arguments require unique bounded choices")
            return Object.freeze({ type, choices, ...optional(value) })
        }
        case "userChoice":
            validateShape(value, ["type", "candidates", "optional"])
            return Object.freeze({
                type,
                candidates: copyCandidates<CommandArgumentUser>(value.candidates, "username"),
                ...optional(value),
            })
        case "channelChoice":
        case "roleChoice":
            validateShape(value, ["type", "candidates", "optional"])
            return type === "channelChoice"
                ? Object.freeze({
                      type,
                      candidates: copyCandidates<CommandArgumentChannel>(value.candidates, "name"),
                      ...optional(value),
                  })
                : Object.freeze({
                      type,
                      candidates: copyCandidates<CommandArgumentRole>(value.candidates, "name"),
                      ...optional(value),
                  })
        case "user":
        case "channel":
        case "role":
            // These names read like guild lookups, which the router does not perform, so point to the forms that exist
            throw new ConfigurationError("command", `The type "${type}" is not supported`, {
                hint:
                    `Use { type: "id", mention: "${type}" } for any ${type} ID or mention, ` +
                    (type === "user" ? `{ type: "member" } for a member of the message's community, ` : "") +
                    `or { type: "${type}Choice", candidates } to pick from a fixed list`,
            })
        default:
            throw new ConfigurationError("command", "Each argument descriptor must select a supported type", {
                hint: argumentTypeHint(type),
            })
    }
}

const argumentTypes = [
    "text",
    "integer",
    "number",
    "duration",
    "boolean",
    "member",
    "id",
    "choice",
    "userChoice",
    "channelChoice",
    "roleChoice",
    "custom",
]

/** Names commonly guessed for a supported type, compared in lowercase */
const argumentTypeGuesses: Readonly<Record<string, string>> = {
    string: "text",
    str: "text",
    txt: "text",
    int: "integer",
    float: "number",
    bool: "boolean",
    snowflake: "id",
}

/** Suggest the supported type an unsupported one most likely meant, then list the supported types */
function argumentTypeHint(type: string): string {
    const guess = Object.hasOwn(argumentTypeGuesses, type.toLowerCase())
        ? argumentTypeGuesses[type.toLowerCase()]
        : undefined
    return guess === undefined
        ? unsupportedKeyHint(type, argumentTypes, "types")
        : `Did you mean ${JSON.stringify(guess)}? Supported types are ${argumentTypes.join(", ")}`
}

function durationDescriptor(value: Record<string, unknown>): CommandArgumentDescriptor {
    validateShape(value, ["type", "optional", "min", "max", "default", "wholeSeconds"])
    if (value.wholeSeconds !== undefined && value.wholeSeconds !== true)
        throw new ConfigurationError("command", 'The option "wholeSeconds" must be true when supplied')
    const limits = bounds("duration", value)
    if (value.wholeSeconds === true && limits.default !== undefined && limits.default % 1000 !== 0)
        throw new ConfigurationError("command", "A wholeSeconds duration's default must be whole seconds")
    return Object.freeze({
        type: "duration",
        ...optional(value),
        ...limits,
        ...(value.wholeSeconds === true ? { wholeSeconds: true as const } : {}),
    })
}

/** Whole-number duration parts from largest to smallest unit, such as 1h30m */
const durationUnits: readonly (readonly [string, number])[] = [
    ["w", 604_800_000],
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
    ["ms", 1],
]
const durationPattern = /^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/

/** Parse unit-suffixed duration text to whole milliseconds, or undefined for anything else, including a bare number */
function parseDuration(raw: string): number | undefined {
    const match = durationPattern.exec(raw)
    if (match === null || raw.length === 0) return undefined
    let total = 0
    for (let index = 0; index < durationUnits.length; index += 1) {
        const part = match[index + 1]
        if (part !== undefined) total += Number(part) * durationUnits[index]![1]
    }
    return Number.isSafeInteger(total) ? total : undefined
}

function withinBounds(
    descriptor: { readonly min?: number; readonly max?: number },
    value: number,
): { readonly _tag: "Converted"; readonly value: number } | { readonly _tag: "Rejected"; readonly reason: "Invalid" } {
    if (descriptor.min !== undefined && value < descriptor.min) return invalid()
    if (descriptor.max !== undefined && value > descriptor.max) return invalid()
    return converted(value)
}

function bounds(
    type: "integer" | "number" | "duration",
    value: Record<string, unknown>,
): { readonly min?: number; readonly max?: number; readonly default?: number } {
    const valid = (entry: unknown): entry is number =>
        typeof entry === "number" && (type === "number" ? Number.isFinite(entry) : Number.isSafeInteger(entry))
    const unit =
        type === "number"
            ? "a finite number"
            : type === "duration"
              ? "a safe integer of milliseconds"
              : "a safe integer"
    for (const key of ["min", "max", "default"] as const)
        if (value[key] !== undefined && !valid(value[key]))
            throw new ConfigurationError("command", `The option "${key}" must be ${unit}`)
    const min = value.min as number | undefined
    const max = value.max as number | undefined
    const fallback = value.default as number | undefined
    if (min !== undefined && max !== undefined && min > max)
        throw new ConfigurationError("command", 'The option "min" must not be greater than "max"')
    if (fallback !== undefined && ((min !== undefined && fallback < min) || (max !== undefined && fallback > max)))
        throw new ConfigurationError("command", 'The option "default" must be within "min" and "max"')
    if (fallback !== undefined && value.optional !== undefined)
        throw new ConfigurationError("command", 'An argument with a default is already optional, so omit "optional"')
    return {
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(fallback === undefined ? {} : { default: fallback }),
    }
}

function optional(value: Record<string, unknown>): { readonly optional?: true } {
    if (value.optional === undefined) return {}
    if (value.optional !== true)
        throw new ConfigurationError("command", 'The option "optional" must be true when supplied')
    return { optional: true }
}

function mention(value: Record<string, unknown>): { readonly mention?: CommandArgumentMention } {
    if (value.mention === undefined) return {}
    if (value.mention !== "user" && value.mention !== "channel" && value.mention !== "role")
        throw new ConfigurationError("command", 'The option "mention" must be "user", "channel" or "role"')
    return { mention: value.mention }
}

function rest(value: Record<string, unknown>): { readonly rest?: true } {
    if (value.rest === undefined) return {}
    if (value.rest !== true) throw new ConfigurationError("command", 'The option "rest" must be true when supplied')
    return { rest: true }
}

function copyCandidates<T extends CommandArgumentUser | CommandArgumentChannel | CommandArgumentRole>(
    value: unknown,
    nameKey: "username" | "name",
): readonly T[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > maxCandidates)
        throw new ConfigurationError("command", "Resource arguments require one to 100 explicit candidates")
    const copied: T[] = []
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
            throw new ConfigurationError("command", "Resource candidates cannot be sparse")
        const candidate = value[index]
        if (
            !isObject(candidate) ||
            typeof candidate.id !== "string" ||
            !decimalId.test(candidate.id) ||
            typeof candidate[nameKey] !== "string" ||
            candidate[nameKey].length === 0
        )
            throw new ConfigurationError("command", "Resource candidates require decimal IDs and nonempty names")
        copied.push(
            Object.freeze(
                nameKey === "username"
                    ? { id: candidate.id, username: candidate.username }
                    : { id: candidate.id, name: candidate.name },
            ) as T,
        )
    }
    return Object.freeze(copied)
}

function copyStrings(value: unknown, message: string): readonly string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > maxCandidates)
        throw new ConfigurationError("command", message)
    for (let index = 0; index < value.length; index += 1)
        if (!Object.hasOwn(value, index) || typeof value[index] !== "string" || value[index].length === 0)
            throw new ConfigurationError("command", message)
    const copied: string[] = []
    for (let index = 0; index < value.length; index += 1) copied.push(value[index] as string)
    return Object.freeze(copied)
}

function convertDescriptor(
    descriptor: CommandArgumentDescriptor,
    raw: string,
    context: CommandArgumentContext,
):
    | { readonly _tag: "Converted"; readonly value: unknown }
    | { readonly _tag: "Rejected"; readonly reason: CommandArgumentRejectionReason } {
    switch (descriptor.type) {
        case "text":
            return raw.length === 0 ? invalid() : converted(raw)
        case "integer": {
            if (!integer.test(raw)) return invalid()
            const value = Number(raw)
            return Number.isSafeInteger(value) ? withinBounds(descriptor, value) : invalid()
        }
        case "number": {
            if (!number.test(raw)) return invalid()
            const value = Number(raw)
            return Number.isFinite(value) ? withinBounds(descriptor, value) : invalid()
        }
        case "duration": {
            const value = parseDuration(raw)
            if (value === undefined || (descriptor.wholeSeconds === true && value % 1000 !== 0)) return invalid()
            return withinBounds(descriptor, value)
        }
        case "member": {
            const userId = /^<@!?(\d+)>$/.exec(raw)?.[1] ?? raw
            if (!isArgumentId(userId) || context.guildId === undefined) return invalid()
            return converted(Object.freeze({ guildId: context.guildId, userId }))
        }
        case "custom":
            return customValue(descriptor.parse(raw))
        case "boolean":
            return raw === "true" ? converted(true) : raw === "false" ? converted(false) : invalid()
        case "id":
            return isArgumentId(raw) ? converted(raw) : selectIdMention(raw, descriptor.mention)
        case "choice":
            return descriptor.choices.includes(raw) ? converted(raw) : invalid()
        case "userChoice":
            return selectResource(descriptor.candidates, raw, "username", /^<@!?([1-9]\d*)>$/)
        case "channelChoice":
            return selectResource(descriptor.candidates, raw, "name", /^<#([1-9]\d*)>$/)
        case "roleChoice":
            return selectResource(descriptor.candidates, raw, "name", /^<@&([1-9]\d*)>$/)
    }
}

function selectIdMention(
    raw: string,
    kind: CommandArgumentMention | undefined,
): { readonly _tag: "Converted"; readonly value: string } | { readonly _tag: "Rejected"; readonly reason: "Invalid" } {
    const match =
        kind === "user"
            ? /^<@!?(\d+)>$/.exec(raw)
            : kind === "channel"
              ? /^<#(\d+)>$/.exec(raw)
              : kind === "role"
                ? /^<@&(\d+)>$/.exec(raw)
                : undefined
    return match === null || match === undefined || !isArgumentId(match[1]) ? invalid() : converted(match[1]!)
}

/** A nonzero decimal ID without leading zeroes, no larger than the largest 64-bit ID, as `id` and `member` accept */
function isArgumentId(value: string | undefined): value is string {
    return value !== "0" && snowflakes.isValid(value)
}

/**
 * Keep a custom parse result, rejecting undefined as Invalid.
 * A returned Err is thrown as its error, like a throwing parse. A Promise or Effect is misuse, because parse runs
 * synchronously and its value would otherwise be stored without being awaited
 */
function customValue(
    value: unknown,
): { readonly _tag: "Converted"; readonly value: unknown } | { readonly _tag: "Rejected"; readonly reason: "Invalid" } {
    throwIfErr(value)
    if (Effect.isEffect(value)) throw asynchronousParse()
    if (isThenable(value)) {
        // allow-silent: The ConfigurationError thrown below reports the misuse, and the late outcome belongs to that misuse
        Promise.resolve(value).then(undefined, () => undefined)
        throw asynchronousParse()
    }
    return value === undefined ? invalid() : converted(value)
}

function asynchronousParse(): ConfigurationError {
    return new ConfigurationError(
        "command",
        "A custom argument parse function must return its value synchronously, not a Promise or Effect",
    )
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        typeof (value as { then?: unknown }).then === "function"
    )
}

function selectResource<N extends "username" | "name", T extends { readonly id: string } & Record<N, string>>(
    candidates: readonly T[],
    raw: string,
    nameKey: N,
    mention: RegExp,
):
    | { readonly _tag: "Converted"; readonly value: T }
    | { readonly _tag: "Rejected"; readonly reason: CommandArgumentRejectionReason } {
    const mentionId = mention.exec(raw)?.[1]
    const id = mentionId ?? (decimalId.test(raw) ? raw : undefined)
    let matches = candidates.filter((candidate) =>
        id === undefined ? candidate[nameKey] === raw : candidate.id === id,
    )
    if (matches.length === 0 && id !== undefined && mentionId === undefined)
        matches = candidates.filter((candidate) => candidate[nameKey] === raw)
    return matches.length === 1
        ? Object.freeze({ _tag: "Converted" as const, value: matches[0]! })
        : matches.length > 1
          ? rejectedValue("Ambiguous")
          : invalid()
}

function converted<T>(value: T): { readonly _tag: "Converted"; readonly value: T } {
    return Object.freeze({ _tag: "Converted", value })
}

function invalid(): { readonly _tag: "Rejected"; readonly reason: "Invalid" } {
    return Object.freeze({ _tag: "Rejected", reason: "Invalid" })
}

function rejectedValue(reason: CommandArgumentRejectionReason): {
    readonly _tag: "Rejected"
    readonly reason: CommandArgumentRejectionReason
} {
    return Object.freeze({ _tag: "Rejected", reason })
}

function rejected(argument: string, reason: CommandArgumentRejectionReason): CommandArgumentConversion {
    return Object.freeze({ _tag: "Rejected", argument, reason })
}

function validateShape(value: Record<string, unknown>, keys: readonly string[]): void {
    for (const key of Reflect.ownKeys(value))
        if (typeof key !== "string" || !keys.includes(key))
            throw new ConfigurationError(
                "command",
                typeof key === "string"
                    ? `Unsupported argument option ${JSON.stringify(key)}`
                    : "An argument descriptor must not have symbol keys",
                { hint: unsupportedKeyHint(typeof key === "string" ? key : "", keys) },
            )
}

function schemaNames(value: Record<string, unknown>): readonly string[] {
    const names: string[] = []
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))
            throw new ConfigurationError("command", 'The option "arguments" must have only enumerable string keys')
        names.push(key)
    }
    return Object.freeze(names)
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasRest(
    descriptor: CommandArgumentDescriptor,
): descriptor is Extract<CommandArgumentDescriptor, { readonly type: "text" | "custom" }> {
    return descriptor.type === "text" || descriptor.type === "custom"
}

function hasBounds(
    descriptor: CommandArgumentDescriptor,
): descriptor is Extract<CommandArgumentDescriptor, { readonly type: "integer" | "number" | "duration" }> {
    return descriptor.type === "integer" || descriptor.type === "number" || descriptor.type === "duration"
}

/** Whether a missing token is accepted, through optional or a default */
function omittable(descriptor: CommandArgumentDescriptor): boolean {
    return descriptor.optional === true || (hasBounds(descriptor) && descriptor.default !== undefined)
}
