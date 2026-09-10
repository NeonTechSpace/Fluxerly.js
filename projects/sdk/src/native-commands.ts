import type {
    CommandCooldownClaim,
    CommandCooldownRequest,
    MemoryCooldownOptions,
    PrefixCommandDefinition,
    PrefixCommandsOptions,
} from "#sdk/commands"
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

/** Caller-owned native cooldown storage. Its claim may be immediate or preserve the handler’s Effect environment */
export interface NativeCooldownStore<E = never, R = never> {
    /** Return an immediate claim or a lazy Effect. Claims must be atomic within whichever scope the store represents */
    claim(input: CommandCooldownRequest): CommandCooldownClaim | Effect.Effect<CommandCooldownClaim, E, R>
}

/** Optional native command cooldown. A successful claim is retained even when a later handler failure occurs */
export interface NativePrefixCommandCooldown<E = never, R = never> {
    /** Caller-owned store. The built-in memory store is bounded and process-local only */
    readonly store: NativeCooldownStore<E, R>
    /** Positive duration in milliseconds, capped at 2,147,483,647 */
    readonly durationMs: number
    /** Per-command key suffix. Defaults to the invoking author ID. The router namespaces it by canonical command name */
    readonly key?: (context: NativePrefixCommandContext) => string
}

/** One native prefix command. The router snapshots metadata and retains only its guard, execute, cooldown key and store references. Its guard and handler execute through the attached client subscription in the caller’s context */
export interface NativePrefixCommand<E = never, R = never> extends PrefixCommandDefinition {
    /** Optional authorization or policy Effect. False skips cooldown and execution without replying */
    readonly guard?: (context: NativePrefixCommandContext) => Effect.Effect<boolean, E, R>
    /** Optional admission limit acquired after a successful guard and before execution */
    readonly cooldown?: NativePrefixCommandCooldown<E, R>
    /** Application Effect for a matched, allowed command. Failure is reported by the attached subscription without retry */
    readonly execute: (context: NativePrefixCommandContext) => Effect.Effect<unknown, E, R>
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
    /** Lazily validate and add one command to a separate router snapshot. Existing routers and attachments stay unchanged */
    register<E, R2>(
        command: NativePrefixCommand<E, R2>,
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
    /** Lazily create a local router without attaching a subscription or connecting a client. Unexpected creation defects remain in the Effect cause */
    create(options: PrefixCommandsOptions): Effect.Effect<NativePrefixCommandRouter, ConfigurationError>
    /** Lazily create a bounded process-local cooldown store */
    memoryCooldowns(options?: MemoryCooldownOptions): Effect.Effect<MemoryCooldownStore, ConfigurationError>
}

/** Implementation shared by the native public namespace */
export const nativeCommands: NativeCommands = Object.freeze({
    create: (options: PrefixCommandsOptions) =>
        configurationEffect(() => freezeRouter(new NativePrefixCommandRouterOwner(new PrefixCommandRegistry(options)))),
    memoryCooldowns: (options: MemoryCooldownOptions | undefined) =>
        configurationEffect(() => nativeMemoryCooldownStore(createMemoryCooldownStore(options))),
})

interface StoredNativeCommand extends PrefixCommandDefinition {
    readonly guard?: (context: NativePrefixCommandContext) => Effect.Effect<boolean, unknown, unknown>
    readonly cooldown?: NativePrefixCommandCooldown<unknown, unknown>
    readonly execute: (context: NativePrefixCommandContext) => Effect.Effect<unknown, unknown, unknown>
}

class NativePrefixCommandRouterOwner<R = never> implements NativePrefixCommandRouter<R> {
    readonly #registry: PrefixCommandRegistry<StoredNativeCommand>

    constructor(registry: PrefixCommandRegistry<StoredNativeCommand>) {
        this.#registry = registry
    }

    register<E, R2>(
        command: NativePrefixCommand<E, R2>,
    ): Effect.Effect<NativePrefixCommandRouter<R | R2>, ConfigurationError> {
        return configurationEffect(() =>
            freezeRouter(
                new NativePrefixCommandRouterOwner<R | R2>(this.#registry.register(snapshotNativeCommand(command))),
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
            guard: (definition, context) =>
                definition.guard === undefined
                    ? Effect.succeed(true)
                    : nativeCallback(() => definition.guard!(context), "A native command guard must return an Effect"),
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

function snapshotNativeCommand<E, R>(command: NativePrefixCommand<E, R>): StoredNativeCommand {
    validateCommandShape(command, ["name", "aliases", "guard", "cooldown", "execute"])
    if (typeof command.execute !== "function") throw new ConfigurationError("command", "A command must provide execute")
    if (command.guard !== undefined && typeof command.guard !== "function")
        throw new ConfigurationError("command", "guard must be a function when supplied")
    validateCommandCooldown(command.cooldown)
    const identity = snapshotCommandIdentity(command)
    const cooldown = command.cooldown
    return Object.freeze({
        ...identity,
        execute: command.execute as StoredNativeCommand["execute"],
        ...(command.guard === undefined ? {} : { guard: command.guard as StoredNativeCommand["guard"] }),
        ...(cooldown === undefined
            ? {}
            : {
                  cooldown: Object.freeze({
                      store: cooldown.store as NativeCooldownStore<unknown, unknown>,
                      durationMs: cooldown.durationMs,
                      ...(cooldown.key === undefined ? {} : { key: cooldown.key }),
                  }),
              }),
    }) as StoredNativeCommand
}

function nativeCooldown(
    definition: StoredNativeCommand,
    context: NativePrefixCommandContext,
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
