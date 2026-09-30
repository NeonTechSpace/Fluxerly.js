import type {
    CommandCooldownClaim,
    CommandCooldownPer,
    CommandCooldownRequest,
    MemoryCooldownOptions,
    PrefixCommandDefinition,
    PrefixCommandGroupDefinition,
    PrefixCommandGroupMetadata,
    PrefixCommandMetadata,
    PrefixCommandGuardResult,
    PrefixCommandParse,
    PrefixCommandParseInput,
    PrefixCommandParsing,
    PrefixCommandPrefixValue,
    PrefixCommandRejection,
    PrefixCommandRegistrationOptions,
    PrefixCommandUnmatched,
} from "#sdk/commands"
import type { CommandArgumentDescriptor, CommandArgumentSchema, CommandArgumentValues } from "#sdk/command-arguments"
import type { CommandContextHelpOptions, CommandHelpOptions } from "#sdk/command-help"
import { commandHelp, contextHelpOptions } from "#sdk/internal/command-help"
import { parseQuotedPrefixCommand } from "#sdk/commands"
import { ApplicationError, ConfigurationError, SdkDefect } from "#sdk/errors"
import { readCaller, readInput, suspendMarked, thrownReason } from "#sdk/internal/defects"
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
import type { Message, MessageCore, ReplyInput, SendOptions } from "#sdk/messages"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Scope from "effect/Scope"
import { clientServices } from "#sdk/internal/client-registry"
import { makeReport, messageReference, primaryError, type InternalReport } from "#sdk/internal/failures"
import type { ClientLogger } from "#sdk/internal/logging"
import { recordCommandFailure } from "#sdk/internal/events"
import type { Client, EventHandlerOptions, Subscription } from "./effect.js"

/**
 * Message and parsed arguments for a native command's guard and rejection callback. These values cannot be changed.
 * Execution and cooldown-key callbacks receive the extended context with converted values.
 * Native callbacks run in the attachment's Effect context, with interruption rather than the default API's AbortSignal field
 *
 * @category Commands
 */
export interface NativePrefixCommandContext<M extends MessageCore = Message> {
    /** Client supplied to `attach`, available for explicit Effect operations. The application still owns its connection and shutdown */
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
     * A string is sent as the reply's content, such as `reply("Pong")`.
     * Delegates to `client.messages.reply`, including its validation, deadline, nonce, retry, cache and defect behavior.
     * Interruption or a lost response can leave the reply posted. Failure does not always mean nothing was sent, and uncertain sends are not replayed.
     * The router replies on its own only when `onReject: "reply"` is selected
     */
    readonly reply: (input: ReplyInput | string, options?: SendOptions) => Effect.Effect<M, SendError>
    /**
     * Build help pages from the router that matched this command, for example `({ help, reply }) => reply(help()[0] ?? "No commands")`.
     * Takes the same settings as `router.help`, all optional: The prefix defaults to the one this message used and the
     * page length to 2,000 UTF-16 code units. Nothing is sent. Invalid settings throw ConfigurationError as `router.help` does
     */
    readonly help: (options?: CommandContextHelpOptions) => readonly string[]
}

/**
 * Command context supplied to execution and cooldown-key callbacks only after the complete argument schema succeeds
 *
 * @category Commands
 */
export interface NativePrefixCommandExecutionContext<
    S extends CommandArgumentSchema = {},
    M extends MessageCore = Message,
> extends NativePrefixCommandContext<M> {
    /** Frozen values keyed by schema names, such as `values.count`, or an empty object when no schema is supplied. Not available to guards or rejection callbacks */
    readonly values: CommandArgumentValues<S>
}

/**
 * Frozen message and prefix for native `onUnmatched` feedback, without an assumed command or converted arguments
 *
 * @category Commands
 */
export interface NativePrefixCommandUnmatchedContext<M extends MessageCore = Message> {
    /** Attached client for explicit feedback operations, without transferring its lifetime to the router */
    readonly client: Client<M>
    /** Incoming frozen message with the client's selected fields only */
    readonly message: M
    /** Exact prefix selected before parsing declined, name lookup missed or a group needed a subcommand */
    readonly prefix: string
    /**
     * Reply to the unmatched incoming message through the attached client, inheriting this callback's interruption.
     * A string is sent as the reply's content.
     * Delegates to `client.messages.reply`, including its validation, deadline, nonce, retry, cache and defect behavior.
     * Interruption or a lost response can leave the reply posted. Failure does not always mean nothing was sent, and uncertain sends are not replayed
     */
    readonly reply: (input: ReplyInput | string, options?: SendOptions) => Effect.Effect<M, SendError>
}

/**
 * Decide whether a matched command may run, from raw context before argument conversion.
 * The Effect produces true to allow it, false to deny it silently, or `{ deny: "reason" }` to deny it with text that
 * `onReject: "reply"` sends. The built-in `guards` cover common checks.
 * A false verdict is still counted, logged at Debug and passed to a custom onReject callback, but never sends an automatic reply.
 * Failures, defects and other values use subscription error reporting
 *
 * @category Commands
 */
export type NativePrefixCommandGuard<E = never, R = never, M extends MessageCore = Message> = (
    context: NativePrefixCommandContext<M>,
) => Effect.Effect<PrefixCommandGuardResult, E, R>

/**
 * Run around every matched command of a router, in registration order, before its guards.
 * Include `next` in the returned Effect to continue. Leaving it out stops the command, which is logged at Debug.
 * The rest of the chain runs at most once: Evaluating `next` again, even concurrently as in
 * `Effect.all([next, next], { concurrency: 2 })`, waits for the first run and repeats its outcome.
 * When the command fails, `next` fails with the command's own failure, the same error or defect its execute Effect produced
 *
 * A failure of the command is reported once with its command name, whatever the middleware does with it.
 * Failing again with that same error adds no second report. A different failure or defect of the middleware is
 * reported as a separate failure after the command's, also with the command name. Without a command failure, a
 * middleware failure is reported like a failed command and stops the command if `next` has not run yet.
 * The command's failure is still reported when the middleware is interrupted, for example because the subscription closes
 *
 * @category Commands
 */
export type NativePrefixCommandMiddleware<E = never, R = never, M extends MessageCore = Message> = (
    context: NativePrefixCommandContext<M>,
    next: Effect.Effect<void, unknown>,
) => Effect.Effect<unknown, E, R>

/**
 * Rejection feedback for a command: `"reply"` sends a short explanation, such as the missing argument and the command's
 * usage, the guard's deny reason or the cooldown's remaining time. `"silent"` sends nothing, and the rejection is still
 * logged at Debug. A guard returning false never sends an automatic reply, even with "reply" selected.
 * A function returns an Effect that gives feedback instead, including for false guard denials
 *
 * So that repeated attempts do not make the bot repeat itself, `"reply"` answers an active cooldown key once until its
 * retry time, and a guard denial once per user and command every 5 seconds, measured with the handler's Effect Clock.
 * Argument rejections are always answered. A skipped reply is counted with the rejection and logged at Debug in the
 * commands category. A function is called for every rejection, so it can count attempts and apply its own limit, for
 * example with `retryAtMs`
 *
 * @category Commands
 */
export type NativePrefixCommandRejectionFeedback<E = never, R = never, M extends MessageCore = Message> =
    | "reply"
    | "silent"
    | ((context: NativePrefixCommandContext<M>, rejection: PrefixCommandRejection) => Effect.Effect<unknown, E, R>)

/**
 * Prefix and parser configuration with optional Effect feedback when no executable command is selected
 *
 * @category Commands
 */
export interface NativePrefixCommandsOptions<
    E = never,
    R = never,
    M extends MessageCore = Message,
> extends PrefixCommandParsing<M> {
    /**
     * Prefix text, accepted-prefix list or per-message resolver, which may return an Effect. If several prefixes match,
     * the longest wins. Return undefined to ignore the message. A resolver failure is reported without a command name
     */
    readonly prefix:
        | string
        | readonly string[]
        | ((message: M) => PrefixCommandPrefixValue | Effect.Effect<PrefixCommandPrefixValue, unknown>)
    /**
     * Rejection feedback for commands that do not set their own `onReject`. Omit it to give no feedback, except in
     * runBot, which replies by default. Guards returning false never send an automatic reply
     */
    readonly onReject?: NativePrefixCommandRejectionFeedback<E, R, M>
    /** Middleware run around every matched command, in order. See NativePrefixCommandMiddleware */
    readonly use?: readonly NativePrefixCommandMiddleware<E, R, M>[]
    /**
     * Return an Effect that handles a parser decline, unknown name or group without a subcommand.
     * An unknown name carries a `suggestion` when a registered name is close.
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
 *
 * @category Commands
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
 * Limit how often a command executes, per user by default. Claimed after the guards allow execution and all arguments
 * convert, before executing the handler.
 * A claimed cooldown remains claimed if the handler fails or is interrupted
 *
 * @category Commands
 */
export interface NativePrefixCommandCooldown<
    E = never,
    R = never,
    S extends CommandArgumentSchema = {},
    M extends MessageCore = Message,
> {
    /** Whole milliseconds per claim, from 1 through 2,147,483,647 */
    readonly durationMs: number
    /** Whose invocations share the cooldown: `user` (default), `channel` or `guild` */
    readonly per?: CommandCooldownPer
    /**
     * Reservation store retained by reference. Omit it to use the router's own memory store in this process, sized by the
     * router's `cooldowns` option, using the handler's Effect Clock and shared by every router derived from the same create
     */
    readonly store?: NativeCooldownStore<E, R>
    /**
     * Synchronously return a nonempty suffix from the converted context, replacing the one selected by `per`.
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
 *
 * @category Commands
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
     * One guard or a list of guards, run in order before argument conversion. The first that denies stops the command.
     * Each command owns its policy, with no inherited group guard or authorization from help visibility.
     * Non-Effect returns and invalid verdicts fail with ConfigurationError.
     * Failures and defects use subscription error reporting rather than rejection feedback
     */
    readonly guard?: NativePrefixCommandGuard<E, R, M> | readonly NativePrefixCommandGuard<E, R, M>[]
    /**
     * Feedback after a denied guard, rejected arguments or a denied cooldown, overriding the router's `onReject`.
     * A function receives raw context and a safe rejection classification, never partially converted values.
     * Its success value is discarded. Failures and defects use attachment error reporting, without retry.
     * Non-Effect returns fail with ConfigurationError
     */
    readonly onReject?: NativePrefixCommandRejectionFeedback<E, R, M>
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

/**
 * Commands keyed by name, as registerMany and the runBot commands option accept them. Each value defines one command without its name.
 * Omit `arguments` to leave raw args unrestricted, or set `arguments: {}` to reject positional arguments
 *
 * @category Commands
 */
export type NativePrefixCommandBatch<M extends MessageCore, S extends Readonly<Record<string, unknown>>> = {
    readonly [K in keyof S]: Omit<
        NativePrefixCommand<unknown, any, S[K] extends CommandArgumentSchema ? S[K] : {}, M>,
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
 * The services required by the Effect that callback F returns, or never when F returns no Effect
 *
 * @category Commands
 */
export type NativeEffectRequirements<F> = F extends (...arguments_: any[]) => Effect.Effect<unknown, unknown, infer R>
    ? R
    : never

/**
 * The services required by one command's execute, guard, onReject and cooldown claim callbacks
 *
 * @category Commands
 */
export type NativeCommandRequirements<C> =
    | (C extends {
          /** Command callback */
          readonly execute: infer F
      }
          ? NativeEffectRequirements<F>
          : never)
    | (C extends {
          /** Optional access check or list of checks */
          readonly guard: infer F
      }
          ? F extends readonly (infer G)[]
              ? NativeEffectRequirements<G>
              : NativeEffectRequirements<F>
          : never)
    | (C extends {
          /** Optional argument rejection callback */
          readonly onReject: infer F
      }
          ? NativeEffectRequirements<F>
          : never)
    | (C extends {
          /** Optional cooldown settings */
          readonly cooldown: {
              /** Store that reserves cooldown keys */
              readonly store: {
                  /** Reservation method, whose returned Effect may require services */
                  readonly claim: infer F
              }
          }
      }
          ? F extends (...arguments_: any[]) => infer A
              ? A extends Effect.Effect<unknown, unknown, infer R>
                  ? R
                  : never
              : never
          : never)

/**
 * The services required by every command in a registerMany batch, recorded on the returned router
 *
 * @category Commands
 */
export type NativeBatchRequirements<C> =
    C extends Readonly<Record<string, unknown>> ? NativeCommandRequirements<C[keyof C]> : never

/**
 * Bounded in-memory cooldown reservations for one process, using the caller's Effect Clock wall time.
 * Claim, sweep and clear return lazy Effects, so storage changes occur only when those Effects run.
 * No background timer, persistence or cross-process coordination is provided
 *
 * @category Commands
 */
export interface MemoryCooldownStore {
    /** Fixed key limit selected when the store is created */
    readonly maxEntries: number
    /** Immediate stored-key count, including expired keys until a full store needs room or a sweep removes them */
    readonly size: number
    /**
     * When run, atomically reserve the key or report its active cooldown.
     * Acquired expiry is the caller Clock's current wall time plus `durationMs`.
     * A new key is never refused for lack of space: A full store removes expired keys first, then the reservation that
     * expires soonest, whose key can then claim again early.
     * Malformed keys or durations are misuse and die with ConfigurationError. Unexpected input getter defects remain in the Effect cause
     */
    claim(input: CommandCooldownRequest): Effect.Effect<CommandCooldownClaim>
    /** Return an Effect that removes keys expired according to the caller's Effect Clock and produces the number removed, preserving active claims */
    sweep(): Effect.Effect<number>
    /** Return an Effect that forgets this store's reservations, allowing new claims. Does not cancel handlers or clear other stores */
    clear(): Effect.Effect<void>
}

/**
 * Immutable registered commands and groups for attachment to a native client.
 * Registration returns a new router synchronously, leaving earlier routers and attachments unchanged, and throws ConfigurationError for misuse.
 * `R` records services required by registered callbacks, which must be provided when attaching the router.
 * Creating or registering a router does not run its callbacks
 *
 * @category Commands
 */
export interface NativePrefixCommandRouter<R = never, M extends MessageCore = Message> {
    /** Frozen executable-command information in registration order across groups, without callbacks or resource candidates. Grouped commands include canonical paths */
    readonly commands: readonly PrefixCommandMetadata[]
    /** Frozen group information in registration order, including empty groups. Groups organize lookup and help, not authorization */
    readonly groups: readonly PrefixCommandGroupMetadata[]
    /**
     * Build frozen help pages locally and synchronously, without sending messages or executing commands.
     * It needs no scope or registered callback services
     *
     * Root help lists immediate commands and groups in sibling registration order.
     * A canonical group selection shows the group and its immediate children, including empty groups, unless include rejects an ancestor.
     * Entries show full canonical paths, aliases and descriptions, with `(Group)` marking groups.
     * Commands and groups registered with `hidden: true` never appear, nor does anything inside a hidden group,
     * and selecting a hidden group throws ConfigurationError as for a missing one
     *
     * Schemas generate `<required>`, `[optional]` and `<rest...>` or `[rest...]` syntax unless explicit `usage` overrides it.
     * An empty usage suppresses inferred syntax, and an absent schema adds no argument syntax.
     * A selection that is empty, or whose group or ancestor include rejects, produces `[]`. No prefix resolver, guard, cooldown or handler is evaluated
     *
     * The explicit UTF-16 page limit preserves surrogate pairs, but may split visible character clusters or Markdown.
     * Page-edge whitespace is trimmed and empty pages are removed, so joining pages does not reconstruct the exact original text.
     * The application chooses which pages to send and how to handle mentions
     *
     * Malformed options, ill-formed text, too-small limits and invalid visibility callbacks throw ConfigurationError.
     * A throwing option getter throws SdkDefect for `commands` with code `application.defect` and the thrown value as its cause, while another unexpected fault uses `sdk.defect`
     */
    help(options: CommandHelpOptions): readonly string[]
    /**
     * Validate and add a command to a new router, at root or an existing canonical `options.group` path.
     * Copies metadata and arguments, retaining callbacks and the cooldown store without invoking them.
     * The resulting router requires this command's services `R2` in addition to existing `R` when attached.
     * Names and aliases must not collide with sibling commands or groups under the router's case policy.
     * Invalid definitions, collisions and missing or alias-only parent paths throw ConfigurationError.
     * A throwing getter throws SdkDefect for `commands` with code `application.defect`, while another unexpected fault uses `sdk.defect`. Earlier routers and active attachments remain unchanged
     */
    register<E, R2, const S extends CommandArgumentSchema = {}>(
        command: NativePrefixCommand<E, R2, S, M>,
        options?: PrefixCommandRegistrationOptions,
    ): NativePrefixCommandRouter<R | R2, M>
    /**
     * Validate and add a nonempty keyed command object to one new router, in JavaScript own enumerable string-key order and under one optional parent.
     * Each object key supplies its command name. Set `arguments: {}` to reject positional arguments, or `arguments: undefined` to leave raw args unrestricted.
     * Every definition is snapshotted before registration. Inherited batch keys are ignored.
     * Recognized fields inside each definition are read once, including inherited and non-enumerable fields.
     * If any definition is invalid or any name collides, the call throws
     * ConfigurationError and produces no partially registered router. Earlier routers and attachments remain unchanged.
     * The optional parent is validated and snapshotted once. A throwing getter throws SdkDefect for `commands` with code `application.defect`, while another unexpected fault uses `sdk.defect`.
     * Each entry retains its inferred argument values, and the returned router records every callback service requirement
     */
    registerMany<
        const S extends Readonly<Record<string, unknown>>,
        const C extends Readonly<
            Record<
                keyof S,
                {
                    /** Argument schema of the command under this key */
                    readonly arguments?: CommandArgumentSchema
                    /** Command callback, whose required services the returned router records */
                    readonly execute: unknown
                }
            >
        >,
    >(
        commands: C & NativePrefixCommandBatch<M, S>,
        options?: PrefixCommandRegistrationOptions,
    ): NativePrefixCommandRouter<R | NativeBatchRequirements<C>, M>
    /**
     * Add a group to a new router, at root or beneath an existing canonical `options.group` path.
     * Register parent groups before children. Groups accept identity and description only, without callbacks or argument schemas.
     * Group names and aliases use fixed whitespace separators at dispatch, before the command parser runs.
     * Invalid metadata, missing parents and sibling name collisions throw ConfigurationError.
     * A throwing getter throws SdkDefect for `commands` with code `application.defect`, while another unexpected fault uses `sdk.defect`. Existing routers keep their data, and required services `R` do not change
     */
    registerGroup(
        group: PrefixCommandGroupDefinition,
        options?: PrefixCommandRegistrationOptions,
    ): NativePrefixCommandRouter<R, M>
    /**
     * Return an Effect that registers this router as one bounded `messageCreate` subscription in the caller's scope.
     * Provide registered callback services `R` and any error-callback services `R2` when running this Effect
     *
     * Produces a Subscription after registration, not after connecting the client or completing future command work.
     * Callback failures and defects use subscription `onError` reporting with the command name and full Cause, rather than failing an already completed attachment Effect.
     * A failed onUnmatched callback or custom parser is reported the same way without a command name.
     * The router owns one bounded queue for its `onError` hook, which receives reports one at a time in order, as for client.on.
     * Omitted or undefined settings default to eight concurrent commands and overflow dropOldest, so a burst never stops the router.
     * Rejected and unmatched commands are counted and logged at Debug in the commands category.
     * The observe option receives one handler observation per router invocation, including event and command middleware.
     * A matched command supplies its canonical command name, even when a guard denies it or middleware stops it.
     * Reported failures produce outcome failure, interruption produces cancelled, and other completions produce success.
     * A message with no command match still produces an observation without a command name.
     * Each attachment dispatches independently, so duplicate attachments can execute a command twice
     *
     * Run `subscription.close()` or close the registration scope to detach and interrupt handlers, without shutting down the client.
     * The returned `subscription.waitForClose()` completes after handler finalizers. Work that disables interruption can delay closure.
     * Synchronous work and caller-owned promises that ignore interruption cannot be forcibly stopped
     *
     * The client must use message type `M`. A full-message router cannot attach to a client with omitted fields.
     * Invalid options are misuse and die with ConfigurationError, and a throwing onError getter dies with its thrown value.
     * On a closing or closed client, attach succeeds with an already-closed
     * Subscription whose waitForClose succeeds, and writes a Warn log record with code events.registeredAfterShutdown
     */
    attach<E = never, R2 = never>(
        client: Client<M>,
        options?: EventHandlerOptions<E, R2>,
    ): Effect.Effect<Subscription, never, Scope.Scope | R | R2>
}

/**
 * Recognize message commands such as `!repeat hello` with `commands` from the package's `/effect` entry point.
 * Creation, registration and help are local and return their result directly, throwing ConfigurationError for misuse.
 * Attachment and memory-store operations return Effects that do nothing until run
 *
 * @category Commands
 */
export interface NativeCommands {
    /**
     * Validate options and create an empty local router, without connecting or subscribing a client.
     * Defaults to full Message typing. Supply MessageCore or the client's SelectedMessage type as `M` for fewer selected fields.
     * Prefix resolvers, parsers, command callbacks and the context client keep the same message type.
     * The router records services `R` required by optional unmatched feedback, but does not require them until attachment.
     * Invalid options throw ConfigurationError. A throwing getter throws SdkDefect for `commands` with code `application.defect`, while another unexpected fault uses `sdk.defect`.
     * No prefix resolver, parser or feedback callback runs during creation
     */
    create<E = never, R = never, M extends MessageCore = Message>(
        options: NativePrefixCommandsOptions<E, R, M>,
    ): NativePrefixCommandRouter<R, M>
    /**
     * Synchronously split a suffix with single or double quotes and backslash escapes, preserving original argument text in `rawArgs`.
     * Select with `create({ prefix: "!", parse: commands.parseQuoted })`, since the default splits only on whitespace.
     * Returns undefined for empty input, invalid names, unclosed quotes or trailing escapes. Empty quotes produce an empty token
     */
    parseQuoted<M extends MessageCore = Message>(input: PrefixCommandParseInput<M>): PrefixCommandParse | undefined
    /**
     * Create a fresh in-memory cooldown store.
     * Defaults to 10,000 retained keys, or the supplied positive safe integer `maxEntries`. A full store makes room rather
     * than refusing a new key, removing expired keys first and then the reservation that expires soonest.
     * Invalid options throw ConfigurationError. A throwing getter throws SdkDefect for `commands` with code `application.defect`, while another unexpected fault uses `sdk.defect`.
     * Keep the store for reuse in command cooldowns. It has no persistence, scope finalizer or background timer
     */
    memoryCooldowns(options?: MemoryCooldownOptions): MemoryCooldownStore
}

/** Native tools behind the public `commands` namespace, with synchronous local setup and lazy attachment */
export const nativeCommands: NativeCommands = Object.freeze({
    create: <E, R, M extends MessageCore = Message>(options: NativePrefixCommandsOptions<E, R, M>) =>
        localSetup(() =>
            freezeRouter(
                new NativePrefixCommandRouterOwner<R, M>(
                    new PrefixCommandRegistry<StoredNativeCommand<M>, M>(options, ["onUnmatched", "onReject", "use"]),
                    readCaller(() => snapshotNativeSettings(options)),
                ),
            ),
        ),
    parseQuoted: parseQuotedPrefixCommand,
    memoryCooldowns: (options: MemoryCooldownOptions | undefined) =>
        localSetup(() => nativeMemoryCooldownStore(createMemoryCooldownStore(options))),
})

interface StoredNativeCommand<M extends MessageCore> extends PrefixCommandDefinition {
    readonly guards: readonly NativePrefixCommandGuard<unknown, unknown, M>[]
    readonly onReject?: NativePrefixCommandRejectionFeedback<unknown, unknown, M>
    readonly cooldown?: {
        readonly store?: NativeCooldownStore<unknown, unknown>
        readonly durationMs: number
        readonly per: CommandCooldownPer
        readonly key?: (context: NativePrefixCommandExecutionContext<CommandArgumentSchema, M>) => string
    }
    readonly execute: (
        context: NativePrefixCommandExecutionContext<CommandArgumentSchema, M>,
    ) => Effect.Effect<unknown, unknown, unknown>
}

class NativePrefixCommandRouterOwner<R = never, M extends MessageCore = Message> implements NativePrefixCommandRouter<
    R,
    M
> {
    readonly #registry: PrefixCommandRegistry<StoredNativeCommand<M>, M>
    readonly #settings: NativeRouterSettings<M>

    constructor(registry: PrefixCommandRegistry<StoredNativeCommand<M>, M>, settings: NativeRouterSettings<M>) {
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
        return localSetup(() => commandHelp(this.#registry.visibleEntries, options))
    }

    register<E, R2, const S extends CommandArgumentSchema = {}>(
        command: NativePrefixCommand<E, R2, S, M>,
        options?: PrefixCommandRegistrationOptions,
    ): NativePrefixCommandRouter<R | R2, M> {
        return localSetup(() =>
            freezeRouter(
                new NativePrefixCommandRouterOwner<R | R2, M>(
                    this.#registry.register(
                        readCaller(() => snapshotNativeCommand(command)),
                        options,
                    ),
                    this.#settings,
                ),
            ),
        )
    }

    registerMany<
        const S extends Readonly<Record<string, unknown>>,
        const C extends Readonly<
            Record<
                keyof S,
                {
                    /** Argument schema of the command under this key */
                    readonly arguments?: CommandArgumentSchema
                    /** Command callback, whose required services the returned router records */
                    readonly execute: unknown
                }
            >
        >,
    >(
        commands: C & NativePrefixCommandBatch<M, S>,
        options?: PrefixCommandRegistrationOptions,
    ): NativePrefixCommandRouter<R | NativeBatchRequirements<C>, M> {
        return localSetup(() => {
            const stored = readCaller(() => snapshotNativeCommandBatch(commands))
            return freezeRouter(
                new NativePrefixCommandRouterOwner<R | NativeBatchRequirements<C>, M>(
                    this.#registry.registerMany(stored, options),
                    this.#settings,
                ),
            )
        })
    }

    registerGroup(
        group: PrefixCommandGroupDefinition,
        options?: PrefixCommandRegistrationOptions,
    ): NativePrefixCommandRouter<R, M> {
        return localSetup(() =>
            freezeRouter(
                new NativePrefixCommandRouterOwner<R, M>(this.#registry.registerGroup(group, options), this.#settings),
            ),
        )
    }

    attach<E = never, R2 = never>(
        client: Client<M>,
        options?: EventHandlerOptions<E, R2>,
    ): Effect.Effect<Subscription, never, Scope.Scope | R | R2> {
        const services = clientServices(client)
        const router = this
        return Effect.gen(function* () {
            const onError: unknown = yield* readInput(() => options?.onError)
            if (onError !== undefined && typeof onError !== "function")
                return yield* Effect.die(new ConfigurationError("onError", 'The option "onError" must be a function'))
            // The router's own hook gets one bounded queue in the registration context, so a failed command only
            // enqueues its report and the hook never holds a command slot. client.on never sees onError
            const hooks =
                services && onError !== undefined
                    ? services.failures.subscriptionQueue(
                          onError as (report: InternalReport) => Effect.Effect<unknown, unknown>,
                          (yield* Effect.context<R2>()) as Context.Context<never>,
                      )
                    : undefined
            let subscriptionId: string | undefined
            const report =
                services &&
                ((message: M, name: string | undefined, cause: Cause.Cause<unknown>): Effect.Effect<void> =>
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
                    }))
            const subscription = yield* client.on(
                "messageCreate",
                (message) => router.dispatch(client, message, services?.logging, report) as Effect.Effect<void, E, R>,
                routerSubscriptionOptions(options) as EventHandlerOptions<never, never>,
            )
            subscriptionId = subscription.id
            return subscription
        })
    }

    private dispatch<R2>(
        client: Client<M>,
        message: M,
        logger: ClientLogger | undefined,
        report:
            ((message: M, name: string | undefined, cause: Cause.Cause<unknown>) => Effect.Effect<void>) | undefined,
    ): Effect.Effect<void, ConfigurationError, R | R2> {
        const registry = this.#registry
        const settings = this.#settings
        const services = clientServices(client)
        return dispatchCommand<
            StoredNativeCommand<M>,
            NativePrefixCommandContext<M>,
            NativePrefixCommandExecutionContext<CommandArgumentSchema, M>,
            unknown,
            unknown,
            M
        >(registry, message, {
            logger,
            prefix: (resolver, value) =>
                Effect.suspend(() => {
                    const resolved: unknown = resolver(value)
                    return Effect.isEffect(resolved) ? resolved : Effect.succeed(resolved)
                }),
            ...(services === undefined ? {} : { selfId: () => services.selfUserId() }),
            ...(settings.use.length === 0
                ? {}
                : {
                      around: (
                          context: NativePrefixCommandContext<M>,
                          rest: Effect.Effect<void, unknown, unknown>,
                      ): Effect.Effect<void, unknown, unknown> =>
                          nativeAround(
                              settings.use,
                              context,
                              rest,
                              report && ((cause) => report(message, context.name, cause)),
                          ),
                  }),
            ...(report === undefined
                ? {}
                : {
                      failed: (name: string | undefined, cause: Cause.Cause<unknown>) =>
                          report(message, name, cause) as unknown as Effect.Effect<void>,
                  }),
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
                    help: (options?: CommandContextHelpOptions) => this.help(contextHelpOptions(options, match.prefix)),
                }) as NativePrefixCommandContext<M>,
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
                          nativeCallback(
                              () =>
                                  settings.onUnmatched!(
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
                Effect.gen(function* () {
                    for (const guard of definition.guards) {
                        const verdict: PrefixCommandGuardResult = yield* nativeCallback(
                            () => guard(context),
                            "A native command guard must return an Effect",
                        )
                        if (verdict !== true) return verdict
                    }
                    return true
                }),
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
                    // The remaining cooldown uses the handler's Clock time, the same Clock that claimed the cooldown
                    const text = rejectionReply(rejection, metadata, context.prefix, now)
                    return text === undefined ? Effect.void : Effect.suspend(() => context.reply(text))
                }
                return nativeCallback(
                    () => feedback(context, rejection),
                    "A native command onReject callback must return an Effect",
                )
            },
            cooldown: (definition, context, routerStore) => nativeCooldown(definition, context, routerStore),
            execute: (definition, context) =>
                nativeCallback(
                    () => definition.execute(context),
                    "A native command execute callback must return an Effect",
                ),
        }) as Effect.Effect<void, ConfigurationError, R>
    }
}

interface NativeRouterSettings<M extends MessageCore> {
    readonly onUnmatched?: (
        context: NativePrefixCommandUnmatchedContext<M>,
        unmatched: PrefixCommandUnmatched,
    ) => Effect.Effect<unknown, unknown, unknown>
    readonly onReject?: NativePrefixCommandRejectionFeedback<unknown, unknown, M>
    readonly use: readonly NativePrefixCommandMiddleware<unknown, unknown, M>[]
}

function snapshotNativeSettings<E, R, M extends MessageCore>(
    options: NativePrefixCommandsOptions<E, R, M>,
): NativeRouterSettings<M> {
    const { onUnmatched, onReject, use } = options
    if (onUnmatched !== undefined && typeof onUnmatched !== "function")
        throw new ConfigurationError("commands", 'The option "onUnmatched" must be a function')
    if (onReject !== undefined && onReject !== "reply" && onReject !== "silent" && typeof onReject !== "function")
        throw new ConfigurationError("commands", 'The option "onReject" must be "reply", "silent" or a function')
    return Object.freeze({
        ...(onUnmatched === undefined ? {} : { onUnmatched: onUnmatched as NativeRouterSettings<M>["onUnmatched"] }),
        ...(onReject === undefined ? {} : { onReject: onReject as NativeRouterSettings<M>["onReject"] }),
        use: nativeFunctions<NativePrefixCommandMiddleware<unknown, unknown, M>>(
            use,
            'The option "use" must be an array of middleware functions',
        ),
    }) as NativeRouterSettings<M>
}

function nativeFunctions<F>(value: unknown, message: string): readonly F[] {
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

/**
 * Run middleware in order around the rest of a command. Each stage, including the rest, runs at most once: The first
 * evaluation of a `next` starts it, and repeated or concurrent evaluations wait for that run's exit.
 * The command's failure is reported once with its command name whether middleware recovers from it, rethrows it or
 * replaces it. A different middleware failure is reported after it, and interruption keeps an earlier command failure
 */
function nativeAround<M extends MessageCore>(
    middleware: readonly NativePrefixCommandMiddleware<unknown, unknown, M>[],
    context: NativePrefixCommandContext<M>,
    rest: Effect.Effect<void, unknown, unknown>,
    report: ((cause: Cause.Cause<unknown>) => Effect.Effect<void>) | undefined,
): Effect.Effect<void, unknown, unknown> {
    return Effect.suspend(() => {
        let outcome: Exit.Exit<void, unknown> | undefined
        // The latch is set before the stage starts, so a concurrent evaluation waits instead of starting it again
        const once = (stage: Effect.Effect<void, unknown, unknown>): Effect.Effect<void, unknown, unknown> => {
            let latch: Deferred.Deferred<void, unknown> | undefined
            return Effect.suspend(() => {
                if (latch !== undefined) return Deferred.await(latch)
                const started = Deferred.makeUnsafe<void, unknown>()
                latch = started
                return stage.pipe(Effect.onExit((exit) => Deferred.done(started, exit)))
            })
        }
        const last = once(
            rest.pipe(
                Effect.onExit((exit) =>
                    Effect.sync(() => {
                        outcome = exit
                    }),
                ),
            ),
        )
        const chain = middleware.reduceRight<Effect.Effect<void, unknown, unknown>>(
            (next, step) =>
                once(
                    nativeCallback(
                        // The rest keeps the attachment context, so middleware sees it as needing no further services
                        () => step(context, next as Effect.Effect<void, unknown>),
                        "Native command middleware must return an Effect",
                    ).pipe(Effect.asVoid),
                ),
            last,
        )
        const settle = settleNativeAround(() => outcome, report)
        return chain.pipe(
            Effect.exit,
            Effect.flatMap((exit) => settle.finish(Exit.isSuccess(exit) ? undefined : exit.cause)),
            Effect.onExit(() => settle.saved),
        )
    })
}

/**
 * Settle a native command wrapped by middleware. The command's own failure is reported once, with its command name,
 * whether middleware succeeded, threw it again or failed differently. A different middleware failure is reported after it.
 * The `saved` argument reports a command failure that nothing else settled, such as after interruption
 */
function settleNativeAround(
    restExit: () => Exit.Exit<void, unknown> | undefined,
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
                middlewareFailure === failure ||
                (!Cause.hasInterrupts(middlewareFailure) && primaryError(middlewareFailure) === primaryError(failure))
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

function snapshotNativeCommand<E, R, S extends CommandArgumentSchema, M extends MessageCore>(
    command: NativePrefixCommand<E, R, S, M>,
    keyedName?: string,
): StoredNativeCommand<M> {
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
              : nativeFunctions<NativePrefixCommandGuard<E, R, M>>(
                    guard,
                    'The option "guard" must be a function or an array of functions',
                )
    if (onReject !== undefined && onReject !== "reply" && onReject !== "silent" && typeof onReject !== "function")
        throw new ConfigurationError("command", 'The option "onReject" must be "reply", "silent" or a function')
    const cooldown = snapshotCommandCooldown(sourceCooldown)
    const definition = snapshotCommandDefinition(command, keyedName)
    return Object.freeze({
        ...definition,
        execute: execute as StoredNativeCommand<M>["execute"],
        guards: guards as StoredNativeCommand<M>["guards"],
        ...(onReject === undefined ? {} : { onReject: onReject as StoredNativeCommand<M>["onReject"] }),
        ...(cooldown === undefined ? {} : { cooldown: cooldown as NonNullable<StoredNativeCommand<M>["cooldown"]> }),
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
            throw new ConfigurationError("command", `The command batch entry ${JSON.stringify(name)} must be an object`)
        if (Object.prototype.hasOwnProperty.call(value, "name"))
            throw new ConfigurationError(
                "command",
                `The command batch entry ${JSON.stringify(name)} must not set "name", because its object key is the name`,
            )
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
    routerStore: LocalMemoryCooldownStore,
): Effect.Effect<{ readonly key: string; readonly claim: unknown } | undefined, unknown, unknown> {
    const cooldown = definition.cooldown
    if (cooldown === undefined) return Effect.succeed(undefined)
    return Effect.suspend(() =>
        Effect.succeed(cooldown.key?.(context) ?? cooldownSuffix(cooldown.per, context.message)),
    ).pipe(
        Effect.flatMap((key) =>
            configurationEffect(() => cooldownRequest(context.path ?? definition.name, key, cooldown.durationMs)),
        ),
        Effect.flatMap((request) => {
            const store = cooldown.store
            const claim: Effect.Effect<unknown, unknown, unknown> =
                store === undefined
                    ? Clock.clockWith((clock) =>
                          configurationEffect(() => {
                              const claimed = routerStore.claim(request, clock.currentTimeMillisUnsafe())
                              if (claimed._tag === "Failure") throw claimed.error
                              return claimed.value
                          }),
                      )
                    : Effect.suspend(() => {
                          const claimed = store.claim(request)
                          return Effect.isEffect(claimed) ? claimed : Effect.succeed(claimed)
                      })
            return Effect.map(claim, (value) => ({ key: request.key, claim: value }))
        }),
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
                suspendMarked(() => {
                    const result = owner.claim(
                        readCaller(() => snapshotClaimInput(input)),
                        clock.currentTimeMillisUnsafe(),
                    )
                    return result._tag === "Success" ? Effect.succeed(result.value) : Effect.die(result.error)
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

/**
 * Run local command setup, keeping ConfigurationError for misuse. A throw from a marked read of caller definitions or
 * options is an application fault, and any other throw, such as from building the registry, is an SDK fault
 */
function localSetup<A>(create: () => A): A {
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

/**
 * Create the native router a runBot commands option describes, registering its keyed commands or its register callback.
 * Rejections are answered with `onReject: "reply"` unless the option selects other feedback.
 * Misuse throws ConfigurationError. A register callback's own throw becomes ApplicationError naming `runBot commands`
 */
export function nativeBotRouter<M extends MessageCore>(options: unknown): NativePrefixCommandRouter<unknown, M> {
    if (typeof options !== "object" || options === null || Array.isArray(options))
        throw new ConfigurationError("commands", "The commands option must be an object")
    checkBotCommandKeys(options, ["onUnmatched", "onReject", "use"])
    const { commands: definitions, onError: _onError, ...settings } = options as Record<string, unknown>
    const router = nativeCommands.create<unknown, unknown, M>({
        ...settings,
        onReject: settings.onReject ?? "reply",
    } as unknown as NativePrefixCommandsOptions<unknown, unknown, M>)
    if (typeof definitions === "function") {
        const registered: unknown = registerCallback(() => (definitions as (router: unknown) => unknown)(router))
        if (!(registered instanceof NativePrefixCommandRouterOwner))
            throw new ConfigurationError("commands", "A commands register callback must return the registered router")
        return registered as NativePrefixCommandRouter<unknown, M>
    }
    return router.registerMany(definitions as never) as NativePrefixCommandRouter<unknown, M>
}
