import { readCaller, thrownReason } from "#sdk/internal/defects"
import type {
    CommandCooldownClaim,
    CommandCooldownPer,
    CommandCooldownRequest,
    MemoryCooldownOptions,
    PrefixCommandDefinition,
    PrefixCommandGroupDefinition,
    PrefixCommandGroupMetadata,
    PrefixCommandGuardResult,
    PrefixCommandMetadata,
    PrefixCommandParse,
    PrefixCommandParseInput,
    PrefixCommandRejection,
    PrefixCommandRegistrationOptions,
    PrefixCommandUnmatched,
    PrefixCommandsOptions,
} from "#sdk/commands"
import type { CommandArgumentDescriptor, CommandArgumentSchema, CommandArgumentValues } from "#sdk/command-arguments"
import type { CommandContextHelpOptions, CommandHelpOptions } from "#sdk/command-help"
import { commandHelp, contextHelpOptions } from "#sdk/internal/command-help"
import { parseQuotedPrefixCommand } from "#sdk/commands"
import { ApplicationError, CancelledError, ConfigurationError, SdkDefect } from "#sdk/errors"
import {
    configurationEffect,
    cooldownRequest,
    cooldownSuffix,
    createMemoryCooldownStore,
    snapshotClaimInput,
    dispatchCommand,
    type LocalMemoryCooldownStore,
    PrefixCommandRegistry,
    rejectionReply,
    routerSubscriptionOptions,
    sameCommandPath,
    snapshotCommandDefinition,
    snapshotCommandCooldown,
    validateCommandShape,
    checkBotCommandKeys,
} from "#sdk/internal/commands"
import { convertCommandArguments } from "#sdk/internal/command-arguments"
import type { SendError } from "#sdk/message-errors"
import type { DefaultSendOptions, Message, MessageCore, ReplyInput, SendOptions } from "#sdk/messages"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { clientServices, type ClientServices } from "#sdk/internal/client-registry"
import { makeReport, messageReference, primaryError, promiseHook, throwIfErr } from "#sdk/internal/failures"
import {
    currentRejectionScope,
    fiberRejectionScope,
    inRejectionScope,
    withRejectionScope,
} from "#sdk/internal/rejection-scope"
import type { ClientLogger } from "#sdk/internal/logging"
import { recordCommandFailure } from "#sdk/internal/events"
import { errAsync, type ResultAsync } from "neverthrow"
import { askerPageOptions } from "#sdk/internal/reaction-pages"
import type { DefaultPaginateOptions, PageInput, PaginateFailure, PaginateResult } from "#sdk/reaction-pages"
import type { Client, EventHandlerOptions, FailureReport, Subscription } from "./index.js"

/**
 * Frozen command information copied for a matched message and passed to its guards, middleware and rejection callback.
 * Includes the incoming message and parsed strings, but not converted argument values.
 * Execution and cooldown-key callbacks receive the extended execution context
 *
 * @category Commands
 */
export interface DefaultPrefixCommandContext<M extends MessageCore = Message> {
    /** Client supplied to `attach`, available for explicit operations. The application remains responsible for connecting and shutting it down */
    readonly client: Client<M>
    /** Incoming frozen message with this client's selected fields. The router does not fetch excluded fields */
    readonly message: M
    /** Prefix that matched this message, such as `!`, `!!` or the bot mention when mentionPrefix is enabled */
    readonly prefix: string
    /** Registered command name, even when the message used an alias or different letter case */
    readonly name: string
    /** Frozen registered names through this command, such as `["admin", "inspect"]`. Absent for root commands and does not imply permission */
    readonly path?: readonly string[]
    /** Parsed string tokens copied to a frozen array, unchanged by subsequent argument conversion */
    readonly args: readonly string[]
    /** Argument text from the parser. The default retains everything after command-name separator whitespace, including trailing whitespace */
    readonly rawArgs: string
    /** Subscription cancellation signal for operations that support it. Cancellation prevents later router callbacks but cannot forcibly stop pending application promises */
    readonly signal: AbortSignal
    /**
     * Reply to the incoming message through the attached client, with this handler's cancellation signal already applied.
     * A string is sent as the reply's content, such as `reply("Pong")`.
     * Delegates to `client.messages.reply`, including its validation, deadline, nonce, retry, cache and defect behavior.
     * Cancellation or a lost response can leave the reply posted. An Err does not always mean nothing was sent, and uncertain sends are not replayed.
     * Returning the result from a command callback reports an Err like a thrown error, so `({ reply }) => reply("Pong")` needs no further checks
     */
    readonly reply: (
        input: ReplyInput | string,
        options?: SendOptions,
    ) => ResultAsync<M, SendError | CancelledError | ConfigurationError>
    /**
     * Build help pages from the router that matched this command, for example `({ help, reply }) => reply(help()[0] ?? "No commands")`.
     * Takes the same settings as `router.help`, all optional: The prefix defaults to the one this message used and the
     * page length to 2,000 UTF-16 code units. Nothing is sent. Invalid settings throw ConfigurationError as `router.help` does
     */
    readonly help: (options?: CommandContextHelpOptions) => readonly string[]
    /**
     * Show several pages in this message's channel that the command's author flips with ◀ and ▶ reactions, such as `({ paginate }) => paginate(["First", "Second"])`.
     * Delegates to `client.messages.paginate` with users defaulting to this message's author and this handler's cancellation signal applied, combined with any supplied signal.
     * Pass users to let other people flip, such as `() => true` for anyone. The other options, defaults, permissions, cleanup and failures are those of `client.messages.paginate`.
     * The result settles when listening ends, so the handler stays active until then. Returning it from a command callback reports an Err like a thrown error
     */
    readonly paginate: (
        pages: readonly PageInput[],
        options?: DefaultPaginateOptions,
    ) => ResultAsync<PaginateResult<M>, PaginateFailure | CancelledError>
    /**
     * Send this router's help in this message's channel, such as `({ sendHelp }) => sendHelp()`.
     * Takes the same optional settings as `help`. One page is sent as a plain message, and several pages use `paginate`
     * with its defaults, so only the command's author can flip them.
     * Invalid settings, and help with no visible entries, return ConfigurationError without sending anything
     */
    readonly sendHelp: (
        options?: CommandContextHelpOptions,
    ) => ResultAsync<PaginateResult<M>, PaginateFailure | CancelledError>
}

/**
 * Matched-command context plus fully converted argument values, supplied to execution and cooldown-key callbacks
 *
 * @category Commands
 */
export interface DefaultPrefixCommandExecutionContext<
    S extends CommandArgumentSchema = {},
    M extends MessageCore = Message,
> extends DefaultPrefixCommandContext<M> {
    /** Frozen values keyed by schema names, such as `values.count`. Empty when no schema is supplied. Guards and rejection callbacks never receive partial values */
    readonly values: CommandArgumentValues<S>
}

/**
 * Frozen message and matched prefix for `onUnmatched`, when parsing or lookup did not select an executable command
 *
 * @category Commands
 */
export interface DefaultPrefixCommandUnmatchedContext<M extends MessageCore = Message> {
    /** Attached client available for explicit feedback. The router does not take ownership of its lifetime */
    readonly client: Client<M>
    /** Incoming frozen message with the attached client's selected fields only */
    readonly message: M
    /** Exact prefix selected before parsing declined, name lookup missed or a group needed a subcommand */
    readonly prefix: string
    /** Cancellation signal for cooperative feedback work. A promise that ignores it may keep running after the subscription closes */
    readonly signal: AbortSignal
    /**
     * Reply to the unmatched incoming message through the attached client, with this callback's cancellation signal already applied.
     * A string is sent as the reply's content.
     * Delegates to `client.messages.reply`, including its validation, deadline, nonce, retry, cache and defect behavior.
     * Cancellation or a lost response can leave the reply posted. An Err does not always mean nothing was sent, and uncertain sends are not replayed.
     * Returning the result from the callback reports an Err like a thrown error
     */
    readonly reply: (
        input: ReplyInput | string,
        options?: SendOptions,
    ) => ResultAsync<M, SendError | CancelledError | ConfigurationError>
}

/**
 * Decide whether a matched command may run, from raw context before argument conversion.
 * Return true to allow it, false to deny it silently, or `{ deny: "reason" }` to deny it with text that
 * `onReject: "reply"` sends. A promise of those values is awaited.
 * A false verdict is still counted, logged at Debug and passed to a custom onReject callback, but never sends an automatic reply.
 * The built-in `guards` cover common checks. Throws, rejected promises, Err results and other values use subscription error reporting
 *
 * @category Commands
 */
export type DefaultPrefixCommandGuard<M extends MessageCore = Message> = (
    context: DefaultPrefixCommandContext<M>,
) => PrefixCommandGuardResult | PromiseLike<PrefixCommandGuardResult>

/**
 * Run around every matched command of a router, in registration order, before its guards.
 * Call `next()` to continue and await it to observe completion. Not calling it stops the command, which is logged at Debug.
 * The rest of the chain runs at most once: Calling `next()` again, even concurrently, returns the first call's promise.
 * When the command fails, `next()` rejects with the command's own error, the same value its execute callback threw,
 * rejected with or returned in an Err
 *
 * A failure of the command is reported once with its command name, whatever the middleware does with the rejection.
 * Rethrowing that same error adds no second report. A different throw, rejection or returned Err from the middleware
 * is reported as a separate failure after the command's, also with the command name. Without a command failure, a
 * middleware failure is reported like a failed command and stops the command if `next()` was not called yet.
 * The command's failure is still reported when the subscription closes while the middleware is running
 *
 * @category Commands
 */
export type DefaultPrefixCommandMiddleware<M extends MessageCore = Message> = (
    context: DefaultPrefixCommandContext<M>,
    next: () => Promise<void>,
) => unknown

/**
 * Rejection feedback for a command: `"reply"` sends a short explanation, such as the missing argument and the command's
 * usage, the guard's deny reason or the cooldown's remaining time. `"silent"` sends nothing, and the rejection is still
 * logged at Debug. A guard returning false never sends an automatic reply, even with "reply" selected.
 * A function receives the context and rejection instead, including false guard denials
 *
 * So that repeated attempts do not make the bot repeat itself, `"reply"` answers an active cooldown key once until its
 * retry time, and a guard denial once per user and command every 5 seconds. Argument rejections are always answered.
 * A skipped reply is counted with the rejection and logged at Debug in the commands category.
 * A function is called for every rejection, so it can count attempts and apply its own limit, for example with `retryAtMs`
 *
 * @category Commands
 */
export type DefaultPrefixCommandRejectionFeedback<M extends MessageCore = Message> =
    "reply" | "silent" | ((context: DefaultPrefixCommandContext<M>, rejection: PrefixCommandRejection) => unknown)

/**
 * Prefix and parsing options, plus router-wide middleware, rejection feedback and optional feedback when a
 * command-like message has no executable match
 *
 * @category Commands
 */
export interface DefaultPrefixCommandsOptions<M extends MessageCore = Message> extends PrefixCommandsOptions<M> {
    /**
     * Handle parser declines, unknown names and groups without a subcommand, optionally sending feedback.
     * An unknown name carries a `suggestion` when a registered name is close.
     * Return normally or a promise that completes the work. The router does not interpret a successful return value or send a response.
     * Throws, rejected promises and returned Err results use the attachment's `onError` reporting, without retry.
     * Not called for ignored bots or messages without a matching prefix
     */
    readonly onUnmatched?: (
        context: DefaultPrefixCommandUnmatchedContext<M>,
        unmatched: PrefixCommandUnmatched,
    ) => unknown
    /**
     * Rejection feedback for commands that do not set their own `onReject`. Omit it to give no feedback, except in
     * runBot, which replies by default. Guards returning false never send an automatic reply
     */
    readonly onReject?: DefaultPrefixCommandRejectionFeedback<M>
    /** Middleware run around every matched command, in order. See DefaultPrefixCommandMiddleware */
    readonly use?: readonly DefaultPrefixCommandMiddleware<M>[]
}

/**
 * Storage that reserves a command cooldown and reports whether this invocation may execute.
 * A custom store must handle saving claims and sharing them across processes if needed.
 * Checking and reserving a full key must be atomic, so two concurrent calls cannot both claim the same key
 *
 * @category Commands
 */
export interface DefaultCooldownStore {
    /**
     * Reserve `input.key` for `input.durationMs` and return a claim immediately or through a promise.
     * Only `CooldownAcquired` permits the handler to run. Other claims give optional rejection feedback, without waiting or retrying.
     * Malformed claims, throws, rejected promises and returned Err results use subscription error reporting
     */
    claim(input: CommandCooldownRequest): CommandCooldownClaim | PromiseLike<CommandCooldownClaim>
}

/**
 * Limit how often a known command executes, per user by default.
 * Claimed after its guards and argument conversion succeed, immediately before execution.
 * The router does not release an acquired claim after handler failure or cancellation
 *
 * @category Commands
 */
export interface DefaultPrefixCommandCooldown<S extends CommandArgumentSchema = {}, M extends MessageCore = Message> {
    /** Whole milliseconds per reservation, from 1 through 2,147,483,647 */
    readonly durationMs: number
    /** Whose invocations share the cooldown: `user` (default), `channel` or `guild` */
    readonly per?: CommandCooldownPer
    /**
     * Store whose `claim` performs the reservation. Omit it to use the router's own memory store in this process, sized by
     * the router's `cooldowns` option and shared by every router derived from the same create
     */
    readonly store?: DefaultCooldownStore
    /**
     * Return a nonempty key suffix from the converted execution context, replacing the one selected by `per`.
     * The router adds the command's canonical name or full group path, so aliases share a reservation and different groups remain separate
     */
    readonly key?: (context: DefaultPrefixCommandExecutionContext<S, M>) => string
}

/**
 * A command name and the application callback that handles it.
 * Dispatch runs router middleware and the command's guards, converts arguments, claims any cooldown and then calls `execute`.
 * Registration copies metadata and arguments but retains callback and cooldown-store references.
 * No automatic message or retry is provided, and successful return values are ignored
 *
 * @category Commands
 */
export interface DefaultPrefixCommand<
    S extends CommandArgumentSchema = {},
    M extends MessageCore = Message,
> extends PrefixCommandDefinition {
    /** Named positional conversions, read in property order. Omitted leaves `args` unrestricted and `values` empty */
    readonly arguments?: S
    /**
     * One guard or a list of guards, run in order before argument conversion. The first that denies stops the command.
     * Each command owns its policy, with no inherited group guard or permission from help visibility
     */
    readonly guard?: DefaultPrefixCommandGuard<M> | readonly DefaultPrefixCommandGuard<M>[]
    /**
     * Feedback after a denied guard, rejected arguments or a denied cooldown claim, overriding the router's `onReject`.
     * A function receives raw context and a safe rejection classification, not partially converted values.
     * Throws, rejected promises and returned Err results use attachment error reporting, without retry
     */
    readonly onReject?: DefaultPrefixCommandRejectionFeedback<M>
    /** Optional reservation required after the guards and arguments succeed. A denied claim skips execution */
    readonly cooldown?: DefaultPrefixCommandCooldown<S, M>
    /**
     * Perform application work after the command is allowed and all arguments convert.
     * Return normally or a promise completing that work. A returned or resolved Err result is reported like a throw,
     * so `({ reply }) => reply("Pong")` reports a failed reply. Other successful values are ignored.
     * Throws, rejected promises and Err results use attachment `onError` reporting, with no automatic retry or cooldown rollback.
     * Pass `context.signal` to cancellable operations when application work should stop with the subscription
     */
    readonly execute: (context: DefaultPrefixCommandExecutionContext<S, M>) => unknown
}

/**
 * Commands keyed by name, as registerMany and the runBot commands option accept them. Each value defines one command without its name.
 * Omit `arguments` to leave raw args unrestricted, or set `arguments: {}` to reject positional arguments
 *
 * @category Commands
 */
export type DefaultPrefixCommandBatch<M extends MessageCore, S extends Readonly<Record<string, unknown>>> = {
    readonly [K in keyof S]: Omit<
        DefaultPrefixCommand<S[K] extends CommandArgumentSchema ? S[K] : {}, M>,
        "name" | "arguments"
    > & {
        /** Argument schema for the command under this key. Omit it to leave positional arguments unrestricted.
         * Each descriptor is checked on its own, so a mistake such as an unknown type is reported on that descriptor
         */
        readonly arguments?: {
            readonly [A in keyof S[K]]: S[K][A] extends CommandArgumentDescriptor ? S[K][A] : CommandArgumentDescriptor
        }
    }
}

/**
 * Cooldown reservations kept in one memory store, up to that store's configured key limit.
 * Share this instance across commands that should use the same store.
 * Uses `Date.now()` to set expiry. It does not save claims, run a background timer or share claims with other processes
 *
 * @category Commands
 */
export interface MemoryCooldownStore {
    /** Maximum keys this store retains, fixed at creation */
    readonly maxEntries: number
    /** Current stored-key count. May include expired keys until a full store needs room or an explicit sweep removes them */
    readonly size: number
    /**
     * Atomically reserve the requested key, or report its active cooldown. Acquired expiry is `Date.now() + durationMs`.
     * A new key is never refused for lack of space: A full store removes expired keys first, then the reservation that
     * expires soonest, whose key can then claim again early.
     * Malformed keys or durations throw ConfigurationError. A throwing claim getter throws SdkDefect for `commands` with code `application.defect` and the thrown value as its cause
     */
    claim(input: CommandCooldownRequest): CommandCooldownClaim
    /** Remove keys expired according to `Date.now()` and return the number removed, without changing active reservations */
    sweep(): number
    /** Forget this store's reservations immediately, allowing new claims. Does not cancel handlers or clear other store instances */
    clear(): void
}

/**
 * Immutable registered commands and groups that can be attached to a client.
 * The `register` and `registerGroup` methods return new routers, so use the returned value for subsequent registrations and attachment.
 * Older routers and their active attachments keep the definitions they already had
 *
 * @category Commands
 */
export interface DefaultPrefixCommandRouter<M extends MessageCore = Message> {
    /** Frozen command descriptions in registration order across groups, without callbacks or resource candidates. Grouped entries include paths of registered names */
    readonly commands: readonly PrefixCommandMetadata[]
    /** Frozen groups in registration order, including empty groups. These names organize lookup and help, not permission checks */
    readonly groups: readonly PrefixCommandGroupMetadata[]
    /**
     * Build frozen help-text pages locally, for example `router.help({ prefix: "!", maxLength: 2000 })`
     *
     * Root help lists immediate commands and groups in sibling registration order.
     * Selecting a group by its registered names shows that group and its immediate children, including empty groups, unless include rejects an ancestor.
     * Entries show full registered-name paths, aliases and descriptions, with `(Group)` marking groups.
     * Commands and groups registered with `hidden: true` never appear, nor does anything inside a hidden group,
     * and selecting a hidden group throws ConfigurationError as for a missing one
     *
     * Arguments generate `<required>`, `[optional]` and `<rest...>` or `[rest...]` syntax unless explicit `usage` overrides it.
     * No schema means no inferred argument syntax, and an explicit empty usage suppresses it.
     * A selection that is empty, or whose group or ancestor include rejects, returns `[]`. Nothing is sent, and no prefix resolver, guard, cooldown or handler runs
     *
     * Pages respect the UTF-16 length limit and do not split a character represented by two code units, but may split visible character clusters or Markdown.
     * Page-edge whitespace is trimmed and empty pages are removed, so joining pages is not a lossless reconstruction.
     * The caller selects pages to send and handles mentions
     *
     * Malformed options, ill-formed text, too-small limits and invalid visibility callbacks throw ConfigurationError.
     * A throwing option getter throws SdkDefect for `commands` with code `application.defect` and the thrown value as its cause, while another unexpected fault uses `sdk.defect`
     */
    help(options: CommandHelpOptions): readonly string[]
    /**
     * Validate and add one executable command to a new router, at root unless `options.group` selects an existing parent by registered names.
     * Copies metadata and arguments while retaining callbacks and the cooldown store.
     * Names and aliases must not collide with sibling commands or groups under the router's case policy.
     * Invalid definitions, collisions and missing or alias-only parent paths throw ConfigurationError.
     * A throwing getter throws SdkDefect for `commands` with code `application.defect`, while another unexpected fault uses `sdk.defect`. The original router and its attachments are unchanged
     */
    register<const S extends CommandArgumentSchema = {}>(
        command: DefaultPrefixCommand<S, M>,
        options?: PrefixCommandRegistrationOptions,
    ): DefaultPrefixCommandRouter<M>
    /**
     * Validate and add a nonempty object of commands to one new router, in the order of its own enumerable string keys and under the same optional parent group.
     * Each object key supplies its command name. Omit `arguments` to leave raw args unrestricted, or set `arguments: {}` to reject positional arguments.
     * The router copies every definition before registration. Keys inherited by the batch object are ignored.
     * Recognized fields inside each definition are read once, including inherited and non-enumerable fields.
     * If any definition is invalid or any name collides, the whole call throws
     * ConfigurationError, without a partially registered router or changes to this router and its attachments.
     * The optional parent is validated and snapshotted once for the whole batch. A throwing getter throws SdkDefect for `commands` with code `application.defect`, while another unexpected fault uses `sdk.defect`.
     * Each entry retains its own inferred argument-value type
     */
    registerMany<const S extends Readonly<Record<string, unknown>>>(
        commands: DefaultPrefixCommandBatch<M, S>,
        options?: PrefixCommandRegistrationOptions,
    ): DefaultPrefixCommandRouter<M>
    /**
     * Add a named group to a new router, at root or beneath an existing `options.group` path of registered names.
     * Register parents before children. Groups accept identity and description only, with no handler, schema, guard or cooldown.
     * At dispatch, group names and aliases are consumed using whitespace separators before the command parser runs.
     * Invalid metadata, missing parents or sibling name collisions throw ConfigurationError.
     * A throwing getter throws SdkDefect for `commands` with code `application.defect`, while another unexpected fault uses `sdk.defect`. No callback runs and older routers remain unchanged
     */
    registerGroup(
        group: PrefixCommandGroupDefinition,
        options?: PrefixCommandRegistrationOptions,
    ): DefaultPrefixCommandRouter<M>
    /**
     * Subscribe this router to `messageCreate` through the client's existing bounded event system.
     * Returns a Subscription immediately, without connecting the client or creating another queue.
     * Invalid options throw ConfigurationError, and a throwing onError getter throws SdkDefect for `commands` with code `application.defect`.
     * On a closing or closed client, attach returns an already-closed Subscription whose waitForClose succeeds, and writes a Warn log record with code events.registeredAfterShutdown.
     * Subscription options control scheduling, overflow and `onError` reports for callback failures.
     * Omitted or undefined settings default to eight concurrent commands and overflow dropOldest, so a burst never stops the router.
     * A failed command is reported with its command name, original error and message IDs to `onError`, or logged at Error without one.
     * A failed onUnmatched callback, prefix resolver or custom parser is reported the same way without a command name.
     * The router owns one bounded queue for its `onError` hook, which receives reports one at a time in order, as for client.on.
     * Rejected and unmatched commands are counted and logged at Debug in the commands category.
     * The observe option receives one handler observation per router invocation, including event and command middleware.
     * A matched command supplies its canonical command name, even when a guard denies it or middleware stops it.
     * Reported failures produce outcome failure, cancellation produces cancelled, and other completions produce success.
     * A message with no command match still produces an observation without a command name.
     * Each attachment dispatches independently, so attaching twice can run the same command twice.
     * Call `subscription.close()` to detach it and signal cancellation, without shutting down the client.
     * The returned `subscription.waitForClose()` observes SDK cleanup, not completion of arbitrary application promises.
     * Cancellation prevents later dispatch stages but cannot forcibly stop application promises already running.
     * The client must have this router's message type `M`. A full-message router cannot attach to a client with omitted fields
     */
    attach(client: Client<M>, options?: EventHandlerOptions): Subscription
}

/**
 * Recognize message commands such as `!repeat hello` with the default API's optional `commands` tools.
 * Create a router, keep the new router returned by each registration and attach the final router to a client,
 * or pass the commands to runBot, which does all of that.
 * Construction is local. No connection or subscription starts until attachment
 *
 * @category Commands
 */
export interface DefaultCommands {
    /**
     * Create an empty router, for example `commands.create({ prefix: "!", parse: commands.parseQuoted })`.
     * Defaults to full Message typing. Supply the client's MessageCore or SelectedMessage type as `M` when it selects fewer fields.
     * Prefix resolvers, parsers, command callbacks and their context client keep that same message type.
     * Invalid options throw ConfigurationError, without including rejected prefix or parser values.
     * A throwing getter throws SdkDefect for `commands` with code `application.defect`, while another unexpected fault uses `sdk.defect`. No client connects and no feedback callback runs during creation
     */
    create<M extends MessageCore = Message>(options: DefaultPrefixCommandsOptions<M>): DefaultPrefixCommandRouter<M>
    /**
     * Split a suffix using single or double quotes and backslash escapes, retaining original argument text in `rawArgs`.
     * Use as `create({ prefix: "!", parse: commands.parseQuoted })` to opt in instead of the whitespace-only default.
     * Returns undefined for empty input, invalid names, unclosed quotes or trailing escapes. Empty quotes produce an empty token.
     * Runs synchronously without client or network work
     */
    parseQuoted<M extends MessageCore = Message>(input: PrefixCommandParseInput<M>): PrefixCommandParse | undefined
    /**
     * Create an empty in-memory cooldown store with a default limit of 10,000 keys, to share one store between routers.
     * An optional positive safe integer `maxEntries` changes that limit. A full store makes room rather than refusing a
     * new key, removing expired keys first and then the reservation that expires soonest.
     * Invalid options throw ConfigurationError. A throwing getter throws SdkDefect for `commands` with code `application.defect`, while another unexpected fault uses `sdk.defect`.
     * The store has no timer or persistence. Reuse it in command cooldown definitions and clear it explicitly to forget claims
     */
    memoryCooldowns(options?: MemoryCooldownOptions): MemoryCooldownStore
}

/** Router option keys this API adds to the shared ones */
const routerAdapterKeys = ["onUnmatched", "onReject", "use"]

/** Default-API command tools exposed through the public `commands` namespace, with immediate creation and registration */
export const defaultCommands: DefaultCommands = Object.freeze({
    create: <M extends MessageCore = Message>(options: DefaultPrefixCommandsOptions<M>) =>
        attempt(() => {
            const registry = new PrefixCommandRegistry<StoredDefaultCommand<M>, M>(options, routerAdapterKeys)
            return freezeRouter(
                new DefaultPrefixCommandRouterOwner(
                    registry,
                    readCaller(() => snapshotRouterSettings(options)),
                ),
            )
        }),
    parseQuoted: parseQuotedPrefixCommand,
    memoryCooldowns: (options: MemoryCooldownOptions | undefined) =>
        attempt(() => defaultMemoryCooldownStore(createMemoryCooldownStore(options))),
})

interface StoredDefaultCommand<M extends MessageCore> extends PrefixCommandDefinition {
    readonly guards: readonly DefaultPrefixCommandGuard<M>[]
    readonly onReject?: DefaultPrefixCommandRejectionFeedback<M>
    readonly cooldown?: {
        readonly store?: DefaultCooldownStore
        readonly durationMs: number
        readonly per: CommandCooldownPer
        readonly key?: (context: DefaultPrefixCommandExecutionContext<CommandArgumentSchema, M>) => string
    }
    readonly execute: (context: DefaultPrefixCommandExecutionContext<CommandArgumentSchema, M>) => unknown
}

interface RouterSettings<M extends MessageCore> {
    readonly onUnmatched?: DefaultPrefixCommandsOptions<M>["onUnmatched"]
    readonly onReject?: DefaultPrefixCommandRejectionFeedback<M>
    readonly use: readonly DefaultPrefixCommandMiddleware<M>[]
}

class DefaultPrefixCommandRouterOwner<M extends MessageCore> implements DefaultPrefixCommandRouter<M> {
    readonly #registry: PrefixCommandRegistry<StoredDefaultCommand<M>, M>
    readonly #settings: RouterSettings<M>

    constructor(registry: PrefixCommandRegistry<StoredDefaultCommand<M>, M>, settings: RouterSettings<M>) {
        this.#registry = registry
        this.#settings = settings
    }

    get commands(): readonly PrefixCommandMetadata[] {
        return this.#registry.commands
    }

    get groups(): readonly PrefixCommandGroupMetadata[] {
        return this.#registry.groups
    }

    help(options: CommandHelpOptions): readonly string[] {
        return attempt(() => commandHelp(this.#registry.visibleEntries, options))
    }

    register<const S extends CommandArgumentSchema = {}>(
        command: DefaultPrefixCommand<S, M>,
        options?: PrefixCommandRegistrationOptions,
    ): DefaultPrefixCommandRouter<M> {
        return attempt(() =>
            freezeRouter(
                new DefaultPrefixCommandRouterOwner(
                    this.#registry.register(
                        readCaller(() => snapshotDefaultCommand(command)),
                        options,
                    ),
                    this.#settings,
                ),
            ),
        )
    }

    registerMany<const S extends Readonly<Record<string, unknown>>>(
        commands: DefaultPrefixCommandBatch<M, S>,
        options?: PrefixCommandRegistrationOptions,
    ): DefaultPrefixCommandRouter<M> {
        return attempt(() => {
            const stored = readCaller(() => snapshotDefaultCommandBatch<M>(commands))
            return freezeRouter(
                new DefaultPrefixCommandRouterOwner(this.#registry.registerMany(stored, options), this.#settings),
            )
        })
    }

    registerGroup(
        group: PrefixCommandGroupDefinition,
        options?: PrefixCommandRegistrationOptions,
    ): DefaultPrefixCommandRouter<M> {
        return attempt(() =>
            freezeRouter(
                new DefaultPrefixCommandRouterOwner(this.#registry.registerGroup(group, options), this.#settings),
            ),
        )
    }

    attach(client: Client<M>, options?: EventHandlerOptions): Subscription {
        const services = clientServices(client)
        const onError: unknown = attempt(() => readCaller(() => options?.onError))
        if (onError !== undefined && typeof onError !== "function")
            throw new ConfigurationError("onError", 'The option "onError" must be a function')
        // The router's own hook gets one bounded queue, so a failed command only enqueues its report and the hook
        // never holds a command slot. client.on never sees onError, so no second queue can reorder the reports
        const hooks =
            services && onError !== undefined
                ? services.failures.subscriptionQueue(
                      promiseHook(onError as (report: FailureReport) => unknown),
                      undefined,
                  )
                : undefined
        let subscriptionId: string | undefined
        const report =
            (services: ClientServices) => (message: M, name: string | undefined, cause: Cause.Cause<unknown>) =>
                Effect.withFiber((fiber) => {
                    recordCommandFailure(name, cause, fiber.context)
                    try {
                        const internal = makeReport(
                            {
                                kind: "handler",
                                cause,
                                event: "messageCreate",
                                command: name,
                                subscriptionId,
                                message: messageReference(message),
                            },
                            services.logging.secrets,
                        )
                        if (!hooks) services.failures.report(internal, fiber.context)
                        else {
                            services.logging.count("handlerFailures")
                            hooks.offer(internal)
                        }
                    } catch (fault) {
                        services.logging.outputFailure(fault)
                    }
                    return Effect.void
                })
        const registered = client.on(
            "messageCreate",
            (message, signal) => this.dispatch(client, message, signal, services, services && report(services)),
            routerSubscriptionOptions(options) as EventHandlerOptions,
        )
        subscriptionId = registered.id
        return registered
    }

    private dispatch(
        client: Client<M>,
        message: M,
        signal: AbortSignal,
        services: ClientServices | undefined,
        report:
            ((message: M, name: string | undefined, cause: Cause.Cause<unknown>) => Effect.Effect<void>) | undefined,
    ): Promise<void> {
        const registry = this.#registry
        const settings = this.#settings
        const logger: ClientLogger | undefined = services?.logging
        const operation = dispatchCommand<
            StoredDefaultCommand<M>,
            DefaultPrefixCommandContext<M>,
            DefaultPrefixCommandExecutionContext<CommandArgumentSchema, M>,
            ConfigurationError,
            never,
            M
        >(registry, message, {
            logger,
            ...(report === undefined
                ? {}
                : { failed: (name: string | undefined, cause: Cause.Cause<unknown>) => report(message, name, cause) }),
            prefix: (resolver, value) => defaultCallback(() => resolver(value)),
            ...(services === undefined ? {} : { selfId: () => services.selfUserId() }),
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
                    help: (options?: CommandContextHelpOptions) => this.help(contextHelpOptions(options, match.prefix)),
                    paginate: boundDefaultPaginate(client, message, signal),
                    sendHelp: (options?: CommandContextHelpOptions) => {
                        let pages: readonly string[]
                        try {
                            pages = this.help(contextHelpOptions(options, match.prefix))
                        } catch (error) {
                            if (error instanceof ConfigurationError) return errAsync(error)
                            throw error
                        }
                        return boundDefaultPaginate(client, message, signal)(pages)
                    },
                }) as DefaultPrefixCommandContext<M>,
            ...(settings.use.length === 0
                ? {}
                : {
                      around: (
                          context: DefaultPrefixCommandContext<M>,
                          rest: Effect.Effect<void, ConfigurationError>,
                      ) =>
                          aroundCommand(
                              settings.use,
                              context,
                              rest,
                              report && ((cause) => report(message, context.name, cause)),
                          ),
                  }),
            guard: (definition, context) =>
                definition.guards.length === 0
                    ? Effect.succeed(true)
                    : defaultCallback(async () => {
                          for (const guard of definition.guards) {
                              const verdict: unknown = await guard(context)
                              throwIfErr(verdict)
                              if (verdict !== true) return verdict
                          }
                          return true
                      }),
            convert: (definition, context) =>
                convertCommandArguments(definition.arguments, context.args, { guildId: context.message.guildId }),
            executionContext: (context, values) =>
                Object.freeze({
                    ...context,
                    values: values as CommandArgumentValues<CommandArgumentSchema>,
                }),
            unmatched:
                settings.onUnmatched === undefined
                    ? undefined
                    : (match) =>
                          defaultCallback(() =>
                              settings.onUnmatched!(
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
            feedback: (definition) => {
                const feedback = definition.onReject ?? settings.onReject
                return feedback === undefined || feedback === "silent"
                    ? undefined
                    : feedback === "reply"
                      ? "reply"
                      : "callback"
            },
            reject: (definition, context, rejection, now) => {
                const feedback = definition.onReject ?? settings.onReject
                if (feedback === undefined || feedback === "silent") return Effect.void
                if (feedback === "reply") {
                    const path = context.path ?? [context.name]
                    const metadata = registry.commands.find((command) =>
                        sameCommandPath(command.path ?? [command.name], path),
                    )
                    const text = rejectionReply(rejection, metadata, context.prefix, now)
                    return text === undefined ? Effect.void : defaultCallback(() => context.reply(text))
                }
                return defaultCallback(() => feedback(context, rejection))
            },
            cooldown: (definition, context, routerStore) => defaultCooldown(definition, context, routerStore),
            execute: (definition, context) => defaultCallback(() => definition.execute(context)),
            active: () => !signal.aborted,
        })
        if (signal.aborted) return Promise.resolve()
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal.addEventListener("abort", abort, { once: true })
        // The router runs as a client.on handler, so its commands share that invocation's rejection records
        return Effect.runPromise(withRejectionScope(operation, currentRejectionScope()), { signal: controller.signal })
            .catch((error: unknown) => {
                if (signal.aborted) return
                throw error
            })
            .finally(() => signal.removeEventListener("abort", abort))
    }
}

/**
 * Run middleware in order around the rest of a command. Each stage, including the rest, runs at most once: A repeated
 * or concurrent `next()` returns the first call's promise, which rejects with the command's primary error.
 * The command's failure is reported once with its command name whether middleware recovers from it, rethrows it or
 * replaces it. A different middleware failure is reported after it, and interruption keeps an earlier command failure
 */
function aroundCommand<M extends MessageCore, E>(
    middleware: readonly DefaultPrefixCommandMiddleware<M>[],
    context: DefaultPrefixCommandContext<M>,
    rest: Effect.Effect<void, E>,
    report: ((cause: Cause.Cause<unknown>) => Effect.Effect<void>) | undefined,
): Effect.Effect<void, E> {
    const signal = context.signal
    return Effect.withFiber((fiber) => {
        const rejections = fiberRejectionScope(fiber.context)
        let outcome: Promise<Exit.Exit<void, E>> | undefined
        let restExit: Exit.Exit<void, E> | undefined
        let restError: unknown
        const stages: Promise<void>[] = []
        const step = (index: number): Promise<void> => {
            const started = stages[index]
            if (started !== undefined) return started
            if (index < middleware.length) {
                const stage = new Promise<unknown>((resolve) =>
                    resolve(inRejectionScope(rejections, () => middleware[index]!(context, () => step(index + 1)))),
                ).then(throwIfErr)
                stages[index] = stage
                return stage
            }
            const stage = (outcome = Effect.runPromiseExit(withRejectionScope(rest, rejections), { signal })).then(
                (exit) => {
                    restExit = exit
                    if (Exit.isFailure(exit)) throw (restError = primaryError(exit.cause))
                },
            )
            // allow-silent: settleAround reports the saved command failure even when no middleware awaits this rejection
            stage.catch(() => undefined)
            stages[index] = stage
            return stage
        }
        const settle = settleAround(
            () => restExit,
            (cause) => primaryError(cause) === restError,
            report,
        )
        return Effect.tryPromise({ try: () => step(0), catch: (error) => error }).pipe(
            Effect.exit,
            // Middleware that did not await next still waits for the command, so its failure is not lost
            Effect.tap(() => Effect.promise(() => outcome ?? Promise.resolve(undefined))),
            Effect.flatMap((exit) =>
                settle.finish(
                    Exit.isSuccess(exit)
                        ? undefined
                        : Cause.hasInterrupts(exit.cause)
                          ? exit.cause
                          : Cause.die(primaryError(exit.cause)),
                ),
            ),
            Effect.onExit(() => settle.saved),
        ) as Effect.Effect<void, E>
    })
}

/**
 * Settle a command wrapped by middleware. The command's own failure is reported once, with its command name, whether
 * middleware succeeded, threw it again or failed differently. A different middleware failure is reported after it.
 * The `saved` argument reports a command failure that nothing else settled, such as after interruption
 */
function settleAround(
    restExit: () => Exit.Exit<void, unknown> | undefined,
    rethrown: (cause: Cause.Cause<unknown>) => boolean,
    report: ((cause: Cause.Cause<unknown>) => Effect.Effect<void>) | undefined,
) {
    let settled = false
    const commandFailure = () => {
        const exit = restExit()
        return exit !== undefined && Exit.isFailure(exit) ? exit.cause : undefined
    }
    const saved = Effect.suspend(() => {
        const failure = commandFailure()
        if (settled || failure === undefined || report === undefined || Cause.hasInterrupts(failure)) return Effect.void
        settled = true
        return report(failure)
    })
    const finish = (middlewareFailure: Cause.Cause<unknown> | undefined): Effect.Effect<void, unknown> =>
        Effect.suspend(() => {
            const failure = commandFailure()
            if (failure === undefined)
                return middlewareFailure === undefined ? Effect.void : Effect.failCause(middlewareFailure)
            // Recovered or rethrown, the command's failure reaches the dispatcher's report once
            if (
                middlewareFailure === undefined ||
                (!Cause.hasInterrupts(middlewareFailure) && rethrown(middlewareFailure))
            ) {
                settled = true
                return Effect.failCause(failure)
            }
            // Without a separate report, one combined failure still carries both errors
            if (report === undefined) {
                settled = true
                return Effect.failCause(Cause.combine(failure, middlewareFailure))
            }
            return saved.pipe(Effect.andThen(Effect.failCause(middlewareFailure)))
        })
    return { finish, saved }
}

function snapshotRouterSettings<M extends MessageCore>(options: DefaultPrefixCommandsOptions<M>): RouterSettings<M> {
    const { onUnmatched, onReject, use } = options
    if (onUnmatched !== undefined && typeof onUnmatched !== "function")
        throw new ConfigurationError("commands", 'The option "onUnmatched" must be a function')
    if (onReject !== undefined && onReject !== "reply" && onReject !== "silent" && typeof onReject !== "function")
        throw new ConfigurationError("commands", 'The option "onReject" must be "reply", "silent" or a function')
    return Object.freeze({
        ...(onUnmatched === undefined ? {} : { onUnmatched }),
        ...(onReject === undefined ? {} : { onReject }),
        use: snapshotFunctions<DefaultPrefixCommandMiddleware<M>>(
            use,
            'The option "use" must be an array of middleware functions',
        ),
    })
}

function snapshotFunctions<F>(value: unknown, message: string): readonly F[] {
    if (value === undefined) return Object.freeze([])
    if (!Array.isArray(value)) throw new ConfigurationError("commands", message)
    const copied: F[] = []
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || typeof value[index] !== "function")
            throw new ConfigurationError("commands", message)
        copied.push(value[index] as F)
    }
    return Object.freeze(copied)
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
        "hidden",
        "arguments",
        "guard",
        "onReject",
        "cooldown",
        "execute",
    ])
    const { execute, guard, onReject, cooldown: sourceCooldown } = command
    if (typeof execute !== "function")
        throw new ConfigurationError("command", 'The command option "execute" must be a function')
    const guards =
        guard === undefined
            ? Object.freeze([])
            : typeof guard === "function"
              ? Object.freeze([guard])
              : snapshotFunctions<DefaultPrefixCommandGuard<M>>(
                    guard,
                    'The option "guard" must be a function or an array of functions',
                )
    if (onReject !== undefined && onReject !== "reply" && onReject !== "silent" && typeof onReject !== "function")
        throw new ConfigurationError("command", 'The option "onReject" must be "reply", "silent" or a function')
    const cooldown = snapshotCommandCooldown(sourceCooldown)
    const definition = snapshotCommandDefinition(command, keyedName)
    return Object.freeze({
        ...definition,
        execute: execute as StoredDefaultCommand<M>["execute"],
        guards: guards as readonly DefaultPrefixCommandGuard<M>[],
        ...(onReject === undefined ? {} : { onReject }),
        ...(cooldown === undefined ? {} : { cooldown: cooldown as NonNullable<StoredDefaultCommand<M>["cooldown"]> }),
    }) as StoredDefaultCommand<M>
}

function snapshotDefaultCommandBatch<M extends MessageCore>(commands: unknown): readonly StoredDefaultCommand<M>[] {
    if (typeof commands !== "object" || commands === null || Array.isArray(commands))
        throw new ConfigurationError("command", "A command batch must be an object")
    for (const key of Reflect.ownKeys(commands))
        if (typeof key === "symbol" && Object.prototype.propertyIsEnumerable.call(commands, key))
            throw new ConfigurationError("command", "Command batch keys must be strings")
    const names = Object.keys(commands)
    if (names.length === 0) throw new ConfigurationError("command", "A command batch must not be empty")
    const stored: StoredDefaultCommand<M>[] = []
    for (const name of names) {
        const value = (commands as Readonly<Record<string, unknown>>)[name]
        if (typeof value !== "object" || value === null || Array.isArray(value))
            throw new ConfigurationError("command", `The command batch entry ${JSON.stringify(name)} must be an object`)
        if (Object.prototype.hasOwnProperty.call(value, "name"))
            throw new ConfigurationError(
                "command",
                `The command batch entry ${JSON.stringify(name)} must not set "name", because its object key is the name`,
            )
        stored.push(snapshotDefaultCommand(value as DefaultPrefixCommand<CommandArgumentSchema, M>, name))
    }
    return Object.freeze(stored)
}

/**
 * Create the command tools a runBot commands option describes, registering its keyed commands or its register callback.
 * Rejections are answered with `onReject: "reply"` unless the option selects other feedback.
 * Misuse throws ConfigurationError. A register callback's own throw becomes ApplicationError naming `runBot commands`
 */
export function botRouter<M extends MessageCore>(
    options: DefaultPrefixCommandsOptions<M> & {
        readonly commands: unknown
    },
): DefaultPrefixCommandRouter<M> {
    if (typeof options !== "object" || options === null || Array.isArray(options))
        throw new ConfigurationError("commands", "The commands option must be an object")
    checkBotCommandKeys(options, routerAdapterKeys)
    const {
        commands: definitions,
        onError: _onError,
        ...settings
    } = options as typeof options & { readonly onError?: unknown }
    const router = defaultCommands.create<M>({ ...settings, onReject: settings.onReject ?? "reply" })
    if (typeof definitions === "function") {
        const registered: unknown = registerCallback(() => definitions(router))
        if (
            typeof registered !== "object" ||
            registered === null ||
            !(registered instanceof DefaultPrefixCommandRouterOwner)
        )
            throw new ConfigurationError("commands", "A commands register callback must return the registered router")
        return registered as DefaultPrefixCommandRouter<M>
    }
    return router.registerMany(definitions as DefaultPrefixCommandBatch<M, Readonly<Record<string, undefined>>>)
}

/** Reply to one message with a string or message input, applying the handler's cancellation signal */
export function boundDefaultReply<M extends MessageCore>(
    client: Client<M>,
    message: M,
    signal: AbortSignal,
): DefaultPrefixCommandContext<M>["reply"] {
    return (input, options) => client.messages.reply(message, input, bindDefaultReplyOptions(options, signal))
}

function boundDefaultPaginate<M extends MessageCore>(
    client: Client<M>,
    message: M,
    signal: AbortSignal,
): DefaultPrefixCommandContext<M>["paginate"] {
    return (pages, options) =>
        client.messages.paginate(message.channelId, pages, askerPageOptions(options, message.author.id, signal))
}

function bindDefaultReplyOptions(options: SendOptions | undefined, signal: AbortSignal): DefaultSendOptions {
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
    routerStore: LocalMemoryCooldownStore,
): Effect.Effect<{ readonly key: string; readonly claim: unknown } | undefined, ConfigurationError> {
    const cooldown = definition.cooldown
    if (cooldown === undefined) return Effect.succeed(undefined)
    return defaultCallback(() => cooldown.key?.(context) ?? cooldownSuffix(cooldown.per, context.message)).pipe(
        Effect.flatMap((key) =>
            configurationEffect(() => cooldownRequest(context.path ?? definition.name, key, cooldown.durationMs)),
        ),
        Effect.flatMap((request) => {
            const store = cooldown.store
            const claim: Effect.Effect<unknown, ConfigurationError> =
                store !== undefined
                    ? defaultCallback(() => store.claim(request))
                    : configurationEffect(() => {
                          const claimed = routerStore.claim(request)
                          if (claimed._tag === "Failure") throw claimed.error
                          return claimed.value
                      })
            return Effect.map(claim, (value) => ({ key: request.key, claim: value }))
        }),
    )
}

function defaultMemoryCooldownStore(owner: LocalMemoryCooldownStore): MemoryCooldownStore {
    return Object.freeze({
        maxEntries: owner.maxEntries,
        get size() {
            return owner.size
        },
        claim: (input: CommandCooldownRequest) => {
            const result = attempt(() => owner.claim(readCaller(() => snapshotClaimInput(input))))
            if (result._tag === "Success") return result.value
            throw result.error
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

/** Run an application callback, treating a returned or resolved Err result like a throw of its error */
function defaultCallback<A>(callback: () => A | PromiseLike<A>): Effect.Effect<A> {
    return Effect.withFiber((fiber) => {
        // Operations the callback starts hold their rejection records for the command's outcome
        const rejections = fiberRejectionScope(fiber.context)
        return Effect.tryPromise({
            try: () =>
                Promise.resolve()
                    .then(() => inRejectionScope(rejections, callback))
                    .then((value) => {
                        throwIfErr(value)
                        return value
                    }),
            catch: (error): never => {
                throw error
            },
        })
    })
}

/**
 * Run local command setup, keeping ConfigurationError for misuse. A throw from a marked read of caller definitions,
 * options or claims is an application fault, and any other throw, such as from building the registry, is an SDK fault
 */
function attempt<A>(create: () => A): A {
    try {
        return create()
    } catch (error) {
        if (error instanceof ConfigurationError) throw error
        throw new SdkDefect("commands", [thrownReason(error)])
    }
}

/**
 * Run a runBot register callback. Misuse and SDK defects from the registrations it makes keep their errors, and any
 * other throw is the application's own failure, carried by ApplicationError naming `runBot commands`
 */
function registerCallback<A>(register: () => A): A {
    try {
        return register()
    } catch (error) {
        if (error instanceof ConfigurationError || error instanceof SdkDefect) throw error
        throw new ApplicationError("runBot commands", error)
    }
}
