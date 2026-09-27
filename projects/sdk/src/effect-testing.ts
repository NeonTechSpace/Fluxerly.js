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
 * Unmatched requests receive a Fluxer-shaped 404 and a testing.unmatchedRequest Warn record.
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
import { checkTestOptionKeys, TestHarness } from "./internal/testing/harness.js"
import { botOptionKeys } from "./internal/bot-runner.js"
import { TestTimeoutError, type UnhandledTestFailuresError } from "./internal/testing/errors.js"
import type {
    TestDisconnectOptions,
    TestEmitOptions,
    TestGatewayCommand,
    TestRequest,
    TestRequestMatcher,
    TestResponder,
    TestResponse,
    TestSettings,
    TestWaitOptions,
} from "./internal/testing/types.js"
import type { Fixtures } from "./internal/testing/fixtures.js"

export {
    createFixtures,
    fixtures,
    fixtureToken,
    type Fixtures,
    type WireChannel,
    type WireGuild,
    type WireGuildCreate,
    type WireGuildCreateOverrides,
    type WireMember,
    type WireMessage,
    type WireOverrides,
    type WireRole,
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
     * It fails with TestTimeoutError when no request arrives within the timeout, default 2,000 ms, and dies with
     * ClientClosedError when the test client shuts down first. Invalid options are a defect carrying ConfigurationError
     */
    next(options?: TestWaitOptions): Effect.Effect<TestRequest, TestTimeoutError>
    /** Stop answering requests. Earlier matching registrations and the default 404 apply again */
    remove(): void
}

/**
 * Register fake Fluxer HTTP API responses for a native test client
 *
 * @category Testing
 */
export interface TestRest {
    /**
     * Answer matching requests with a fixed response or a handler's response until the registration is removed.
     * The newest matching registration wins. Invalid matchers or responses throw ConfigurationError
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
     * Running it again while connected succeeds without opening another socket.
     * It fails with the connect failure, such as ConnectionError when a handler closed the connection
     */
    ready(): Effect.Effect<void, ConnectError>
    /**
     * Deliver one gateway dispatch to a connected shard when run, with the next sequence number.
     * The type is the Fluxer wire dispatch name, such as MESSAGE_CREATE or GUILD_MEMBER_ADD, and the payload is the wire
     * body in snake_case, so it passes through the SDK's real decoders, cache updates and handlers.
     * Handlers run afterwards on their own schedule. Start client.waitFor before emitting to await delivery.
     * Unknown types are delivered too, as Fluxer would send them, and malformed payloads follow the client's
     * gateway.onMalformedDispatch policy.
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
     * Error records of failures no application code handled so far, in order, such as an event handler or command
     * that failed while no onError hook was registered. Assert expected failures here, because shutdown fails for
     * unhandled failures that failures() has not returned.
     * The records come from logs(), so a logging level above error hides them
     */
    failures(): readonly LogRecord[]
    /**
     * Succeed once the client has settled: No event handler or command is running, no REST request is queued or
     * waiting for its test response, and no new log record, request or gateway command appeared for a few event loop
     * turns. Run it after emit to assert that the bot did nothing, or before inspecting results.
     * Open waits and collectors do not count as work, and onError hooks are not awaited.
     * It fails with TestTimeoutError when the client is still busy after the timeout, default 2,000 ms, and dies with
     * ClientClosedError after shutdown. Invalid options are a defect carrying ConfigurationError.
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
 * and closes the test transport
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
        return Object.freeze({
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
                testWait((signal) => harness.idle(() => client.diagnostics(), options, signal)),
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
 * A native test client running a bot written for runBot. It is a TestClient whose ready first runs the bot's setup
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
}

/**
 * Create a test client that runs a bot written for the native runBot: Its events, commands and setup Effect, with the
 * same handler contexts, delivery defaults and command router as runBot. Pass the bot's own options object: Its
 * signal, processSignals, reportFailure and drainMs settings are ignored, an undefined token uses the fixture token, and
 * transport and instance belong to the test client. Handlers and commands are registered when the Effect runs, and ready runs setup before connecting, as runBot
 * does. The creating Scope cleans the client up, as with createTestClient
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
 *         const replies = test.rest.respond("POST /channels/:id/messages", {
 *             body: test.fixtures.message({ content: "Pong!" }),
 *         })
 *         yield* test.ready()
 *         yield* test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ping" }))
 *         return yield* replies.next()
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
            commands,
            setup,
            token,
            signal: _signal,
            processSignals: _processSignals,
            reportFailure: _reportFailure,
            drainMs: _drainMs,
            ...clientOptions
        } = options
        const test = yield* createTestClient({
            ...clientOptions,
            ...(token === undefined ? {} : { token }),
        } as TestClientOptions<OptionsError, OptionsServices, F>)
        const runSetup = yield* installNativeTestBot(test.client as unknown as Client, { events, commands, setup })
        // Setup runs with the services and Scope of this Effect, as runBot runs it inside its own run
        const context = yield* Effect.context<Scope.Scope>()
        const setupOnce = yield* Effect.cached(runSetup.pipe(Effect.provideContext(context)))
        return Object.freeze({
            ...test,
            ready: () => setupOnce.pipe(Effect.andThen(test.ready())),
        })
    }) as never
}
