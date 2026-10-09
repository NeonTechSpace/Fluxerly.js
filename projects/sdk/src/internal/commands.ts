/**
 * Prefix-command registry, matching, cooldowns and dispatch over existing message subscriptions.
 * Invariant: Commands use existing subscriptions without owning delivery, and every command failure is reported with the command name.
 * Implements [SDK contracts: User-handler failures](/docs/SDK-CONTRACTS.md#user-handler-failures)
 */
import type {
    CommandCooldownClaim,
    CommandCooldownPer,
    CommandCooldownRequest,
    MemoryCooldownOptions,
    PrefixCommandDefinition,
    PrefixCommandGroupDefinition,
    PrefixCommandGroupMetadata,
    PrefixCommandMetadata,
    PrefixCommandParse,
    PrefixCommandParseInput,
    PrefixCommandParseRejection,
    PrefixCommandParsing,
    PrefixCommandRejection,
    PrefixCommandRegistrationOptions,
    PrefixCommandUnmatched,
} from "#sdk/commands"
import {
    commandArgumentMetadata,
    type CommandArgumentConversion,
    snapshotCommandArguments,
} from "#sdk/internal/command-arguments"
import { ConfigurationError } from "#sdk/errors"
import { readCaller } from "./defects.js"
import { MessageType, type Message, type MessageCore } from "#sdk/messages"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { nowMs } from "./clock.js"
import type { ClientLogger } from "./logging.js"
import { editDistance, unsupportedKeyHint } from "./suggest.js"
import { identifyCommand } from "./events.js"

const commandName = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const maxDurationMs = 2_147_483_647
const emptyCommandMetadata: readonly PrefixCommandMetadata[] = Object.freeze([])
/** Default key limit of a memory cooldown store, including each router's own store */
const defaultCooldownEntries = 10_000
/** How long `onReject: "reply"` stays quiet for one user and command after answering a guard denial */
const guardFeedbackWindowMs = 5_000

export interface PrefixCommandMatch<D extends PrefixCommandDefinition> {
    readonly definition: D
    readonly prefix: string
    readonly parse: PrefixCommandParse
    readonly path?: readonly string[]
}

/** Prefix and frozen unmatched result retained only while an attached router dispatches one message */
export interface PrefixCommandUnmatchedMatch {
    readonly prefix: string
    readonly unmatched: PrefixCommandUnmatched
}

/** Validated router settings shared by both adapters. The prefix may be a resolver that each adapter runs its own way */
export interface RouterSettings<M extends MessageCore> extends PrefixCommandParsing<M> {
    readonly prefix: string | readonly string[] | ((message: M) => unknown)
}

/** Shared immutable command lookup state. Entry-point adapters own callback and error boundaries */
export class PrefixCommandRegistry<D extends PrefixCommandDefinition, M extends MessageCore = Message> {
    readonly #definitions: ReadonlyMap<string, D>
    readonly #commands: readonly PrefixCommandMetadata[]
    readonly #groups: readonly PrefixCommandGroupMetadata[]
    readonly #groupLookup: ReadonlyMap<string, PrefixCommandGroupMetadata>
    readonly #entries: readonly PrefixCommandMetadata[]
    readonly #options: Readonly<RouterSettings<M>>
    #visibleEntries: readonly PrefixCommandMetadata[] | undefined
    /** The router-owned cooldown store for commands that do not supply their own, shared by every router derived from one create */
    readonly cooldowns: LocalMemoryCooldownStore
    /** Keys whose `onReject: "reply"` feedback was already sent, shared like the cooldown store and bounded by the same limit */
    readonly feedback: ExpiringKeys

    constructor(
        options: unknown,
        adapterKeys: readonly string[],
        definitions: ReadonlyMap<string, D> = new Map(),
        commands: readonly PrefixCommandMetadata[] = emptyCommandMetadata,
        groups: readonly PrefixCommandGroupMetadata[] = Object.freeze([]),
        groupLookup: ReadonlyMap<string, PrefixCommandGroupMetadata> = new Map(),
        entries: readonly PrefixCommandMetadata[] = commands,
        shared?: { readonly cooldowns: LocalMemoryCooldownStore; readonly feedback: ExpiringKeys },
    ) {
        // Only the reads of the caller options are marked as application input, not building the registry
        this.#options = readCaller(() => copyOptions<M>(options, adapterKeys))
        this.#definitions = definitions
        this.#commands = commands
        this.#groups = groups
        this.#groupLookup = groupLookup
        this.#entries = entries
        // Read the router-level cooldown options once, after the option shape has been validated
        this.cooldowns =
            shared?.cooldowns ??
            createMemoryCooldownStore(readCaller(() => (options as { readonly cooldowns?: unknown }).cooldowns))
        this.feedback = shared?.feedback ?? new ExpiringKeys(this.cooldowns.maxEntries)
    }

    /** The configured prefix or resolver, for the adapter that runs a resolver in its own way */
    get prefix(): RouterSettings<M>["prefix"] {
        return this.#options.prefix
    }

    /** Whether a mention of the bot also acts as a prefix */
    get mentionPrefix(): boolean {
        return this.#options.mentionPrefix === true
    }

    /**
     * Whether the router skips a message before any prefix work: One from a bot unless `ignoreBots` is false, or one a person did not type.
     * Only Default and Reply messages carry typed text. Every other type is a notice Fluxer posts itself, such as a new thread's name, so an allow-list keeps future types out too.
     * Fluxer always sends a type, so a message without one, such as a hand-written test payload, counts as typed rather than being dropped silently
     */
    ignores(message: M): boolean {
        const { type } = message
        if (type !== undefined && type !== MessageType.Default && type !== MessageType.Reply) return true
        return this.#options.ignoreBots !== false && message.author.isBot === true
    }

    private derive(
        definitions: ReadonlyMap<string, D>,
        commands: readonly PrefixCommandMetadata[],
        groups: readonly PrefixCommandGroupMetadata[],
        groupLookup: ReadonlyMap<string, PrefixCommandGroupMetadata>,
        entries: readonly PrefixCommandMetadata[],
    ): PrefixCommandRegistry<D, M> {
        return new PrefixCommandRegistry<D, M>(
            this.#options,
            ["prefix", "parse", "ignoreBots", "caseSensitive", "mentionPrefix"],
            definitions,
            commands,
            groups,
            groupLookup,
            entries,
            { cooldowns: this.cooldowns, feedback: this.feedback },
        )
    }

    /** Immutable registration-order help metadata with no callbacks or local storage references */
    get commands(): readonly PrefixCommandMetadata[] {
        return this.#commands
    }

    get groups(): readonly PrefixCommandGroupMetadata[] {
        return this.#groups
    }

    get entries(): readonly PrefixCommandMetadata[] {
        return this.#entries
    }

    /**
     * Commands and groups that help and unknown-name suggestions may reveal, in registration order.
     * Leaves out entries registered with `hidden: true` and every entry inside a hidden group
     */
    get visibleEntries(): readonly PrefixCommandMetadata[] {
        if (this.#visibleEntries !== undefined) return this.#visibleEntries
        const hiddenGroups = new Set(
            this.#groups.filter((group) => group.hidden === true).map((group) => JSON.stringify(group.path)),
        )
        const visible = this.#entries.filter((entry) => {
            if (entry.hidden === true) return false
            const path = entry.path ?? [entry.name]
            for (let depth = 1; depth < path.length; depth += 1)
                if (hiddenGroups.has(JSON.stringify(path.slice(0, depth)))) return false
            return true
        })
        this.#visibleEntries = visible.length === this.#entries.length ? this.#entries : Object.freeze(visible)
        return this.#visibleEntries
    }

    /** Retain an adapter-validated owned definition in a separate registry. Existing routers and subscriptions keep their previous definitions */
    register(stored: D, options?: PrefixCommandRegistrationOptions): PrefixCommandRegistry<D, M> {
        return this.registerAtParent(stored, this.registrationParent(options))
    }

    /** Register an already snapshotted batch into one new registry, leaving this registry unchanged if any entry fails */
    registerMany(stored: readonly D[], options?: PrefixCommandRegistrationOptions): PrefixCommandRegistry<D, M> {
        const parent = this.registrationParent(options)
        let registry: PrefixCommandRegistry<D, M> = this
        for (const definition of stored) registry = registry.registerAtParent(definition, parent)
        return registry
    }

    private registerAtParent(stored: D, parent: readonly string[]): PrefixCommandRegistry<D, M> {
        const keys = this.registrationKeys(stored, parent)
        const definitions = new Map(this.#definitions)
        for (const key of keys) definitions.set(key, stored)
        const metadata = commandMetadata(stored, parent)
        return this.derive(
            definitions,
            Object.freeze([...this.#commands, metadata]),
            this.#groups,
            this.#groupLookup,
            Object.freeze([...this.#entries, metadata]),
        )
    }

    registerGroup(
        value: PrefixCommandGroupDefinition,
        options?: PrefixCommandRegistrationOptions,
    ): PrefixCommandRegistry<D, M> {
        const definition = readCaller(() => {
            validateCommandShape(value, ["name", "aliases", "description", "hidden"])
            const aliases = value.aliases
            const description = value.description
            const hidden = value.hidden
            return snapshotCommandDefinition({
                name: value.name,
                ...(aliases === undefined ? {} : { aliases }),
                ...(description === undefined ? {} : { description }),
                ...(hidden === undefined ? {} : { hidden }),
            })
        })
        const parent = this.registrationParent(options)
        const keys = this.registrationKeys(definition, parent)
        const metadata: PrefixCommandGroupMetadata = Object.freeze({
            ...definition,
            kind: "group",
            path: Object.freeze([...parent, definition.name]),
        })
        const lookup = new Map(this.#groupLookup)
        for (const key of keys) lookup.set(key, metadata)
        return this.derive(
            this.#definitions,
            this.#commands,
            Object.freeze([...this.#groups, metadata]),
            lookup,
            Object.freeze([...this.#entries, metadata]),
        )
    }

    /** Match a message against the prefixes the adapter resolved for it, then consume groups and parse the command */
    resolve(message: M, prefixes: unknown): PrefixCommandMatch<D> | PrefixCommandUnmatchedMatch | undefined {
        if (this.ignores(message)) return undefined
        const prefix = this.matchPrefix(message, prefixes)
        if (prefix === undefined) return undefined
        let source = message.content.slice(prefix.length)
        let parent: readonly string[] = Object.freeze([])
        for (;;) {
            const suffix = source.trimStart()
            const segment = /^(\S+)(?:\s+|$)/.exec(suffix)
            const group = segment === null ? undefined : this.#groupLookup.get(this.lookupKey(parent, segment[1]!))
            if (group === undefined) break
            parent = group.path
            source = suffix.slice(segment![0].length)
            if (source.length === 0)
                return Object.freeze({
                    prefix,
                    unmatched: Object.freeze({ _tag: "CommandMissingSubcommand", path: parent }),
                })
        }
        const grouped = parent.length === 0 ? {} : { path: parent }
        const input: PrefixCommandParseInput<M> = Object.freeze({
            message,
            prefix,
            source,
            ...grouped,
        })
        const parsed = this.#options.parse === undefined ? defaultParse(input) : this.#options.parse(input)
        if (parsed === undefined || isParseRejection(parsed)) {
            const reason = parsed === undefined ? undefined : copyParseRejection(parsed)
            return Object.freeze({
                prefix,
                unmatched: Object.freeze({
                    _tag: "CommandParserRejected",
                    ...(reason === undefined ? {} : { reason }),
                    ...grouped,
                }),
            })
        }
        const parse = copyParse(parsed)
        const definition = this.#definitions.get(this.lookupKey(parent, parse.name))
        if (definition === undefined) {
            const suggestion = this.closestName(parent, parse.name)
            return Object.freeze({
                prefix,
                unmatched: Object.freeze({
                    _tag: "CommandUnknownName",
                    name: parse.name,
                    ...(suggestion === undefined ? {} : { suggestion }),
                    ...grouped,
                }),
            })
        }
        return Object.freeze({
            definition,
            prefix,
            parse,
            ...(parent.length === 0 ? {} : { path: Object.freeze([...parent, definition.name]) }),
        })
    }

    private registrationParent(options: PrefixCommandRegistrationOptions | undefined): readonly string[] {
        if (options === undefined) return Object.freeze([])
        const path = readCaller(() => {
            validateObjectShape(options, ["group"], "command", "registration options")
            const group = options.group
            return group === undefined ? Object.freeze([]) : copyCommandGroupPath(group, "command")
        })
        if (path.length > 0 && !this.#groups.some((group) => sameCommandPath(group.path, path)))
            throw new ConfigurationError(
                "command",
                'The registration option "group" must be the path of a registered group, using group names rather than aliases',
                { hint: 'Register the parent group first, then pass its full path, such as ["admin", "roles"]' },
            )
        return path
    }

    private registrationKeys(value: PrefixCommandDefinition, parent: readonly string[]): readonly string[] {
        const names = [value.name, ...(value.aliases ?? [])]
        const keys = names.map((name) => this.lookupKey(parent, name))
        if (new Set(keys).size !== keys.length)
            throw new ConfigurationError("aliases", `The name and aliases of ${value.name} must all be different`)
        const taken = keys.findIndex((key) => this.#definitions.has(key) || this.#groupLookup.has(key))
        if (taken !== -1)
            throw new ConfigurationError(
                "aliases",
                `The name or alias ${JSON.stringify(names[taken])} of ${value.name} is already used by another command or group at the same level`,
                { hint: "Choose a different name or alias" },
            )
        return keys
    }

    private lookupKey(parent: readonly string[], name: string): string {
        return JSON.stringify([...parent, this.normalize(name)])
    }

    /**
     * The visible registered command or group name in this parent closest to an unknown name, within a bounded edit
     * distance: At most one edit for names up to four characters and two edits for longer names, preferring the earliest
     * registration. Hidden entries and entries inside hidden groups are never suggested
     */
    private closestName(parent: readonly string[], name: string): string | undefined {
        const wanted = this.normalize(name)
        const limit = wanted.length <= 4 ? 1 : 2
        let best: { readonly name: string; readonly distance: number } | undefined
        for (const entry of this.visibleEntries) {
            const path = entry.path ?? [entry.name]
            if (!sameCommandPath(path.slice(0, -1), parent)) continue
            for (const candidate of [entry.name, ...(entry.aliases ?? [])]) {
                const distance = editDistance(wanted, this.normalize(candidate), limit)
                if (distance <= limit && (best === undefined || distance < best.distance))
                    best = { name: entry.name, distance }
            }
        }
        return best?.name
    }

    private matchPrefix(message: M, resolved: unknown): string | undefined {
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
type LocalMemoryResult<A> =
    { readonly _tag: "Success"; readonly value: A } | { readonly _tag: "Failure"; readonly error: ConfigurationError }

/** Process-local cooldown state shared by default and native adapters */
export interface LocalMemoryCooldownStore {
    readonly maxEntries: number
    readonly size: number
    claim(input: unknown, now?: number): LocalMemoryResult<CommandCooldownClaim>
    sweep(now?: number): number
    clear(): void
}

/**
 * Create one bounded local cooldown store after validating only its retention limit.
 * Used for `commands.memoryCooldowns(options)` and for a router's own store from its `cooldowns` option
 */
export function createMemoryCooldownStore(options: unknown): LocalMemoryCooldownStore {
    // Only reading the caller options is marked as application input, not creating the store
    const maxEntries = readCaller(() => {
        if (options !== undefined) validateObjectShape(options, ["maxEntries"], "maxEntries", "cooldown options")
        const selected = (options as MemoryCooldownOptions | undefined)?.maxEntries
        return selected === undefined ? defaultCooldownEntries : selected
    })
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
        throw new ConfigurationError("maxEntries", 'The cooldown option "maxEntries" must be a positive safe integer')
    return new LocalMemoryCooldownStoreOwner(maxEntries)
}

/** Copy a caller claim once, so the validated key and duration are the ones claimed. Other values pass unchanged */
export function snapshotClaimInput(input: unknown): unknown {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input
    const { key, durationMs } = input as { readonly key?: unknown; readonly durationMs?: unknown }
    return { key, durationMs }
}

/**
 * Keys with expiry times in one process, bounded without ever refusing a new key.
 * Making room removes expired keys first and then the key that expires soonest
 */
export class ExpiringKeys {
    readonly #entries = new Map<string, number>()

    constructor(readonly maxEntries: number) {}

    get size(): number {
        return this.#entries.size
    }

    /** The expiry of an unexpired key, or undefined after removing an expired one */
    active(key: string, now: number): number | undefined {
        const expiry = this.#entries.get(key)
        if (expiry === undefined) return undefined
        if (expiry > now) return expiry
        this.#entries.delete(key)
        return undefined
    }

    /** Keep a key until expiry, making room first when a new key would exceed the limit */
    set(key: string, expiry: number, now: number): void {
        if (!this.#entries.has(key) && this.#entries.size >= this.maxEntries) {
            this.sweep(now)
            if (this.#entries.size >= this.maxEntries) {
                let soonest: string | undefined
                let soonestExpiry = Infinity
                for (const [candidate, candidateExpiry] of this.#entries)
                    if (candidateExpiry < soonestExpiry) {
                        soonest = candidate
                        soonestExpiry = candidateExpiry
                    }
                if (soonest !== undefined) this.#entries.delete(soonest)
            }
        }
        this.#entries.set(key, expiry)
    }

    /**
     * Report whether a key is already active. Otherwise keep it until `until` and report false, so the caller acts once
     * per active key. A time that has already passed is not kept
     */
    suppress(key: string, until: number, now: number): boolean {
        if (this.active(key, now) !== undefined) return true
        if (until > now) this.set(key, until, now)
        return false
    }

    /** Remove expired keys and return how many were removed */
    sweep(now: number): number {
        let count = 0
        for (const [key, expiry] of this.#entries)
            if (expiry <= now) {
                this.#entries.delete(key)
                count += 1
            }
        return count
    }

    clear(): void {
        this.#entries.clear()
    }
}

/** A command's validated cooldown: The store to claim from, the reservation length and how invocations share a key */
export interface StoredCooldown {
    /** Application store, or undefined for the router-owned memory store */
    readonly store?: unknown
    readonly durationMs: number
    readonly per: CommandCooldownPer
    readonly key?: unknown
}

/** Snapshot cooldown fields before validation, retaining only the intentional store and key references */
export function snapshotCommandCooldown(value: unknown): StoredCooldown | undefined {
    if (value === undefined) return
    validateObjectShape(value, ["store", "durationMs", "per", "key"], "cooldown", "cooldown")
    const { durationMs, store, key, per } = value as {
        readonly durationMs?: unknown
        readonly store?: unknown
        readonly key?: unknown
        readonly per?: unknown
    }
    if (
        typeof durationMs !== "number" ||
        !Number.isSafeInteger(durationMs) ||
        durationMs < 1 ||
        durationMs > maxDurationMs
    )
        throw new ConfigurationError(
            "cooldown",
            `The cooldown option "durationMs" must be a positive safe integer of at most ${maxDurationMs} ms`,
        )
    if (
        store !== undefined &&
        (typeof store !== "object" || store === null || typeof (store as { claim?: unknown }).claim !== "function")
    )
        throw new ConfigurationError("cooldown", 'The cooldown option "store" must be an object with a claim method')
    if (key !== undefined && typeof key !== "function")
        throw new ConfigurationError("cooldown", 'The cooldown option "key" must be a function')
    if (per !== undefined && per !== "user" && per !== "channel" && per !== "guild")
        throw new ConfigurationError("cooldown", 'The cooldown option "per" must be "user", "channel" or "guild"')
    return Object.freeze({
        durationMs,
        per: per ?? "user",
        ...(store === undefined ? {} : { store }),
        ...(key === undefined ? {} : { key }),
    })
}

/** The default cooldown key suffix for one invocation, selected by per */
export function cooldownSuffix(per: CommandCooldownPer, message: MessageCore): string {
    if (per === "channel") return `channel:${message.channelId}`
    if (per === "guild")
        return message.guildId === undefined ? `channel:${message.channelId}` : `guild:${message.guildId}`
    return `user:${message.author.id}`
}

/** Validate and copy the shared definition fields once before an adapter adds its callback and cooldown references */
export function snapshotCommandDefinition(value: PrefixCommandDefinition, keyedName?: string): PrefixCommandDefinition {
    if (typeof value !== "object" || value === null)
        throw new ConfigurationError("command", "The command must be an object")
    const name = keyedName ?? value.name
    if (!isCommandName(name))
        throw new ConfigurationError(
            "command",
            "Command names must use ASCII letters, numbers, `_` or `-` and begin alphanumerically",
        )
    const { aliases: sourceAliases, description, usage, hidden, arguments: sourceArguments } = value
    const aliases = sourceAliases === undefined ? undefined : copyCommandNames(sourceAliases, "aliases")
    if (description !== undefined && typeof description !== "string")
        throw new ConfigurationError("command", "Command description must be a string when supplied")
    if (usage !== undefined && typeof usage !== "string")
        throw new ConfigurationError("command", "Command usage must be a string when supplied")
    if (hidden !== undefined && typeof hidden !== "boolean")
        throw new ConfigurationError("command", "Command hidden must be a boolean when supplied")
    const argumentsSchema = snapshotCommandArguments(sourceArguments)
    return Object.freeze({
        name,
        ...(aliases === undefined ? {} : { aliases }),
        ...(description === undefined ? {} : { description }),
        ...(usage === undefined ? {} : { usage }),
        ...(hidden === undefined ? {} : { hidden }),
        ...(argumentsSchema === undefined ? {} : { arguments: argumentsSchema }),
    })
}

/** Validate a finite adapter command object before reading its selected public fields */
export function validateCommandShape(value: unknown, keys: readonly string[]): void {
    validateObjectShape(value, keys, "command", "command")
}

/** Reject malformed command cooldown claims without exposing caller-supplied data */
function validateCooldownClaim(value: unknown): asserts value is CommandCooldownClaim {
    if (typeof value !== "object" || value === null)
        throw new ConfigurationError("cooldown", "The cooldown store returned an invalid claim", { hint: claimHint })
    const claim = value as { _tag?: unknown; retryAtMs?: unknown }
    if (
        (claim._tag === "CooldownAcquired" || claim._tag === "CooldownActive") &&
        typeof claim.retryAtMs === "number" &&
        Number.isSafeInteger(claim.retryAtMs)
    )
        return
    throw new ConfigurationError("cooldown", "The cooldown store returned an invalid claim", { hint: claimHint })
}

const claimHint =
    'A cooldown store claim must return { _tag: "CooldownAcquired" } or { _tag: "CooldownActive" } with a safe integer retryAtMs'

/** Validate and namespace a caller-selected cooldown key before a store sees it */
export function cooldownRequest(
    commandName: string | readonly string[],
    key: unknown,
    durationMs: number,
): CommandCooldownRequest {
    if (typeof key !== "string" || key.length === 0)
        throw new ConfigurationError("cooldown", "A cooldown key must be a nonempty string")
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
export interface CommandDispatchAdapter<
    D extends PrefixCommandDefinition,
    C,
    X = C,
    E = never,
    R = never,
    M extends MessageCore = Message,
> {
    /** Run a prefix resolver for one message in the adapter's style, producing its raw value for validation */
    readonly prefix: (resolver: (message: M) => unknown, message: M) => Effect.Effect<unknown, E, R>
    /** The bot's user ID for mentionPrefix, or undefined when it is not available yet */
    readonly selfId?: () => Effect.Effect<string | undefined>
    readonly context: (match: PrefixCommandMatch<D>) => C
    /** Evaluate the command's guards, producing a boolean or `{ deny }` verdict */
    readonly guard: (definition: D, context: C) => Effect.Effect<unknown, E, R>
    /** Run router middleware around the rest of a matched command. The rest never runs if middleware does not call it */
    readonly around?: (
        context: C,
        rest: Effect.Effect<void, ConfigurationError | E, R>,
    ) => Effect.Effect<void, ConfigurationError | E, R>
    /** Local synchronous conversion after a successful guard and before a cooldown claim */
    readonly convert?: (definition: D, context: C) => CommandArgumentConversion
    readonly executionContext?: (context: C, values: Readonly<Record<string, unknown>>) => X
    /**
     * Claim the command's cooldown, producing the namespaced key and the store's unvalidated claim, or undefined when
     * the command has no cooldown
     */
    readonly cooldown?: (
        definition: D,
        context: X,
        routerStore: LocalMemoryCooldownStore,
    ) => Effect.Effect<{ readonly key: string; readonly claim: unknown } | undefined, E, R>
    /** The command's effective rejection feedback: The router's reply, an application callback or none */
    readonly feedback?: (definition: D) => "reply" | "callback" | undefined
    /**
     * Contextual rejection feedback, called only when feedback is selected and not suppressed.
     * The time comes from the dispatch Clock. It runs through the existing subscription error boundary
     */
    readonly reject?: (
        definition: D,
        context: C,
        rejection: PrefixCommandRejection,
        now: number,
    ) => Effect.Effect<unknown, E, R>
    /** Optional application-owned feedback for a parser decline or unregistered parsed name */
    readonly unmatched?: ((match: PrefixCommandUnmatchedMatch) => Effect.Effect<unknown, E, R>) | undefined
    readonly execute: (definition: D, context: X) => Effect.Effect<unknown, E, R>
    /** Return false after default cancellation so a later callback never starts */
    readonly active?: () => boolean
    /** Client logger for rejected, unmatched and executed command records */
    readonly logger?: ClientLogger | undefined
    /** Report a failed dispatch: A command callback with its command name, or an unmatched callback, prefix or parser
     * failure without one. Interruption is never reported. When omitted, the failure fails the dispatch
     */
    readonly failed?: (name: string | undefined, cause: Cause.Cause<unknown>) => Effect.Effect<void>
}

/** Why a command did not run, for its Debug record. Never includes the rejected argument text */
function rejectionText(rejection: PrefixCommandRejection, now: number): string {
    switch (rejection._tag) {
        case "CommandGuardRejected":
            return "a guard denied it"
        case "CommandCooldownActive":
            return `its cooldown is active for another ${Math.max(0, rejection.retryAtMs - now)} ms`
        case "CommandArgumentRejected":
            if (rejection.reason === "Unexpected") return "it received more arguments than it accepts"
            if (rejection.reason === "Missing") return `the argument ${rejection.argument} is missing`
            if (rejection.reason === "Ambiguous")
                return `the argument ${rejection.argument} matches more than one option`
            return `the argument ${rejection.argument} is invalid`
    }
}

/** Unmatched reasons in plain words for the Debug record */
const unmatchedText: Record<PrefixCommandUnmatched["_tag"], string> = {
    CommandUnknownName: "A message used the command prefix with a name that matches no command",
    CommandMissingSubcommand: "A message named a command group without a subcommand",
    CommandParserRejected: "A message used the command prefix, but the parser found no command in it",
}

/** Command routers keep up with bursts: Several commands run at once and overflow drops the oldest waiting message */
const routerDefaults = Object.freeze({ concurrency: 8, overflow: "dropOldest" as const })

/** Subscription options for an attached router: Its defaults, then each defined caller setting. An explicit undefined
 * keeps the default. The onError option is removed because the router reports command failures through its own hook queue.
 * A non-object value passes through unchanged so client.on rejects it with its usual ConfigurationError
 */
export function routerSubscriptionOptions(options: unknown): unknown {
    if (options === undefined) return routerDefaults
    if (typeof options !== "object" || options === null || Array.isArray(options)) return options
    const selected: Record<string, unknown> = { ...routerDefaults }
    for (const [key, value] of Object.entries(options))
        if (key !== "onError" && value !== undefined) selected[key] = value
    return Object.freeze(selected)
}

/** Validate a guard verdict: `true` allows, `false` denies without a reason and `{ deny }` denies with one */
function guardVerdict(value: unknown): true | { readonly reason?: string } {
    if (value === true) return true
    if (value === false) return {}
    if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { deny?: unknown }).deny === "string" &&
        (value as { deny: string }).deny.length > 0
    )
        return { reason: (value as { deny: string }).deny }
    throw new ConfigurationError("command", "A command guard must return a boolean or { deny: string }")
}

/** Prefixes to try for one message: The configured or resolved prefixes, plus the bot mention when enabled */
function prefixesFor<D extends PrefixCommandDefinition, C, X, E, R, M extends MessageCore>(
    registry: PrefixCommandRegistry<D, M>,
    message: M,
    adapter: CommandDispatchAdapter<D, C, X, E, R, M>,
): Effect.Effect<unknown, E, R> {
    return Effect.gen(function* () {
        const source = registry.prefix
        const prefixes = typeof source === "function" ? yield* adapter.prefix(source, message) : source
        if (!registry.mentionPrefix || adapter.selfId === undefined || prefixes === undefined) return prefixes
        if (!message.content.startsWith("<@")) return prefixes
        const id = yield* adapter.selfId()
        if (id === undefined) return prefixes
        const listed = typeof prefixes === "string" ? [prefixes] : Array.isArray(prefixes) ? prefixes : undefined
        // A malformed resolver value stays as it is, so resolve rejects it with the usual ConfigurationError
        return listed === undefined ? prefixes : [...listed, `<@${id}>`, `<@!${id}>`]
    })
}

/** Dispatch one resolved command through the caller's Effect runtime without a queue, send or retry */
export function dispatchCommand<D extends PrefixCommandDefinition, C, X, E, R, M extends MessageCore>(
    registry: PrefixCommandRegistry<D, M>,
    message: M,
    adapter: CommandDispatchAdapter<D, C, X, E, R, M>,
): Effect.Effect<void, ConfigurationError | E, R> {
    const active = (): Effect.Effect<void> =>
        adapter.active === undefined
            ? Effect.void
            : (Effect.suspend(() => (adapter.active!() ? Effect.void : Effect.interrupt)) as Effect.Effect<void>)
    /**
     * Log a rejection and give its feedback. A `"reply"` answers once per limit key while that key is active, so repeated
     * attempts do not make the bot repeat itself. Application callbacks receive every rejection
     */
    const reject = (
        definition: D,
        context: C,
        rejection: PrefixCommandRejection,
        limit?: { readonly key: string; readonly until: (now: number) => number },
    ) =>
        Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const selected =
                adapter.reject === undefined
                    ? undefined
                    : adapter.feedback === undefined
                      ? "callback"
                      : adapter.feedback(definition)
            // A false guard has no automatic reply, but custom callbacks still receive every rejection
            const feedback =
                selected === "reply" && rejection._tag === "CommandGuardRejected" && rejection.reason === undefined
                    ? undefined
                    : selected
            const suppressed =
                feedback === "reply" &&
                limit !== undefined &&
                registry.feedback.suppress(limit.key, limit.until(now), now)
            adapter.logger?.drop("commandRejections", {
                level: "debug",
                category: "commands",
                code: "commands.rejected",
                message: `Command ${definition.name} did not run because ${rejectionText(rejection, now)}${
                    feedback === undefined
                        ? ""
                        : suppressed
                          ? ". No reply was sent because the same rejection was answered recently"
                          : feedback === "reply"
                            ? ". A reply explains why"
                            : ". The onReject callback was called"
                }`,
                command: definition.name,
                fields: {
                    rejection: rejection._tag,
                    ...(rejection._tag === "CommandArgumentRejected" ? { argument: rejection.argument } : {}),
                    ...(suppressed ? { feedbackSuppressed: true } : {}),
                },
            })
            if (feedback === undefined || suppressed) return
            yield* adapter.reject!(definition, context, rejection, now)
        })
    const dispatch = Effect.gen(function* () {
        yield* active()
        if (registry.ignores(message)) return
        const prefixes = yield* prefixesFor(registry, message, adapter)
        const resolved = yield* configurationEffect(() => registry.resolve(message, prefixes))
        if (resolved === undefined) return
        if ("unmatched" in resolved) {
            yield* active()
            const suggestion =
                resolved.unmatched._tag === "CommandUnknownName" ? resolved.unmatched.suggestion : undefined
            const detail =
                resolved.unmatched._tag === "CommandMissingSubcommand"
                    ? ` (${resolved.unmatched.path.join(" ")})`
                    : resolved.unmatched._tag === "CommandParserRejected" && resolved.unmatched.reason !== undefined
                      ? ` (${resolved.unmatched.reason})`
                      : ""
            adapter.logger?.drop("unmatchedCommands", {
                level: "debug",
                category: "commands",
                code: "commands.unmatched",
                message: `${unmatchedText[resolved.unmatched._tag]}${detail}${suggestion === undefined ? "" : `. The closest command is ${suggestion}`}${adapter.unmatched === undefined ? "" : ". The onUnmatched callback was called"}`,
                fields: {
                    reason: resolved.unmatched._tag,
                    messageId: message.id,
                    channelId: message.channelId,
                    ...(suggestion === undefined ? {} : { suggestion }),
                },
            })
            if (adapter.unmatched !== undefined) yield* adapter.unmatched(resolved)
            return
        }
        const matched = resolved
        yield* identifyCommand(matched.definition.name)
        const run = matchedCommand(matched).pipe(
            Effect.withSpan("fluxerly.command.execute", {
                attributes: { "fluxerly.command": matched.definition.name },
            }),
        )
        if (adapter.failed === undefined) return yield* run
        return yield* run.pipe(
            Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause) ? Effect.failCause(cause) : adapter.failed!(matched.definition.name, cause),
            ),
        )
    }) as Effect.Effect<void, ConfigurationError | E, R>
    if (adapter.failed === undefined) return dispatch
    // Unmatched callbacks and custom parsers can fail outside a matched command, and they reach the same report
    return dispatch.pipe(
        Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : adapter.failed!(undefined, cause),
        ),
    )

    function matchedCommand(matched: PrefixCommandMatch<D>) {
        return Effect.gen(function* () {
            const context = adapter.context(matched)
            yield* active()
            let continued = false
            const rest = Effect.gen(function* () {
                continued = true
                yield* checkedCommand(matched, context)
            }) as Effect.Effect<void, ConfigurationError | E, R>
            if (adapter.around === undefined) return yield* rest
            yield* adapter.around(context, rest)
            if (!continued)
                adapter.logger?.log({
                    level: "debug",
                    category: "commands",
                    code: "commands.middlewareStopped",
                    message: `Command ${matched.definition.name} did not run because middleware did not continue`,
                    command: matched.definition.name,
                })
        })
    }

    function checkedCommand(matched: PrefixCommandMatch<D>, context: C) {
        return Effect.gen(function* () {
            const verdict = guardVerdict(yield* adapter.guard(matched.definition, context))
            if (verdict !== true) {
                yield* active()
                yield* reject(
                    matched.definition,
                    context,
                    Object.freeze({
                        _tag: "CommandGuardRejected",
                        ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
                    }),
                    {
                        key: JSON.stringify(["guard", matched.path ?? [matched.definition.name], message.author.id]),
                        until: (now) => now + guardFeedbackWindowMs,
                    },
                )
                return
            }
            const conversion = adapter.convert === undefined ? undefined : adapter.convert(matched.definition, context)
            if (conversion !== undefined && conversion._tag === "Rejected") {
                yield* active()
                yield* reject(
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
                const claimed = yield* adapter.cooldown(matched.definition, executionContext, registry.cooldowns)
                if (claimed !== undefined) {
                    yield* configurationEffect(() => validateCooldownClaim(claimed.claim))
                    const claim = claimed.claim as CommandCooldownClaim
                    if (claim._tag === "CooldownActive") {
                        yield* active()
                        yield* reject(
                            matched.definition,
                            context,
                            Object.freeze({ _tag: "CommandCooldownActive", retryAtMs: claim.retryAtMs }),
                            { key: JSON.stringify(["cooldown", claimed.key]), until: () => claim.retryAtMs },
                        )
                        return
                    }
                }
            }
            yield* active()
            // Measured on the dispatch's Effect Clock, so a TestClock controls the reported duration
            const clock = yield* Clock.Clock
            const startedAt = nowMs(clock)
            yield* adapter.execute(matched.definition, executionContext)
            adapter.logger?.log({
                level: "debug",
                category: "commands",
                code: "commands.executed",
                message: `Command ${matched.definition.name} finished`,
                command: matched.definition.name,
                durationMs: Math.round(nowMs(clock) - startedAt),
            })
        }) as Effect.Effect<void, ConfigurationError | E, R>
    }
}

/**
 * Impersonal reply text for a rejected command, used by `onReject: "reply"`.
 * A guard denial without a reason returns undefined, so a false verdict has no generic reply.
 * Argument rejections name the argument, what was expected and the command's usage.
 * Cooldown replies measure the remaining time from `now`, the dispatch Clock's wall time
 */
export function rejectionReply(
    rejection: PrefixCommandRejection,
    command: PrefixCommandMetadata | undefined,
    prefix: string,
    now: number,
): string | undefined {
    switch (rejection._tag) {
        case "CommandGuardRejected":
            return rejection.reason
        case "CommandCooldownActive": {
            const seconds = Math.max(1, Math.ceil((rejection.retryAtMs - now) / 1_000))
            return `This command is on cooldown. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}`
        }
        case "CommandArgumentRejected": {
            const usage =
                command === undefined
                    ? ""
                    : `. Usage: ${prefix}${(command.path ?? [command.name]).join(" ")}${commandUsage(command) ? " " + commandUsage(command) : ""}`
            if (rejection.reason === "Unexpected") return `Too many arguments${usage}`
            const argument = command?.arguments?.find((entry) => entry.name === rejection.argument)
            if (rejection.reason === "Missing") return `Missing ${rejection.argument}${usage}`
            if (rejection.reason === "Ambiguous")
                return `The ${rejection.argument} value matches more than one option, so an ID or mention is needed${usage}`
            return `Invalid ${rejection.argument}${argument === undefined ? "" : `. Expected ${expectation(argument)}`}${usage}`
        }
    }
}

/** Generated usage syntax such as `<text> [count]`, or the command's explicit usage */
function commandUsage(command: PrefixCommandMetadata): string {
    return (
        command.usage ??
        command.arguments
            ?.map((argument) => {
                const name = argument.name + (argument.rest ? "..." : "")
                return argument.optional ? `[${name}]` : `<${name}>`
            })
            .join(" ") ??
        ""
    )
}

function expectation(argument: NonNullable<PrefixCommandMetadata["arguments"]>[number]): string {
    const range = (unit: (value: number) => string) =>
        argument.min !== undefined && argument.max !== undefined
            ? ` from ${unit(argument.min)} to ${unit(argument.max)}`
            : argument.min !== undefined
              ? ` of at least ${unit(argument.min)}`
              : argument.max !== undefined
                ? ` of at most ${unit(argument.max)}`
                : ""
    switch (argument.type) {
        case "integer":
            return `a whole number${range(String)}`
        case "number":
            return `a number${range(String)}`
        case "duration":
            return `a duration${argument.wholeSeconds === true ? " in whole seconds" : ""} such as 10m or 1h30m${range((value) => `${value} ms`)}`
        case "boolean":
            return "true or false"
        case "id":
            return argument.mention === undefined ? "an ID" : `an ID or ${argument.mention} mention`
        case "choice":
            return `one of ${(argument.choices ?? []).join(", ")}`
        case "member":
            return "a member mention or ID"
        case "userChoice":
            return "a listed user"
        case "channelChoice":
            return "a listed channel"
        case "roleChoice":
            return "a listed role"
        case "custom":
            return argument.expected ?? "a valid value"
        case "text":
            return "text"
    }
}

/** Router option keys shared by both APIs. Each API adds its own callback keys */
const routerOptionKeys = ["prefix", "parse", "ignoreBots", "caseSensitive", "mentionPrefix", "cooldowns"] as const

/** Subscription delivery settings that a runBot commands option passes to the router's attach unchanged */
export const botCommandDeliveryKeys = [
    "concurrency",
    "partition",
    "overflow",
    "maxPendingMessages",
    "maxPendingBytes",
] as const

/**
 * Check the keys of a runBot commands option before its router is created, so the hint also lists commands and onError.
 * A key whose value looks like a command definition is explained as a command placed one level too high.
 * Values are read through property descriptors, so no getter runs here
 */
export function checkBotCommandKeys(options: object, adapterKeys: readonly string[]): void {
    const keys = [...routerOptionKeys, ...adapterKeys, ...botCommandDeliveryKeys, "commands", "onError"]
    for (const key of Reflect.ownKeys(options)) {
        if (typeof key !== "string" || keys.includes(key)) continue
        const value: unknown = Reflect.getOwnPropertyDescriptor(options, key)?.value
        const command = typeof value === "object" && value !== null && Object.hasOwn(value, "execute")
        throw new ConfigurationError(
            "commands",
            `Unsupported key ${JSON.stringify(key)} in the runBot commands option`,
            {
                hint: command
                    ? `Put command definitions in the inner commands object, next to prefix, such as commands: { prefix: "!", commands: { ${key.length > 64 ? "name" : key}: { execute } } }`
                    : unsupportedKeyHint(key, keys, "keys"),
            },
        )
    }
}

/**
 * Validate the shared router settings. Adapter keys, such as callbacks, are allowed here and validated by the adapter.
 * The `cooldowns` option is allowed but not copied, because the registry reads it once to create its own store
 */
function copyOptions<M extends MessageCore>(
    input: unknown,
    adapterKeys: readonly string[],
): Readonly<RouterSettings<M>> {
    validateObjectShape(input, [...routerOptionKeys, ...adapterKeys], "commands", "prefix command options")
    const value = input as RouterSettings<M>
    if (value.prefix === undefined)
        throw new ConfigurationError("prefix", 'The option "prefix" is required', {
            hint: 'Set the text that starts a command, such as prefix: "!"',
        })
    if (typeof value.prefix !== "string" && !Array.isArray(value.prefix) && typeof value.prefix !== "function")
        throw new ConfigurationError(
            "prefix",
            'The option "prefix" must be a string, an array of strings or a function',
        )
    if (typeof value.prefix === "string" && value.prefix.length === 0)
        throw new ConfigurationError("prefix", 'The option "prefix" must not be empty')
    const prefix = Array.isArray(value.prefix) ? copyNonemptyStringArray(value.prefix, "prefix") : value.prefix
    if (value.parse !== undefined && typeof value.parse !== "function")
        throw new ConfigurationError("parser", 'The option "parse" must be a function')
    if (value.ignoreBots !== undefined && typeof value.ignoreBots !== "boolean")
        throw new ConfigurationError("commands", 'The option "ignoreBots" must be a boolean')
    if (value.caseSensitive !== undefined && typeof value.caseSensitive !== "boolean")
        throw new ConfigurationError("commands", 'The option "caseSensitive" must be a boolean')
    if (value.mentionPrefix !== undefined && typeof value.mentionPrefix !== "boolean")
        throw new ConfigurationError("commands", 'The option "mentionPrefix" must be a boolean')
    return Object.freeze({
        prefix,
        ...(value.parse === undefined ? {} : { parse: value.parse }),
        ...(value.ignoreBots === undefined ? {} : { ignoreBots: value.ignoreBots }),
        ...(value.caseSensitive === undefined ? {} : { caseSensitive: value.caseSensitive }),
        ...(value.mentionPrefix === undefined ? {} : { mentionPrefix: value.mentionPrefix }),
    })
}

/** Project only public metadata from an already validated owned registration snapshot */
function commandMetadata(value: PrefixCommandDefinition, parent: readonly string[]): PrefixCommandMetadata {
    const argumentsMetadata = commandArgumentMetadata(value.arguments)
    return Object.freeze({
        name: value.name,
        ...(parent.length === 0 ? {} : { path: Object.freeze([...parent, value.name]) }),
        ...(value.aliases === undefined ? {} : { aliases: value.aliases }),
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.usage === undefined ? {} : { usage: value.usage }),
        ...(value.hidden === undefined ? {} : { hidden: value.hidden }),
        ...(argumentsMetadata === undefined ? {} : { arguments: argumentsMetadata }),
    })
}

/** Validate a canonical group selector without retaining rejected caller values */
export function copyCommandGroupPath(value: unknown, field: "command" | "help"): readonly string[] {
    if (!Array.isArray(value))
        throw new ConfigurationError(field, 'The option "group" must be an array of group names, not aliases')
    validateArrayShape(value, field)
    const path: string[] = []
    for (let index = 0; index < value.length; index += 1) {
        const name = value[index]
        if (!isCommandName(name))
            throw new ConfigurationError(
                field,
                'The option "group" must contain group names that use ASCII letters, numbers, `_` or `-` and begin alphanumerically',
            )
        path.push(name)
    }
    return Object.freeze(path)
}

/** Exact canonical path comparison, independent of alias matching policy */
export function sameCommandPath(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((name, index) => name === right[index])
}

/** A parser result with a reason and no name, which declines the text with an explanation instead of naming a command */
function isParseRejection(value: unknown): value is PrefixCommandParseRejection {
    return typeof value === "object" && value !== null && "reason" in value && !("name" in value)
}

function copyParseRejection(value: PrefixCommandParseRejection): string {
    validateObjectShape(value, ["reason"], "parser", "parser rejection")
    const reason = value.reason
    if (typeof reason !== "string" || reason.length === 0)
        throw new ConfigurationError("parser", "A parser rejection must have a nonempty string reason")
    return reason
}

function copyParse(value: PrefixCommandParse): PrefixCommandParse {
    validateObjectShape(value, ["name", "args", "rawArgs"], "parser", "parser result")
    if (!isCommandName(value.name)) throw new ConfigurationError("parser", "A parser must return a valid command name")
    if (typeof value.rawArgs !== "string")
        throw new ConfigurationError("parser", "A parser must return rawArgs as a string")
    return Object.freeze({ name: value.name, rawArgs: value.rawArgs, args: copyStringArray(value.args, "parser") })
}

function defaultParse<M extends MessageCore>(input: PrefixCommandParseInput<M>): PrefixCommandParse | undefined {
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
    if (values.length === 0) throw new ConfigurationError("prefix", prefixArrayMessage)
    for (const prefix of values) if (prefix.length === 0) throw new ConfigurationError("prefix", prefixArrayMessage)
    return values
}

const prefixArrayMessage = "A prefix array must contain at least one prefix, and no prefix may be empty"

/** How array shape messages name the value they check */
const shapeSubjects: Record<"aliases" | "prefix" | "parser" | "command" | "help", string> = {
    aliases: 'The option "aliases"',
    prefix: "The prefix list",
    parser: 'The parser result "args"',
    command: 'The option "group"',
    help: 'The help option "group"',
}

function copyStringArray(value: unknown, field: "aliases" | "prefix" | "parser"): readonly string[] {
    if (!Array.isArray(value))
        throw new ConfigurationError(field, `${shapeSubjects[field]} must be an array of strings`)
    validateArrayShape(value, field)
    const copied: string[] = []
    for (let index = 0; index < value.length; index += 1) {
        const entry = value[index]
        if (typeof entry !== "string")
            throw new ConfigurationError(field, `${shapeSubjects[field]} must contain only strings`)
        copied.push(entry)
    }
    return Object.freeze(copied)
}

function validateObjectShape(
    value: unknown,
    keys: readonly string[],
    field: ConfigurationError["field"],
    subject: string,
): void {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new ConfigurationError(field, `The ${subject} must be an object`)
    for (const key of Reflect.ownKeys(value))
        if (typeof key !== "string" || !keys.includes(key))
            throw new ConfigurationError(
                field,
                typeof key === "string"
                    ? `Unsupported key ${JSON.stringify(key)} in the ${subject}`
                    : `The ${subject} must not have symbol keys`,
                {
                    hint:
                        typeof key === "string"
                            ? unsupportedKeyHint(key, keys, "keys")
                            : `Supported keys are ${keys.join(", ")}`,
                },
            )
}

function validateArrayShape(
    value: readonly unknown[],
    field: "aliases" | "prefix" | "parser" | "command" | "help",
): void {
    for (let index = 0; index < value.length; index += 1)
        if (!Object.hasOwn(value, index))
            throw new ConfigurationError(field, `${shapeSubjects[field]} must not have empty slots`)
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue
        if (typeof key !== "string" || !isArrayIndex(key, value.length))
            throw new ConfigurationError(
                field,
                `${shapeSubjects[field]} must be a plain array without extra properties`,
            )
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

/** A memory cooldown store that never denies a new key for capacity, evicting as ExpiringKeys describes */
class LocalMemoryCooldownStoreOwner implements LocalMemoryCooldownStore {
    readonly #entries: ExpiringKeys

    constructor(readonly maxEntries: number) {
        this.#entries = new ExpiringKeys(maxEntries)
    }

    get size(): number {
        return this.#entries.size
    }

    claim(input: unknown, now = Date.now()): LocalMemoryResult<CommandCooldownClaim> {
        const request = validateMemoryRequest(input)
        if (request._tag === "Failure") return request
        const active = this.#entries.active(request.value.key, now)
        if (active !== undefined) return success(Object.freeze({ _tag: "CooldownActive", retryAtMs: active }))
        const retryAtMs = now + request.value.durationMs
        this.#entries.set(request.value.key, retryAtMs, now)
        return success(Object.freeze({ _tag: "CooldownAcquired", retryAtMs }))
    }

    sweep(now = Date.now()): number {
        return this.#entries.sweep(now)
    }

    clear(): void {
        this.#entries.clear()
    }
}

function validateMemoryRequest(input: unknown): LocalMemoryResult<CommandCooldownRequest> {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        return failure(new ConfigurationError("cooldown", "A cooldown claim requires an object"))
    const request = input as { key?: unknown; durationMs?: unknown }
    if (typeof request.key !== "string" || request.key.length === 0)
        return failure(new ConfigurationError("cooldown", "A cooldown key must be a nonempty string"))
    if (
        typeof request.durationMs !== "number" ||
        !Number.isSafeInteger(request.durationMs) ||
        request.durationMs < 1 ||
        request.durationMs > maxDurationMs
    )
        return failure(
            new ConfigurationError(
                "cooldown",
                `The cooldown option "durationMs" must be a positive safe integer of at most ${maxDurationMs} ms`,
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
