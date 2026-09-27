import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Scope from "effect/Scope"
import {
    reportBotFailure,
    runBotCore,
    snapshotBotEvents,
    standaloneBotLogger,
    validateBotClientOptions,
    validateRunOptions,
} from "#sdk/internal/bot-runner"
import { ApplicationError, ConfigurationError, type ConnectError } from "#sdk/errors"
import type { CriticalWorkerStoppedError, RunBotOptions } from "#sdk/bot-runner"
import { EventOverflowError, type SendError } from "#sdk/message-errors"
import type { Message, MessageCore, MessageFields, SelectedMessage, ReplyInput, SendOptions } from "#sdk/messages"
import type { HandlerOptions, EventMap, EventName } from "#sdk/events"
import type { CommandArgumentSchema } from "#sdk/command-arguments"
import {
    nativeBotRouter,
    type NativeBatchRequirements,
    type NativePrefixCommandBatch,
    type NativePrefixCommandRouter,
    type NativePrefixCommandsOptions,
} from "#sdk/native-commands"
import { type ClientOptions, type Client, createClient } from "./client.js"
import { type FailureReport } from "./failures.js"
import { type Subscription, type EventHandlerOptions } from "./events.js"

/**
 * Give a bot handler its event payload and client. The messageCreate context also provides
 * `message` as an alias for the payload and `reply`, which uses the client's native messages.reply operation.
 * The reply Effect sends only when executed and retains its normal SendError and interruption behavior
 *
 * @category Client and lifecycle
 */
export type BotEventContext<K extends EventName, M extends MessageCore = Message> = {
    /** The payload delivered by the named gateway event */
    readonly event: EventMap<M>[K]
    /** The client owned by this bot run. Do not retain it after the run stops */
    readonly client: Client<M>
} & (K extends "messageCreate"
    ? {
          /** The messageCreate payload, identical to event */
          readonly message: M
          /** Build a native reply Effect targeting this message. A string is sent as the content. Executing it can fail with SendError */
          readonly reply: (input: ReplyInput | string, options?: SendOptions) => Effect.Effect<M, SendError>
      }
    : {})

/**
 * A native runBot event handler
 *
 * @category Client and lifecycle
 */
export type BotEventHandler<K extends EventName, E = never, R = never, M extends MessageCore = Message> = (
    context: BotEventContext<K, M>,
) => Effect.Effect<unknown, E, R>

/** A native runBot event handler with its own delivery settings.
 * Omitted settings use the runBot defaults: Overflow dropOldest, concurrency 8 for messageCreate or a partitioned handler and 1 otherwise,
 * and the client.on queue limits
 *
 * @category Client and lifecycle
 */
export interface BotEventOptions<
    K extends EventName,
    E = never,
    R = never,
    M extends MessageCore = Message,
> extends HandlerOptions<EventMap<M>[K]> {
    /** Called for each event */
    readonly handler: BotEventHandler<K, E, R, M>
    /** Receive this handler's failures instead of the client-level onError */
    readonly onError?: (report: FailureReport) => Effect.Effect<unknown, E, R>
}

/** One optional handler per event, as a function or an object with a handler and delivery settings.
 * The runBot function delivers with overflow dropOldest, so a full queue drops the oldest waiting event with a Warn record and a
 * counter instead of stopping the bot. Handlers for messageCreate run up to eight at a time by default, and other events
 * run one at a time. A failed handler is reported with its original Cause without stopping the bot
 *
 * @category Client and lifecycle
 */
export type BotEvents<E = never, R = never, M extends MessageCore = Message> = {
    readonly [K in EventName]?: BotEventHandler<K, E, R, M> | BotEventOptions<K, E, R, M> | undefined
}

/**
 * The keyed-command constraint the native runBot infers command services from: Each entry's optional argument schema and callback
 *
 * @category Commands
 */
export type BotCommandEntries<S> = Readonly<
    Record<
        keyof S,
        {
            /** Argument schema of the command under this key */
            readonly arguments?: CommandArgumentSchema
            /** Command callback, whose required services runBot adds to its own requirements */
            readonly execute: unknown
        }
    >
>

/**
 * Prefix commands for the native runBot: The router options of commands.create, the commands themselves and an optional
 * failure hook. Router-level callbacks, such as onUnmatched and middleware, run without extra services, while each
 * command's services are added to the bot's requirements. The router is attached before the gateway starts and closed when the bot stops.
 * Unlike commands.create, runBot replies to a rejected command by default, such as one with a missing argument, as
 * `onReject: "reply"` does. Set `onReject: "silent"` to send no reply, or a function to give custom feedback
 *
 * @category Commands
 */
export interface BotCommandsOptions<
    M extends MessageCore = Message,
    S extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
    C extends BotCommandEntries<S> = BotCommandEntries<S>,
    RouterServices = never,
> extends NativePrefixCommandsOptions<unknown, never, M> {
    /**
     * Commands keyed by name, such as `{ ping: { execute: ({ reply }) => reply("Pong") } }`, or a callback that
     * receives the empty router and returns it with registrations, for groups or commands built elsewhere.
     * The callback runs synchronously when the runBot Effect runs. Invalid registrations and a return value other than
     * the registered router are misuse and die with ConfigurationError. Any other throw from the callback creates no
     * client, and runBot fails with ApplicationError whose source is "runBot commands" and whose cause is the thrown value
     */
    readonly commands:
        | (C & NativePrefixCommandBatch<M, S>)
        | ((router: NativePrefixCommandRouter<never, M>) => NativePrefixCommandRouter<RouterServices, M>)
    /** Receive command failures instead of the client-level onError, as the router attach option does */
    readonly onError?: (report: FailureReport) => Effect.Effect<unknown, unknown, never>
}

/**
 * Configure one Effect bot with client settings, optional stop signals, event handlers, prefix commands and startup work.
 * The token accepts an unvalidated environment value, and a missing or blank value is misuse that dies with
 * ConfigurationError. Client settings, including messageFields and cache callbacks, retain their native semantics.
 * Handlers and commands are registered when the Effect runs, before the gateway starts
 *
 * @category Client and lifecycle
 */
export type BotOptions<
    EventError = never,
    EventServices = never,
    OptionsError = never,
    OptionsServices = never,
    F extends MessageFields | undefined = undefined,
> = ClientOptions<OptionsError, OptionsServices, F> &
    RunBotOptions & {
        /** Event handlers registered before the gateway starts and closed when the bot stops.
         * Pass a function, or an object with a handler and its own delivery settings.
         * By default messageCreate runs up to 8 callbacks at a time and other events 1, and a full queue drops the oldest
         * waiting event with a Warn record instead of stopping the bot
         */
        readonly events?: BotEvents<EventError, EventServices, SelectedMessage<F>>
        /** Prefix commands registered and attached before the gateway starts. See BotCommandsOptions */
        readonly commands?: BotCommandsOptions<SelectedMessage<F>>
        /**
         * Startup work after events and commands are registered and before the gateway connects, such as extra
         * subscriptions in the bot's Scope. The bot connects only after the Effect succeeds, so no handler runs before
         * setup finishes. A failure stops the bot before connecting, and runBot fails with ApplicationError whose source is
         * "runBot setup" and whose cause is the original failure, such as the GuildOperationError of a failed read.
         * A defect or interruption stops the bot with that cause unchanged. Passed inline to runBot, the Effect's other
         * services are added to the bot's requirements
         */
        readonly setup?: (client: Client<SelectedMessage<F>>) => Effect.Effect<unknown, unknown, Scope.Scope>
    }

/**
 * The services required by one runBot event handler H, including its onError hook
 *
 * @category Client and lifecycle
 */
export type HandlerServices<H> = H extends (...args: never[]) => Effect.Effect<unknown, unknown, infer R>
    ? R
    : H extends {
            /** Event handler of an options-object entry */
            readonly handler: (...args: never[]) => Effect.Effect<unknown, unknown, infer R>
            /** Optional failure hook of an options-object entry */
            readonly onError?: infer Hook
        }
      ? R | (Hook extends (...args: never[]) => Effect.Effect<unknown, unknown, infer R2> ? R2 : never)
      : never

/**
 * The services required by every handler in a runBot events object, which runBot adds to its own requirements.
 * Omitted events require no services
 *
 * @category Client and lifecycle
 */
export type BotEventServices<Events> = {
    [K in keyof Events]-?: HandlerServices<NonNullable<Events[K]>> extends infer R
        ? unknown extends R
            ? never
            : R
        : never
}[keyof Events]

/** A native bot's checked event handlers, command router and callbacks, read once before any client exists */
interface PreparedNativeBot {
    readonly entries: ReturnType<typeof snapshotBotEvents>
    readonly router: NativePrefixCommandRouter<unknown, Message> | undefined
    readonly onError: ((report: FailureReport) => Effect.Effect<unknown, unknown, never>) | undefined
    readonly setup: ((client: Client) => Effect.Effect<unknown, unknown, unknown>) | undefined
    /** A commands register callback's own failure, returned once the other options are checked */
    readonly commandsFailure: ApplicationError | undefined
}

/** Read and check a native bot's events, commands and setup callback. Misuse throws ConfigurationError */
function prepareNativeBot(events: unknown, commands: unknown, setup: unknown): PreparedNativeBot {
    if (setup !== undefined && typeof setup !== "function")
        throw new ConfigurationError("configuration", 'The option "setup" must be a function')
    const entries = snapshotBotEvents(events)
    let router: NativePrefixCommandRouter<unknown, Message> | undefined
    let commandsFailure: ApplicationError | undefined
    try {
        router = commands === undefined ? undefined : nativeBotRouter<Message>(commands as never)
    } catch (error) {
        // A register callback's own failure is an application outcome, failed once the other options are checked
        if (!(error instanceof ApplicationError)) throw error
        commandsFailure = error
    }
    const onError = (commands as { readonly onError?: unknown } | undefined)?.onError
    if (onError !== undefined && typeof onError !== "function")
        throw new ConfigurationError("onError", 'The option "commands.onError" must be a function')
    return {
        entries,
        router,
        onError: onError as PreparedNativeBot["onError"],
        setup: setup as PreparedNativeBot["setup"],
        commandsFailure,
    }
}

/** Register a native bot's event handlers and command router on a client in the current Scope, as runBot does */
function registerNativeBot(
    client: Client,
    prepared: PreparedNativeBot,
): Effect.Effect<readonly Subscription[], never, Scope.Scope> {
    return Effect.gen(function* () {
        const subscriptions: Subscription[] = []
        for (const { event, handler, options } of prepared.entries)
            subscriptions.push(
                yield* client.on(
                    event,
                    (payload) =>
                        (handler as (context: BotEventContext<EventName>) => Effect.Effect<unknown, unknown, unknown>)(
                            Object.freeze(
                                event === "messageCreate"
                                    ? {
                                          event: payload,
                                          client,
                                          message: payload,
                                          reply: (input: ReplyInput | string, options?: SendOptions) =>
                                              client.messages.reply(payload as Message, input, options),
                                      }
                                    : { event: payload, client },
                            ) as BotEventContext<EventName>,
                        ),
                    options as EventHandlerOptions<unknown, unknown>,
                ),
            )
        if (prepared.router !== undefined)
            subscriptions.push(
                yield* prepared.router.attach(
                    client,
                    prepared.onError === undefined ? undefined : { onError: prepared.onError },
                ),
            )
        return subscriptions
    }) as Effect.Effect<readonly Subscription[], never, Scope.Scope>
}

/** Run a native bot's setup once. A failure becomes ApplicationError with source "runBot setup", and defects stay defects */
function nativeBotSetup(
    client: Client,
    setup: PreparedNativeBot["setup"],
): Effect.Effect<void, ApplicationError, Scope.Scope> {
    if (setup === undefined) return Effect.void
    return Effect.suspend(() => setup(client)).pipe(
        // A setup failure, such as a failed read, is an application outcome. Defects stay defects
        Effect.mapError((error) => new ApplicationError("runBot setup", error)),
        Effect.asVoid,
    ) as Effect.Effect<void, ApplicationError, Scope.Scope>
}

/** Split runBot options once into runner settings and client settings. A throwing getter throws its value */
function readNativeBotOptions(options: BotOptions<unknown, unknown, unknown, unknown>) {
    const { events, commands, setup, signal, processSignals, reportFailure, drainMs, ...clientOptions } = options
    return { events, commands, setup, signal, processSignals, reportFailure, drainMs, clientOptions }
}

/**
 * End a native run on misuse or a throwing option getter before any client exists. The error is a defect in the
 * native API, and it is reported like any failure that stops the bot, logged once and setting process.exitCode to 1
 * unless reportFailure is false, because nothing else shows a defect when the application only runs the Effect
 */
function misuse(error: unknown, clientOptions: Readonly<Record<string, unknown>>, reportFailure: unknown) {
    return reportBotFailure(
        Exit.die(error),
        standaloneBotLogger(clientOptions, true),
        reportFailure === false ? { reportFailure } : {},
    ).pipe(Effect.andThen(Effect.die(error)))
}

/**
 * Register runBot events and commands on a test client in the current Scope, with the same checks, contexts and
 * registration as runBot, returning the setup Effect that the test client runs before it connects. Used by the
 * Effect testing entry point. Misuse dies with ConfigurationError, and a commands register callback's own
 * failure fails with its ApplicationError
 */
export function installNativeTestBot(
    client: Client,
    options: { readonly events?: unknown; readonly commands?: unknown; readonly setup?: unknown },
): Effect.Effect<Effect.Effect<void, ApplicationError, Scope.Scope>, ApplicationError, Scope.Scope> {
    return Effect.suspend(() => {
        let prepared: PreparedNativeBot
        try {
            prepared = prepareNativeBot(options.events, options.commands, options.setup)
        } catch (error) {
            return Effect.die(error)
        }
        if (prepared.commandsFailure !== undefined) return Effect.fail(prepared.commandsFailure)
        return registerNativeBot(client, prepared).pipe(Effect.as(nativeBotSetup(client, prepared.setup)))
    })
}

/**
 * Run a bot from one configuration object in the application's Effect context and scope.
 * When the Effect runs, it creates the client and registers every event handler and command before the gateway
 * starts, so no event is missed and no handler runs before registration and setup complete.
 * A malformed option, misspelled option key, non-function handler, unsupported event name, invalid delivery setting,
 * invalid command or missing token is misuse and dies with ConfigurationError. Every option is checked before any client, signal listener or request
 * exists, even when the signal is already aborted, so misuse leaves nothing to clean up.
 * Handler and command failures are isolated and reported by client.on, not bot failures.
 * A failed setup Effect or a throwing commands register callback fails the bot with ApplicationError before it connects.
 * A subscription that closes normally while the bot runs fails the bot with CriticalWorkerStoppedError, and a
 * handler set to overflow "stop" that overflows is reported while the bot keeps running without it. Cleanup is awaited.
 * Aborting signal or enabled SIGINT/SIGTERM stops successfully, after running handlers and their requests had up to
 * drainMs, default 5,000 ms, to finish. Fiber interruption remains interruption and does not drain.
 * By default a failure or defect that stops the bot, including misuse, is also logged once, with code
 * lifecycle.botFailed unless the client already logged that error, and sets process.exitCode to 1, so running the
 * Effect needs no further handling.
 * Set reportFailure to false when the application handles the failure and exit status itself.
 * No separate runtime is created and the process is not exited
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { runBot } from "@neontechspace/fluxerly/effect"
 *
 * export function pingBot(token: string | undefined) {
 *     return runBot({
 *         token,
 *         processSignals: true,
 *         commands: {
 *             prefix: "!",
 *             commands: {
 *                 ping: { execute: ({ reply }) => reply("Pong!") },
 *             },
 *         },
 *         events: {
 *             guildCreate: ({ event }) => Effect.logInfo(`Joined ${event.name}`),
 *         },
 *     })
 * }
 * ```
 *
 * @category Client and lifecycle
 */
export function runBot<
    const F extends MessageFields | undefined = undefined,
    const Events extends BotEvents<unknown, unknown, SelectedMessage<F>> = BotEvents<
        unknown,
        unknown,
        SelectedMessage<F>
    >,
    const S extends Readonly<Record<string, unknown>> = {},
    const C extends BotCommandEntries<S> = BotCommandEntries<S>,
    RouterServices = never,
    OptionsError = never,
    OptionsServices = never,
    SetupServices = never,
>(
    options: Omit<BotOptions<unknown, unknown, OptionsError, OptionsServices, F>, "events" | "commands" | "setup"> & {
        readonly events?: Events & Record<Exclude<keyof Events, EventName>, never>
        readonly commands?: BotCommandsOptions<SelectedMessage<F>, S, C, RouterServices>
        readonly setup?: (client: Client<SelectedMessage<F>>) => Effect.Effect<unknown, unknown, SetupServices>
    },
): Effect.Effect<
    void,
    ConnectError | CriticalWorkerStoppedError | ApplicationError,
    Exclude<
        BotEventServices<Events> | NativeBatchRequirements<C> | RouterServices | OptionsServices | SetupServices,
        Scope.Scope
    >
> {
    const botOptions = options as unknown as BotOptions<unknown, unknown, unknown, unknown>
    return Effect.suspend(() => {
        if (typeof botOptions !== "object" || botOptions === null || Array.isArray(botOptions))
            return misuse(
                new ConfigurationError("configuration", "The runBot options must be an object"),
                {},
                undefined,
            )
        let read: ReturnType<typeof readNativeBotOptions>
        try {
            read = readNativeBotOptions(botOptions)
        } catch (error) {
            return misuse(error, {}, undefined)
        }
        const { events, commands, setup, signal, processSignals, reportFailure, drainMs, clientOptions } = read
        let prepared: PreparedNativeBot
        try {
            validateRunOptions({ signal, processSignals, reportFailure, drainMs })
            prepared = prepareNativeBot(events, commands, setup)
            // Checked before the runner adds signal listeners or creates the client, so misuse has no side effects
            validateBotClientOptions(clientOptions, true)
        } catch (error) {
            return misuse(error, clientOptions, reportFailure)
        }
        // The callback already ran, so its failure is returned even when the signal is already aborted
        const runOptions: RunBotOptions = {
            ...(signal === undefined ? {} : { signal }),
            ...(processSignals === undefined ? {} : { processSignals }),
            ...(reportFailure === undefined ? {} : { reportFailure }),
            ...(drainMs === undefined ? {} : { drainMs }),
        }
        const commandsFailure = prepared.commandsFailure
        if (commandsFailure !== undefined)
            return reportBotFailure(
                Exit.fail(commandsFailure),
                standaloneBotLogger(clientOptions, true),
                runOptions,
            ).pipe(Effect.andThen(Effect.fail(commandsFailure)))
        return runBotCore(
            Effect.suspend(() => createClient(clientOptions as ClientOptions)),
            (client) =>
                Effect.gen(function* () {
                    const subscriptions = yield* registerNativeBot(client, prepared)
                    yield* nativeBotSetup(client, prepared.setup)
                    // An overflowing event subscription was already reported, and the bot keeps running without it
                    return subscriptions.map((subscription) => ({
                        waitForClose: () =>
                            subscription.waitForClose().pipe(
                                Effect.catchIf(
                                    (error): error is EventOverflowError => error instanceof EventOverflowError,
                                    () => client.waitForClose().pipe(Effect.exit, Effect.asVoid),
                                ),
                            ),
                    }))
                }),
            runOptions,
            () => standaloneBotLogger(clientOptions, true),
        )
    }) as Effect.Effect<
        void,
        ConnectError | CriticalWorkerStoppedError | ApplicationError,
        Exclude<
            BotEventServices<Events> | NativeBatchRequirements<C> | RouterServices | OptionsServices | SetupServices,
            Scope.Scope
        >
    >
}
