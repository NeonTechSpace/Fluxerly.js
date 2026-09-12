import type {
    CommandCooldownClaim,
    CommandCooldownRequest,
    MemoryCooldownOptions,
    PrefixCommandDefinition,
    PrefixCommandMetadata,
    PrefixCommandParse,
    PrefixCommandParseInput,
    PrefixCommandRejection,
    PrefixCommandUnmatched,
    PrefixCommandsOptions,
} from "#sdk/commands"
import {
    commandArgumentMetadata,
    type CommandArgumentConversion,
    snapshotCommandArguments,
} from "#sdk/internal/command-arguments"
import { ConfigurationError } from "#sdk/errors"
import type { Message } from "#sdk/messages"
import { Effect } from "effect"

const commandName = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const maxDurationMs = 2_147_483_647
const emptyCommandMetadata: readonly PrefixCommandMetadata[] = Object.freeze([])

export interface PrefixCommandMatch<D extends PrefixCommandDefinition> {
    readonly definition: D
    readonly prefix: string
    readonly parse: PrefixCommandParse
}

/** Prefix and frozen unmatched result retained only while an attached router dispatches one message */
export interface PrefixCommandUnmatchedMatch {
    readonly prefix: string
    readonly unmatched: PrefixCommandUnmatched
}

/** Shared immutable command lookup state. Entry-point adapters own callback and error boundaries */
export class PrefixCommandRegistry<D extends PrefixCommandDefinition> {
    readonly #definitions: ReadonlyMap<string, D>
    readonly #commands: readonly PrefixCommandMetadata[]
    readonly #options: Readonly<PrefixCommandsOptions>

    constructor(
        options: PrefixCommandsOptions,
        definitions: ReadonlyMap<string, D> = new Map(),
        commands: readonly PrefixCommandMetadata[] = emptyCommandMetadata,
    ) {
        this.#options = copyOptions(options)
        this.#definitions = definitions
        this.#commands = commands
    }

    /** Immutable registration-order help metadata with no callbacks or local storage references */
    get commands(): readonly PrefixCommandMetadata[] {
        return this.#commands
    }

    /** Return a separate registry snapshot. Existing routers and subscriptions keep their previous definitions */
    register(definition: D): PrefixCommandRegistry<D> {
        validateDefinition(definition)
        const stored = copyDefinition(definition)
        const keys = [stored.name, ...(stored.aliases ?? [])].map((value) => this.normalize(value))
        if (new Set(keys).size !== keys.length)
            throw new ConfigurationError("aliases", "A command name and its aliases must be unique")
        for (const key of keys)
            if (this.#definitions.has(key))
                throw new ConfigurationError("aliases", "A command name or alias is already registered")
        const definitions = new Map(this.#definitions)
        for (const key of keys) definitions.set(key, stored)
        return new PrefixCommandRegistry(
            this.#options,
            definitions,
            Object.freeze([...this.#commands, snapshotCommandIdentity(stored)]),
        )
    }

    resolve(message: Message): PrefixCommandMatch<D> | PrefixCommandUnmatchedMatch | undefined {
        if (this.#options.ignoreBots !== false && message.author.isBot) return undefined
        const prefix = this.matchPrefix(message)
        if (prefix === undefined) return undefined
        const input: PrefixCommandParseInput = Object.freeze({
            message,
            prefix,
            source: message.content.slice(prefix.length),
        })
        const parsed = this.#options.parse === undefined ? defaultParse(input) : this.#options.parse(input)
        if (parsed === undefined)
            return Object.freeze({
                prefix,
                unmatched: Object.freeze({ _tag: "CommandParserRejected" }),
            })
        const parse = copyParse(parsed)
        const definition = this.#definitions.get(this.normalize(parse.name))
        return definition === undefined
            ? Object.freeze({
                  prefix,
                  unmatched: Object.freeze({ _tag: "CommandUnknownName", name: parse.name }),
              })
            : Object.freeze({ definition, prefix, parse })
    }

    private matchPrefix(message: Message): string | undefined {
        const resolved =
            typeof this.#options.prefix === "function" ? this.#options.prefix(message) : this.#options.prefix
        const prefixes = typeof resolved === "string" ? [resolved] : resolved
        if (!Array.isArray(prefixes)) {
            if (prefixes === undefined) return undefined
            throw new ConfigurationError("prefix", "A prefix resolver must return a string, string array or undefined")
        }
        const values = copyNonemptyStringArray(prefixes, "prefix")
        let selected: string | undefined
        for (const prefix of values)
            if (message.content.startsWith(prefix) && (selected === undefined || prefix.length > selected.length))
                selected = prefix
        return selected
    }

    private normalize(value: string): string {
        return this.#options.caseSensitive === true ? value : value.toLowerCase()
    }
}

/** A local cooldown outcome with configuration failures kept as data for the public adapter */
export type LocalMemoryResult<A> =
    { readonly _tag: "Success"; readonly value: A } | { readonly _tag: "Failure"; readonly error: ConfigurationError }

/** Process-local cooldown state shared by default and native adapters */
export interface LocalMemoryCooldownStore {
    readonly maxEntries: number
    readonly size: number
    claim(input: unknown): LocalMemoryResult<CommandCooldownClaim>
    sweep(): number
    clear(): void
}

/** Create one bounded local cooldown store after validating only its retention limit */
export function createMemoryCooldownStore(options: MemoryCooldownOptions | undefined): LocalMemoryCooldownStore {
    if (options !== undefined) validateObjectShape(options, ["maxEntries"], "maxEntries", "Cooldown options")
    const maxEntries = options?.maxEntries === undefined ? 1_024 : options.maxEntries
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
        throw new ConfigurationError("maxEntries", "maxEntries must be a positive safe integer")
    return new LocalMemoryCooldownStoreOwner(maxEntries)
}

/** Validate command-level cooldown metadata before an adapter snapshots its intentional store and key references */
export function validateCommandCooldown(value: unknown): void {
    if (value === undefined) return
    validateObjectShape(value, ["store", "durationMs", "key"], "cooldown", "cooldown")
    const cooldown = value as { durationMs?: unknown; store?: unknown; key?: unknown }
    if (
        typeof cooldown.durationMs !== "number" ||
        !Number.isSafeInteger(cooldown.durationMs) ||
        cooldown.durationMs < 1 ||
        cooldown.durationMs > maxDurationMs
    )
        throw new ConfigurationError(
            "cooldown",
            `cooldown durationMs must be a positive safe integer no greater than ${maxDurationMs}`,
        )
    if (
        typeof cooldown.store !== "object" ||
        cooldown.store === null ||
        typeof (cooldown.store as { claim?: unknown }).claim !== "function"
    )
        throw new ConfigurationError("cooldown", "cooldown store must provide claim")
    if (cooldown.key !== undefined && typeof cooldown.key !== "function")
        throw new ConfigurationError("cooldown", "cooldown key must be a function when supplied")
}

/** Validate and copy the command identity portion retained by an adapter snapshot */
export function snapshotCommandIdentity(value: PrefixCommandDefinition): PrefixCommandMetadata {
    validateDefinition(value)
    const aliases = value.aliases === undefined ? undefined : copyCommandNames(value.aliases, "aliases")
    const argumentsSchema = snapshotCommandArguments(value.arguments)
    const argumentsMetadata = commandArgumentMetadata(argumentsSchema)
    return Object.freeze({
        name: value.name,
        ...(aliases === undefined ? {} : { aliases }),
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.usage === undefined ? {} : { usage: value.usage }),
        ...(argumentsMetadata === undefined ? {} : { arguments: argumentsMetadata }),
    })
}

/** Validate a finite adapter command object before reading its selected public fields */
export function validateCommandShape(value: unknown, keys: readonly string[]): void {
    validateObjectShape(value, keys, "command", "A command")
}

/** Reject malformed command cooldown claims without exposing caller-supplied data */
export function validateCooldownClaim(value: unknown): asserts value is CommandCooldownClaim {
    if (typeof value !== "object" || value === null)
        throw new ConfigurationError("cooldown", "Cooldown store returned an invalid claim")
    const claim = value as { _tag?: unknown; retryAtMs?: unknown }
    if (claim._tag === "CooldownAcquired" || claim._tag === "CooldownActive") {
        if (typeof claim.retryAtMs === "number" && Number.isSafeInteger(claim.retryAtMs)) return
    }
    if (
        claim._tag === "CooldownCapacity" &&
        (claim.retryAtMs === null || (typeof claim.retryAtMs === "number" && Number.isSafeInteger(claim.retryAtMs)))
    )
        return
    throw new ConfigurationError("cooldown", "Cooldown store returned an invalid claim")
}

/** Validate and namespace a caller-selected cooldown key before a store sees it */
export function cooldownRequest(commandName: string, key: unknown, durationMs: number): CommandCooldownRequest {
    if (typeof key !== "string" || key.length === 0)
        throw new ConfigurationError("cooldown", "Cooldown keys must be nonempty strings")
    return Object.freeze({ key: JSON.stringify([commandName, key]), durationMs })
}

/** Convert only expected configuration exceptions into the Effect error channel. Other exceptions remain defects */
export function configurationEffect<A>(thunk: () => A): Effect.Effect<A, ConfigurationError> {
    return Effect.try({
        try: thunk,
        catch: (error) => {
            if (error instanceof ConfigurationError) return error
            throw error
        },
    })
}

/** Adapter callbacks for one shared Effect dispatcher */
export interface CommandDispatchAdapter<D extends PrefixCommandDefinition, C, X = C, E = never, R = never> {
    readonly context: (match: PrefixCommandMatch<D>) => C
    readonly guard: (definition: D, context: C) => Effect.Effect<unknown, E, R>
    /** Local synchronous conversion after a successful guard and before a cooldown claim */
    readonly convert?: (definition: D, context: C) => CommandArgumentConversion
    readonly executionContext?: (context: C, values: Readonly<Record<string, unknown>>) => X
    readonly cooldown?: (definition: D, context: X) => Effect.Effect<CommandCooldownClaim, E, R>
    /** Optional contextual rejection feedback. It runs through the existing subscription error boundary and never sends a response itself */
    readonly reject?: (definition: D, context: C, rejection: PrefixCommandRejection) => Effect.Effect<unknown, E, R>
    /** Optional application-owned feedback for a parser decline or unregistered parsed name */
    readonly unmatched?: (match: PrefixCommandUnmatchedMatch) => Effect.Effect<unknown, E, R>
    readonly execute: (definition: D, context: X) => Effect.Effect<unknown, E, R>
    /** Return false after default cancellation so a later callback never starts */
    readonly active?: () => boolean
}

/** Dispatch one resolved command through the caller's Effect runtime without a queue, send or retry */
export function dispatchCommand<D extends PrefixCommandDefinition, C, X, E, R>(
    registry: PrefixCommandRegistry<D>,
    message: Message,
    adapter: CommandDispatchAdapter<D, C, X, E, R>,
): Effect.Effect<void, ConfigurationError | E, R> {
    const active = (): Effect.Effect<void> =>
        adapter.active === undefined
            ? Effect.void
            : (Effect.suspend(() => (adapter.active!() ? Effect.void : Effect.interrupt)) as Effect.Effect<void>)
    return Effect.gen(function* () {
        yield* active()
        const resolved = yield* configurationEffect(() => registry.resolve(message))
        if (resolved === undefined) return
        if ("unmatched" in resolved) {
            yield* active()
            if (adapter.unmatched !== undefined) yield* adapter.unmatched(resolved)
            return
        }
        const matched = resolved
        const context = adapter.context(matched)
        yield* active()
        const permitted = yield* adapter.guard(matched.definition, context)
        if (typeof permitted !== "boolean")
            return yield* Effect.fail(new ConfigurationError("command", "A command guard must return a boolean"))
        if (!permitted) {
            yield* active()
            if (adapter.reject !== undefined)
                yield* adapter.reject(matched.definition, context, Object.freeze({ _tag: "CommandGuardRejected" }))
            return
        }
        const conversion = adapter.convert === undefined ? undefined : adapter.convert(matched.definition, context)
        if (conversion !== undefined && conversion._tag === "Rejected") {
            yield* active()
            if (adapter.reject !== undefined)
                yield* adapter.reject(
                    matched.definition,
                    context,
                    Object.freeze({
                        _tag: "CommandArgumentRejected",
                        argument: conversion.argument,
                        reason: conversion.reason,
                    }),
                )
            return
        }
        const executionContext =
            conversion === undefined || adapter.executionContext === undefined
                ? (context as unknown as X)
                : adapter.executionContext(context, conversion.values)
        if (adapter.cooldown !== undefined) {
            yield* active()
            const claim = yield* adapter.cooldown(matched.definition, executionContext)
            yield* configurationEffect(() => validateCooldownClaim(claim))
            if (claim._tag !== "CooldownAcquired") {
                yield* active()
                if (adapter.reject !== undefined)
                    yield* adapter.reject(
                        matched.definition,
                        context,
                        claim._tag === "CooldownActive"
                            ? Object.freeze({ _tag: "CommandCooldownActive", retryAtMs: claim.retryAtMs })
                            : Object.freeze({ _tag: "CommandCooldownCapacity", retryAtMs: claim.retryAtMs }),
                    )
                return
            }
        }
        yield* active()
        yield* adapter.execute(matched.definition, executionContext)
    }) as Effect.Effect<void, ConfigurationError | E, R>
}

function copyOptions(value: PrefixCommandsOptions): Readonly<PrefixCommandsOptions> {
    validateObjectShape(
        value,
        ["prefix", "parse", "ignoreBots", "caseSensitive", "onUnmatched"],
        "commands",
        "Prefix command options",
    )
    if (typeof value.prefix !== "string" && !Array.isArray(value.prefix) && typeof value.prefix !== "function")
        throw new ConfigurationError("prefix", "prefix must be a string, string array or resolver")
    if (typeof value.prefix === "string" && value.prefix.length === 0)
        throw new ConfigurationError("prefix", "prefix must be nonempty")
    const prefix = Array.isArray(value.prefix) ? copyNonemptyStringArray(value.prefix, "prefix") : value.prefix
    if (value.parse !== undefined && typeof value.parse !== "function")
        throw new ConfigurationError("parser", "parse must be a function when supplied")
    if (value.ignoreBots !== undefined && typeof value.ignoreBots !== "boolean")
        throw new ConfigurationError("commands", "ignoreBots must be a boolean when supplied")
    if (value.caseSensitive !== undefined && typeof value.caseSensitive !== "boolean")
        throw new ConfigurationError("commands", "caseSensitive must be a boolean when supplied")
    return Object.freeze({
        prefix,
        ...(value.parse === undefined ? {} : { parse: value.parse }),
        ...(value.ignoreBots === undefined ? {} : { ignoreBots: value.ignoreBots }),
        ...(value.caseSensitive === undefined ? {} : { caseSensitive: value.caseSensitive }),
    })
}

function validateDefinition(value: PrefixCommandDefinition): void {
    if (typeof value !== "object" || value === null)
        throw new ConfigurationError("command", "A command must be an object")
    if (!isCommandName(value.name))
        throw new ConfigurationError(
            "command",
            "Command names must use ASCII letters, numbers, `_` or `-` and begin alphanumerically",
        )
    if (value.aliases !== undefined) copyCommandNames(value.aliases, "aliases")
    if (value.description !== undefined && typeof value.description !== "string")
        throw new ConfigurationError("command", "Command description must be a string when supplied")
    if (value.usage !== undefined && typeof value.usage !== "string")
        throw new ConfigurationError("command", "Command usage must be a string when supplied")
    snapshotCommandArguments(value.arguments)
}

function copyDefinition<D extends PrefixCommandDefinition>(value: D): D {
    const aliases = value.aliases === undefined ? undefined : copyCommandNames(value.aliases, "aliases")
    const argumentsSchema = snapshotCommandArguments(value.arguments)
    return Object.freeze({
        ...value,
        name: value.name,
        ...(aliases === undefined ? {} : { aliases }),
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.usage === undefined ? {} : { usage: value.usage }),
        ...(argumentsSchema === undefined ? {} : { arguments: argumentsSchema }),
    }) as D
}

function copyParse(value: PrefixCommandParse): PrefixCommandParse {
    validateObjectShape(value, ["name", "args", "rawArgs"], "parser", "A parser result")
    if (!isCommandName(value.name)) throw new ConfigurationError("parser", "A parser must return a valid command name")
    if (typeof value.rawArgs !== "string")
        throw new ConfigurationError("parser", "A parser must return rawArgs as a string")
    return Object.freeze({ name: value.name, rawArgs: value.rawArgs, args: copyStringArray(value.args, "parser") })
}

function defaultParse(input: PrefixCommandParseInput): PrefixCommandParse | undefined {
    const source = input.source.trimStart()
    if (source.length === 0) return undefined
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(source)
    const name = match?.[1]
    if (name === undefined || !isCommandName(name)) return undefined
    const rawArgs = match?.[2] ?? ""
    const positional = rawArgs.trim()
    return { name, rawArgs, args: positional.length === 0 ? [] : positional.split(/\s+/) }
}

function copyCommandNames(value: unknown, field: "aliases"): readonly string[] {
    const names = copyStringArray(value, field)
    for (const name of names)
        if (!isCommandName(name))
            throw new ConfigurationError(
                "aliases",
                "Command aliases must use ASCII letters, numbers, `_` or `-` and begin alphanumerically",
            )
    return names
}

function copyNonemptyStringArray(value: unknown, field: "prefix"): readonly string[] {
    const values = copyStringArray(value, field)
    if (values.length === 0)
        throw new ConfigurationError("prefix", "prefix arrays require at least one nonempty string")
    for (const prefix of values)
        if (prefix.length === 0)
            throw new ConfigurationError("prefix", "prefix arrays require at least one nonempty string")
    return values
}

function copyStringArray(value: unknown, field: "aliases" | "prefix" | "parser"): readonly string[] {
    if (!Array.isArray(value)) throw new ConfigurationError(field, `${field} must be a string array`)
    validateArrayShape(value, field)
    const copied: string[] = []
    for (let index = 0; index < value.length; index += 1) {
        const entry = value[index]
        if (typeof entry !== "string") throw new ConfigurationError(field, `${field} must contain only strings`)
        copied.push(entry)
    }
    return Object.freeze(copied)
}

function validateObjectShape(
    value: unknown,
    keys: readonly string[],
    field: ConfigurationError["field"],
    label: string,
): void {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new ConfigurationError(field, `${label} must be an object`)
    for (const key of Reflect.ownKeys(value))
        if (typeof key !== "string" || !keys.includes(key))
            throw new ConfigurationError(field, `${label} contains an unsupported option`)
}

function validateArrayShape(value: readonly unknown[], field: "aliases" | "prefix" | "parser"): void {
    for (let index = 0; index < value.length; index += 1)
        if (!Object.hasOwn(value, index)) throw new ConfigurationError(field, `${field} cannot be sparse`)
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue
        if (typeof key !== "string" || !isArrayIndex(key, value.length))
            throw new ConfigurationError(field, `${field} contains an unsupported entry`)
    }
}

function isArrayIndex(key: string, length: number): boolean {
    if (!/^(?:0|[1-9]\d*)$/.test(key)) return false
    const index = Number(key)
    return Number.isSafeInteger(index) && index >= 0 && index < length
}

function isCommandName(value: unknown): value is string {
    return typeof value === "string" && commandName.test(value)
}

class LocalMemoryCooldownStoreOwner implements LocalMemoryCooldownStore {
    private readonly entries = new Map<string, number>()

    constructor(readonly maxEntries: number) {}

    get size(): number {
        return this.entries.size
    }

    claim(input: unknown): LocalMemoryResult<CommandCooldownClaim> {
        const request = validateMemoryRequest(input)
        if (request._tag === "Failure") return request
        const now = Date.now()
        this.sweepAt(now)
        const active = this.entries.get(request.value.key)
        if (active !== undefined && active > now)
            return success(Object.freeze({ _tag: "CooldownActive", retryAtMs: active }))
        if (this.entries.size >= this.maxEntries) {
            let earliest: number | undefined
            for (const expiry of this.entries.values())
                if (earliest === undefined || expiry < earliest) earliest = expiry
            return success(Object.freeze({ _tag: "CooldownCapacity", retryAtMs: earliest ?? null }))
        }
        const retryAtMs = now + request.value.durationMs
        this.entries.set(request.value.key, retryAtMs)
        return success(Object.freeze({ _tag: "CooldownAcquired", retryAtMs }))
    }

    sweep(): number {
        return this.sweepAt(Date.now())
    }

    clear(): void {
        this.entries.clear()
    }

    private sweepAt(now: number): number {
        let count = 0
        for (const [key, expiry] of this.entries)
            if (expiry <= now) {
                this.entries.delete(key)
                count += 1
            }
        return count
    }
}

function validateMemoryRequest(input: unknown): LocalMemoryResult<CommandCooldownRequest> {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        return failure(new ConfigurationError("cooldown", "A cooldown claim requires an object"))
    const request = input as { key?: unknown; durationMs?: unknown }
    if (typeof request.key !== "string" || request.key.length === 0)
        return failure(new ConfigurationError("cooldown", "Cooldown keys must be nonempty strings"))
    if (
        typeof request.durationMs !== "number" ||
        !Number.isSafeInteger(request.durationMs) ||
        request.durationMs < 1 ||
        request.durationMs > maxDurationMs
    )
        return failure(
            new ConfigurationError(
                "cooldown",
                `cooldown durationMs must be a positive safe integer no greater than ${maxDurationMs}`,
            ),
        )
    return success(Object.freeze({ key: request.key, durationMs: request.durationMs }))
}

function success<A>(value: A): LocalMemoryResult<A> {
    return Object.freeze({ _tag: "Success", value })
}

function failure<A = never>(error: ConfigurationError): LocalMemoryResult<A> {
    return Object.freeze({ _tag: "Failure", error })
}
