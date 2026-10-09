import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { errAsync, okAsync, ResultAsync, type Result } from "neverthrow"
import { CriticalWorkerStoppedError, type RunBotOptions } from "#sdk/bot-runner"
import {
    readIgnoreBots,
    reportBotFailure,
    runBotCore,
    skipsBotMessage,
    snapshotBotCommandDelivery,
    snapshotBotEvents,
    standaloneBotLogger,
    validateBotClientOptions,
    validateRunOptions,
} from "#sdk/internal/bot-runner"
import { clientServices } from "#sdk/internal/client-registry"
import { throwIfErr } from "#sdk/internal/failures"
import { defectReason } from "#sdk/internal/defects"
import type { ClientOptions, ShutdownOptions } from "#sdk/client"
import type { CommandArgumentSchema } from "#sdk/command-arguments"
import { ApplicationError, CancelledError, ConfigurationError, SdkDefect, type ConnectError } from "#sdk/errors"
import { EventOverflowError } from "#sdk/message-errors"
import type { Message, MessageCore, MessageFields, SelectedMessage, ReplyInput, SendOptions } from "#sdk/messages"
import type { HandlerOptions, EventMap, EventName } from "#sdk/events"
import type { FailureReport } from "#sdk/failures"
import {
    botRouter,
    boundDefaultReply,
    type DefaultPrefixCommandBatch,
    type DefaultPrefixCommandRouter,
    type DefaultPrefixCommandsOptions,
} from "#sdk/default-commands"
import { type Subscription, type EventHandlerOptions } from "./events.js"
import { type Client, createClient } from "./client.js"
import { type OperationFailure, fromExit } from "#sdk/internal/binding/execute"

type BotFailure = ConnectError | CancelledError | CriticalWorkerStoppedError | ApplicationError | ConfigurationError
/** Failures the runner observes from client operations. Its own signal is always valid, so a signal ConfigurationError
 * cannot occur. An overflowing subscription's EventOverflowError becomes CriticalWorkerStoppedError before the Result,
 * and a failed setup callback adds ApplicationError
 */
type RunnerFailure = Exclude<BotFailure, ApplicationError> | ConfigurationError | EventOverflowError

/**
 * Read or validate runBot options. Misuse, SDK defects and register-callback failures keep their errors, and any other
 * throw, such as from an option getter, is an application fault reported as an SdkDefect for runBot
 */
function readBotOptions<A>(read: () => A): A {
    try {
        return read()
    } catch (error) {
        if (error instanceof ConfigurationError || error instanceof SdkDefect || error instanceof ApplicationError)
            throw error
        throw new SdkDefect("runBot", [defectReason(error, "application")])
    }
}

function restoreTrustedSdkDefect<A, E extends OperationFailure>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return effect.pipe(
        Effect.catchCause((cause) => {
            const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined
            if (reason?._tag !== "Die" || !(reason.defect instanceof SdkDefect)) return Effect.failCause(cause)
            if (reason.defect.reasons.length === 0) return Effect.failCause(Cause.die(reason.defect))
            const restored = reason.defect.reasons.reduce<Cause.Cause<E>>(
                (combined, detail) =>
                    Cause.combine(
                        combined,
                        detail.kind === "Failure"
                            ? Cause.fail(detail.failure as E)
                            : detail.kind === "Interruption"
                              ? Cause.interrupt()
                              : Cause.die(detail.defect),
                    ),
                Cause.empty,
            )
            return Effect.failCause(restored)
        }),
    )
}

function botOperation<A, E extends RunnerFailure>(
    start: (signal: AbortSignal) => ResultAsync<A, E>,
    trustedSdkDefects = false,
): Effect.Effect<A, E> {
    const controller = new AbortController()
    const operation = Promise.resolve(start(controller.signal))
    const awaited = Effect.promise(() => operation)
    const observed = trustedSdkDefects ? restoreTrustedSdkDefect(awaited) : awaited
    return observed.pipe(
        Effect.flatMap((result) => (result.isErr() ? Effect.fail(result.error) : Effect.succeed(result.value))),
        Effect.onInterrupt(() =>
            Effect.sync(() => controller.abort()).pipe(
                Effect.andThen(observed),
                Effect.flatMap((result) =>
                    result.isErr() &&
                    result.error._tag !== "CancelledError" &&
                    result.error._tag !== "ClientClosedError"
                        ? Effect.fail(result.error)
                        : Effect.void,
                ),
            ),
        ),
    )
}

/**
 * Data and operations available to one configured bot event handler
 *
 * @category Client and lifecycle
 */
export type BotEventContext<K extends EventName, M extends MessageCore = Message> = {
    /** Frozen event payload, using this client's selected message fields where applicable */
    readonly event: EventMap<M>[K]
    /** Full client for operations beyond the event's convenience methods. The runner owns its lifetime */
    readonly client: Client<M>
    /** Cancels SDK operations passed this signal when the handler is stopped. It cannot stop arbitrary application Promises */
    readonly signal: AbortSignal
} & (K extends "messageCreate"
    ? {
          /** The same incoming message as event */
          readonly message: M
          /** Reply to this message with the handler's cancellation signal already applied. A string is sent as the content.
           * Uses client.messages.reply without extra retries. Returning the result from the handler reports an Err
           * like a thrown error, so `({ reply }) => reply("Pong")` needs no further checks.
           * An uncertain failure can leave a reply posted. Retaining this function does not extend the handler's lifetime
           */
          readonly reply: (
              input: ReplyInput | string,
              options?: SendOptions,
          ) => ReturnType<Client<M>["messages"]["reply"]>
      }
    : {})

/**
 * A runBot event handler. A returned or resolved Err result is reported like a thrown error, and other return values are ignored
 *
 * @category Client and lifecycle
 */
export type BotEventHandler<K extends EventName, M extends MessageCore = Message> = (
    context: BotEventContext<K, M>,
) => unknown

/** A runBot event handler with its own delivery settings.
 * Omitted settings use the runBot defaults: Overflow dropOldest, concurrency 8 for messageCreate or a partitioned handler and 1 otherwise,
 * and the client.on queue limits
 *
 * @category Client and lifecycle
 */
export interface BotEventOptions<K extends EventName, M extends MessageCore = Message> extends HandlerOptions<
    EventMap<M>[K]
> {
    /** Called for each event */
    readonly handler: BotEventHandler<K, M>
    /** Receive this handler's failures instead of the client-level onError */
    readonly onError?: (report: FailureReport) => unknown
}

/** One optional handler per event, as a function or an object with a handler and delivery settings.
 * The runBot function delivers with overflow dropOldest, so a full queue drops the oldest waiting event with a Warn record and a
 * counter instead of stopping the bot. Handlers for messageCreate run up to eight at a time by default, so they can finish
 * out of order, and other events run one at a time.
 * A failed handler is reported with its original error to onError, or logged in full, without stopping the
 * bot or retrying that handler
 *
 * @category Client and lifecycle
 */
export type BotEvents<M extends MessageCore = Message> = {
    readonly [K in EventName]?: BotEventHandler<K, M> | BotEventOptions<K, M> | undefined
}

/**
 * Prefix commands for runBot: The router options of commands.create, the commands themselves, an optional failure hook
 * and the delivery settings of the router's attach.
 * The router is attached before the gateway starts and closed when the bot stops.
 * The delivery settings concurrency, partition, overflow, maxPendingMessages and maxPendingBytes are passed to attach
 * unchanged and checked before any client exists. Omitted settings keep the attach defaults: Eight commands at a time
 * and overflow dropOldest, so a burst drops the oldest waiting message with a Warn record. With overflow "stop", a full
 * queue stops the bot with CriticalWorkerStoppedError.
 * Unlike commands.create, runBot replies to a rejected command by default, such as one with a missing argument, as
 * `onReject: "reply"` does. Set `onReject: "silent"` to send no reply, or a function to give custom feedback.
 * An unset ignoreBots follows the runBot ignoreBots setting
 *
 * @category Commands
 */
export interface BotCommandsOptions<
    M extends MessageCore = Message,
    S extends Readonly<Record<string, unknown>> = Readonly<Record<string, CommandArgumentSchema | undefined>>,
>
    extends DefaultPrefixCommandsOptions<M>, HandlerOptions<M> {
    /**
     * Commands keyed by name, such as `{ ping: { execute: ({ reply }) => reply("Pong") } }`, or a callback that
     * receives the empty router and returns it with registrations, for groups or commands built elsewhere.
     * The callback runs synchronously inside runBot. Invalid registrations and a return value other than the registered
     * router throw ConfigurationError. Any other throw from the callback creates no client, and runBot returns an Err
     * ApplicationError whose source is "runBot commands" and whose cause is the thrown value
     */
    readonly commands:
        DefaultPrefixCommandBatch<M, S> | ((router: DefaultPrefixCommandRouter<M>) => DefaultPrefixCommandRouter<M>)
    /** Receive command failures instead of the client-level onError, as the router attach option does */
    readonly onError?: (report: FailureReport) => unknown
}

/**
 * Configure a bot: Client settings, event handlers, prefix commands, optional startup work and stop signals.
 * A missing token or a commands-registration failure reported before client creation uses the configured logging
 * settings and masks the normalized token, including a token enclosed in matching quotes. Other misuse and
 * option-getter failures instead throw synchronously without a runner report or exit-status change
 *
 * @category Client and lifecycle
 */
export interface BotOptions<
    F extends MessageFields | undefined = undefined,
    S extends Readonly<Record<string, unknown>> = Readonly<Record<string, CommandArgumentSchema | undefined>>,
>
    extends ClientOptions<F>, RunBotOptions {
    /** Handlers registered before connecting and closed when the bot stops.
     * Own enumerable entries are read once when runBot is called. Undefined handlers are skipped.
     * Pass a function, or an object with a handler and its own delivery settings.
     * By default messageCreate runs up to 8 callbacks at a time and other events 1, and a full queue drops the oldest
     * waiting event with a Warn record instead of stopping the bot.
     * Bot-authored messageCreate and messageUpdate events skip these handlers unless ignoreBots is false
     */
    readonly events?: BotEvents<SelectedMessage<F>>
    /**
     * Skip messageCreate and messageUpdate events whose author is a bot, including this bot's own messages, before they
     * reach the events handlers or prefix commands. Defaults to true, so a reply cannot trigger its own handler.
     * Set false for a bridge or logging bot that handles every message, and check message.author.isBot where needed.
     * Prefix commands follow the same setting unless commands.ignoreBots sets its own.
     * A value other than a boolean throws ConfigurationError
     */
    readonly ignoreBots?: boolean
    /** Prefix commands registered and attached before connecting. See BotCommandsOptions */
    readonly commands?: BotCommandsOptions<SelectedMessage<F>, S>
    /**
     * Startup work after events and commands are registered and before the gateway connects, such as extra subscriptions,
     * cache warm-up or scheduled tasks. The bot connects only after a returned promise settles, so no handler runs before setup finishes.
     * Start timers and background work with client.schedule, whose tasks belong to the bot: A requested stop lets their
     * running work finish within drainMs, every stop cancels the rest, and a failure reaches onError or the log.
     * The signal aborts when the bot begins stopping for any reason, including a requested stop before its drain, a
     * failure and a stop while setup is still running. Pass it to SDK operations, or listen for its abort event to end
     * other work started here, which the runner does not track or await.
     * A throw, rejection or returned or resolved Err result stops the bot before connecting, and runBot returns an Err
     * ApplicationError whose source is "runBot setup" and whose cause is the original value, such as the
     * GuildOperationError of a failed read. A thrown SdkDefect remains a defect and rejects with SdkDefect.
     * The Effect API runs setup in the bot's Scope instead, so its finalizers and scoped fibers end with the bot
     */
    readonly setup?: (client: Client<SelectedMessage<F>>, context: { readonly signal: AbortSignal }) => unknown
}

/**
 * Start a bot from event handlers and prefix commands, and watch its connection and subscriptions.
 * The client is created and every handler and command is registered synchronously, before this function returns and
 * before the gateway connects, so no event is missed and no handler runs before registration and setup complete.
 * Invalid options, such as a misspelled option key, an unknown event name, invalid delivery settings or an invalid
 * command, throw ConfigurationError at once. Every option is checked before any client, signal listener or request
 * exists, even when the signal is already aborted, so misuse leaves nothing to clean up.
 * A missing or empty token, usually from an unset environment variable, is reported like a failed run instead: Once
 * every other option is valid, runBot returns an Err ConfigurationError with field token before any client exists.
 * The returned ResultAsync then runs the bot until it stops.
 * Handler contexts expose the full client. Message-create contexts also expose message and a cancellation-aware reply.
 * Handler and command failures are reported to onError, or logged in full, without restarting them or stopping the bot.
 * By default, SIGINT and SIGTERM request a normal stop and messages written by bots skip the events handlers and
 * prefix commands. Set processSignals or ignoreBots to false to opt out. Stopping waits for SDK cleanup, not unrelated application Promises.
 * Expected runner failures return Err, including ApplicationError when the setup callback or a commands register
 * callback fails and ConfigurationError for a missing token, and SDK defects reject with SdkDefect.
 * By default a failed run is also logged once, with code lifecycle.botFailed unless the client already logged that
 * error, and sets process.exitCode to 1, so `await runBot({...})` needs no further handling.
 * Set reportFailure to false when the application handles the returned failure and exit status itself.
 * A missing token or a commands-registration failure reported before client creation uses the configured logging
 * settings, prints no stack for the missing token and masks the token after removing surrounding whitespace and one pair
 * of matching quotes. Unusable logging settings are misuse.
 * An option getter that throws while the options are checked throws SdkDefect with code application.defect and the
 * thrown value as the cause, before any client exists. Other misuse and option-getter failures throw synchronously
 * without a runner report or exit-status change, regardless of reportFailure
 *
 * @remarks
 * Aborting the optional signal requests a normal stop, not a cancellation Err. A requested stop first stops accepting
 * events and lets running handlers, scheduled tasks and their requests finish for up to drainMs, default 5,000 ms. Success means the client has
 * stopped and cleanup has finished. The runner always shuts down its client, including after a failure.
 * If an event or command subscription closes while the bot is still running, the result fails with
 * CriticalWorkerStoppedError. That includes a handler or command router set to overflow "stop" whose queue overflows.
 * The overflow is still reported to onError or logged, and the error names the event and the exceeded capacity, with
 * the EventOverflowError as its cause.
 * Process signal listeners are removed when the run finishes, and the runner never exits the process
 *
 * @example
 * ```ts
 * import { runBot } from "@neontechspace/fluxerly"
 *
 * export function pingBot(token: string | undefined) {
 *     return runBot({
 *         token,
 *         commands: {
 *             prefix: "!",
 *             commands: {
 *                 ping: { execute: ({ reply }) => reply("Pong!") },
 *                 roll: {
 *                     arguments: { sides: { type: "integer", min: 2, max: 100, default: 6 } },
 *                     execute: ({ reply, values }) => reply(`${1 + Math.floor(Math.random() * values.sides)}`),
 *                 },
 *             },
 *         },
 *     })
 * }
 * ```
 *
 * @category Client and lifecycle
 */
export function runBot<
    const F extends MessageFields | undefined = undefined,
    const S extends Readonly<Record<string, unknown>> = Readonly<Record<string, CommandArgumentSchema | undefined>>,
>(
    options: BotOptions<F, S>,
): ResultAsync<
    void,
    ConnectError | CancelledError | CriticalWorkerStoppedError | ApplicationError | ConfigurationError
> {
    try {
        return startBot<F, S>(options)
    } catch (error) {
        // Misuse is found inside validation, so the stack starts at the caller's line instead, as in createClient
        if (error instanceof ConfigurationError) Error.captureStackTrace(error, runBot)
        throw error
    }
}

function startBot<const F extends MessageFields | undefined, const S extends Readonly<Record<string, unknown>>>(
    options: BotOptions<F, S>,
): ResultAsync<void, BotFailure> {
    type M = SelectedMessage<F>
    if (typeof options !== "object" || options === null || Array.isArray(options))
        throw new ConfigurationError("configuration", "The runBot options must be an object")
    const { events, ignoreBots, commands, setup, signal, processSignals, reportFailure, drainMs, clientOptions } =
        readBotOptions(() => {
            const {
                events,
                ignoreBots,
                commands,
                setup,
                signal,
                processSignals,
                reportFailure,
                drainMs,
                ...clientOptions
            } = options
            return {
                events,
                ignoreBots,
                commands,
                setup,
                signal,
                processSignals,
                reportFailure,
                drainMs,
                clientOptions,
            }
        })
    readBotOptions(() => validateRunOptions({ signal, processSignals, reportFailure, drainMs }))
    const runOptions: RunBotOptions = {
        ...(signal === undefined ? {} : { signal }),
        // The default API handles process signals unless the application opts out
        processSignals: processSignals !== false,
        ...(reportFailure === undefined ? {} : { reportFailure }),
        ...(drainMs === undefined ? {} : { drainMs }),
    }
    // All configuration is checked before any client, listener or request exists, so misuse has no side effects.
    // An already aborted signal still reports misuse rather than hiding it
    const { entries, skipBots, router, commandHook, commandDelivery, commandsFailure } = prepareBot<M>(
        events,
        ignoreBots,
        commands as BotCommandsOptions<M, never> | undefined,
        setup,
    )
    // A missing token and the callback's failure are returned even when the signal is already aborted
    const failure = readBotOptions(() => validateBotClientOptions(clientOptions, false)) ?? commandsFailure
    if (failure !== undefined) {
        Effect.runSync(reportBotFailure(Exit.fail(failure), standaloneBotLogger(clientOptions, false), runOptions))
        return errAsync<void, BotFailure>(failure)
    }
    if (readBotOptions(() => signal?.aborted)) return okAsync<void, BotFailure>(undefined)
    const client = createClient<F>(clientOptions as ClientOptions<F>)
    let subscriptions: readonly Subscription[]
    try {
        subscriptions = registerBot(client, { entries, skipBots, router, commandHook, commandDelivery })
    } catch (error) {
        // Validated registration cannot be misuse here, so this is a defect. The unused client owns no socket yet,
        // and its cleanup failure is logged by the client
        void client
            .shutdown()
            .then(undefined, (defect: unknown) => clientServices(client)?.logging.outputFailure(defect))
        throw error
    }
    const shutdownClient = (options?: ShutdownOptions) =>
        restoreTrustedSdkDefect(Effect.promise(() => client.shutdown(options))).pipe(Effect.asVoid)
    // Every way the runner stops shuts its client down, so aborting there tells setup work that the bot is stopping
    const stopping = new AbortController()
    // The client exists before the runner starts, so the runner owns its shutdown only once it takes the client
    let taken = false
    const program = runBotCore(
        Effect.sync(() => {
            taken = true
            return {
                source: client,
                logger: clientServices(client)?.logging,
                get state() {
                    return client.state
                },
                run: () => botOperation((signal) => client.run({ signal }), true),
                shutdown: (options?: ShutdownOptions) =>
                    Effect.sync(() => stopping.abort()).pipe(Effect.andThen(shutdownClient(options))),
            }
        }),
        () =>
            (setup === undefined
                ? Effect.void
                : Effect.tryPromise({
                      try: () => runBotSetup(setup, client, stopping.signal),
                      catch: (error) => error,
                  }).pipe(
                      // Setup failures, such as a failed read, are application outcomes. An SDK defect stays a defect
                      Effect.catch((error) =>
                          error instanceof ApplicationError ? Effect.fail(error) : Effect.die(error),
                      ),
                  )
            ).pipe(
                Effect.as(
                    subscriptions.map((subscription, index) => ({
                        // A subscription stopped by overflow "stop" stops the bot, naming its event and capacity
                        waitForClose: () =>
                            botOperation((signal) => subscription.waitForClose({ signal })).pipe(
                                Effect.mapError((error) =>
                                    error instanceof EventOverflowError
                                        ? new CriticalWorkerStoppedError(index, {
                                              // The command router follows the event handlers and receives messageCreate
                                              event: entries[index]?.event ?? "messageCreate",
                                              error,
                                          })
                                        : error,
                                ),
                            ),
                    })),
                ),
            ),
        runOptions,
    ).pipe(Effect.ensuring(Effect.suspend(() => (taken ? Effect.void : shutdownClient()))))
    // fromExit returns a single failure unchanged, including the setup ApplicationError that no client operation returns
    return new ResultAsync(
        Effect.runPromiseExit(program as Effect.Effect<void, RunnerFailure>).then(
            (exit) => fromExit<void, RunnerFailure>(exit, "runBot") as Result<void, BotFailure>,
        ),
    )
}

/**
 * Read and check a bot's event handlers, commands and setup callback before any client exists. Misuse throws
 * ConfigurationError. A commands register callback's own failure is returned as commandsFailure, so the caller can
 * finish checking the other options first
 */
function prepareBot<M extends MessageCore>(
    events: unknown,
    ignoreBots: unknown,
    commands: BotCommandsOptions<M> | undefined,
    setup: unknown,
) {
    if (setup !== undefined && typeof setup !== "function")
        throw new ConfigurationError("configuration", 'The option "setup" must be a function')
    const entries = readBotOptions(() => snapshotBotEvents(events))
    const skipBots = readIgnoreBots(ignoreBots)
    let router: DefaultPrefixCommandRouter<M> | undefined
    let commandsFailure: ApplicationError | undefined
    try {
        router = commands === undefined ? undefined : readBotOptions(() => botRouter<M>(commands, skipBots))
    } catch (error) {
        // A register callback's own failure is an application outcome, returned once the other options are checked
        if (!(error instanceof ApplicationError)) throw error
        commandsFailure = error
    }
    const commandHook = readBotOptions(() => commands?.onError)
    if (commandHook !== undefined && typeof commandHook !== "function")
        throw new ConfigurationError("onError", 'The option "commands.onError" must be a function')
    const commandDelivery =
        commands === undefined ? undefined : readBotOptions(() => snapshotBotCommandDelivery(commands))
    return { entries, skipBots, router, commandHook, commandDelivery, commandsFailure }
}

/**
 * Run a bot's setup callback once with the signal that aborts when the bot begins stopping. A throw, rejection or
 * returned Err rejects with ApplicationError whose source is "runBot setup" and whose cause is the original value.
 * A thrown SdkDefect rejects unchanged
 */
async function runBotSetup<M extends MessageCore>(
    setup: (client: Client<M>, context: { readonly signal: AbortSignal }) => unknown,
    client: Client<M>,
    signal: AbortSignal,
) {
    try {
        throwIfErr(await setup(client, Object.freeze({ signal })))
    } catch (error) {
        throw error instanceof SdkDefect ? error : new ApplicationError("runBot setup", error)
    }
}

/**
 * Register runBot events and commands on a test client with the same checks, contexts and registration as runBot,
 * returning the setup work that the test client runs before it connects, given the signal that aborts when the test
 * client stops. Used by the testing entry point.
 * Misuse throws ConfigurationError, and a commands register callback's own failure throws its ApplicationError
 */
export function installTestBot<M extends MessageCore>(
    client: Client<M>,
    options: Pick<BotOptions, "events" | "ignoreBots" | "commands" | "setup">,
): (signal: AbortSignal) => Promise<void> {
    const { events, ignoreBots, commands, setup } = readBotOptions(() => ({
        events: options.events,
        ignoreBots: options.ignoreBots,
        commands: options.commands,
        setup: options.setup,
    }))
    const prepared = prepareBot<M>(events, ignoreBots, commands as BotCommandsOptions<M, never> | undefined, setup)
    if (prepared.commandsFailure !== undefined) throw prepared.commandsFailure
    registerBot(client, prepared)
    return setup === undefined
        ? async () => undefined
        : (signal) =>
              runBotSetup(
                  setup as unknown as (client: Client<M>, context: { readonly signal: AbortSignal }) => unknown,
                  client,
                  signal,
              )
}

/** Register the bot's event handlers and command router synchronously, returning the subscriptions to supervise */
function registerBot<M extends MessageCore>(
    client: Client<M>,
    {
        entries,
        skipBots,
        router,
        commandHook,
        commandDelivery,
    }: Pick<ReturnType<typeof prepareBot<M>>, "entries" | "skipBots" | "router" | "commandHook" | "commandDelivery">,
): readonly Subscription[] {
    const subscriptions: Subscription[] = []
    try {
        for (const { event, handler, options } of entries) {
            // The snapshot validates functions, and client.on validates event names and delivery settings
            const callback = handler as (context: BotEventContext<EventName, M>) => unknown
            subscriptions.push(
                client.on(
                    event,
                    (payload, signal) =>
                        skipsBotMessage(event, payload, skipBots)
                            ? undefined
                            : callback(
                                  Object.freeze({
                                      event: payload,
                                      client,
                                      signal,
                                      ...(event === "messageCreate"
                                          ? {
                                                message: payload as M,
                                                reply: boundDefaultReply(client, payload as M, signal),
                                            }
                                          : {}),
                                  }) as BotEventContext<EventName, M>,
                              ),
                    options as EventHandlerOptions,
                ),
            )
        }
        if (router !== undefined)
            subscriptions.push(
                router.attach(client, {
                    ...commandDelivery,
                    ...(commandHook === undefined ? {} : { onError: commandHook }),
                } as EventHandlerOptions),
            )
        return subscriptions
    } catch (error) {
        for (const subscription of subscriptions) subscription.close()
        if (error instanceof ConfigurationError) throw error
        throw new SdkDefect("runBot", [defectReason(error)])
    }
}
