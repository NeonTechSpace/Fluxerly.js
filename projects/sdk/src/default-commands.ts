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
import type { OperationOptions } from "#sdk/client"
import { ConfigurationError, SdkDefect } from "#sdk/errors"
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
import { Effect } from "effect"
import { err, ok, type Result } from "neverthrow"
import type { Client, EventHandlerOptions, Subscription } from "./index.js"

/** Context retained only for one default prefix-command guard and handler invocation */
export interface DefaultPrefixCommandContext {
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
    /** Cooperative subscription signal. It cannot forcibly stop application promises */
    readonly signal: NonNullable<OperationOptions["signal"]>
}

/** Context passed to execute and cooldown key callbacks after successful local argument conversion */
export interface DefaultPrefixCommandExecutionContext<
    S extends CommandArgumentSchema = {},
> extends DefaultPrefixCommandContext {
    /** Frozen values converted from this command's own schema. Guards receive raw context before conversion and rejection callbacks never receive partially converted values */
    readonly values: CommandArgumentValues<S>
}

/** Context retained only for one default unmatched-command callback invocation */
export interface DefaultPrefixCommandUnmatchedContext {
    /** Attached client. The router never connects, runs or shuts it down */
    readonly client: Client
    /** Frozen gateway message selected by the client subscription */
    readonly message: Message
    /** Exact prefix matched before the parser declined or lookup missed */
    readonly prefix: string
    /** Cooperative subscription signal. It cannot forcibly stop application promises */
    readonly signal: NonNullable<OperationOptions["signal"]>
}

/** Default router construction options, including application-owned feedback for matched prefixes with no runnable command */
export interface DefaultPrefixCommandsOptions extends PrefixCommandsOptions {
    /** Optional feedback after the parser declines or returns an unregistered name. The router never sends a response, retries this callback or invokes it for ignored bots or unmatched prefixes */
    readonly onUnmatched?: (
        context: DefaultPrefixCommandUnmatchedContext,
        unmatched: PrefixCommandUnmatched,
    ) => void | Promise<void>
}

/** Caller-owned default cooldown storage. Claims must be atomic within whichever scope the store represents */
export interface DefaultCooldownStore {
    /** Return a claim now or after caller-owned asynchronous storage work */
    claim(
        input: CommandCooldownRequest,
    ):
        | CommandCooldownClaim
        | Result<CommandCooldownClaim, ConfigurationError>
        | Promise<CommandCooldownClaim | Result<CommandCooldownClaim, ConfigurationError>>
}

/** Optional command cooldown. A successful claim is retained even when a later handler failure occurs */
export interface DefaultPrefixCommandCooldown<S extends CommandArgumentSchema = {}> {
    /** Caller-owned store. The built-in memory store is bounded and process-local only */
    readonly store: DefaultCooldownStore
    /** Positive duration in milliseconds, capped at 2,147,483,647 */
    readonly durationMs: number
    /** Per-command key suffix. Defaults to the invoking author ID. The router namespaces it by canonical command name */
    readonly key?: (context: DefaultPrefixCommandExecutionContext<S>) => string
}

/** One default prefix command. The router snapshots metadata and retains only its guard, onReject, execute, cooldown key and store references. It neither interprets handler return values nor sends automatic responses */
export interface DefaultPrefixCommand<S extends CommandArgumentSchema = {}> extends PrefixCommandDefinition {
    /** Optional registration-ordered local conversion schema */
    readonly arguments?: S
    /** Optional authorization or policy decision. False skips cooldown and execution without an automatic response, while onReject can provide application-owned feedback */
    readonly guard?: (context: DefaultPrefixCommandContext) => boolean | Promise<boolean>
    /** Optional feedback after a false guard, argument conversion rejection or rejected cooldown. It receives raw context without partial values and failures use the attached subscription’s safe error reporting without retry */
    readonly onReject?: (
        context: DefaultPrefixCommandContext,
        rejection: PrefixCommandRejection,
    ) => void | Promise<void>
    /** Optional admission limit acquired after a successful guard and argument conversion, before execution */
    readonly cooldown?: DefaultPrefixCommandCooldown<S>
    /** Application work for a matched, allowed command. Rejection is reported by the attached subscription without retry */
    readonly execute: (context: DefaultPrefixCommandExecutionContext<S>) => void | Promise<void>
}

/** Bounded process-local cooldown storage for the default entry point */
export interface MemoryCooldownStore {
    /** Configured upper bound for retained keys */
    readonly maxEntries: number
    /** Current retained key count, including expired keys not yet swept */
    readonly size: number
    /** Atomically acquire or observe one process-local cooldown, or return ConfigurationError for malformed input. Unexpected input getter defects throw safe SdkDefect commands */
    claim(input: CommandCooldownRequest): Result<CommandCooldownClaim, ConfigurationError>
    /** Remove expired entries now and return how many were released */
    sweep(): number
    /** Remove every retained key. This does not cancel handlers or affect another store */
    clear(): void
}

/** Registered default commands. Register returns a new immutable router snapshot */
export interface DefaultPrefixCommandRouter {
    /** Frozen registration-order metadata containing identity, help text and safe argument signatures, without resource candidates or callbacks */
    readonly commands: readonly PrefixCommandMetadata[]
    /**
     * Generate frozen text pages from this router snapshot, without attaching, sending or running guards, cooldowns or handlers.
     * Uses the explicit display prefix and registration order, then aliases and description. Explicit usage overrides generated schema syntax, including an empty usage string.
     * Schema syntax is `<required>`, `[optional]` and a trailing `...` inside the brackets for rest arguments. No schema means no inferred arguments
     *
     * Empty selection returns []. Page lengths use UTF-16 code units and never split a surrogate pair, but may split graphemes or Markdown.
     * Page-edge whitespace is trimmed and empty pages are omitted for message delivery. Pages are not a lossless serialization of metadata.
     * The caller owns page selection, sending and mention intent
     *
     * Malformed options, ill-formed text, an insufficient page ceiling or an invalid include callback fail with ConfigurationError without private input.
     * Unexpected option getter defects throw safe SdkDefect commands
     */
    help(options: CommandHelpOptions): Result<readonly string[], ConfigurationError>
    /** Validate and add one command to a separate router snapshot. Existing routers and attachments stay unchanged */
    register<const S extends CommandArgumentSchema = {}>(
        command: DefaultPrefixCommand<S>,
    ): Result<DefaultPrefixCommandRouter, ConfigurationError>
    /**
     * Register one existing bounded messageCreate subscription without connecting or starting a background queue.
     * Every attachment dispatches its router snapshot independently. Closing it releases the SDK subscription reference and signals callbacks, but cannot preempt a caller promise
     */
    attach(client: Client, options?: EventHandlerOptions): Result<Subscription, RegistrationError>
}

/** Default optional command tools. Construction is local and does not attach a subscription or connect a client */
export interface DefaultCommands {
    /** Create a local router or return ConfigurationError without rejected prefix/parser values. onUnmatched remains application-owned and receives no automatic response helper. Unexpected getter defects throw safe SdkDefect commands without the caller value */
    create(options: DefaultPrefixCommandsOptions): Result<DefaultPrefixCommandRouter, ConfigurationError>
    /** Parse quoted positional arguments without changing the router default parser. Unterminated quotes or trailing escapes return undefined for application policy */
    parseQuoted(input: PrefixCommandParseInput): PrefixCommandParse | undefined
    /** Create a bounded process-local cooldown store or return ConfigurationError for invalid options or claims */
    memoryCooldowns(options?: MemoryCooldownOptions): Result<MemoryCooldownStore, ConfigurationError>
}

/** Implementation shared by the default public namespace */
export const defaultCommands: DefaultCommands = Object.freeze({
    create: (options: DefaultPrefixCommandsOptions) =>
        attempt(() =>
            freezeRouter(
                new DefaultPrefixCommandRouterOwner(
                    new PrefixCommandRegistry(options),
                    snapshotDefaultOnUnmatched(options.onUnmatched),
                ),
            ),
        ),
    parseQuoted: parseQuotedPrefixCommand,
    memoryCooldowns: (options: MemoryCooldownOptions | undefined) =>
        attempt(() => defaultMemoryCooldownStore(createMemoryCooldownStore(options))),
})

interface StoredDefaultCommand extends PrefixCommandDefinition {
    readonly guard?: (context: DefaultPrefixCommandContext) => boolean | Promise<boolean>
    readonly onReject?: (
        context: DefaultPrefixCommandContext,
        rejection: PrefixCommandRejection,
    ) => void | Promise<void>
    readonly cooldown?: DefaultPrefixCommandCooldown<CommandArgumentSchema>
    readonly execute: (context: DefaultPrefixCommandExecutionContext<CommandArgumentSchema>) => void | Promise<void>
}

class DefaultPrefixCommandRouterOwner implements DefaultPrefixCommandRouter {
    readonly #registry: PrefixCommandRegistry<StoredDefaultCommand>
    readonly #onUnmatched?: DefaultPrefixCommandsOptions["onUnmatched"]

    constructor(
        registry: PrefixCommandRegistry<StoredDefaultCommand>,
        onUnmatched?: DefaultPrefixCommandsOptions["onUnmatched"],
    ) {
        this.#registry = registry
        this.#onUnmatched = onUnmatched
    }

    get commands(): readonly PrefixCommandMetadata[] {
        return this.#registry.commands
    }

    help(options: CommandHelpOptions): Result<readonly string[], ConfigurationError> {
        return attempt(() => commandHelp(this.commands, options))
    }

    register<const S extends CommandArgumentSchema = {}>(
        command: DefaultPrefixCommand<S>,
    ): Result<DefaultPrefixCommandRouter, ConfigurationError> {
        return attempt(() =>
            freezeRouter(
                new DefaultPrefixCommandRouterOwner(
                    this.#registry.register(snapshotDefaultCommand(command)),
                    this.#onUnmatched,
                ),
            ),
        )
    }

    attach(client: Client, options?: EventHandlerOptions): Result<Subscription, RegistrationError> {
        return client.on("messageCreate", (message, signal) => this.dispatch(client, message, signal), options)
    }

    private dispatch(client: Client, message: Message, signal: NonNullable<OperationOptions["signal"]>): Promise<void> {
        const operation = dispatchCommand(this.#registry, message, {
            context: (match) =>
                Object.freeze({
                    client,
                    message,
                    prefix: match.prefix,
                    name: match.definition.name,
                    args: Object.freeze([...match.parse.args]),
                    rawArgs: match.parse.rawArgs,
                    signal,
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
                              Object.freeze({ client, message, prefix: match.prefix, signal }),
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

function snapshotDefaultOnUnmatched(
    value: DefaultPrefixCommandsOptions["onUnmatched"],
): DefaultPrefixCommandsOptions["onUnmatched"] {
    if (value !== undefined && typeof value !== "function")
        throw new ConfigurationError("commands", "onUnmatched must be a function when supplied")
    return value
}

function snapshotDefaultCommand<S extends CommandArgumentSchema>(
    command: DefaultPrefixCommand<S>,
): StoredDefaultCommand {
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
        execute: command.execute as StoredDefaultCommand["execute"],
        ...(argumentsSchema === undefined ? {} : { arguments: argumentsSchema }),
        ...(command.guard === undefined ? {} : { guard: command.guard }),
        ...(command.onReject === undefined ? {} : { onReject: command.onReject }),
        ...(cooldown === undefined
            ? {}
            : {
                  cooldown: Object.freeze({
                      store: cooldown.store,
                      durationMs: cooldown.durationMs,
                      ...(cooldown.key === undefined
                          ? {}
                          : { key: cooldown.key as NonNullable<StoredDefaultCommand["cooldown"]>["key"] }),
                  }),
              }),
    }) as unknown as StoredDefaultCommand
}

function defaultCooldown(
    definition: StoredDefaultCommand,
    context: DefaultPrefixCommandExecutionContext<CommandArgumentSchema>,
): Effect.Effect<CommandCooldownClaim, ConfigurationError> {
    const cooldown = definition.cooldown
    if (cooldown === undefined) return Effect.succeed({ _tag: "CooldownAcquired", retryAtMs: Number.MAX_SAFE_INTEGER })
    return defaultCallback(() => cooldown.key?.(context) ?? context.message.author.id).pipe(
        Effect.flatMap((key) => configurationEffect(() => cooldownRequest(definition.name, key, cooldown.durationMs))),
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

function freezeRouter(router: DefaultPrefixCommandRouterOwner): DefaultPrefixCommandRouter {
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
