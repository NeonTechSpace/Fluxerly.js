import type {
    CommandArgumentChannel,
    CommandArgumentDescriptor,
    CommandArgumentMetadata,
    CommandArgumentRejectionReason,
    CommandArgumentRole,
    CommandArgumentSchema,
    CommandArgumentUser,
} from "#sdk/command-arguments"
import { ConfigurationError } from "#sdk/errors"

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
    if (!isObject(value)) throw new ConfigurationError("command", "arguments must be an object when supplied")
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
        const descriptor = snapshotDescriptor(value[name]!)
        if (optional && descriptor.optional !== true)
            throw new ConfigurationError("command", "Required arguments cannot follow optional arguments")
        if (hasRest(descriptor) && descriptor.rest === true && index + 1 !== names.length)
            throw new ConfigurationError("command", "A rest argument must be the final argument")
        optional ||= descriptor.optional === true
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
            optional: descriptor.optional === true,
            rest: hasRest(descriptor) && descriptor.rest === true,
            ...(descriptor.type === "choice" ? { choices: Object.freeze([...descriptor.choices]) } : {}),
        })
    })
    return Object.freeze(metadata)
}

/** Convert already parsed positional arguments without reading a cache or performing network work */
export function convertCommandArguments(
    schema: CommandArgumentSchema | undefined,
    args: readonly string[],
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
            if (descriptor.optional === true) {
                values[name] = undefined
                continue
            }
            return rejected(name, "Missing")
        }
        const converted = convertDescriptor(descriptor, raw)
        if (converted._tag === "Rejected") return rejected(name, converted.reason)
        values[name] = converted.value
        position = hasRest(descriptor) && descriptor.rest === true ? args.length : position + 1
    }
    if (position < args.length) return rejected("arguments", "Unexpected")
    return Object.freeze({ _tag: "Converted", values: Object.freeze(values) })
}

function snapshotDescriptor(value: unknown): CommandArgumentDescriptor {
    if (!isObject(value)) throw new ConfigurationError("command", "Each argument descriptor must be an object")
    const type = value.type
    if (typeof type !== "string") throw new ConfigurationError("command", "Each argument descriptor must select a type")
    switch (type) {
        case "text":
            validateShape(value, ["type", "optional", "rest"])
            return Object.freeze({ type, ...optional(value), ...rest(value) })
        case "integer":
        case "number":
        case "boolean":
        case "id":
            validateShape(value, ["type", "optional"])
            return Object.freeze({ type, ...optional(value) })
        case "choice": {
            validateShape(value, ["type", "choices", "optional"])
            const choices = copyStrings(value.choices, "Choice arguments require one to 100 unique nonempty choices")
            if (new Set(choices).size !== choices.length)
                throw new ConfigurationError("command", "Choice arguments require unique bounded choices")
            return Object.freeze({ type, choices, ...optional(value) })
        }
        case "user":
            validateShape(value, ["type", "candidates", "optional"])
            return Object.freeze({
                type,
                candidates: copyCandidates<CommandArgumentUser>(value.candidates, "username"),
                ...optional(value),
            })
        case "channel":
        case "role":
            validateShape(value, ["type", "candidates", "optional"])
            return type === "channel"
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
        default:
            throw new ConfigurationError("command", "Each argument descriptor must select a supported type")
    }
}

function optional(value: Record<string, unknown>): { readonly optional?: true } {
    if (value.optional === undefined) return {}
    if (value.optional !== true) throw new ConfigurationError("command", "optional must be true when supplied")
    return { optional: true }
}

function rest(value: Record<string, unknown>): { readonly rest?: true } {
    if (value.rest === undefined) return {}
    if (value.rest !== true) throw new ConfigurationError("command", "rest must be true when supplied")
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
):
    | { readonly _tag: "Converted"; readonly value: unknown }
    | { readonly _tag: "Rejected"; readonly reason: CommandArgumentRejectionReason } {
    switch (descriptor.type) {
        case "text":
            return raw.length === 0 ? invalid() : converted(raw)
        case "integer": {
            if (!integer.test(raw)) return invalid()
            const value = Number(raw)
            return Number.isSafeInteger(value) ? converted(value) : invalid()
        }
        case "number": {
            if (!number.test(raw)) return invalid()
            const value = Number(raw)
            return Number.isFinite(value) ? converted(value) : invalid()
        }
        case "boolean":
            return raw === "true" ? converted(true) : raw === "false" ? converted(false) : invalid()
        case "id":
            return decimalId.test(raw) ? converted(raw) : invalid()
        case "choice":
            return descriptor.choices.includes(raw) ? converted(raw) : invalid()
        case "user":
            return selectResource(descriptor.candidates, raw, "username", /^<@!?([1-9]\d*)>$/)
        case "channel":
            return selectResource(descriptor.candidates, raw, "name", /^<#([1-9]\d*)>$/)
        case "role":
            return selectResource(descriptor.candidates, raw, "name", /^<@&([1-9]\d*)>$/)
    }
}

function selectResource<N extends "username" | "name", T extends { readonly id: string } & Record<N, string>>(
    candidates: readonly T[],
    raw: string,
    nameKey: N,
    mention: RegExp,
):
    | { readonly _tag: "Converted"; readonly value: T }
    | { readonly _tag: "Rejected"; readonly reason: CommandArgumentRejectionReason } {
    const id = mention.exec(raw)?.[1] ?? (decimalId.test(raw) ? raw : undefined)
    const matches = candidates.filter((candidate) =>
        id === undefined ? candidate[nameKey] === raw : candidate.id === id,
    )
    return matches.length === 1
        ? Object.freeze({ _tag: "Converted" as const, value: matches[0]! })
        : matches.length > 1
          ? rejectedValue("Ambiguous")
          : invalid()
}

function converted(value: unknown): { readonly _tag: "Converted"; readonly value: unknown } {
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
            throw new ConfigurationError("command", "An argument descriptor contains an unsupported option")
}

function schemaNames(value: Record<string, unknown>): readonly string[] {
    const names: string[] = []
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))
            throw new ConfigurationError("command", "arguments contains an unsupported entry")
        names.push(key)
    }
    return Object.freeze(names)
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasRest(
    descriptor: CommandArgumentDescriptor,
): descriptor is Extract<CommandArgumentDescriptor, { readonly type: "text" }> {
    return descriptor.type === "text"
}
