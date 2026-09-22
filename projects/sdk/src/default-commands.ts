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
import type { OperationOptions } from "#sdk/client"
import { CancelledError, ConfigurationError, SdkDefect } from "#sdk/errors"
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
import type { RegistrationError } from "#sdk/message-errors"
import type { SendError } from "#sdk/message-errors"
import type { DefaultSendOptions, Message, MessageCore, ReplyInput, SendOptions } from "#sdk/messages"
import { Effect } from "effect"
import { err, ok, type Result, type ResultAsync } from "neverthrow"
import type { Client, EventHandlerOptions, Subscription } from "./index.js"

/**
 * Frozen information about one matched command, passed to its guard and rejection callback.
 * Includes the incoming message and parsed strings, but not converted argument values.
 * Execution and cooldown-key callbacks receive the extended execution context
 */
export interface DefaultPrefixCommandContext<M extends MessageCore = Message> {
    /** Client supplied to `attach`, available for explicit operations. Its connection and shutdown remain your responsibility */
    readonly client: Client<M>
    /** Incoming frozen message with this client's selected fields. The router does not fetch excluded fields */
    readonly message: M
    /** Prefix that matched this message, such as `!` or `!!` */
    readonly prefix: string
    /** Registered command name, even when the message used an alias or different letter case */
    readonly name: string
    /** Frozen registered names through this command, such as `["admin", "inspect"]`. Absent for root commands and does not imply permission */
    readonly path?: readonly string[]
    /** Parsed string tokens copied to a frozen array, unchanged by subsequent argument conversion */
    readonly args: readonly string[]
    /** Argument text from the parser. The default retains everything after command-name separator whitespace, including trailing whitespace */
    readonly rawArgs: string
    /** Subscription cancellation signal to pass to operations that support it. Cancellation prevents later router callbacks but cannot forcibly stop your pending promises */
    readonly signal: NonNullable<OperationOptions["signal"]>
    /**
     * Reply to the incoming message through the attached client, with this handler's cancellation signal already applied.
     * Delegates to `client.messages.reply`, including its validation, deadline, nonce, retry, cache and defect behavior.
     * Cancellation or a lost response can leave the reply posted. An Err does not always mean nothing was sent, and uncertain sends are not replayed.
     * Check the returned Result explicitly. Returning an Err from `execute` does not report a handler failure unless the callback throws it
     */
    readonly reply: (
        input: ReplyInput,
        options?: SendOptions,
    ) => ResultAsync<M, SendError | CancelledError | ConfigurationError>
}

/** Matched-command context plus fully converted argument values, supplied to execution and cooldown-key callbacks */
export interface DefaultPrefixCommandExecutionContext<
    S extends CommandArgumentSchema = {},
    M extends MessageCore = Message,
> extends DefaultPrefixCommandContext<M> {
    /** Frozen values keyed by schema names, such as `values.count`. Empty when no schema is supplied. Guards and rejection callbacks never receive partial values */
    readonly values: CommandArgumentValues<S>
}

/** Frozen message and matched prefix for `onUnmatched`, when parsing or lookup did not select an executable command */
export interface DefaultPrefixCommandUnmatchedContext<M extends MessageCore = Message> {
    /** Attached client you can use for explicit feedback, without transferring its lifetime to the router */
    readonly client: Client<M>
    /** Incoming frozen message with the attached client's selected fields only */
    readonly message: M
    /** Exact prefix selected before parsing declined, name lookup missed or a group needed a subcommand */
    readonly prefix: string
    /** Cancellation signal for cooperative feedback work. A promise that ignores it may keep running after the subscription closes */
    readonly signal: NonNullable<OperationOptions["signal"]>
    /**
     * Reply to the unmatched incoming message through the attached client, with this callback's cancellation signal already applied.
     * Delegates to `client.messages.reply`, including its validation, deadline, nonce, retry, cache and defect behavior.
     * Cancellation or a lost response can leave the reply posted. An Err does not always mean nothing was sent, and uncertain sends are not replayed.
     * Check the returned Result explicitly and throw its error to use attachment `onError` reporting
     */
    readonly reply: (
        input: ReplyInput,
        options?: SendOptions,
    ) => ResultAsync<M, SendError | CancelledError | ConfigurationError>
}

/** Prefix and parsing options, plus optional feedback when a command-like message has no executable match */
export interface DefaultPrefixCommandsOptions<M extends MessageCore = Message> extends PrefixCommandsOptions<M> {
    /**
     * Handle parser declines, unknown names and groups without a subcommand, optionally sending your own feedback.
     * Return normally or a promise that completes your work. The router does not interpret a successful return value or send a response.
     * Throws and rejected promises use the attachment's `onError` reporting, without retry.
     * Not called for ignored bots or messages without a matching prefix
     */
    readonly onUnmatched?: (
        context: DefaultPrefixCommandUnmatchedContext<M>,
        unmatched: PrefixCommandUnmatched,
    ) => void | Promise<void>
}

/**
 * Storage that reserves a command cooldown and reports whether this invocation may execute.
 * You own persistence, concurrency and coordination between processes.
 * Each claim must atomically check and reserve its complete key, rather than using separate read and write calls
 */
export interface DefaultCooldownStore {
    /**
     * Reserve `input.key` for `input.durationMs` and return a claim immediately or through a promise.
     * May return a Result to report ConfigurationError. Malformed claims also fail dispatch with ConfigurationError.
     * Only `CooldownAcquired` permits the handler to run. Other claims call optional rejection feedback, without waiting or retrying.
     * Throws, rejected promises and errors returned in a Result use subscription error reporting
     */
    claim(
        input: CommandCooldownRequest,
    ):
        | CommandCooldownClaim
        | Result<CommandCooldownClaim, ConfigurationError>
        | Promise<CommandCooldownClaim | Result<CommandCooldownClaim, ConfigurationError>>
}

/**
 * Limit how often a known command executes for each selected key.
 * Claimed after its guard and argument conversion succeed, immediately before execution.
 * The router does not release an acquired claim after handler failure or cancellation
 */
export interface DefaultPrefixCommandCooldown<S extends CommandArgumentSchema = {}, M extends MessageCore = Message> {
    /** Store whose `claim` performs the reservation. The built-in memory store coordinates only callers sharing that store in one process */
    readonly store: DefaultCooldownStore
    /** Whole milliseconds per reservation, from 1 through 2,147,483,647 */
    readonly durationMs: number
    /**
     * Return a nonempty key suffix from the converted execution context, defaulting to the invoking author's ID.
     * The router adds the command's canonical name or full group path, so aliases share a reservation and different groups remain separate.
     * Sharing a store between routers also shares claims for matching command identities and suffixes
     */
    readonly key?: (context: DefaultPrefixCommandExecutionContext<S, M>) => string
}

/**
 * A command name and the application callback that handles it.
 * Dispatch runs the optional guard, converts arguments, claims any cooldown and then calls `execute`.
 * Registration copies metadata and arguments but retains callback and cooldown-store references.
 * No automatic message, retry or interpretation of successful handler return values is provided
 */
export interface DefaultPrefixCommand<
    S extends CommandArgumentSchema = {},
    M extends MessageCore = Message,
> extends PrefixCommandDefinition {
    /** Named positional conversions, read in property order. Omitted leaves `args` unrestricted and `values` empty */
    readonly arguments?: S
    /**
     * Return true, or a promise of true, to allow this command. Omitted means allow it.
     * Runs before argument conversion with raw context only.
     * False skips conversion, cooldown and execution, then calls optional `onReject` without an automatic response.
     * Each command owns its policy, with no inherited group guard or permission from help visibility.
     * Throws, rejected promises and non-boolean results use subscription error reporting rather than rejection feedback
     */
    readonly guard?: (context: DefaultPrefixCommandContext<M>) => boolean | Promise<boolean>
    /**
     * Provide your own feedback after a false guard, rejected arguments or a denied cooldown claim.
     * Receives raw context and a safe rejection classification, not partially converted values.
     * Return normally or await your work in a promise. Throws and rejected promises use attachment error reporting, without retry
     */
    readonly onReject?: (
        context: DefaultPrefixCommandContext<M>,
        rejection: PrefixCommandRejection,
    ) => void | Promise<void>
    /** Optional reservation required after the guard and arguments succeed. A denied claim skips execution */
    readonly cooldown?: DefaultPrefixCommandCooldown<S, M>
    /**
     * Perform application work after the command is allowed and all arguments convert.
     * Return normally or a promise completing that work. Successful values are discarded, not sent as replies.
     * Inspect Results from client operations yourself, since returning an Err value does not reject this callback.
     * Throws or rejected promises use attachment `onError` reporting, with no automatic retry or cooldown rollback.
     * Pass `context.signal` to cancellable operations when your work should stop with the subscription
     */
    readonly execute: (context: DefaultPrefixCommandExecutionContext<S, M>) => void | Promise<void>
}

type DefaultPrefixCommandBatch<
    M extends MessageCore,
    S extends Readonly<Record<string, CommandArgumentSchema | undefined>>,
> = {
    readonly [K in keyof S]: Omit<
        DefaultPrefixCommand<S[K] extends CommandArgumentSchema ? S[K] : {}, M>,
        "name" | "arguments"
    > & { readonly arguments: S[K] }
}

/**
 * In-memory cooldown reservations for one process, bounded by a key limit.
 * Share this instance across commands that should use the same store.
 * Uses `Date.now()` expiry times, with no persistence, background timer or cross-process coordination
 */
export interface MemoryCooldownStore {
    /** Maximum keys this store retains, fixed at creation */
    readonly maxEntries: number
    /** Current stored-key count. May include expired keys until a claim or explicit sweep removes them */
    readonly size: number
    /**
     * Sweep expired keys, then atomically reserve the requested key or report an active cooldown or full store.
     * Acquired expiry is `Date.now() + durationMs`. Full stores preserve existing active reservations.
     * Returns Err(ConfigurationError) for malformed keys or durations. Unexpected getter defects throw a safe SdkDefect for `commands`
     */
    claim(input: CommandCooldownRequest): Result<CommandCooldownClaim, ConfigurationError>
    /** Remove keys expired according to `Date.now()` and return the number removed, without changing active reservations */
    sweep(): number
    /** Forget this store's reservations immediately, allowing new claims. Does not cancel handlers or clear other store instances */
    clear(): void
}

/**
 * Immutable set of registered commands and groups that you can attach to a client.
 * `register` and `registerGroup` return new routers, so use the returned value for subsequent registrations and attachment.
 * Older routers and their active attachments keep the definitions they already had
 */
export interface DefaultPrefixCommandRouter<M extends MessageCore = Message> {
    /** Frozen executable-command metadata in registration order across groups, without callbacks or resource candidates. Grouped entries include canonical paths */
    readonly commands: readonly PrefixCommandMetadata[]
    /** Frozen groups in registration order, including empty groups. These names organize lookup and help, not permission checks */
    readonly groups: readonly PrefixCommandGroupMetadata[]
    /**
     * Build frozen help-text pages locally, for example `router.help({ prefix: "!", maxLength: 2000 })`
     *
     * Root help lists immediate commands and groups in sibling registration order.
     * Selecting a canonical group shows that group and its immediate children, including empty groups, unless an ancestor is hidden.
     * Entries show full canonical invocation paths, aliases and descriptions, with `(Group)` marking groups
     *
     * Arguments generate `<required>`, `[optional]` and `<rest...>` or `[rest...]` syntax unless explicit `usage` overrides it.
     * No schema means no inferred argument syntax, and an explicit empty usage suppresses it.
     * Empty or hidden selections return `[]`. Nothing is sent, and no prefix resolver, guard, cooldown or handler runs
     *
     * Pages respect the explicit UTF-16 length limit and do not split surrogate pairs, but may split visible character clusters or Markdown.
     * Page-edge whitespace is trimmed and empty pages are removed, so joining pages is not a lossless reconstruction.
     * You own page selection, sending and mention handling
     *
     * Malformed options, ill-formed text, too-small limits and invalid visibility callbacks return Err(ConfigurationError).
     * Unexpected option getter defects throw a safe SdkDefect for `commands`, without their private value
     */
    help(options: CommandHelpOptions): Result<readonly string[], ConfigurationError>
    /**
     * Validate and add one executable command to a new router, at root unless `options.group` selects an existing canonical parent.
     * Copies metadata and arguments while retaining callbacks and the cooldown store.
     * Names and aliases must not collide with sibling commands or groups under the router's case policy.
     * Returns Err(ConfigurationError) for invalid definitions, collisions or missing and alias-only parent paths.
     * Unexpected getter defects throw a safe SdkDefect for `commands`. The original router and its attachments are unchanged
     */
    register<const S extends CommandArgumentSchema = {}>(
        command: DefaultPrefixCommand<S, M>,
        options?: PrefixCommandRegistrationOptions,
    ): Result<DefaultPrefixCommandRouter<M>, ConfigurationError>
    /**
     * Validate and add a nonempty keyed command object to one new router, in JavaScript own enumerable string-key order and under the same optional parent group.
     * Each object key supplies its command name. Set `arguments: {}` to reject positional arguments, or `arguments: undefined` to leave raw args unrestricted.
     * Every definition is snapshotted before registration. Inherited batch keys are ignored.
     * Recognized fields inside each definition are read once, including inherited and non-enumerable fields.
     * If any definition is invalid or any name collides, the whole call returns
     * Err(ConfigurationError), without a partially registered router or changes to this router and its attachments.
     * The optional parent is validated and snapshotted once for the whole batch. Unexpected getter defects throw a safe SdkDefect for `commands`.
     * Each entry retains its own inferred argument-value type
     */
    registerMany<const S extends Readonly<Record<string, CommandArgumentSchema | undefined>>>(
        commands: DefaultPrefixCommandBatch<M, S>,
        options?: PrefixCommandRegistrationOptions,
    ): Result<DefaultPrefixCommandRouter<M>, ConfigurationError>
    /**
     * Add a named group to a new router, at root or beneath an existing canonical `options.group` path.
     * Register parents before children. Groups accept identity and description only, with no handler, schema, guard or cooldown.
     * At dispatch, group names and aliases are consumed using whitespace separators before the command parser runs.
     * Invalid metadata, missing parents or sibling name collisions return Err(ConfigurationError).
     * Unexpected getter defects throw a safe SdkDefect for `commands`. No callback runs and older routers remain unchanged
     */
    registerGroup(
        group: PrefixCommandGroupDefinition,
        options?: PrefixCommandRegistrationOptions,
    ): Result<DefaultPrefixCommandRouter<M>, ConfigurationError>
    /**
     * Subscribe this router to `messageCreate` through the client's existing bounded event system.
     * Returns a Subscription or registration error immediately, without connecting the client or creating another queue.
     * Subscription options control scheduling and safe `onError` reports for callback failures.
     * Each attachment dispatches independently, so attaching twice can run the same command twice.
     * Call `subscription.unsubscribe()` to detach it and signal cancellation, without shutting down the client.
     * `subscription.waitForClose()` observes SDK cleanup, not completion of arbitrary application promises.
     * Cancellation prevents later dispatch stages but cannot forcibly stop application promises already running.
     * The client must have this router's message type `M`. A full-message router cannot attach to a client with omitted fields
     */
    attach(client: Client<M>, options?: EventHandlerOptions): Result<Subscription, RegistrationError>
}

/**
 * Recognize message commands such as `!repeat hello` with the default API's optional `commands` tools.
 * Create a router, keep the new router returned by each registration and attach the final router to your client.
 * Construction is local, with no connection or subscription until you explicitly attach
 */
export interface DefaultCommands {
    /**
     * Create an empty router, for example `commands.create({ prefix: "!", parse: commands.parseQuoted })`.
     * Defaults to full Message typing. Supply the client's MessageCore or SelectedMessage type as `M` when it selects fewer fields.
     * Prefix resolvers, parsers, command callbacks and their context client keep that same message type.
     * Returns Err(ConfigurationError) for invalid options, without including rejected prefix or parser values.
     * Unexpected getter defects throw a safe SdkDefect for `commands`. No client connects and no feedback callback runs during creation
     */
    create<M extends MessageCore = Message>(
        options: DefaultPrefixCommandsOptions<M>,
    ): Result<DefaultPrefixCommandRouter<M>, ConfigurationError>
    /**
     * Split a suffix using single or double quotes and backslash escapes, retaining original argument text in `rawArgs`.
     * Use as `create({ prefix: "!", parse: commands.parseQuoted })` to opt in instead of the whitespace-only default.
     * Returns undefined for empty input, invalid names, unclosed quotes or trailing escapes. Empty quotes produce an empty token.
     * Runs synchronously without client or network work
     */
    parseQuoted<M extends MessageCore = Message>(input: PrefixCommandParseInput<M>): PrefixCommandParse | undefined
    /**
     * Create an empty in-memory cooldown store with a default limit of 1,024 keys.
     * An optional positive safe integer `maxEntries` changes that limit.
     * Returns Err(ConfigurationError) for invalid options. Unexpected getters throw a safe SdkDefect for `commands`.
     * The store has no timer or persistence. Reuse it in command cooldown definitions and clear it explicitly to forget claims
     */
    memoryCooldowns(options?: MemoryCooldownOptions): Result<MemoryCooldownStore, ConfigurationError>
}

/** Default-API command tools exposed through the public `commands` namespace, with immediate Result-based creation and registration */
export const defaultCommands: DefaultCommands = Object.freeze({
    create: <M extends MessageCore = Message>(options: DefaultPrefixCommandsOptions<M>) =>
        attempt(() =>
            freezeRouter(
                new DefaultPrefixCommandRouterOwner(
                    new PrefixCommandRegistry<StoredDefaultCommand<M>, M>(options),
                    snapshotDefaultOnUnmatched(options.onUnmatched),
                ),
            ),
        ),
    parseQuoted: parseQuotedPrefixCommand,
    memoryCooldowns: (options: MemoryCooldownOptions | undefined) =>
        attempt(() => defaultMemoryCooldownStore(createMemoryCooldownStore(options))),
})

interface StoredDefaultCommand<M extends MessageCore> extends PrefixCommandDefinition {
    readonly guard?: (context: DefaultPrefixCommandContext<M>) => boolean | Promise<boolean>
    readonly onReject?: (
        context: DefaultPrefixCommandContext<M>,
        rejection: PrefixCommandRejection,
    ) => void | Promise<void>
    readonly cooldown?: DefaultPrefixCommandCooldown<CommandArgumentSchema, M>
    readonly execute: (context: DefaultPrefixCommandExecutionContext<CommandArgumentSchema, M>) => void | Promise<void>
}

class DefaultPrefixCommandRouterOwner<M extends MessageCore> implements DefaultPrefixCommandRouter<M> {
    readonly #registry: PrefixCommandRegistry<StoredDefaultCommand<M>, M>
    readonly #onUnmatched?: DefaultPrefixCommandsOptions<M>["onUnmatched"]

    constructor(
        registry: PrefixCommandRegistry<StoredDefaultCommand<M>, M>,
        onUnmatched?: DefaultPrefixCommandsOptions<M>["onUnmatched"],
    ) {
        this.#registry = registry
        this.#onUnmatched = onUnmatched
    }

    get commands(): readonly PrefixCommandMetadata[] {
        return this.#registry.commands
    }

    get groups(): readonly PrefixCommandGroupMetadata[] {
        return this.#registry.groups
    }

    help(options: CommandHelpOptions): Result<readonly string[], ConfigurationError> {
        return attempt(() => commandHelp(this.#registry.entries, options))
    }

    register<const S extends CommandArgumentSchema = {}>(
        command: DefaultPrefixCommand<S, M>,
        options?: PrefixCommandRegistrationOptions,
    ): Result<DefaultPrefixCommandRouter<M>, ConfigurationError> {
        return attempt(() =>
            freezeRouter(
                new DefaultPrefixCommandRouterOwner(
                    this.#registry.register(snapshotDefaultCommand(command), options),
                    this.#onUnmatched,
                ),
            ),
        )
    }

    registerMany<const S extends Readonly<Record<string, CommandArgumentSchema | undefined>>>(
        commands: DefaultPrefixCommandBatch<M, S>,
        options?: PrefixCommandRegistrationOptions,
    ): Result<DefaultPrefixCommandRouter<M>, ConfigurationError> {
        return attempt(() => {
            const stored = snapshotDefaultCommandBatch(commands)
            return freezeRouter(
                new DefaultPrefixCommandRouterOwner(this.#registry.registerMany(stored, options), this.#onUnmatched),
            )
        })
    }

    registerGroup(
        group: PrefixCommandGroupDefinition,
        options?: PrefixCommandRegistrationOptions,
    ): Result<DefaultPrefixCommandRouter<M>, ConfigurationError> {
        return attempt(() =>
            freezeRouter(
                new DefaultPrefixCommandRouterOwner(this.#registry.registerGroup(group, options), this.#onUnmatched),
            ),
        )
    }

    attach(client: Client<M>, options?: EventHandlerOptions): Result<Subscription, RegistrationError> {
        return client.on("messageCreate", (message, signal) => this.dispatch(client, message, signal), options)
    }

    private dispatch(client: Client<M>, message: M, signal: NonNullable<OperationOptions["signal"]>): Promise<void> {
        const operation = dispatchCommand(this.#registry, message, {
            context: (match) =>
                Object.freeze({
                    client,
                    message,
                    prefix: match.prefix,
                    name: match.definition.name,
                    ...(match.path === undefined ? {} : { path: match.path }),
                    args: Object.freeze([...match.parse.args]),
                    rawArgs: match.parse.rawArgs,
                    signal,
                    reply: boundDefaultReply(client, message, signal),
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
                    : defaultCallback(() =>
                          this.#onUnmatched!(
                              Object.freeze({
                                  client,
                                  message,
                                  prefix: match.prefix,
                                  signal,
                                  reply: boundDefaultReply(client, message, signal),
                              }),
                              match.unmatched,
                          ),
                      ),
            guard: (definition, context) =>
                definition.guard === undefined
                    ? Effect.succeed(true)
                    : defaultCallback(() => definition.guard!(context)),
            reject: (definition, context, rejection) =>
                definition.onReject === undefined
                    ? Effect.void
                    : defaultCallback(() => definition.onReject!(context, rejection)),
            cooldown: (definition, context) =>
                definition.cooldown === undefined
                    ? Effect.succeed({ _tag: "CooldownAcquired", retryAtMs: Number.MAX_SAFE_INTEGER })
                    : defaultCooldown(definition, context),
            execute: (definition, context) => defaultCallback(() => definition.execute(context)),
            active: () => !signal.aborted,
        })
        if (signal.aborted) return Promise.resolve()
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal.addEventListener("abort", abort, { once: true })
        return Effect.runPromise(operation, { signal: controller.signal })
            .catch((error: unknown) => {
                if (signal.aborted) return
                throw error
            })
            .finally(() => signal.removeEventListener("abort", abort))
    }
}

function snapshotDefaultOnUnmatched<M extends MessageCore>(
    value: DefaultPrefixCommandsOptions<M>["onUnmatched"],
): DefaultPrefixCommandsOptions<M>["onUnmatched"] {
    if (value !== undefined && typeof value !== "function")
        throw new ConfigurationError("commands", "onUnmatched must be a function when supplied")
    return value
}

function snapshotDefaultCommand<S extends CommandArgumentSchema, M extends MessageCore>(
    command: DefaultPrefixCommand<S, M>,
    keyedName?: string,
): StoredDefaultCommand<M> {
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
        execute: execute as StoredDefaultCommand<M>["execute"],
        ...(guard === undefined ? {} : { guard }),
        ...(onReject === undefined ? {} : { onReject }),
        ...(cooldown === undefined
            ? {}
            : {
                  cooldown: Object.freeze({
                      store: cooldown.store,
                      durationMs: cooldown.durationMs,
                      ...(cooldown.key === undefined
                          ? {}
                          : { key: cooldown.key as NonNullable<StoredDefaultCommand<M>["cooldown"]>["key"] }),
                  }),
              }),
    }) as unknown as StoredDefaultCommand<M>
}

function snapshotDefaultCommandBatch<M extends MessageCore>(
    commands: Readonly<Record<string, unknown>>,
): readonly StoredDefaultCommand<M>[] {
    if (typeof commands !== "object" || commands === null || Array.isArray(commands))
        throw new ConfigurationError("command", "A command batch must be an object")
    for (const key of Reflect.ownKeys(commands))
        if (typeof key === "symbol" && Object.prototype.propertyIsEnumerable.call(commands, key))
            throw new ConfigurationError("command", "Command batch keys must be strings")
    const names = Object.keys(commands)
    if (names.length === 0) throw new ConfigurationError("command", "A command batch must not be empty")
    const stored: StoredDefaultCommand<M>[] = []
    for (const name of names) {
        const value = commands[name]
        if (typeof value !== "object" || value === null || Array.isArray(value))
            throw new ConfigurationError("command", "A command batch entry must be an object")
        if (Object.prototype.hasOwnProperty.call(value, "name"))
            throw new ConfigurationError("command", "A command batch entry must use its object key as the name")
        stored.push(snapshotDefaultCommand(value as DefaultPrefixCommand<CommandArgumentSchema, M>, name))
    }
    return Object.freeze(stored)
}

function boundDefaultReply<M extends MessageCore>(
    client: Client<M>,
    message: M,
    signal: NonNullable<OperationOptions["signal"]>,
): DefaultPrefixCommandContext<M>["reply"] {
    return (input, options) => client.messages.reply(message, input, bindDefaultReplyOptions(options, signal))
}

function bindDefaultReplyOptions(
    options: SendOptions | undefined,
    signal: NonNullable<OperationOptions["signal"]>,
): DefaultSendOptions {
    if (options === undefined) return { signal }
    if (typeof options !== "object" || options === null || Array.isArray(options)) return options as DefaultSendOptions
    // Bind cancellation without reading getters before the operation's async validation and defect boundary
    return new Proxy(Object.create(null) as DefaultSendOptions, {
        get: (_target, property) => (property === "signal" ? signal : Reflect.get(options, property, options)),
        ownKeys: () => Reflect.ownKeys(options),
        getOwnPropertyDescriptor: (_target, property) => {
            const descriptor = Reflect.getOwnPropertyDescriptor(options, property)
            return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
        },
    })
}

function defaultCooldown<M extends MessageCore>(
    definition: StoredDefaultCommand<M>,
    context: DefaultPrefixCommandExecutionContext<CommandArgumentSchema, M>,
): Effect.Effect<CommandCooldownClaim, ConfigurationError> {
    const cooldown = definition.cooldown
    if (cooldown === undefined) return Effect.succeed({ _tag: "CooldownAcquired", retryAtMs: Number.MAX_SAFE_INTEGER })
    return defaultCallback(() => cooldown.key?.(context) ?? context.message.author.id).pipe(
        Effect.flatMap((key) =>
            configurationEffect(() => cooldownRequest(context.path ?? definition.name, key, cooldown.durationMs)),
        ),
        Effect.flatMap((request) => defaultCallback(() => cooldown.store.claim(request))),
        Effect.flatMap((claim) =>
            isResult(claim)
                ? claim.isOk()
                    ? Effect.succeed(claim.value)
                    : Effect.fail(claim.error)
                : Effect.succeed(claim),
        ),
    )
}

function defaultMemoryCooldownStore(owner: LocalMemoryCooldownStore): MemoryCooldownStore {
    return Object.freeze({
        maxEntries: owner.maxEntries,
        get size() {
            return owner.size
        },
        claim: (input: CommandCooldownRequest) => {
            const result = attempt(() => owner.claim(input))
            if (result.isErr()) return err(result.error)
            return result.value._tag === "Success" ? ok(result.value.value) : err(result.value.error)
        },
        sweep: () => owner.sweep(),
        clear: () => owner.clear(),
    })
}

function freezeRouter<M extends MessageCore>(
    router: DefaultPrefixCommandRouterOwner<M>,
): DefaultPrefixCommandRouter<M> {
    return Object.freeze(router)
}

function defaultCallback<A>(callback: () => A | Promise<A>): Effect.Effect<A> {
    return Effect.tryPromise({
        try: () => Promise.resolve().then(callback),
        catch: (error): never => {
            throw error
        },
    })
}

function isResult(value: unknown): value is Result<CommandCooldownClaim, ConfigurationError> {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { isOk?: unknown }).isOk === "function" &&
        typeof (value as { isErr?: unknown }).isErr === "function"
    )
}

function attempt<A>(create: () => A): Result<A, ConfigurationError> {
    try {
        return ok(create())
    } catch (error) {
        if (error instanceof ConfigurationError) return err(error)
        throw new SdkDefect("commands", [{ kind: "Defect" }])
    }
}
