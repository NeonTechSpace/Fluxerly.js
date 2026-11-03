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
 * Message sends and edits without a registered response receive an echoed bot message, and other unmatched requests
 * receive a Fluxer-shaped 404 and a testing.unmatchedRequest Warn record.
 * Waits such as idle, say and TestRoute.next have no deadline unless timeoutMs is passed, and the Node.js test runner has
 * no default timeout. Pass timeoutMs to a wait that might never settle, or run tests with --test-timeout and
 * --test-force-exit.
 * SDK timers run on real time unless the clock option selects "manual", whose time moves only through advance.
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
import type { GatewayErrorData } from "./gateway-payloads.js"
import { ConfigurationError } from "./errors.js"
import { attachCreationClock } from "./internal/client.js"
import { checkTestOptionKeys, clientWork, defaultTestSettingKeys, TestHarness } from "./internal/testing/harness.js"
import { ManualClock } from "./internal/testing/manual-clock.js"
import { botOptionKeys } from "./internal/bot-runner.js"
import type {
    TestDisconnectOptions,
    TestEmitOptions,
    TestGatewayCommand,
    TestRequest,
    TestRest,
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
    TestRest,
    TestRoute,
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
 * Choose the clock that a default test client's SDK timers follow
 *
 * @category Testing
 */
export interface TestClockSettings {
    /**
     * The clock of the SDK's own timers, default "real".
     * With "manual", a test clock that starts at 0, as monotonic time and as Unix epoch milliseconds, moves only when
     * advance moves it. It drives client.schedule delays and intervals, waitFor and collector timeouts, cooldowns in a
     * command router's own store, cache expiry, member request timeouts, REST and presence pacing, the keepTyping
     * refresh, reconnect delays and the gateway heartbeat. A cooldown store passed to a command, such as commands.memoryCooldowns(), keeps its own time.
     * Date.now() and new Date() in application code, timers the application starts itself, the timeoutMs of next, idle
     * and say, and socket and process watchdogs keep real time.
     * A client that owns more than one shard or uses automatic sharding throws ConfigurationError with "manual", because
     * the SDK spaces several shards' Identify commands on the clock, and so does any other value
     */
    readonly clock?: "real" | "manual"
}

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
    TestSettings &
    TestClockSettings

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
     * body in snake_case, so it passes through the SDK's real decoders, cache updates and handlers. With the
     * client's cache option enabled, handlers receive EventContext.previous exactly as against Fluxer, and every
     * accepted dispatch advances client.lastReceipt.
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
     * Deliver one opcode 12 Gateway Error frame to a connected shard synchronously, as Fluxer does when it refuses a
     * voice join. The data is the frame's d with Fluxer's field names, such as
     * { code: "VOICE_CHANNEL_FULL", message: "Voice channel is full" }, and reaches gatewayError subscriptions, never raw
     * ones, without a sequence number. The frame goes to shard 0 unless options.shardId names another shard.
     * Handlers run afterwards on their own schedule. Throws ConfigurationError before ready, for a shard this client does
     * not own and for data that is not JSON-serializable
     */
    emitGatewayError(data: GatewayErrorData, options?: TestEmitOptions): void
    /**
     * Close one shard's connection from the gateway side with a close code. The SDK then recovers as it would
     * against Fluxer, resuming with RESUMED for a resumable code, or ends the connection lifetime for a fatal one.
     * With endSession set, the client identifies a new session instead of resuming.
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
     * Error records of failures no application code handled so far, in order, such as an event handler, command or
     * client.schedule task run that threw or returned a failed Result while no onError hook was registered, whether the
     * error came from the application or from a Fluxer rejection. Assert expected failures here, because
     * shutdown rejects for unhandled failures that failures() has not returned.
     * Failures are captured whatever the logging level, categories and deduplication, so each one appears here and
     * counts for shutdown even when logs() leaves it out
     */
    failures(): readonly LogRecord[]
    /**
     * Resolve once the client has settled: No event handler or command is running or has a received event waiting for
     * it, no client.schedule task run is running, no REST request is queued or waiting for its test response, and no new
     * log record, request or gateway command appeared for a few event loop turns. Use it after emit to assert that the
     * bot did nothing, or before inspecting results.
     * Open waits and collectors do not count as work, and onError hooks are not awaited. A scheduled task waiting for its
     * time does not count either, so advance the manual clock to run it, or wait for its delay on real time.
     * Without timeoutMs the wait has no SDK deadline, so it can run forever unless the test runner stops the test. With timeoutMs the promise rejects with TestTimeoutError when the client is still busy after it.
     * It rejects with ClientClosedError after shutdown. Invalid options throw ConfigurationError.
     * The wait's own timers, including timeoutMs, stay real when a test fakes timers.
     * The SDK runs on setImmediate, so fake timers must leave it real, otherwise idle rejects with ConfigurationError
     * instead of settling while no handler can run
     */
    idle(options?: TestWaitOptions): Promise<void>
    /**
     * Move the manual test clock forward by ms milliseconds, then resolve once the client has settled at the new time.
     * The clock stops at each SDK deadline on the way, in order, and waits there until the work it starts has settled,
     * as idle does, before it moves on. So a task scheduled with delayMs runs once the clock reaches its delay, and an
     * interval task advanced by three intervals runs three times. Calls made while one runs wait for it.
     * Work that keeps running counts as waiting for the clock, so it cannot hold the clock still, only while every
     * running handler, command and scheduled task awaits an SDK call, such as waitFor or a request in a rate limit wait,
     * and nothing new happens for a few more event loop turns. A handler awaiting anything else, such as its own file,
     * database or timer, is waited for as idle waits for it, before the clock moves on. A handler awaiting its own work
     * and an SDK call together, as in Promise.all, counts as waiting for the clock.
     * Like idle, it has no deadline, so work that keeps making requests or never finishes keeps it waiting.
     * Throws ConfigurationError without clock: "manual" and for a negative or non-finite ms, and rejects with
     * ClientClosedError after shutdown
     *
     * @example
     * ```ts
     * import assert from "node:assert/strict"
     * import { createTestClient } from "@neontechspace/fluxerly/testing"
     *
     * await using test = createTestClient({ clock: "manual" })
     * let runs = 0
     * test.client.schedule(() => void runs++, { delayMs: 60_000, intervalMs: 60_000 })
     * await test.advance(59_999)
     * assert.equal(runs, 0)
     * await test.advance(120_001)
     * assert.equal(runs, 3)
     * ```
     */
    advance(ms: number): Promise<void>
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
    return openTestClient(options).test
}

/** Create a test client together with the harness that createTestBot also drives */
function openTestClient<F extends MessageFields | undefined>(
    options: TestClientOptions<F>,
): { readonly test: TestClient<SelectedMessage<F>>; readonly harness: TestHarness } {
    let manual: ManualClock | undefined
    const harness = new TestHarness(options, () => (manual = new ManualClock()))
    const clientOptions = harness.clientOptions(options)
    // Every SDK timer of the client, and the default-API work it runs, then follows the manual clock
    if (manual !== undefined) attachCreationClock(clientOptions, manual.clock)
    const client = createClient<F>(clientOptions as ClientOptions<F>)
    harness.attachLogger(clientServices(client)!.logging)
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
    const test = Object.freeze({
        client,
        fixtures: harness.fixtures,
        rest: Object.freeze({ respond: harness.http.respond.bind(harness.http) }),
        ready: async (options?: OperationOptions) => {
            const connected = await client.connect(options)
            if (connected.isErr()) throw connected.error
        },
        emit: (type: string, payload: unknown, options?: TestEmitOptions) =>
            harness.gateway.emit(type, payload, options),
        emitGatewayError: (data: GatewayErrorData, options?: TestEmitOptions) =>
            harness.gateway.emitGatewayError(data, options),
        disconnect: (options?: TestDisconnectOptions) => harness.gateway.disconnect(options),
        requests: () => harness.http.requests(),
        commands: () => harness.gateway.commands(),
        logs: () => harness.logs(),
        failures: () => harness.failures(),
        idle: (options?: TestWaitOptions) => harness.idle(clientWork(client), options),
        advance: (ms: number) => harness.advance(clientWork(client), ms),
        counters: () => client.diagnostics().counters,
        shutdown,
        [Symbol.asyncDispose]: shutdown,
    })
    return { test, harness }
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
    Omit<TestSettings, "token"> &
    TestClockSettings & {
        /** Token passed to the client, never sent anywhere. Omit it or pass undefined to use the fixture token */
        readonly token?: string | undefined
    }

/**
 * A test client running a bot written for runBot, with say to talk to the bot as a user would
 *
 * @category Testing
 */
export interface TestBot<M extends MessageCore = Message> extends TestClient<M> {
    /**
     * Deliver a message with this content from a human user, wait until the bot has settled as idle does, and resolve
     * with the messages the bot sent meanwhile, in send order, or an empty list when it sent nothing. Call ready first.
     * Each entry is a message send (POST /channels/:id/messages) in wire shape, built from the request body with the
     * fields the automatic reply echoes, so it shows what the bot sent even when a rest.respond handler answered,
     * including a send that handler rejected.
     * Edits, reactions and other requests are not included, and remain visible through requests().
     * The message comes from the fixture set's default human author in its default channel and community, and
     * options.message replaces any of those wire fields. The content is normalized as Fluxer normalizes sent text,
     * without form feed (U+000C) or U+202E and with surrounding whitespace trimmed, so "!ping " arrives as "!ping".
     * Use emit with fixtures.message to deliver content unchanged.
     * With the manual clock, say also resolves once the bot can continue only when the clock moves, as advance does at
     * each stop, such as a command awaiting waitFor. Call advance next to let it finish, and inspect the later replies
     * with requests(). Like idle, say has no deadline unless
     * options.timeoutMs is set, then rejects with TestTimeoutError when the bot is still busy after it, and rejects
     * with ClientClosedError after shutdown. It throws ConfigurationError for content that is not a string, invalid
     * options, before ready and when gateway filtering would suppress the message, as emit does
     *
     * @example
     * ```ts
     * import assert from "node:assert/strict"
     * import { createTestBot } from "@neontechspace/fluxerly/testing"
     *
     * await using test = createTestBot({
     *     commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong!") } } },
     * })
     * await test.ready()
     * const [reply] = await test.say("!ping")
     * // Checked first, because a failed assertion and a failed cleanup together can hide the reason behind SuppressedError
     * assert.deepEqual(test.failures(), [])
     * assert.equal(reply?.content, "Pong!")
     * assert.deepEqual(await test.say("hello"), [])
     * ```
     */
    say(content: string, options?: TestSayOptions): Promise<readonly WireMessage[]>
}

/**
 * Create a test client that runs a bot written for runBot: Its events, ignoreBots setting, commands and setup callback,
 * with the same handler contexts, delivery defaults and command router as runBot. Handlers and commands are registered at once,
 * and ready runs setup before connecting, as runBot does, so a test drives the bot exactly as Fluxer would.
 * The setup signal aborts when shutdown starts.
 * It returns the controls of createTestClient plus say, and shutdown or `await using` cleans it up. Automatic gateway
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
 * await test.ready()
 * // The test transport answers the reply with an echoed message, so no rest.respond fixture is needed
 * const replies = await test.say("!ping")
 * // Checked first, because a failed assertion and a failed cleanup together can hide the reason behind SuppressedError
 * assert.deepEqual(test.failures(), [])
 * assert.deepEqual(
 *     replies.map((message) => message.content),
 *     ["Pong!"],
 * )
 * ```
 *
 * @category Testing
 */
export function createTestBot<
    const F extends MessageFields | undefined = undefined,
    const S extends Readonly<Record<string, unknown>> = Readonly<Record<string, CommandArgumentSchema | undefined>>,
>(options: TestBotOptions<F, S>): TestBot<SelectedMessage<F>> {
    if (typeof options !== "object" || options === null || Array.isArray(options))
        throw new ConfigurationError("configuration", "Bot options must be an object")
    checkTestOptionKeys(options, [...botOptionKeys, ...defaultTestSettingKeys])
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
    const { test, harness } = openTestClient<F>({
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
    const say = (content: string, sayOptions?: TestSayOptions) =>
        harness.say(clientWork(test.client), content, sayOptions)
    return Object.freeze({ ...test, ready, say, shutdown, [Symbol.asyncDispose]: shutdown })
}
