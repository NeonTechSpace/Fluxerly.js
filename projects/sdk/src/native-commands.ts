import type {
    CommandCooldownClaim,
    CommandCooldownRequest,
    MemoryCooldownOptions,
    PrefixCommandDefinition,
    PrefixCommandGroupDefinition,
    PrefixCommandGroupMetadata,
    PrefixCommandMetadata,
    PrefixCommandParse,
    PrefixCommandParseInput,
    PrefixCommandRejection,
    PrefixCommandRegistrationOptions,
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
    snapshotCommandDefinition,
    snapshotCommandCooldown,
    validateCommandShape,
} from "#sdk/internal/commands"
import { convertCommandArguments } from "#sdk/internal/command-arguments"
import type { RegistrationError, SendError } from "#sdk/message-errors"
import type { Message, MessageCore, ReplyInput, SendOptions } from "#sdk/messages"
import { Clock, Effect, type Scope } from "effect"
import type { Client, EventHandlerOptions, Subscription } from "./effect.js"

/**
 * Message and parsed arguments for a native command's guard and rejection callback. These values cannot be changed.
 * Execution and cooldown-key callbacks receive the extended context with converted values.
 * Native callbacks run in the attachment's Effect context, with interruption rather than the default API's AbortSignal field
 */
export interface NativePrefixCommandContext<M extends MessageCore = Message> {
    /** Client supplied to `attach`, available for explicit Effect operations. You still own its connection and shutdown */
    readonly client: Client<M>
    /** Frozen incoming message with the attached client's selected fields. The router does not fetch omitted fields */
    readonly message: M
    /** Exact prefix selected for this invocation, such as `!` or `!!` */
    readonly prefix: string
    /** Registered command name, regardless of the alias or letter case used in the message */
    readonly name: string
    /** Frozen registered names through this command, such as `["admin", "inspect"]`. Absent at root and does not imply authorization */
    readonly path?: readonly string[]
    /** Parsed string tokens copied to a frozen array, preserved alongside any converted values */
    readonly args: readonly string[]
    /** Argument text retained by the parser. The default removes command-name separator whitespace but preserves the remainder */
    readonly rawArgs: string
    /**
     * Reply to the incoming message through the attached client. The returned Effect follows handler interruption and can fail with SendError.
     * Delegates to `client.messages.reply`, including its validation, deadline, nonce, retry, cache and defect behavior.
     * Interruption or a lost response can leave the reply posted. Failure does not always mean nothing was sent, and uncertain sends are not replayed.
     * The router does not send a reply or error message on its own
     */
    readonly reply: (input: ReplyInput, options?: SendOptions) => Effect.Effect<M, SendError>
}

/** Command context supplied to execution and cooldown-key callbacks only after the complete argument schema succeeds */
export interface NativePrefixCommandExecutionContext<
    S extends CommandArgumentSchema = {},
    M extends MessageCore = Message,
> extends NativePrefixCommandContext<M> {
    /** Frozen values keyed by schema names, such as `values.count`, or an empty object when no schema is supplied. Not available to guards or rejection callbacks */
    readonly values: CommandArgumentValues<S>
}

/** Frozen message and prefix for native `onUnmatched` feedback, without an assumed command or converted arguments */
export interface NativePrefixCommandUnmatchedContext<M extends MessageCore = Message> {
    /** Attached client for explicit feedback operations, without transferring its lifetime to the router */
    readonly client: Client<M>
    /** Incoming frozen message with the client's selected fields only */
    readonly message: M
    /** Exact prefix selected before parsing declined, name lookup missed or a group needed a subcommand */
    readonly prefix: string
    /**
     * Reply to the unmatched incoming message through the attached client, inheriting this callback's interruption.
     * Delegates to `client.messages.reply`, including its validation, deadline, nonce, retry, cache and defect behavior.
     * Interruption or a lost response can leave the reply posted. Failure does not always mean nothing was sent, and uncertain sends are not replayed
     */
    readonly reply: (input: ReplyInput, options?: SendOptions) => Effect.Effect<M, SendError>
}

/** Prefix and parser configuration with optional Effect feedback when no executable command is selected */
export interface NativePrefixCommandsOptions<
    E = never,
    R = never,
    M extends MessageCore = Message,
> extends PrefixCommandsOptions<M> {
    /**
     * Return an Effect that handles a parser decline, unknown name or group without a subcommand.
     * Runs in the attachment's captured Effect context and follows subscription interruption, with its success value discarded.
     * Failures and defects use attachment `onError` reporting, without retry or automatic replies.
     * Not called for ignored bot messages or messages without a matching prefix.
     * Returning anything other than an Effect fails dispatch with ConfigurationError
     */
    readonly onUnmatched?: (
        context: NativePrefixCommandUnmatchedContext<M>,
        unmatched: PrefixCommandUnmatched,
    ) => Effect.Effect<unknown, E, R>
}

/**
 * Storage that checks and reserves a command cooldown in one atomic claim.
 * The application owns persistence and coordination of competing claims, including across processes.
 * A claim can be immediate or return an Effect requiring the handler's services
 */
export interface NativeCooldownStore<E = never, R = never> {
    /**
     * Reserve `input.key` for `input.durationMs`, returning a claim directly or through an Effect.
     * The returned Effect runs within command dispatch, preserving the attachment's services and interruption.
     * Only `CooldownAcquired` permits execution. Other claims call optional rejection feedback without waiting or retrying.
     * Malformed claims fail with ConfigurationError. Store failures and defects use subscription error reporting
     */
    claim(input: CommandCooldownRequest): CommandCooldownClaim | Effect.Effect<CommandCooldownClaim, E, R>
}

/**
 * Reserve a cooldown after the command guard allows execution and all arguments convert.
 * The router calls the store before executing the handler.
 * A claimed cooldown remains claimed if the handler fails or is interrupted
 */
export interface NativePrefixCommandCooldown<
    E = never,
    R = never,
    S extends CommandArgumentSchema = {},
    M extends MessageCore = Message,
> {
    /** Reservation store retained by reference. The built-in store coordinates only callers sharing one instance within one process */
    readonly store: NativeCooldownStore<E, R>
    /** Whole milliseconds per claim, from 1 through 2,147,483,647 */
    readonly durationMs: number
    /**
     * Synchronously return a nonempty suffix from the converted context, defaulting to the invoking author's ID.
     * The router adds the canonical command name or full group path, so aliases share a claim but different parent groups do not.
     * Routers sharing a store also share claims when their command identities and suffixes match
     */
    readonly key?: (context: NativePrefixCommandExecutionContext<S, M>) => string
}

/**
 * A prefix command whose application callbacks return Effects rather than promises.
 * Dispatch evaluates its guard, converts arguments, claims any cooldown and runs the execution Effect.
 * Callbacks use the attachment's captured services and interruption, without a detached runtime.
 * Registration copies metadata and arguments while retaining callbacks and the cooldown store.
 * `E` describes callback failures and `R` describes required services. Callback failures are reported by the subscription, not by a completed `attach`
 */
export interface NativePrefixCommand<
    E = never,
    R = never,
    S extends CommandArgumentSchema = {},
    M extends MessageCore = Message,
> extends PrefixCommandDefinition {
    /** Named positional conversions in property order. Omitted leaves parsed `args` unrestricted and converted `values` empty */
    readonly arguments?: S
    /**
     * Return an Effect producing true to allow this command. Omitted means allow it.
     * Receives raw context before argument conversion. False skips conversion, cooldown and execution and calls optional `onReject`.
     * Each command owns its policy, with no inherited group guard or authorization from help visibility.
     * Non-Effect returns and non-boolean success values fail with ConfigurationError.
     * Failures and defects use subscription error reporting rather than rejection feedback
     */
    readonly guard?: (context: NativePrefixCommandContext<M>) => Effect.Effect<boolean, E, R>
    /**
     * Return an Effect for your feedback after a false guard, rejected arguments or a denied cooldown.
     * Receives raw context and a safe rejection classification, never partially converted values.
     * Its success value is discarded. Failures and defects use attachment error reporting, without retry.
     * The router sends no automatic feedback, and non-Effect returns fail with ConfigurationError
     */
    readonly onReject?: (
        context: NativePrefixCommandContext<M>,
        rejection: PrefixCommandRejection,
    ) => Effect.Effect<unknown, E, R>
    /** Optional cooldown claim required after the guard and arguments succeed. Denied claims skip execution */
    readonly cooldown?: NativePrefixCommandCooldown<E, R, S, M>
    /**
     * Return the Effect that performs work for this allowed command with fully converted arguments.
     * The subscription runs it in the attachment's context and discards its success value, rather than sending it as a reply.
     * Failures and defects use safe attachment `onError` reporting, without retry or cooldown rollback.
     * Non-Effect returns fail with ConfigurationError. Cooperative Effect work is interrupted when the attachment closes.
     * Synchronous work and promises that ignore cancellation cannot be forcibly stopped
     */
    readonly execute: (context: NativePrefixCommandExecutionContext<S, M>) => Effect.Effect<unknown, E, R>
}

type NativePrefixCommandBatch<
    M extends MessageCore,
    S extends Readonly<Record<string, CommandArgumentSchema | undefined>>,
> = {
    readonly [K in keyof S]: Omit<
        NativePrefixCommand<unknown, any, S[K] extends CommandArgumentSchema ? S[K] : {}, M>,
        "name" | "arguments"
    > & { readonly arguments: S[K] }
}

type NativeEffectRequirements<F> = F extends (...arguments_: any[]) => Effect.Effect<unknown, unknown, infer R>
    ? R
    : never

type NativeCommandRequirements<C> =
    | (C extends { readonly execute: infer F } ? NativeEffectRequirements<F> : never)
    | (C extends { readonly guard: infer F } ? NativeEffectRequirements<F> : never)
    | (C extends { readonly onReject: infer F } ? NativeEffectRequirements<F> : never)
    | (C extends { readonly cooldown: { readonly store: { readonly claim: infer F } } }
          ? F extends (...arguments_: any[]) => infer A
              ? A extends Effect.Effect<unknown, unknown, infer R>
                  ? R
                  : never
              : never
          : never)

type NativeBatchRequirements<C> =
    C extends Readonly<Record<string, unknown>> ? NativeCommandRequirements<C[keyof C]> : never

/**
 * Bounded in-memory cooldown reservations for one process, using the caller's Effect Clock wall time.
 * Claim, sweep and clear return lazy Effects, so storage changes occur only when those Effects run.
 * No background timer, persistence or cross-process coordination is provided
 */
export interface MemoryCooldownStore {
    /** Fixed key limit selected when the store is created */
    readonly maxEntries: number
    /** Immediate stored-key count, including expired keys until a claim or sweep removes them */
    readonly size: number
    /**
     * When run, sweep expired keys and atomically reserve the key or report an active cooldown or full store.
     * Acquired expiry is the caller Clock's current wall time plus `durationMs`, and active entries are never evicted to make room.
     * Malformed keys or durations fail with ConfigurationError. Unexpected input getter defects remain in the Effect cause
     */
    claim(input: CommandCooldownRequest): Effect.Effect<CommandCooldownClaim, ConfigurationError>
    /** Return an Effect that removes keys expired according to the caller's Effect Clock and produces the number removed, preserving active claims */
    sweep(): Effect.Effect<number>
    /** Return an Effect that forgets this store's reservations, allowing new claims. Does not cancel handlers or clear other stores */
    clear(): Effect.Effect<void>
}

/**
 * Immutable registered commands and groups for attachment to a native client.
 * Registration Effects produce new snapshots, leaving earlier routers and attachments unchanged.
 * `R` records services required by registered callbacks, which you must provide when attaching the router.
 * Creating or registering a router does not run its callbacks
 */
export interface NativePrefixCommandRouter<R = never, M extends MessageCore = Message> {
    /** Frozen executable-command information in registration order across groups, without callbacks or resource candidates. Grouped commands include canonical paths */
    readonly commands: readonly PrefixCommandMetadata[]
    /** Frozen group information in registration order, including empty groups. Groups organize lookup and help, not authorization */
    readonly groups: readonly PrefixCommandGroupMetadata[]
    /**
     * Return an Effect that builds frozen help pages locally, without sending messages or executing commands.
     * No rendering or visibility callback runs until the Effect executes. It needs no scope or registered callback services
     *
     * Root help lists immediate commands and groups in sibling registration order.
     * A canonical group selection shows the group and its immediate children, including empty groups, unless an ancestor is hidden.
     * Entries show full canonical paths, aliases and descriptions, with `(Group)` marking groups
     *
     * Schemas generate `<required>`, `[optional]` and `<rest...>` or `[rest...]` syntax unless explicit `usage` overrides it.
     * An empty usage suppresses inferred syntax, and an absent schema adds no argument syntax.
     * Empty or hidden selections produce `[]`. No prefix resolver, guard, cooldown or handler is evaluated
     *
     * The explicit UTF-16 page limit preserves surrogate pairs, but may split visible character clusters or Markdown.
     * Page-edge whitespace is trimmed and empty pages are removed, so joining pages does not reconstruct the exact original text.
     * You choose which pages to send and how to handle mentions
     *
     * Malformed options, ill-formed text, too-small limits and invalid visibility callbacks fail with ConfigurationError.
     * Unexpected option getter defects remain in the Effect cause. Synchronous rendering cannot be interrupted while running
     */
    help(options: CommandHelpOptions): Effect.Effect<readonly string[], ConfigurationError>
    /**
     * Return an Effect that validates and adds a command to a new router, at root or an existing canonical `options.group` path.
     * Copies metadata and arguments when run, retaining callbacks and the cooldown store without invoking them.
     * The resulting router requires this command's services `R2` in addition to existing `R` when attached.
     * Names and aliases must not collide with sibling commands or groups under the router's case policy.
     * Invalid definitions, collisions and missing or alias-only parent paths fail with ConfigurationError.
     * Unexpected getter defects remain in the Effect cause. Earlier routers and active attachments remain unchanged
     */
    register<E, R2, const S extends CommandArgumentSchema = {}>(
        command: NativePrefixCommand<E, R2, S, M>,
        options?: PrefixCommandRegistrationOptions,
    ): Effect.Effect<NativePrefixCommandRouter<R | R2, M>, ConfigurationError>
    /**
     * Return an Effect that validates and adds a nonempty keyed command object to one new router, in JavaScript own enumerable string-key order and under one optional parent.
     * Each object key supplies its command name. Set `arguments: {}` to reject positional arguments, or `arguments: undefined` to leave raw args unrestricted.
     * Every definition is snapshotted before registration. Inherited batch keys are ignored.
     * Recognized fields inside each definition are read once, including inherited and non-enumerable fields.
     * If any definition is invalid or any name collides, the Effect fails with
     * ConfigurationError and produces no partially registered router. Earlier routers and attachments remain unchanged.
     * The optional parent is validated and snapshotted once when the Effect runs. Unexpected getter defects remain in the Effect cause.
     * Each entry retains its inferred argument values, and the returned router records every callback service requirement
     */
    registerMany<
        const S extends Readonly<Record<string, CommandArgumentSchema | undefined>>,
        const C extends Readonly<
            Record<
                keyof S,
                {
                    readonly arguments: CommandArgumentSchema | undefined
                    readonly execute: unknown
                }
            >
        >,
    >(
        commands: C & NativePrefixCommandBatch<M, S>,
        options?: PrefixCommandRegistrationOptions,
    ): Effect.Effect<NativePrefixCommandRouter<R | NativeBatchRequirements<C>, M>, ConfigurationError>
    /**
     * Return an Effect that adds a group to a new router, at root or beneath an existing canonical `options.group` path.
     * Register parent groups before children. Groups accept identity and description only, without callbacks or argument schemas.
     * Group names and aliases use fixed whitespace separators at dispatch, before the command parser runs.
     * Invalid metadata, missing parents and sibling name collisions fail with ConfigurationError.
     * Unexpected getter defects remain in the Effect cause. Existing routers keep their data, and required services `R` do not change
     */
    registerGroup(
        group: PrefixCommandGroupDefinition,
        options?: PrefixCommandRegistrationOptions,
    ): Effect.Effect<NativePrefixCommandRouter<R, M>, ConfigurationError>
    /**
     * Return an Effect that registers this router as one bounded `messageCreate` subscription in the caller's scope.
     * Provide registered callback services `R` and any error-callback services `R2` when running this Effect
     *
     * Produces a Subscription after registration, not after connecting the client or completing future command work.
     * Callback failures and defects use subscription `onError` reporting, rather than failing an already completed attachment Effect.
     * Each attachment dispatches independently, so duplicate attachments can execute a command twice
     *
     * Run `subscription.unsubscribe()` or close the registration scope to detach and interrupt handlers, without shutting down the client.
     * `subscription.waitForClose()` completes after handler finalizers. Work that disables interruption can delay closure.
     * Synchronous work and caller-owned promises that ignore interruption cannot be forcibly stopped
     *
     * The client must use message type `M`. A full-message router cannot attach to a client with omitted fields
     */
    attach<E = never, R2 = never>(
        client: Client<M>,
        options?: EventHandlerOptions<E, R2>,
    ): Effect.Effect<Subscription, RegistrationError, Scope.Scope | R | R2>
}

/**
 * Recognize message commands such as `!repeat hello` with `commands` from the package's `/effect` entry point.
 * Creation, registration and memory-store operations return Effects that do nothing until run.
 * Quoted parsing is a synchronous pure helper shared with the default API
 */
export interface NativeCommands {
    /**
     * Return an Effect that validates options and creates an empty local router, without connecting or subscribing a client.
     * Defaults to full Message typing. Supply MessageCore or the client's SelectedMessage type as `M` for fewer selected fields.
     * Prefix resolvers, parsers, command callbacks and the context client keep the same message type.
     * The router records services `R` required by optional unmatched feedback, but does not require them until attachment.
     * Invalid options fail with ConfigurationError. Unexpected creation defects remain in the Effect cause.
     * No prefix resolver, parser or feedback callback runs during creation
     */
    create<E = never, R = never, M extends MessageCore = Message>(
        options: NativePrefixCommandsOptions<E, R, M>,
    ): Effect.Effect<NativePrefixCommandRouter<R, M>, ConfigurationError>
    /**
     * Synchronously split a suffix with single or double quotes and backslash escapes, preserving original argument text in `rawArgs`.
     * Select with `create({ prefix: "!", parse: commands.parseQuoted })`, since the default splits only on whitespace.
     * Returns undefined for empty input, invalid names, unclosed quotes or trailing escapes. Empty quotes produce an empty token.
     * Unlike creation and store methods, this helper returns its result directly, not an Effect
     */
    parseQuoted<M extends MessageCore = Message>(input: PrefixCommandParseInput<M>): PrefixCommandParse | undefined
    /**
     * Return an Effect that creates a fresh in-memory cooldown store each time it runs.
     * Defaults to 1,024 retained keys, or the supplied positive safe integer `maxEntries`.
     * Invalid options fail with ConfigurationError. Unexpected getter defects remain in the Effect cause.
     * Keep the produced store for reuse in command cooldowns. It has no persistence, scope finalizer or background timer
     */
    memoryCooldowns(options?: MemoryCooldownOptions): Effect.Effect<MemoryCooldownStore, ConfigurationError>
}

/** Native tools behind the public `commands` namespace, returning lazy Effects except for synchronous quoted parsing */
export const nativeCommands: NativeCommands = Object.freeze({
    create: <E, R, M extends MessageCore = Message>(options: NativePrefixCommandsOptions<E, R, M>) =>
        configurationEffect(() =>
            freezeRouter(
                new NativePrefixCommandRouterOwner<R, M>(
                    new PrefixCommandRegistry<StoredNativeCommand<M>, M>(options),
                    snapshotNativeOnUnmatched(options.onUnmatched),
                ),
            ),
        ),
    parseQuoted: parseQuotedPrefixCommand,
    memoryCooldowns: (options: MemoryCooldownOptions | undefined) =>
        configurationEffect(() => nativeMemoryCooldownStore(createMemoryCooldownStore(options))),
})

interface StoredNativeCommand<M extends MessageCore> extends PrefixCommandDefinition {
    readonly guard?: (context: NativePrefixCommandContext<M>) => Effect.Effect<boolean, unknown, unknown>
    readonly onReject?: (
        context: NativePrefixCommandContext<M>,
        rejection: PrefixCommandRejection,
    ) => Effect.Effect<unknown, unknown, unknown>
    readonly cooldown?: NativePrefixCommandCooldown<unknown, unknown, CommandArgumentSchema, M>
    readonly execute: (
        context: NativePrefixCommandExecutionContext<CommandArgumentSchema, M>,
    ) => Effect.Effect<unknown, unknown, unknown>
}

class NativePrefixCommandRouterOwner<R = never, M extends MessageCore = Message> implements NativePrefixCommandRouter<
    R,
    M
> {
    readonly #registry: PrefixCommandRegistry<StoredNativeCommand<M>, M>
    readonly #onUnmatched?: StoredNativeOnUnmatched<M>

    constructor(registry: PrefixCommandRegistry<StoredNativeCommand<M>, M>, onUnmatched?: StoredNativeOnUnmatched<M>) {
        this.#registry = registry
        if (onUnmatched !== undefined) this.#onUnmatched = onUnmatched
    }

    get commands(): readonly PrefixCommandMetadata[] {
        return this.#registry.commands
    }

    get groups(): readonly PrefixCommandGroupMetadata[] {
        return this.#registry.groups
    }

    help(options: CommandHelpOptions): Effect.Effect<readonly string[], ConfigurationError> {
        return configurationEffect(() => commandHelp(this.#registry.entries, options))
    }

    register<E, R2, const S extends CommandArgumentSchema = {}>(
        command: NativePrefixCommand<E, R2, S, M>,
        options?: PrefixCommandRegistrationOptions,
    ): Effect.Effect<NativePrefixCommandRouter<R | R2, M>, ConfigurationError> {
        return configurationEffect(() =>
            freezeRouter(
                new NativePrefixCommandRouterOwner<R | R2, M>(
                    this.#registry.register(snapshotNativeCommand(command), options),
                    this.#onUnmatched,
                ),
            ),
        )
    }

    registerMany<
        const S extends Readonly<Record<string, CommandArgumentSchema | undefined>>,
        const C extends Readonly<
            Record<
                keyof S,
                {
                    readonly arguments: CommandArgumentSchema | undefined
                    readonly execute: unknown
                }
            >
        >,
    >(
        commands: C & NativePrefixCommandBatch<M, S>,
        options?: PrefixCommandRegistrationOptions,
    ): Effect.Effect<NativePrefixCommandRouter<R | NativeBatchRequirements<C>, M>, ConfigurationError> {
        return configurationEffect(() => {
            const stored = snapshotNativeCommandBatch(commands)
            return freezeRouter(
                new NativePrefixCommandRouterOwner<R | NativeBatchRequirements<C>, M>(
                    this.#registry.registerMany(stored, options),
                    this.#onUnmatched,
                ),
            )
        })
    }

    registerGroup(
        group: PrefixCommandGroupDefinition,
        options?: PrefixCommandRegistrationOptions,
    ): Effect.Effect<NativePrefixCommandRouter<R, M>, ConfigurationError> {
        return configurationEffect(() =>
            freezeRouter(
                new NativePrefixCommandRouterOwner<R, M>(
                    this.#registry.registerGroup(group, options),
                    this.#onUnmatched,
                ),
            ),
        )
    }

    attach<E = never, R2 = never>(
        client: Client<M>,
        options?: EventHandlerOptions<E, R2>,
    ): Effect.Effect<Subscription, RegistrationError, Scope.Scope | R | R2> {
        return client.on(
            "messageCreate",
            (message) => this.dispatch(client, message) as Effect.Effect<void, E, R>,
            options,
        )
    }

    private dispatch(client: Client<M>, message: M): Effect.Effect<void, ConfigurationError, R> {
        return dispatchCommand(this.#registry, message, {
            context: (match) =>
                Object.freeze({
                    client,
                    message,
                    prefix: match.prefix,
                    name: match.definition.name,
                    ...(match.path === undefined ? {} : { path: match.path }),
                    args: Object.freeze([...match.parse.args]),
                    rawArgs: match.parse.rawArgs,
                    reply: boundNativeReply(client, message),
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
                                  Object.freeze({
                                      client,
                                      message,
                                      prefix: match.prefix,
                                      reply: boundNativeReply(client, message),
                                  }),
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

type StoredNativeOnUnmatched<M extends MessageCore> = (
    context: NativePrefixCommandUnmatchedContext<M>,
    unmatched: PrefixCommandUnmatched,
) => Effect.Effect<unknown, unknown, unknown>

function snapshotNativeOnUnmatched<E, R, M extends MessageCore>(
    value: NativePrefixCommandsOptions<E, R, M>["onUnmatched"],
): StoredNativeOnUnmatched<M> | undefined {
    if (value !== undefined && typeof value !== "function")
        throw new ConfigurationError("commands", "onUnmatched must be a function when supplied")
    return value as StoredNativeOnUnmatched<M> | undefined
}

function snapshotNativeCommand<E, R, S extends CommandArgumentSchema, M extends MessageCore>(
    command: NativePrefixCommand<E, R, S, M>,
    keyedName?: string,
): StoredNativeCommand<M> {
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
    const { execute, guard, onReject, cooldown: sourceCooldown } = command
    if (typeof execute !== "function") throw new ConfigurationError("command", "A command must provide execute")
    if (guard !== undefined && typeof guard !== "function")
        throw new ConfigurationError("command", "guard must be a function when supplied")
    if (onReject !== undefined && typeof onReject !== "function")
        throw new ConfigurationError("command", "onReject must be a function when supplied")
    const cooldown = snapshotCommandCooldown(sourceCooldown)
    const definition = snapshotCommandDefinition(command, keyedName)
    return Object.freeze({
        ...definition,
        execute: execute as StoredNativeCommand<M>["execute"],
        ...(guard === undefined ? {} : { guard: guard as StoredNativeCommand<M>["guard"] }),
        ...(onReject === undefined ? {} : { onReject: onReject as StoredNativeCommand<M>["onReject"] }),
        ...(cooldown === undefined
            ? {}
            : {
                  cooldown: Object.freeze({
                      store: cooldown.store as NativeCooldownStore<unknown, unknown>,
                      durationMs: cooldown.durationMs,
                      ...(cooldown.key === undefined
                          ? {}
                          : { key: cooldown.key as NonNullable<StoredNativeCommand<M>["cooldown"]>["key"] }),
                  }),
              }),
    }) as StoredNativeCommand<M>
}

function snapshotNativeCommandBatch<M extends MessageCore>(
    commands: Readonly<Record<string, unknown>>,
): readonly StoredNativeCommand<M>[] {
    if (typeof commands !== "object" || commands === null || Array.isArray(commands))
        throw new ConfigurationError("command", "A command batch must be an object")
    for (const key of Reflect.ownKeys(commands))
        if (typeof key === "symbol" && Object.prototype.propertyIsEnumerable.call(commands, key))
            throw new ConfigurationError("command", "Command batch keys must be strings")
    const names = Object.keys(commands)
    if (names.length === 0) throw new ConfigurationError("command", "A command batch must not be empty")
    const stored: StoredNativeCommand<M>[] = []
    for (const name of names) {
        const value = commands[name]
        if (typeof value !== "object" || value === null || Array.isArray(value))
            throw new ConfigurationError("command", "A command batch entry must be an object")
        if (Object.prototype.hasOwnProperty.call(value, "name"))
            throw new ConfigurationError("command", "A command batch entry must use its object key as the name")
        stored.push(
            snapshotNativeCommand(value as NativePrefixCommand<unknown, unknown, CommandArgumentSchema, M>, name),
        )
    }
    return Object.freeze(stored)
}

function boundNativeReply<M extends MessageCore>(
    client: Client<M>,
    message: M,
): NativePrefixCommandContext<M>["reply"] {
    return (input, options) => client.messages.reply(message, input, options)
}

function nativeCooldown<M extends MessageCore>(
    definition: StoredNativeCommand<M>,
    context: NativePrefixCommandExecutionContext<CommandArgumentSchema, M>,
): Effect.Effect<CommandCooldownClaim, unknown, unknown> {
    const cooldown = definition.cooldown
    if (cooldown === undefined) return Effect.succeed({ _tag: "CooldownAcquired", retryAtMs: Number.MAX_SAFE_INTEGER })
    return Effect.suspend(() => Effect.succeed(cooldown.key?.(context) ?? context.message.author.id)).pipe(
        Effect.flatMap((key) =>
            configurationEffect(() => cooldownRequest(context.path ?? definition.name, key, cooldown.durationMs)),
        ),
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
            Clock.clockWith((clock) =>
                Effect.suspend(() => {
                    const result = owner.claim(input, clock.currentTimeMillisUnsafe())
                    return result._tag === "Success" ? Effect.succeed(result.value) : Effect.fail(result.error)
                }),
            ),
        sweep: () => Clock.clockWith((clock) => Effect.sync(() => owner.sweep(clock.currentTimeMillisUnsafe()))),
        clear: () => Effect.sync(() => owner.clear()),
    })
}

function freezeRouter<R, M extends MessageCore>(
    router: NativePrefixCommandRouterOwner<R, M>,
): NativePrefixCommandRouter<R, M> {
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
