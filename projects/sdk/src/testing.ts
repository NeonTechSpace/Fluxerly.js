/**
 * Test Fluxer bots built with the default API without a network, a token or a Fluxer account.
 * Import from @neontechspace/fluxerly/testing in application tests
 *
 * @example
 * ```ts
 * import assert from "node:assert/strict"
 * import { createTestClient } from "@neontechspace/fluxerly/testing"
 *
 * await using test = createTestClient()
 * const replies = test.rest.respond("POST /channels/:id/messages", { body: test.fixtures.message({ content: "Pong!" }) })
 * test.client.on("messageCreate", (message) =>
 *     message.content === "!ping" ? test.client.messages.reply(message, { content: "Pong!" }) : undefined,
 * )
 * await test.ready()
 * test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ping" }))
 * // Handlers run after emit returns, so wait for the reply before asserting on it
 * const request = await replies.next()
 * assert.equal((request.body as { content?: unknown }).content, "Pong!")
 *
 * // A message the bot ignores sends nothing, which idle confirms without a fixed sleep
 * test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "hello" }))
 * await test.idle()
 * assert.equal(replies.requests().length, 1)
 * ```
 *
 * @remarks
 * A test client is a real client from createClient whose HTTP and WebSocket traffic goes to an in-memory transport
 * through the transport option. Events therefore pass through the SDK's own decoders, caches, handlers and logging.
 * The fake gateway speaks protocol v1: It sends HELLO, answers Identify with READY and Resume with RESUMED, acknowledges
 * heartbeats and delivers emitted dispatches with increasing sequence numbers. The fake HTTP side serves hosted Fluxer's
 * discovery document, with presigned uploads off so attachments arrive as one multipart request, answers requests from
 * registered responses and records every request without its Authorization header.
 * Unmatched requests receive a Fluxer-shaped 404 and a testing.unmatchedRequest Warn record.
 * Log records go to logs() and to any sinks in the logging option instead of the console.
 * Shutdown stops the client and closes the transport, leaving no sockets, timers or listeners behind, and rejects when
 * a handler or command failed without an onError hook and the test did not read that failure from failures()
 *
 * @packageDocumentation
 */
// Checked first, so an unsupported Node.js version fails with a clear message before any other SDK code runs
import "./internal/node-version.js"
import type { ClientCounters, LogRecord } from "./logging.js"
import type { ClientOptions, OperationOptions } from "./client.js"
import type { Message, MessageCore, MessageFields, SelectedMessage } from "./messages.js"
import { createClient, type Client } from "./api/default/client.js"
import { installTestBot, type BotOptions } from "./api/default/bot.js"
import { clientServices } from "./internal/client-registry.js"
import type { CommandArgumentSchema } from "./command-arguments.js"
import { ConfigurationError } from "./errors.js"
import { checkTestOptionKeys, TestHarness } from "./internal/testing/harness.js"
import { botOptionKeys } from "./internal/bot-runner.js"
import type {
    TestDisconnectOptions,
    TestEmitOptions,
    TestGatewayCommand,
    TestRequest,
    TestRest,
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
    TestRest,
    TestRoute,
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
 * Options for createTestClient: Every createClient option except token, transport and instance, plus test settings.
 * The token defaults to the fixture token, the transport is always the in-memory test transport and the instance is
 * always hosted Fluxer served from memory
 *
 * @category Testing
 */
export type TestClientOptions<F extends MessageFields | undefined = undefined> = Omit<
    ClientOptions<F>,
    "token" | "transport" | "instance"
> &
    TestSettings

/**
 * A real default-API client connected to an in-memory Fluxer, with controls for driving and inspecting it.
 * Controls throw ConfigurationError for misuse, such as emitting before ready, and ClientClosedError after shutdown
 *
 * @category Testing
 */
export interface TestClient<M extends MessageCore = Message> extends AsyncDisposable {
    /** The client under test, created with createClient. Use it exactly as in the application */
    readonly client: Client<M>
    /** A fixture set of its own, whose IDs do not depend on other tests. READY reports its botUser() by default */
    readonly fixtures: Fixtures
    /** Register the HTTP responses the fake Fluxer API returns */
    readonly rest: TestRest
    /**
     * Connect the client to the test gateway and resolve once every shard it owns is READY, like client.connect.
     * Calling it again while connected resolves without opening another socket. With gateway.ignoredEvents set to "auto",
     * register handlers before this call, because Identify chooses the session's filtering from those registrations.
     * The promise rejects with the connect failure, such as ConnectionError when a handler closed the connection,
     * so a failed start fails the test
     */
    ready(options?: OperationOptions): Promise<void>
    /**
     * Deliver one gateway dispatch to a connected shard synchronously, with the next sequence number.
     * The type is the Fluxer wire dispatch name, such as MESSAGE_CREATE or GUILD_MEMBER_ADD, and the payload is the wire
     * body in snake_case, so it passes through the SDK's real decoders, cache updates and handlers.
     * Handlers run afterwards on their own schedule. Register client.waitFor before emitting to await delivery.
     * Unknown types are delivered too unless explicitly suppressed, and malformed payloads follow the client's
     * gateway.onMalformedDispatch policy.
     * Throws ConfigurationError without consuming a sequence when the session's Identify filtering would suppress the
     * dispatch. Suppressed MESSAGE_CREATE still arrives for a direct bot mention, @here or @everyone. Role-only mentions,
     * direct-message delivery and bot authorship alone do not exempt it. Generated MESSAGE_REACTION_ADD_MANY is gated by
     * MESSAGE_REACTION_ADD, not its generated name. Register handlers before ready when gateway.ignoredEvents is "auto",
     * or remove the source type from the explicit list (use [] to disable suppression). Resume keeps the current list.
     * READY and RESUMED are reserved for the handshake. Throws ConfigurationError before ready or for a shard this
     * client does not own
     */
    emit(type: string, payload: unknown, options?: TestEmitOptions): void
    /**
     * Close one shard's connection from the gateway side with a close code. The SDK then recovers as it would
     * against Fluxer, resuming with RESUMED for a resumable code, or ends the connection lifetime for a fatal one.
     * Throws ConfigurationError when that shard is not connected
     */
    disconnect(options?: TestDisconnectOptions): void
    /** HTTP requests the client sent so far, in order, excluding the discovery bootstrap and without credentials */
    requests(): readonly TestRequest[]
    /** Gateway commands the client sent so far, in order, with tokens redacted */
    commands(): readonly TestGatewayCommand[]
    /**
     * Log records the client produced so far, in order, at the logging option's level and categories, default Info.
     * The records also reach any sinks in the logging option. Nothing is printed to the console
     */
    logs(): readonly LogRecord[]
    /** The client's running totals, the same as client.diagnostics().counters */
    counters(): ClientCounters
    /**
     * Error records of failures no application code handled so far, in order, such as an event handler or command
     * that threw or returned a failed Result while no onError hook was registered. Assert expected failures here, because
     * shutdown rejects for unhandled failures that failures() has not returned.
     * The records come from logs(), so a logging level above error hides them
     */
    failures(): readonly LogRecord[]
    /**
     * Resolve once the client has settled: No event handler or command is running, no REST request is queued or
     * waiting for its test response, and no new log record, request or gateway command appeared for a few event loop
     * turns. Use it after emit to assert that the bot did nothing, or before inspecting results.
     * Open waits and collectors do not count as work, and onError hooks are not awaited.
     * The promise rejects with TestTimeoutError when the client is still busy after the timeout, default 2,000 ms, and
     * with ClientClosedError after shutdown. Invalid options throw ConfigurationError.
     * Its timers stay real when a test fakes timers. The SDK runs on setImmediate, so fake timers must leave it real,
     * otherwise idle rejects with ConfigurationError instead of settling while no handler can run
     */
    idle(options?: TestWaitOptions): Promise<void>
    /**
     * Shut the client down, then close the test transport. Resolves after both finish and can be called again.
     * Rejects with SdkDefect when client cleanup fails, and otherwise with UnhandledTestFailuresError when application
     * code failed without a handler and failures() did not return that failure, so a broken handler fails the test.
     * Each failure is reported once, so a later call resolves.
     * Disposal with `await using` calls it
     */
    shutdown(): Promise<void>
}

/**
 * Create a real default-API client wired to an in-memory Fluxer for application tests.
 * Creation opens no connection and starts no timers. Call ready to connect, and shutdown or `await using` to clean up.
 * The gateway enforces gateway.ignoredEvents, so register handlers before ready when automatic filtering is enabled
 *
 * @remarks
 * Invalid options throw ConfigurationError as createClient does, and supplying transport or instance also throws
 * ConfigurationError because the test transport owns both. The hint for a misspelled key suggests the closest key a
 * test client accepts
 *
 * @example
 * ```ts
 * import { createTestClient } from "@neontechspace/fluxerly/testing"
 *
 * export async function greetingTest() {
 *     await using test = createTestClient({ cache: { members: true } })
 *     const joined = test.client.waitFor("guildMemberAdd")
 *     await test.ready()
 *     test.emit("GUILD_MEMBER_ADD", test.fixtures.member())
 *     const member = await joined
 *     return member.isOk() && test.client.members.get(member.value) !== undefined
 * }
 * ```
 *
 * @category Testing
 */
export function createTestClient<const F extends MessageFields | undefined = undefined>(
    options: TestClientOptions<F> = {} as TestClientOptions<F>,
): TestClient<SelectedMessage<F>> {
    const harness = new TestHarness(options)
    const client = createClient<F>(harness.clientOptions(options) as ClientOptions<F>)
    let closing: Promise<void> | undefined
    const shutdown = async () => {
        closing ??= (async () => {
            try {
                await client.shutdown()
            } finally {
                harness.close()
            }
        })()
        await closing
        harness.checkFailures()
    }
    return Object.freeze({
        client,
        fixtures: harness.fixtures,
        rest: Object.freeze({ respond: harness.http.respond.bind(harness.http) }),
        ready: async (options?: OperationOptions) => {
            const connected = await client.connect(options)
            if (connected.isErr()) throw connected.error
        },
        emit: (type: string, payload: unknown, options?: TestEmitOptions) =>
            harness.gateway.emit(type, payload, options),
        disconnect: (options?: TestDisconnectOptions) => harness.gateway.disconnect(options),
        requests: () => harness.http.requests(),
        commands: () => harness.gateway.commands(),
        logs: () => harness.logs(),
        failures: () => harness.failures(),
        idle: (options?: TestWaitOptions) => harness.idle(() => client.diagnostics(), options),
        counters: () => client.diagnostics().counters,
        shutdown,
        [Symbol.asyncDispose]: shutdown,
    })
}

/**
 * Options for createTestBot: The runBot options object of the bot under test, plus test settings.
 * The signal, processSignals, reportFailure and drainMs settings are accepted and ignored, so the bot's own options object can be
 * passed unchanged. An undefined token, such as an unset environment variable, uses the fixture token. Transport and
 * instance belong to the test client
 *
 * @category Testing
 */
export type TestBotOptions<
    F extends MessageFields | undefined = undefined,
    S extends Readonly<Record<string, unknown>> = Readonly<Record<string, CommandArgumentSchema | undefined>>,
> = Omit<BotOptions<F, S>, "token" | "transport" | "instance"> &
    Omit<TestSettings, "token"> & {
        /** Token passed to the client, never sent anywhere. Omit it or pass undefined to use the fixture token */
        readonly token?: string | undefined
    }

/**
 * Create a test client that runs a bot written for runBot: Its events, ignoreBots setting, commands and setup callback,
 * with the same handler contexts, delivery defaults and command router as runBot. Handlers and commands are registered at once,
 * and ready runs setup before connecting, as runBot does, so a test drives the bot exactly as Fluxer would.
 * The setup signal aborts when shutdown starts.
 * It returns the same test client as createTestClient, and shutdown or `await using` cleans it up. Automatic gateway
 * filtering sees the bot's handlers, commands and setup registrations, and emit rejects dispatches that list suppresses
 *
 * @remarks
 * Invalid options throw ConfigurationError, as runBot does, and a commands register callback that throws throws its
 * ApplicationError. A failed setup rejects ready with ApplicationError whose source is "runBot setup", and setup runs
 * at most once however often ready is called. The runBot supervision of a stopped subscription does not apply in tests
 *
 * @example
 * ```ts
 * import assert from "node:assert/strict"
 * import { createTestBot } from "@neontechspace/fluxerly/testing"
 *
 * await using test = createTestBot({
 *     commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong!") } } },
 * })
 * const replies = test.rest.respond("POST /channels/:id/messages", { body: test.fixtures.message({ content: "Pong!" }) })
 * await test.ready()
 * test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!ping" }))
 * const request = await replies.next()
 * assert.equal((request.body as { content?: unknown }).content, "Pong!")
 * ```
 *
 * @category Testing
 */
export function createTestBot<
    const F extends MessageFields | undefined = undefined,
    const S extends Readonly<Record<string, unknown>> = Readonly<Record<string, CommandArgumentSchema | undefined>>,
>(options: TestBotOptions<F, S>): TestClient<SelectedMessage<F>> {
    if (typeof options !== "object" || options === null || Array.isArray(options))
        throw new ConfigurationError("configuration", "Bot options must be an object")
    checkTestOptionKeys(options, botOptionKeys)
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
    const test = createTestClient<F>({
        ...clientOptions,
        ...(token === undefined ? {} : { token }),
    } as TestClientOptions<F>)
    let runSetup: (signal: AbortSignal) => Promise<void>
    try {
        runSetup = installTestBot(test.client, { events, ignoreBots, commands, setup } as never)
    } catch (error) {
        // The client owns no socket yet, and its cleanup failure is logged by the client, as runBot does
        void test
            .shutdown()
            .then(undefined, (defect: unknown) => clientServices(test.client)?.logging.outputFailure(defect))
        throw error
    }
    // Shutdown aborts the setup signal before stopping the client, as runBot does when the bot begins stopping
    const stopping = new AbortController()
    let setupDone: Promise<void> | undefined
    const ready = async (readyOptions?: OperationOptions) => {
        setupDone ??= runSetup(stopping.signal)
        await setupDone
        await test.ready(readyOptions)
    }
    const shutdown = () => {
        stopping.abort()
        return test.shutdown()
    }
    return Object.freeze({ ...test, ready, shutdown, [Symbol.asyncDispose]: shutdown })
}
