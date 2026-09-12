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
import type { CommandArgumentSchema, CommandArgumentValues } from "#sdk/command-arguments"
import type { CommandHelpOptions } from "#sdk/command-help"
import { commandHelp } from "#sdk/internal/command-help"
import { parseQuotedPrefixCommand } from "#sdk/commands"
import { ConfigurationError } from "#sdk/errors"
import {
    configurationEffect,
    cooldownRequest,
    createMemoryCooldownStore,
    dispatchCommand,
    type LocalMemoryCooldownStore,
    PrefixCommandRegistry,
    snapshotCommandIdentity,
    validateCommandCooldown,
    validateCommandShape,
} from "#sdk/internal/commands"
import { convertCommandArguments, snapshotCommandArguments } from "#sdk/internal/command-arguments"
import type { RegistrationError } from "#sdk/message-errors"
import type { Message } from "#sdk/messages"
import { Effect, type Scope } from "effect"
import type { Client, EventHandlerOptions, Subscription } from "./effect.js"

/** Context retained only while one native prefix-command guard and handler Effect runs in the caller’s scope */
export interface NativePrefixCommandContext {
    /** Attached client. The router never connects, runs or shuts it down */
    readonly client: Client
    /** Frozen gateway message selected by the client subscription */
    readonly message: Message
    /** Exact matched prefix */
    readonly prefix: string
    /** Registered canonical command name, not necessarily the alias used in the message */
    readonly name: string
    /** Parsed positional arguments in a new frozen array */
    readonly args: readonly string[]
    /** Parser-defined argument remainder */
    readonly rawArgs: string
}

/** Context passed to execute and cooldown key callbacks after successful local argument conversion */
export interface NativePrefixCommandExecutionContext<
    S extends CommandArgumentSchema = {},
> extends NativePrefixCommandContext {
    /** Frozen values converted from this command's own schema. Guards receive raw context before conversion and rejection callbacks never receive partially converted values */
    readonly values: CommandArgumentValues<S>
}

/** Context retained only while one native unmatched-command callback Effect runs in the caller’s scope */
export interface NativePrefixCommandUnmatchedContext {
    /** Attached client. The router never connects, runs or shuts it down */
    readonly client: Client
    /** Frozen gateway message selected by the client subscription */
    readonly message: Message
    /** Exact prefix matched before the parser declined or lookup missed */
    readonly prefix: string
}

/** Native router construction options, including application-owned feedback for matched prefixes with no runnable command */
export interface NativePrefixCommandsOptions<E = never, R = never> extends PrefixCommandsOptions {
    /** Optional feedback Effect after the parser declines or returns an unregistered name. It keeps caller Effect context and interruption, and the router never sends a response, retries it or invokes it for ignored bots or unmatched prefixes */
    readonly onUnmatched?: (
        context: NativePrefixCommandUnmatchedContext,
        unmatched: PrefixCommandUnmatched,
    ) => Effect.Effect<unknown, E, R>
}

/** Caller-owned native cooldown storage. Its claim may be immediate or preserve the handler’s Effect environment */
export interface NativeCooldownStore<E = never, R = never> {
    /** Return an immediate claim or a lazy Effect. Claims must be atomic within whichever scope the store represents */
    claim(input: CommandCooldownRequest): CommandCooldownClaim | Effect.Effect<CommandCooldownClaim, E, R>
}

/** Optional native command cooldown. A successful claim is retained even when a later handler failure occurs */
export interface NativePrefixCommandCooldown<E = never, R = never, S extends CommandArgumentSchema = {}> {
    /** Caller-owned store. The built-in memory store is bounded and process-local only */
    readonly store: NativeCooldownStore<E, R>
    /** Positive duration in milliseconds, capped at 2,147,483,647 */
    readonly durationMs: number
    /** Per-command key suffix. Defaults to the invoking author ID. The router namespaces it by canonical command name */
    readonly key?: (context: NativePrefixCommandExecutionContext<S>) => string
}

/** One native prefix command. The router snapshots metadata and retains only its guard, onReject, execute, cooldown key and store references. Its guard and handler execute through the attached client subscription in the caller’s context */
export interface NativePrefixCommand<
    E = never,
    R = never,
    S extends CommandArgumentSchema = {},
> extends PrefixCommandDefinition {
    /** Optional registration-ordered local conversion schema */
    readonly arguments?: S
    /** Optional authorization or policy Effect. False skips cooldown and execution without an automatic response, while onReject can provide application-owned feedback */
    readonly guard?: (context: NativePrefixCommandContext) => Effect.Effect<boolean, E, R>
    /** Optional feedback Effect after a false guard, argument conversion rejection or rejected cooldown. It receives raw context without partial values and failures use the attached subscription’s safe error reporting without retry */
    readonly onReject?: (
        context: NativePrefixCommandContext,
        rejection: PrefixCommandRejection,
    ) => Effect.Effect<unknown, E, R>
    /** Optional admission limit acquired after a successful guard and argument conversion, before execution */
    readonly cooldown?: NativePrefixCommandCooldown<E, R, S>
    /** Application Effect for a matched, allowed command. Failure is reported by the attached subscription without retry */
    readonly execute: (context: NativePrefixCommandExecutionContext<S>) => Effect.Effect<unknown, E, R>
}

/** Bounded process-local cooldown storage for the native entry point */
export interface MemoryCooldownStore {
    /** Configured upper bound for retained keys */
    readonly maxEntries: number
    /** Current retained key count, including expired keys not yet swept */
    readonly size: number
    /** Lazily acquire or observe one process-local cooldown, failing with ConfigurationError for malformed input */
    claim(input: CommandCooldownRequest): Effect.Effect<CommandCooldownClaim, ConfigurationError>
    /** Lazily remove expired entries now and return how many were released */
    sweep(): Effect.Effect<number>
    /** Lazily remove every retained key. This does not cancel handlers or affect another store */
    clear(): Effect.Effect<void>
}

/** Registered native commands. Register returns a new immutable router snapshot with the widened environment */
export interface NativePrefixCommandRouter<R = never> {
    /** Frozen registration-order metadata containing identity, help text and safe argument signatures, without resource candidates or callbacks */
    readonly commands: readonly PrefixCommandMetadata[]
    /**
     * Lazily generate frozen text pages from this router snapshot, without attaching, sending or running guards, cooldowns or handlers.
     * Uses the explicit display prefix and registration order, then aliases and description. Explicit usage overrides generated schema syntax, including an empty usage string.
     * Schema syntax is `<required>`, `[optional]` and a trailing `...` inside the brackets for rest arguments. No schema means no inferred arguments
     *
     * Empty selection returns []. Page lengths use UTF-16 code units and never split a surrogate pair, but may split graphemes or Markdown.
     * Page-edge whitespace is trimmed and empty pages are omitted for message delivery. Pages are not a lossless serialization of metadata.
     * The caller owns page selection, sending and mention intent
     *
     * Malformed options, ill-formed text, an insufficient page ceiling or an invalid include callback fail with ConfigurationError without private input.
     * Unexpected option getter defects remain in the Effect cause. This local synchronous operation needs no scope or client environment
     */
    help(options: CommandHelpOptions): Effect.Effect<readonly string[], ConfigurationError>
    /** Lazily validate and add one command to a separate router snapshot. Existing routers and attachments stay unchanged */
    register<E, R2, const S extends CommandArgumentSchema = {}>(
        command: NativePrefixCommand<E, R2, S>,
    ): Effect.Effect<NativePrefixCommandRouter<R | R2>, ConfigurationError>
    /**
     * Lazily register one existing bounded messageCreate subscription in the caller’s scope without connecting or creating a detached runtime.
     * Every attachment dispatches its router snapshot independently. Its returned subscription owns only that attachment and interruption cannot preempt caller-owned promises
     */
    attach<E = never, R2 = never>(
        client: Client,
        options?: EventHandlerOptions<E, R2>,
    ): Effect.Effect<Subscription, RegistrationError, Scope.Scope | R | R2>
}

/** Native optional command tools with lazy creation, registration and local-store claims */
export interface NativeCommands {
    /** Lazily create a local router without attaching a subscription or connecting a client. onUnmatched remains application-owned and receives no automatic response helper. Unexpected creation defects remain in the Effect cause */
    create<E = never, R = never>(
        options: NativePrefixCommandsOptions<E, R>,
    ): Effect.Effect<NativePrefixCommandRouter<R>, ConfigurationError>
    /** Parse quoted positional arguments without changing the router default parser. Unterminated quotes or trailing escapes return undefined for application policy */
    parseQuoted(input: PrefixCommandParseInput): PrefixCommandParse | undefined
    /** Lazily create a bounded process-local cooldown store */
    memoryCooldowns(options?: MemoryCooldownOptions): Effect.Effect<MemoryCooldownStore, ConfigurationError>
}

/** Implementation shared by the native public namespace */
export const nativeCommands: NativeCommands = Object.freeze({
    create: <E, R>(options: NativePrefixCommandsOptions<E, R>) =>
        configurationEffect(() =>
            freezeRouter(
                new NativePrefixCommandRouterOwner<R>(
                    new PrefixCommandRegistry(options),
                    snapshotNativeOnUnmatched(options.onUnmatched),
                ),
            ),
        ),
    parseQuoted: parseQuotedPrefixCommand,
    memoryCooldowns: (options: MemoryCooldownOptions | undefined) =>
        configurationEffect(() => nativeMemoryCooldownStore(createMemoryCooldownStore(options))),
})

interface StoredNativeCommand extends PrefixCommandDefinition {
    readonly guard?: (context: NativePrefixCommandContext) => Effect.Effect<boolean, unknown, unknown>
    readonly onReject?: (
        context: NativePrefixCommandContext,
        rejection: PrefixCommandRejection,
    ) => Effect.Effect<unknown, unknown, unknown>
    readonly cooldown?: NativePrefixCommandCooldown<unknown, unknown, CommandArgumentSchema>
    readonly execute: (
        context: NativePrefixCommandExecutionContext<CommandArgumentSchema>,
    ) => Effect.Effect<unknown, unknown, unknown>
}

class NativePrefixCommandRouterOwner<R = never> implements NativePrefixCommandRouter<R> {
    readonly #registry: PrefixCommandRegistry<StoredNativeCommand>
    readonly #onUnmatched?: StoredNativeOnUnmatched

    constructor(registry: PrefixCommandRegistry<StoredNativeCommand>, onUnmatched?: StoredNativeOnUnmatched) {
        this.#registry = registry
        if (onUnmatched !== undefined) this.#onUnmatched = onUnmatched
    }

    get commands(): readonly PrefixCommandMetadata[] {
        return this.#registry.commands
    }

    help(options: CommandHelpOptions): Effect.Effect<readonly string[], ConfigurationError> {
        return configurationEffect(() => commandHelp(this.commands, options))
    }

    register<E, R2, const S extends CommandArgumentSchema = {}>(
        command: NativePrefixCommand<E, R2, S>,
    ): Effect.Effect<NativePrefixCommandRouter<R | R2>, ConfigurationError> {
        return configurationEffect(() =>
            freezeRouter(
                new NativePrefixCommandRouterOwner<R | R2>(
                    this.#registry.register(snapshotNativeCommand(command)),
                    this.#onUnmatched,
                ),
            ),
        )
    }

    attach<E = never, R2 = never>(
        client: Client,
        options?: EventHandlerOptions<E, R2>,
    ): Effect.Effect<Subscription, RegistrationError, Scope.Scope | R | R2> {
        return client.on(
            "messageCreate",
            (message) => this.dispatch(client, message) as Effect.Effect<void, E, R>,
            options,
        )
    }

    private dispatch(client: Client, message: Message): Effect.Effect<void, ConfigurationError, R> {
        return dispatchCommand(this.#registry, message, {
            context: (match) =>
                Object.freeze({
                    client,
                    message,
                    prefix: match.prefix,
                    name: match.definition.name,
                    args: Object.freeze([...match.parse.args]),
                    rawArgs: match.parse.rawArgs,
                }),
            convert: (definition, context) => convertCommandArguments(definition.arguments, context.args),
            executionContext: (context, values) =>
                Object.freeze({
                    ...context,
                    values: values as CommandArgumentValues<CommandArgumentSchema>,
                }),
            unmatched: (match) =>
                this.#onUnmatched === undefined
                    ? Effect.void
                    : nativeCallback(
                          () =>
                              this.#onUnmatched!(
                                  Object.freeze({ client, message, prefix: match.prefix }),
                                  match.unmatched,
                              ),
                          "A native command onUnmatched callback must return an Effect",
                      ),
            guard: (definition, context) =>
                definition.guard === undefined
                    ? Effect.succeed(true)
                    : nativeCallback(() => definition.guard!(context), "A native command guard must return an Effect"),
            reject: (definition, context, rejection) =>
                definition.onReject === undefined
                    ? Effect.void
                    : nativeCallback(
                          () => definition.onReject!(context, rejection),
                          "A native command onReject callback must return an Effect",
                      ),
            cooldown: (definition, context) =>
                definition.cooldown === undefined
                    ? Effect.succeed({ _tag: "CooldownAcquired", retryAtMs: Number.MAX_SAFE_INTEGER })
                    : nativeCooldown(definition, context),
            execute: (definition, context) =>
                nativeCallback(
                    () => definition.execute(context),
                    "A native command execute callback must return an Effect",
                ),
        }) as Effect.Effect<void, ConfigurationError, R>
    }
}

type StoredNativeOnUnmatched = (
    context: NativePrefixCommandUnmatchedContext,
    unmatched: PrefixCommandUnmatched,
) => Effect.Effect<unknown, unknown, unknown>

function snapshotNativeOnUnmatched<E, R>(
    value: NativePrefixCommandsOptions<E, R>["onUnmatched"],
): StoredNativeOnUnmatched | undefined {
    if (value !== undefined && typeof value !== "function")
        throw new ConfigurationError("commands", "onUnmatched must be a function when supplied")
    return value as StoredNativeOnUnmatched | undefined
}

function snapshotNativeCommand<E, R, S extends CommandArgumentSchema>(
    command: NativePrefixCommand<E, R, S>,
): StoredNativeCommand {
    validateCommandShape(command, [
        "name",
        "aliases",
        "description",
        "usage",
        "arguments",
        "guard",
        "onReject",
        "cooldown",
        "execute",
    ])
    if (typeof command.execute !== "function") throw new ConfigurationError("command", "A command must provide execute")
    if (command.guard !== undefined && typeof command.guard !== "function")
        throw new ConfigurationError("command", "guard must be a function when supplied")
    if (command.onReject !== undefined && typeof command.onReject !== "function")
        throw new ConfigurationError("command", "onReject must be a function when supplied")
    validateCommandCooldown(command.cooldown)
    const identity = snapshotCommandIdentity(command)
    const argumentsSchema = snapshotCommandArguments(command.arguments)
    const cooldown = command.cooldown
    const { arguments: _argumentsMetadata, ...definition } = identity
    return Object.freeze({
        ...definition,
        execute: command.execute as StoredNativeCommand["execute"],
        ...(argumentsSchema === undefined ? {} : { arguments: argumentsSchema }),
        ...(command.guard === undefined ? {} : { guard: command.guard as StoredNativeCommand["guard"] }),
        ...(command.onReject === undefined ? {} : { onReject: command.onReject as StoredNativeCommand["onReject"] }),
        ...(cooldown === undefined
            ? {}
            : {
                  cooldown: Object.freeze({
                      store: cooldown.store as NativeCooldownStore<unknown, unknown>,
                      durationMs: cooldown.durationMs,
                      ...(cooldown.key === undefined
                          ? {}
                          : { key: cooldown.key as NonNullable<StoredNativeCommand["cooldown"]>["key"] }),
                  }),
              }),
    }) as StoredNativeCommand
}

function nativeCooldown(
    definition: StoredNativeCommand,
    context: NativePrefixCommandExecutionContext<CommandArgumentSchema>,
): Effect.Effect<CommandCooldownClaim, unknown, unknown> {
    const cooldown = definition.cooldown
    if (cooldown === undefined) return Effect.succeed({ _tag: "CooldownAcquired", retryAtMs: Number.MAX_SAFE_INTEGER })
    return Effect.suspend(() => Effect.succeed(cooldown.key?.(context) ?? context.message.author.id)).pipe(
        Effect.flatMap((key) => configurationEffect(() => cooldownRequest(definition.name, key, cooldown.durationMs))),
        Effect.flatMap((request) =>
            Effect.suspend(() => {
                const claim = cooldown.store.claim(request)
                return Effect.isEffect(claim) ? claim : Effect.succeed(claim)
            }),
        ),
    )
}

function nativeMemoryCooldownStore(owner: LocalMemoryCooldownStore): MemoryCooldownStore {
    return Object.freeze({
        maxEntries: owner.maxEntries,
        get size() {
            return owner.size
        },
        claim: (input: CommandCooldownRequest) =>
            Effect.suspend(() => {
                const result = owner.claim(input)
                return result._tag === "Success" ? Effect.succeed(result.value) : Effect.fail(result.error)
            }),
        sweep: () => Effect.sync(() => owner.sweep()),
        clear: () => Effect.sync(() => owner.clear()),
    })
}

function freezeRouter<R>(router: NativePrefixCommandRouterOwner<R>): NativePrefixCommandRouter<R> {
    return Object.freeze(router)
}

function nativeCallback<A, E, R>(
    callback: () => Effect.Effect<A, E, R>,
    message: string,
): Effect.Effect<A, ConfigurationError | E, R> {
    return Effect.suspend(() => {
        const value: unknown = callback()
        return Effect.isEffect(value) ? value : Effect.fail(new ConfigurationError("command", message))
    }) as Effect.Effect<A, ConfigurationError | E, R>
}
