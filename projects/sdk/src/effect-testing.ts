/**
 * Test Fluxer bots built with the Effect API without a network, a token or a Fluxer account.
 * Import from @neontechspace/fluxerly/effect/testing in application tests
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { createTestClient } from "@neontechspace/fluxerly/effect/testing"
 *
 * export const pingTest = Effect.scoped(
 *     Effect.gen(function* () {
 *         const test = yield* createTestClient()
 *         const replies = test.rest.respond("POST /channels/:id/messages", {
 *             body: test.fixtures.message({ content: "Pong!" }),
 *         })
 *         yield* test.client.on("messageCreate", (message) =>
 *             message.content === "!ping" ? test.client.messages.reply(message, { content: "Pong!" }) : Effect.void,
 *         )
 *         yield* test.ready()
 *         yield* test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ping" }))
 *         // Handlers run after emit returns, so wait for the reply before the Scope closes the client
 *         const reply = yield* replies.next()
 *         // A message the bot ignores sends nothing, which idle confirms without a fixed sleep
 *         yield* test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "hello" }))
 *         yield* test.idle()
 *         return { reply, requests: replies.requests().length }
 *     }),
 * )
 * ```
 *
 * @remarks
 * A test client is a real client from the native createClient whose HTTP and WebSocket traffic goes to an in-memory
 * transport through the transport option. Events therefore pass through the SDK's own decoders, caches, handlers and logging.
 * The fake gateway speaks protocol v1: It sends HELLO, answers Identify with READY and Resume with RESUMED, acknowledges
 * heartbeats and delivers emitted dispatches with increasing sequence numbers. The fake HTTP side serves hosted Fluxer's
 * discovery document, with presigned uploads off so attachments arrive as one multipart request, answers requests from
 * registered responses and records every request without its Authorization header.
 * Message sends and edits without a registered response receive an echoed bot message, and other unmatched requests
 * receive a Fluxer-shaped 404 and a testing.unmatchedRequest Warn record.
 * Waits such as idle and TestRoute.next have no deadline unless timeoutMs is passed, so the test runner's timeout
 * bounds a test that hangs.
 * Log records go to logs() and to any sinks in the logging option instead of the Effect logger.
 * Closing the creating scope stops the client and closes the transport, leaving no sockets, timers or listeners behind,
 * and dies with UnhandledTestFailuresError when a handler or command failed without an onError hook and the test did
 * not read that failure from failures().
 * The fixture builders and their types are shared with @neontechspace/fluxerly/testing
 *
 * @packageDocumentation
 */
// Checked first, so an unsupported Node.js version fails with a clear message before any other SDK code runs
import "./internal/node-version.js"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { FluxerClient } from "./api/effect/service.js"
import type { ClientCounters, LogRecord } from "./logging.js"
import { ConfigurationError, type ApplicationError, type ConnectError } from "./errors.js"
import type { EventName } from "./events.js"
import type { NativeBatchRequirements } from "./native-commands.js"
import {
    installNativeTestBot,
    type BotCommandEntries,
    type BotCommandsOptions,
    type BotEventServices,
    type BotEvents,
} from "./api/effect/bot.js"
import type { Message, MessageCore, MessageFields, SelectedMessage } from "./messages.js"
import { createClient, type Client, type ClientOptions } from "./api/effect/client.js"
import { checkTestOptionKeys, TestHarness, type TestClientWork } from "./internal/testing/harness.js"
import { botOptionKeys } from "./internal/bot-runner.js"
import { clientServices } from "./internal/client-registry.js"
import { TestTimeoutError, type UnhandledTestFailuresError } from "./internal/testing/errors.js"
import type {
    TestDisconnectOptions,
    TestEmitOptions,
    TestGatewayCommand,
    TestRequest,
    TestRequestMatcher,
    TestResponder,
    TestResponse,
    TestSayOptions,
    TestSettings,
    TestWaitOptions,
} from "./internal/testing/types.js"
import type { Fixtures, WireMessage } from "./internal/testing/fixtures.js"

export {
    createFixtures,
    fixtures,
    fixtureToken,
    type Fixtures,
    type WireChannel,
    type WireForumChannel,
    type WireGuild,
    type WireGuildCreate,
    type WireGuildCreateOverrides,
    type WireMember,
    type WireMessage,
    type WireOverrides,
    type WireRole,
    type WireThread,
    type WireUser,
} from "./internal/testing/fixtures.js"
export type {
    TestRequest,
    TestRequestFile,
    TestRequestMatcher,
    TestResponder,
    TestResponse,
} from "./internal/testing/types.js"
export type {
    TestDisconnectOptions,
    TestEmitOptions,
    TestGatewayCommand,
    TestSayOptions,
    TestSettings,
    TestWaitOptions,
} from "./internal/testing/types.js"
export { TestTimeoutError, UnhandledTestFailuresError } from "./internal/testing/errors.js"

/**
 * One registered response of a native test client. Registrations are searched newest first, so a later registration
 * overrides an earlier one for the requests both match
 *
 * @category Testing
 */
export interface TestRoute {
    /** Requests this registration answered so far, in order */
    requests(): readonly TestRequest[]
    /**
     * Succeed with the next request this registration answers. Each run returns a different request, in order, so a
     * request that arrived before the run is returned at once.
     * Without timeoutMs the wait has no SDK deadline, so the test runner's own timeout ends a test whose request never
     * arrives. With timeoutMs it fails with TestTimeoutError when no request arrives in time.
     * It dies with ClientClosedError when the test client shuts down first, and interruption ends the wait.
     * Invalid options are a defect carrying ConfigurationError
     */
    next(options?: TestWaitOptions): Effect.Effect<TestRequest, TestTimeoutError>
    /** Stop answering requests. Earlier matching registrations and the default 404 apply again */
    remove(): void
}

/**
 * Register fake Fluxer HTTP API responses for a native test client.
 * Without a registration, message sends (POST /channels/:id/messages) and edits (PATCH /channels/:id/messages/:id)
 * receive an automatic reply: A message by the bot account that echoes the request's content, embeds, flags and tts,
 * with a new fixture ID for a send and the edited ID for an edit. Other unmatched requests receive a Fluxer-shaped 404
 *
 * @category Testing
 */
export interface TestRest {
    /**
     * Answer matching requests with a fixed response or a handler's response until the registration is removed.
     * The newest matching registration wins, including over the automatic message replies.
     * Invalid matchers or responses throw ConfigurationError
     *
     * @example
     * ```ts
     * import { createTestClient } from "@neontechspace/fluxerly/effect/testing"
     * import { Effect } from "effect"
     *
     * export const respondExample = Effect.gen(function* () {
     *     const test = yield* createTestClient()
     *     test.rest.respond("GET /users/@me", { body: test.fixtures.botUser() })
     *     return test.rest.respond("POST /channels/:id/messages", (request) => ({
     *         body: test.fixtures.message({ content: String((request.body as { content?: unknown }).content) }),
     *     }))
     * })
     * ```
     */
    respond(matcher: TestRequestMatcher, response: TestResponse | TestResponder): TestRoute
}

/** Run a test wait as an Effect. A timeout is the typed failure, and misuse or shutdown is a defect */
function testWait<A>(start: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, TestTimeoutError> {
    return Effect.tryPromise({ try: start, catch: (error) => error }).pipe(
        Effect.catch((error) => (error instanceof TestTimeoutError ? Effect.fail(error) : Effect.die(error))),
    )
}

/**
 * Options for createTestClient: Every native createClient option except token, transport and instance, plus test settings.
 * The token defaults to the fixture token, the transport is always the in-memory test transport and the instance is
 * always hosted Fluxer served from memory
 *
 * @category Testing
 */
export type TestClientOptions<E = never, R = never, F extends MessageFields | undefined = undefined> = Omit<
    ClientOptions<E, R, F>,
    "token" | "transport" | "instance"
> &
    TestSettings

/**
 * A real native client connected to an in-memory Fluxer, with controls for driving and inspecting it.
 * Control misuse, such as emitting before ready, is a defect carrying ConfigurationError, and use after shutdown is a
 * defect carrying ClientClosedError
 *
 * @category Testing
 */
export interface TestClient<M extends MessageCore = Message> {
    /** The client under test, created with the native createClient. Use it exactly as in the application */
    readonly client: Client<M>
    /** A fixture set of its own, whose IDs do not depend on other tests. READY reports its botUser() by default */
    readonly fixtures: Fixtures
    /** Register the HTTP responses the fake Fluxer API returns */
    readonly rest: TestRest
    /**
     * Connect the client to the test gateway and succeed once every shard it owns is READY, like client.connect.
     * Running it again while connected succeeds without opening another socket. With gateway.ignoredEvents set to "auto",
     * register handlers before running this Effect, because Identify chooses filtering from those registrations.
     * It fails with the connect failure, such as ConnectionError when a handler closed the connection
     */
    ready(): Effect.Effect<void, ConnectError>
    /**
     * Deliver one gateway dispatch to a connected shard when run, with the next sequence number.
     * The type is the Fluxer wire dispatch name, such as MESSAGE_CREATE or GUILD_MEMBER_ADD, and the payload is the wire
     * body in snake_case, so it passes through the SDK's real decoders, cache updates and handlers.
     * Handlers run afterwards on their own schedule. Start client.waitFor before emitting to await delivery.
     * Unknown types are delivered too unless explicitly suppressed, and malformed payloads follow the client's
     * gateway.onMalformedDispatch policy.
     * Dies with ConfigurationError without consuming a sequence when the session's Identify filtering would suppress
     * the dispatch. Suppressed MESSAGE_CREATE still arrives for a direct bot mention, @here or @everyone. Role-only
     * mentions, direct-message delivery and bot authorship alone do not exempt it. Generated MESSAGE_REACTION_ADD_MANY is
     * gated by MESSAGE_REACTION_ADD, not its generated name. Register handlers before ready when gateway.ignoredEvents
     * is "auto", or remove the source type from the explicit list (use [] to disable suppression). Resume keeps the list.
     * READY and RESUMED are reserved for the handshake. Dies with ConfigurationError before ready or for a shard this
     * client does not own
     */
    emit(type: string, payload: unknown, options?: TestEmitOptions): Effect.Effect<void>
    /**
     * Close one shard's connection from the gateway side with a close code when run. The SDK then recovers as it would
     * against Fluxer, resuming with RESUMED for a resumable code, or ends the connection lifetime for a fatal one.
     * Dies with ConfigurationError when that shard is not connected
     */
    disconnect(options?: TestDisconnectOptions): Effect.Effect<void>
    /** HTTP requests the client sent so far, in order, excluding the discovery bootstrap and without credentials */
    requests(): readonly TestRequest[]
    /** Gateway commands the client sent so far, in order, with tokens redacted */
    commands(): readonly TestGatewayCommand[]
    /**
     * Log records the client produced so far, in order, at the logging option's level and categories, default Info.
     * The records also reach any sinks in the logging option. Nothing reaches the Effect logger
     */
    logs(): readonly LogRecord[]
    /** The client's running totals, the same as client.diagnostics().counters */
    counters(): ClientCounters
    /**
     * Error records of failures no application code handled so far, in order, such as an event handler, command or
     * client.schedule task run that failed while no onError hook was registered, whether the error came from the
     * application or from a Fluxer rejection. Assert expected failures here, because shutdown fails for
     * unhandled failures that failures() has not returned.
     * Failures are captured whatever the logging level, categories and deduplication, so each one appears here and
     * counts for shutdown even when logs() leaves it out
     */
    failures(): readonly LogRecord[]
    /**
     * Succeed once the client has settled: No event handler or command is running or has a received event waiting for
     * it, no client.schedule task run is running, no REST request is queued or waiting for its test response, and no new
     * log record, request or gateway command appeared for a few event loop turns. Run it after emit to assert that the
     * bot did nothing, or before inspecting results.
     * Open waits and collectors do not count as work, and onError hooks are not awaited. A scheduled task waiting for its
     * time does not count either, so advance the clock that drives the client's timers to run it.
     * Without timeoutMs the wait has no SDK deadline, so the test runner's own timeout ends a test whose client never
     * settles. With timeoutMs it fails with TestTimeoutError when the client is still busy after it.
     * It dies with ClientClosedError after shutdown. Invalid options are a defect carrying ConfigurationError.
     * Its timers stay real when a test fakes timers. The SDK runs on setImmediate, so fake timers must leave it real,
     * otherwise idle dies with ConfigurationError instead of settling while no handler can run
     */
    idle(options?: TestWaitOptions): Effect.Effect<void, TestTimeoutError>
    /**
     * Shut the client down, then close the test transport. It fails with UnhandledTestFailuresError when application
     * code failed without a handler and failures() did not return that failure, so a broken handler fails the test.
     * Each failure is reported once, so running it again succeeds.
     * Closing the creating scope does the same, and dies with UnhandledTestFailuresError for failures not reported yet
     */
    shutdown(): Effect.Effect<void, UnhandledTestFailuresError>
}

/**
 * Create a real native client wired to an in-memory Fluxer for application tests, owned by the caller's Scope.
 * Creation opens no connection and starts no timers. Run ready to connect. Closing the scope shuts the client down
 * and closes the test transport. The gateway enforces gateway.ignoredEvents, so register handlers before ready when
 * automatic filtering is enabled
 *
 * @remarks
 * Invalid options are a defect carrying ConfigurationError, as with createClient, and supplying transport or instance
 * is too, because the test transport owns both. The hint for a misspelled key suggests the closest key a test client
 * accepts
 *
 * @example
 * ```ts
 * import { Effect, Fiber } from "effect"
 * import { createTestClient } from "@neontechspace/fluxerly/effect/testing"
 *
 * export const greetingTest = Effect.scoped(
 *     Effect.gen(function* () {
 *         const test = yield* createTestClient({ cache: { members: true } })
 *         yield* test.ready()
 *         const joined = yield* Effect.forkScoped(test.client.waitFor("guildMemberAdd"))
 *         yield* Effect.yieldNow
 *         yield* test.emit("GUILD_MEMBER_ADD", test.fixtures.member())
 *         return yield* Fiber.join(joined)
 *     }),
 * )
 * ```
 *
 * @category Testing
 */
export function createTestClient<E = never, R = never, const F extends MessageFields | undefined = undefined>(
    options: TestClientOptions<E, R, F> = {} as TestClientOptions<E, R, F>,
): Effect.Effect<TestClient<SelectedMessage<F>>, never, Scope.Scope | R> {
    return openTestClient(options).pipe(Effect.map(({ test }) => test))
}

/** The client's work in progress that idle and say wait for, including scheduled task runs and queued handler events */
function clientWork(client: { diagnostics(): TestClientWork["diagnostics"] }): () => TestClientWork {
    return () => {
        const services = clientServices(client)
        const handlers = services?.events.drainState()
        return {
            diagnostics: client.diagnostics(),
            runningTasks: services?.tasks.running ?? 0,
            pendingHandlers: handlers === undefined ? 0 : handlers.running + handlers.waiting,
        }
    }
}

/** Create a native test client together with the harness that createTestBot also drives */
function openTestClient<E, R, F extends MessageFields | undefined>(
    options: TestClientOptions<E, R, F>,
): Effect.Effect<
    { readonly test: TestClient<SelectedMessage<F>>; readonly harness: TestHarness },
    never,
    Scope.Scope | R
> {
    return Effect.gen(function* () {
        const harness = yield* Effect.sync(() => new TestHarness(options))
        // Added before the client, so the scope closes the transport only after the client's own shutdown finalizer.
        // A failure no application code handled then fails the scope, so a broken handler fails the test
        yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
                harness.close()
                harness.checkFailures()
            }),
        )
        const client = yield* createClient<E, R, F>(harness.clientOptions(options) as ClientOptions<E, R, F>)
        clientServices(client)!.logging.errorTap = harness.captureError
        const test: TestClient<SelectedMessage<F>> = Object.freeze({
            client,
            fixtures: harness.fixtures,
            rest: Object.freeze({
                respond: (matcher: TestRequestMatcher, response: TestResponse | TestResponder): TestRoute => {
                    const route = harness.http.respond(matcher, response)
                    return Object.freeze({
                        requests: () => route.requests(),
                        next: (options?: TestWaitOptions) => testWait((signal) => route.next(options, signal)),
                        remove: () => route.remove(),
                    })
                },
            }),
            ready: () => client.connect(),
            emit: (type: string, payload: unknown, options?: TestEmitOptions) =>
                Effect.sync(() => harness.gateway.emit(type, payload, options)),
            disconnect: (options?: TestDisconnectOptions) => Effect.sync(() => harness.gateway.disconnect(options)),
            requests: () => harness.http.requests(),
            commands: () => harness.gateway.commands(),
            logs: () => harness.logs(),
            failures: () => harness.failures(),
            idle: (options?: TestWaitOptions) =>
                testWait((signal) => harness.idle(clientWork(client), options, signal)),
            counters: () => client.diagnostics().counters,
            shutdown: () =>
                client.shutdown().pipe(
                    Effect.ensuring(Effect.sync(() => harness.close())),
                    Effect.andThen(
                        Effect.try({
                            try: () => harness.checkFailures(),
                            catch: (error) => error as UnhandledTestFailuresError,
                        }),
                    ),
                ),
        })
        return { test, harness }
    })
}

/**
 * Effect service holding a native test client, for applications whose code reads the client from the FluxerClient
 * service. Build both services with FluxerTestClient.layer(options) and read the controls with `yield* FluxerTestClient`
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { FluxerClient } from "@neontechspace/fluxerly/effect"
 * import { FluxerTestClient } from "@neontechspace/fluxerly/effect/testing"
 *
 * // Application code that depends on the FluxerClient service
 * const registerPing = Effect.gen(function* () {
 *     const client = yield* FluxerClient
 *     yield* client.on("messageCreate", (message) =>
 *         message.content === "!ping" ? client.messages.reply(message, "Pong!") : Effect.void,
 *     )
 * })
 *
 * export const pingTest = Effect.gen(function* () {
 *     yield* registerPing
 *     const test = yield* FluxerTestClient
 *     const replies = test.rest.respond("POST /channels/:id/messages", {
 *         body: test.fixtures.message({ content: "Pong!" }),
 *     })
 *     yield* test.ready()
 *     yield* test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ping" }))
 *     return yield* replies.next()
 * }).pipe(Effect.scoped, Effect.provide(FluxerTestClient.layer()))
 * ```
 *
 * @category Testing
 */
export class FluxerTestClient extends Context.Service<FluxerTestClient, TestClient>()(
    "@neontechspace/fluxerly/FluxerTestClient",
) {
    /**
     * Build a test client with createTestClient and provide it twice: Its client as the FluxerClient service, so
     * application code runs unchanged, and the whole test client as the FluxerTestClient service, for the controls.
     * The layer takes the options of createTestClient without messageFields, because FluxerClient holds full messages.
     * The client is created in the layer's Scope without connecting, and closing that Scope shuts it down and closes the
     * test transport. It dies with UnhandledTestFailuresError when a handler or command failed without an onError hook and
     * the test did not read that failure from failures(). Invalid options are a defect carrying ConfigurationError, as
     * with createTestClient. Each build of the layer creates its own test client
     */
    static layer<E = never, R = never>(
        options?: Omit<TestClientOptions<E, R>, "messageFields">,
    ): Layer.Layer<FluxerTestClient | FluxerClient, never, R> {
        return Layer.effectContext(
            createTestClient<E, R>(options as TestClientOptions<E, R>).pipe(
                Effect.map((test) => Context.make(FluxerTestClient, test).pipe(Context.add(FluxerClient, test.client))),
            ),
        )
    }
}

/**
 * A native test client running a bot written for runBot. It is a TestClient whose ready first runs the bot's setup,
 * with say to talk to the bot as a user would
 *
 * @category Testing
 */
export interface TestBot<M extends MessageCore = Message> extends Omit<TestClient<M>, "ready"> {
    /**
     * Run the bot's setup Effect once, then connect to the test gateway and succeed once every shard it owns is READY.
     * Running it again runs setup no more and succeeds without opening another socket while connected.
     * A failed setup fails with ApplicationError whose source is "runBot setup", before connecting, and a failed
     * connection fails with its connect failure
     */
    ready(): Effect.Effect<void, ConnectError | ApplicationError>
    /**
     * Deliver a message with this content from a human user, wait until the bot has settled as idle does, and succeed
     * with the messages the bot sent meanwhile, in send order, or an empty list when it sent nothing. Run ready first.
     * Each entry is a message send (POST /channels/:id/messages) in wire shape, built from the request body with the
     * fields the automatic reply echoes, so it shows what the bot sent even when a rest.respond handler answered.
     * Edits, reactions and other requests are not included, and remain visible through requests().
     * The message comes from the fixture set's default human author in its default channel and community, and
     * options.message replaces any of those wire fields. Like idle, say has no deadline unless options.timeoutMs is
     * set, then fails with TestTimeoutError when the bot is still busy after it, and dies with ClientClosedError after
     * shutdown. It dies with ConfigurationError for content that is not a string, invalid options, before ready and
     * when gateway filtering would suppress the message, as emit does
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import { createTestBot } from "@neontechspace/fluxerly/effect/testing"
     *
     * export const sayTest = Effect.scoped(
     *     Effect.gen(function* () {
     *         const test = yield* createTestBot({
     *             commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong!") } } },
     *         })
     *         yield* test.ready()
     *         const replies = yield* test.say("!ping")
     *         return replies.map((message) => message.content)
     *     }),
     * )
     * ```
     */
    say(content: string, options?: TestSayOptions): Effect.Effect<readonly WireMessage[], TestTimeoutError>
}

/**
 * Create a test client that runs a bot written for the native runBot: Its events, ignoreBots setting, commands and setup Effect, with the
 * same handler contexts, delivery defaults and command router as runBot. Pass the bot's own options object: Its
 * signal, processSignals, reportFailure and drainMs settings are ignored, an undefined token uses the fixture token, and
 * transport and instance belong to the test client. Handlers and commands are registered when the Effect runs, and ready runs setup before connecting, as runBot
 * does. The creating Scope cleans the client up, as with createTestClient. Automatic gateway filtering sees the bot's
 * handlers, commands and setup registrations, and emit dies for dispatches that list suppresses
 *
 * @remarks
 * Invalid options die with ConfigurationError, as in runBot, and a commands register callback that throws fails with
 * its ApplicationError. The services that handlers, commands and setup need are required by this Effect.
 * The runBot supervision of a stopped subscription does not apply in tests
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { createTestBot } from "@neontechspace/fluxerly/effect/testing"
 *
 * export const pingTest = Effect.scoped(
 *     Effect.gen(function* () {
 *         const test = yield* createTestBot({
 *             commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong!") } } },
 *         })
 *         yield* test.ready()
 *         // The test transport answers the reply with an echoed message, so no rest.respond fixture is needed
 *         return yield* test.say("!ping")
 *     }),
 * )
 * ```
 *
 * @category Testing
 */
export function createTestBot<
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
    options: Omit<TestClientOptions<OptionsError, OptionsServices, F>, "token"> & {
        /** Event handlers, as in runBot */
        readonly events?: Events & Record<Exclude<keyof Events, EventName>, never>
        /** Skip bot-authored messageCreate and messageUpdate events in the handlers, as in runBot. Defaults to true */
        readonly ignoreBots?: boolean
        /** Prefix commands, as in runBot */
        readonly commands?: BotCommandsOptions<SelectedMessage<F>, S, C, RouterServices>
        /** Startup work that ready runs before connecting, as in runBot */
        readonly setup?: (client: Client<SelectedMessage<F>>) => Effect.Effect<unknown, unknown, SetupServices>
        /** Token passed to the client, never sent anywhere. Omit it or pass undefined to use the fixture token */
        readonly token?: string | undefined
        /** Ignored in tests. The creating Scope owns the client's lifetime */
        readonly signal?: unknown
        /** Ignored in tests, which never handle process signals */
        readonly processSignals?: boolean
        /** Ignored in tests, which never set the process exit code */
        readonly reportFailure?: boolean
        /** Ignored in tests. Use client.shutdown({ drainMs }) to test a drain */
        readonly drainMs?: number
    },
): Effect.Effect<
    TestBot<SelectedMessage<F>>,
    ApplicationError,
    | Scope.Scope
    | Exclude<
          BotEventServices<Events> | NativeBatchRequirements<C> | RouterServices | OptionsServices | SetupServices,
          Scope.Scope
      >
> {
    return Effect.gen(function* () {
        if (typeof options !== "object" || options === null || Array.isArray(options))
            return yield* Effect.die(new ConfigurationError("configuration", "Bot options must be an object"))
        yield* Effect.sync(() => checkTestOptionKeys(options, botOptionKeys))
        const {
            events,
            ignoreBots,
            commands,
            setup,
            token,
            signal: _signal,
            processSignals: _processSignals,
            reportFailure: _reportFailure,
            drainMs: _drainMs,
            ...clientOptions
        } = options
        const { test, harness } = yield* openTestClient({
            ...clientOptions,
            ...(token === undefined ? {} : { token }),
        } as TestClientOptions<OptionsError, OptionsServices, F>)
        const runSetup = yield* installNativeTestBot(test.client as unknown as Client, {
            events,
            ignoreBots,
            commands,
            setup,
        })
        // Setup runs with the services and Scope of this Effect, as runBot runs it inside its own run
        const context = yield* Effect.context<Scope.Scope>()
        const setupOnce = yield* Effect.cached(runSetup.pipe(Effect.provideContext(context)))
        return Object.freeze({
            ...test,
            ready: () => setupOnce.pipe(Effect.andThen(test.ready())),
            say: (content: string, sayOptions?: TestSayOptions) =>
                testWait((signal) => harness.say(clientWork(test.client), content, sayOptions, signal)),
        })
    }) as never
}
