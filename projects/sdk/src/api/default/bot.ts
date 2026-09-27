import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { errAsync, okAsync, ResultAsync, type Result } from "neverthrow"
import { CriticalWorkerStoppedError, type RunBotOptions } from "#sdk/bot-runner"
import {
    reportBotFailure,
    runBotCore,
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

type BotFailure = ConnectError | CancelledError | CriticalWorkerStoppedError | ApplicationError
/** Failures the runner observes from client operations. Its own signal is always valid, so a signal ConfigurationError
 * cannot occur. An overflowing subscription's EventOverflowError is caught before the Result, and a failed setup
 * callback adds ApplicationError
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
 * Prefix commands for runBot: The router options of commands.create, the commands themselves and an optional failure hook.
 * The router is attached before the gateway starts and closed when the bot stops.
 * Unlike commands.create, runBot replies to a rejected command by default, such as one with a missing argument, as
 * `onReject: "reply"` does. Set `onReject: "silent"` to send no reply, or a function to give custom feedback
 *
 * @category Commands
 */
export interface BotCommandsOptions<
    M extends MessageCore = Message,
    S extends Readonly<Record<string, unknown>> = Readonly<Record<string, CommandArgumentSchema | undefined>>,
> extends DefaultPrefixCommandsOptions<M> {
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
 * Configure a bot: Client settings, event handlers, prefix commands, optional startup work and stop signals
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
     * waiting event with a Warn record instead of stopping the bot
     */
    readonly events?: BotEvents<SelectedMessage<F>>
    /** Prefix commands registered and attached before connecting. See BotCommandsOptions */
    readonly commands?: BotCommandsOptions<SelectedMessage<F>, S>
    /**
     * Startup work after events and commands are registered and before the gateway connects, such as extra subscriptions
     * or cache warm-up. The bot connects only after a returned promise settles, so no handler runs before setup finishes.
     * A throw, rejection or returned or resolved Err result stops the bot before connecting, and runBot returns an Err
     * ApplicationError whose source is "runBot setup" and whose cause is the original value, such as the
     * GuildOperationError of a failed read. A thrown SdkDefect remains a defect and rejects with SdkDefect
     */
    readonly setup?: (client: Client<SelectedMessage<F>>) => unknown
}

/**
 * Start a bot from event handlers and prefix commands, and watch its connection and subscriptions.
 * The client is created and every handler and command is registered synchronously, before this function returns and
 * before the gateway connects, so no event is missed and no handler runs before registration and setup complete.
 * Invalid options, such as a missing token from an unset environment variable, a misspelled option key, an unknown event
 * name, invalid delivery settings or an invalid command, throw ConfigurationError at once. Every option is checked before any client, signal
 * listener or request exists, even when the signal is already aborted, so misuse leaves nothing to clean up.
 * The returned ResultAsync then runs the bot until it stops.
 * Handler contexts expose the full client. Message-create contexts also expose message and a cancellation-aware reply.
 * Handler and command failures are reported to onError, or logged in full, without restarting them or stopping the bot.
 * Process signals are opt-in, and stopping waits for SDK cleanup, not unrelated application Promises.
 * Expected runner failures return Err, including ApplicationError when the setup callback or a commands register
 * callback fails, and SDK defects reject with SdkDefect.
 * By default a failed run is also logged once, with code lifecycle.botFailed unless the client already logged that
 * error, and sets process.exitCode to 1, so `await runBot({...})` needs no further handling.
 * Set reportFailure to false when the application handles the returned failure and exit status itself.
 * An option getter that throws while the options are checked throws SdkDefect with code application.defect and the
 * thrown value as the cause, before any client exists
 *
 * @remarks
 * Aborting the optional signal requests a normal stop, not a cancellation Err. A requested stop first stops accepting
 * events and lets running handlers and their requests finish for up to drainMs, default 5,000 ms. Success means the client has
 * stopped and cleanup has finished. The runner always shuts down its client, including after a failure.
 * If an event or command subscription closes normally while the bot is still running, the result fails with
 * CriticalWorkerStoppedError. A handler set to overflow "stop" that overflows is reported, and the bot keeps running
 * without it.
 * Process signal listeners are removed when the run finishes, and the runner never exits the process
 *
 * @example
 * ```ts
 * import { runBot } from "@neontechspace/fluxerly"
 *
 * export function pingBot(token: string | undefined) {
 *     return runBot({
 *         token,
 *         processSignals: true,
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
): ResultAsync<void, ConnectError | CancelledError | CriticalWorkerStoppedError | ApplicationError> {
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
    const { events, commands, setup, signal, processSignals, reportFailure, drainMs, clientOptions } = readBotOptions(
        () => {
            const { events, commands, setup, signal, processSignals, reportFailure, drainMs, ...clientOptions } =
                options
            return { events, commands, setup, signal, processSignals, reportFailure, drainMs, clientOptions }
        },
    )
    readBotOptions(() => validateRunOptions({ signal, processSignals, reportFailure, drainMs }))
    const runOptions: RunBotOptions = {
        ...(signal === undefined ? {} : { signal }),
        ...(processSignals === undefined ? {} : { processSignals }),
        ...(reportFailure === undefined ? {} : { reportFailure }),
        ...(drainMs === undefined ? {} : { drainMs }),
    }
    // All configuration is checked before any client, listener or request exists, so misuse has no side effects.
    // An already aborted signal still reports misuse rather than hiding it
    const { entries, router, commandHook, commandsFailure } = prepareBot<M>(
        events,
        commands as BotCommandsOptions<M, never> | undefined,
        setup,
    )
    readBotOptions(() => validateBotClientOptions(clientOptions, false))
    // The callback already ran, so its failure is returned even when the signal is already aborted
    if (commandsFailure !== undefined) {
        Effect.runSync(
            reportBotFailure(Exit.fail(commandsFailure), standaloneBotLogger(clientOptions, false), runOptions),
        )
        return errAsync<void, BotFailure>(commandsFailure)
    }
    if (readBotOptions(() => signal?.aborted)) return okAsync<void, BotFailure>(undefined)
    const client = createClient<F>(clientOptions as ClientOptions<F>)
    let subscriptions: readonly Subscription[]
    try {
        subscriptions = registerBot(client, entries, router, commandHook)
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
    // The client exists before the runner starts, so the runner owns its shutdown only once it takes the client
    let taken = false
    const program = runBotCore(
        Effect.sync(() => {
            taken = true
            return {
                source: client,
                logging: clientServices(client)?.logging,
                get state() {
                    return client.state
                },
                run: () => botOperation((signal) => client.run({ signal }), true),
                shutdown: shutdownClient,
            }
        }),
        () =>
            (setup === undefined
                ? Effect.void
                : Effect.tryPromise({ try: () => runBotSetup(setup, client), catch: (error) => error }).pipe(
                      // Setup failures, such as a failed read, are application outcomes. An SDK defect stays a defect
                      Effect.catch((error) =>
                          error instanceof ApplicationError ? Effect.fail(error) : Effect.die(error),
                      ),
                  )
            ).pipe(
                Effect.as(
                    subscriptions.map((subscription) => ({
                        // An overflowing event subscription was already reported, and the bot keeps running without it
                        waitForClose: () =>
                            botOperation((signal) => subscription.waitForClose({ signal })).pipe(
                                Effect.catchIf(
                                    (error): error is EventOverflowError => error instanceof EventOverflowError,
                                    () =>
                                        botOperation((signal) => client.waitForClose({ signal })).pipe(
                                            Effect.exit,
                                            Effect.asVoid,
                                        ),
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
    commands: BotCommandsOptions<M> | undefined,
    setup: unknown,
) {
    if (setup !== undefined && typeof setup !== "function")
        throw new ConfigurationError("configuration", 'The option "setup" must be a function')
    const entries = readBotOptions(() => snapshotBotEvents(events))
    let router: DefaultPrefixCommandRouter<M> | undefined
    let commandsFailure: ApplicationError | undefined
    try {
        router = commands === undefined ? undefined : readBotOptions(() => botRouter<M>(commands))
    } catch (error) {
        // A register callback's own failure is an application outcome, returned once the other options are checked
        if (!(error instanceof ApplicationError)) throw error
        commandsFailure = error
    }
    const commandHook = readBotOptions(() => commands?.onError)
    if (commandHook !== undefined && typeof commandHook !== "function")
        throw new ConfigurationError("onError", 'The option "commands.onError" must be a function')
    return { entries, router, commandHook, commandsFailure }
}

/**
 * Run a bot's setup callback once. A throw, rejection or returned Err rejects with ApplicationError whose source is
 * "runBot setup" and whose cause is the original value. A thrown SdkDefect rejects unchanged
 */
async function runBotSetup<M extends MessageCore>(setup: (client: Client<M>) => unknown, client: Client<M>) {
    try {
        throwIfErr(await setup(client))
    } catch (error) {
        throw error instanceof SdkDefect ? error : new ApplicationError("runBot setup", error)
    }
}

/**
 * Register runBot events and commands on a test client with the same checks, contexts and registration as runBot,
 * returning the setup work that the test client runs before it connects. Used by the testing entry point.
 * Misuse throws ConfigurationError, and a commands register callback's own failure throws its ApplicationError
 */
export function installTestBot<M extends MessageCore>(
    client: Client<M>,
    options: Pick<BotOptions, "events" | "commands" | "setup">,
): () => Promise<void> {
    const { events, commands, setup } = readBotOptions(() => ({
        events: options.events,
        commands: options.commands,
        setup: options.setup,
    }))
    const prepared = prepareBot<M>(events, commands as BotCommandsOptions<M, never> | undefined, setup)
    if (prepared.commandsFailure !== undefined) throw prepared.commandsFailure
    registerBot(client, prepared.entries, prepared.router, prepared.commandHook)
    return setup === undefined
        ? async () => undefined
        : () => runBotSetup(setup as unknown as (client: Client<M>) => unknown, client)
}

/** Register the bot's event handlers and command router synchronously, returning the subscriptions to supervise */
function registerBot<M extends MessageCore>(
    client: Client<M>,
    entries: ReturnType<typeof snapshotBotEvents>,
    router: DefaultPrefixCommandRouter<M> | undefined,
    commandHook: ((report: FailureReport) => unknown) | undefined,
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
                        callback(
                            Object.freeze({
                                event: payload,
                                client,
                                signal,
                                ...(event === "messageCreate"
                                    ? { message: payload as M, reply: boundDefaultReply(client, payload as M, signal) }
                                    : {}),
                            }) as BotEventContext<EventName, M>,
                        ),
                    options as EventHandlerOptions,
                ),
            )
        }
        if (router !== undefined)
            subscriptions.push(router.attach(client, commandHook === undefined ? undefined : { onError: commandHook }))
        return subscriptions
    } catch (error) {
        for (const subscription of subscriptions) subscription.close()
        if (error instanceof ConfigurationError) throw error
        throw new SdkDefect("runBot", [defectReason(error)])
    }
}
