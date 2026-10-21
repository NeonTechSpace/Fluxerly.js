import { setImmediate as turn } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect, onTestFinished, test, vi } from "vitest"
import {
    ApplicationError,
    commands,
    AttachmentDownloadError,
    AttachmentRefreshError,
    AuthenticationError,
    BotApplicationOperationError,
    CancelledError,
    ChannelOperationError,
    ClientClosedError,
    CollectorError,
    ConfigurationError,
    ConnectionError,
    createClient,
    runBot,
    describeError,
    errors,
    FluxerlyError,
    GuildOperationError,
    HelperError,
    MessageCleanupError,
    MessageError,
    MessageOperationError,
    OAuthOperationError,
    RateLimitError,
    RestRequestError,
    SdkDefect,
    ShardConnectionError,
    UserOperationError,
    WebhookOperationError,
    type NotFoundResource,
} from "../../src/index.js"
import * as native from "../../src/effect.js"
import { apiErrorDetail } from "../../src/api-errors.js"
import { ExpiryQueue } from "../../src/internal/expiry-queue.js"
import { fixtureToken } from "../support/both-apis.js"
import { modes, setup } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"

test("SDK errors share the FluxerlyError base with stable codes, hints, details and JSON", () => {
    const failure = new GuildOperationError({
        operation: "roles.edit",
        reason: "rateLimit",
        outcome: "rejected",
        status: 429,
        retryAfterMs: 1_500,
        cause: new Error("transport detail"),
    })
    expect(failure).toBeInstanceOf(FluxerlyError)
    expect(failure).toMatchObject({
        _tag: "GuildOperationError",
        code: "guild.rateLimit",
        retryAfterMs: 1_500,
        hint: expect.any(String),
        details: {
            operation: "roles.edit",
            reason: "rateLimit",
            outcome: "rejected",
            status: 429,
            retryAfterMs: 1_500,
        },
    })
    expect(Object.isFrozen(failure.details)).toBe(true)
    expect(JSON.parse(JSON.stringify(failure))).toMatchObject({
        _tag: "GuildOperationError",
        code: "guild.rateLimit",
        cause: { name: "Error", message: "transport detail" },
    })
    const shard = new ShardConnectionError(1, new AuthenticationError())
    expect(shard.cause).toBe(shard.failure)
    expect(shard.hint).toEqual(expect.any(String))
    expect(shard.hint).toBe(shard.failure.hint)
    expect(native.FluxerlyError).toBe(FluxerlyError)
})

test("describeError prints the name, code, message, hint, details and cause chain with optional stacks", () => {
    const root = new TypeError("socket reset")
    const error = new ConnectionError("gateway", "network", null, { cause: root })
    const text = describeError(error)
    // The layout is the documented output, while the error's own message and hint prose are not fixed here
    expect(error.hint).toEqual(expect.any(String))
    expect(text.split("\n").slice(0, 3)).toEqual([
        `ConnectionError [connection.gateway.network]: ${error.message}`,
        `  Hint: ${error.hint}`,
        "  Details: phase=gateway reason=network",
    ])
    expect(text).toContain("Caused by: TypeError: socket reset")
    expect(text).toMatch(/\n {2}at /)
    expect(describeError(root, { stack: false })).toBe("TypeError: socket reset")
    expect(describeError("plain text")).toBe("Non-Error value (string): plain text")
    expect(describeError(new Error(`Bot ${"Mzk0.fixture-canary".repeat(2)}`))).toContain("Bot [redacted]")
})

test("isRetryable separates safe repeats from rejections, input and uncertain writes", () => {
    const operation = (
        reason: "busy" | "network" | "rejected" | "input" | "rateLimit",
        outcome: "notDispatched" | "unknown" | "rejected",
    ) => new GuildOperationError({ operation: "roles.edit", reason, outcome })
    expect(errors.isRetryable(operation("busy", "notDispatched"))).toBe(true)
    expect(errors.isRetryable(operation("network", "notDispatched"))).toBe(true)
    expect(errors.isRetryable(operation("network", "unknown"))).toBe(false)
    expect(errors.isRetryable(operation("rateLimit", "rejected"))).toBe(true)
    expect(errors.isRetryable(operation("rejected", "rejected"))).toBe(false)
    expect(errors.isRetryable(operation("input", "notDispatched"))).toBe(false)
    expect(errors.isRetryable(new MessageError({ reason: "timeout", outcome: "notDispatched" }))).toBe(true)
    expect(errors.isRetryable(new MessageError({ reason: "timeout", outcome: "unknown" }))).toBe(false)
    expect(errors.isRetryable(new RateLimitError("gateway", null))).toBe(true)
    expect(errors.isRetryable(new ShardConnectionError(0, new ConnectionError("gateway", "network")))).toBe(true)
    expect(errors.isRetryable(new AuthenticationError())).toBe(false)
    expect(errors.isRetryable(new Error("application"))).toBe(false)
})

test("isRetryable of an Effect Cause needs a reason and only retryable failures", () => {
    const retryable = new GuildOperationError({ operation: "roles.edit", reason: "network", outcome: "notDispatched" })
    const uncertain = new GuildOperationError({ operation: "roles.edit", reason: "network", outcome: "unknown" })
    const fail = (error: unknown) => Cause.makeFailReason(error)
    expect(errors.isRetryable(Cause.fail(retryable))).toBe(true)
    expect(errors.isRetryable(Cause.fromReasons([fail(retryable), fail(new RateLimitError("http", 500))]))).toBe(true)
    // One failure that is not safe to repeat, a defect, an interruption or no reason at all makes the Cause false
    expect(errors.isRetryable(Cause.fromReasons([fail(retryable), fail(uncertain)]))).toBe(false)
    expect(errors.isRetryable(Cause.fromReasons([fail(retryable), Cause.makeDieReason(new Error("cleanup"))]))).toBe(
        false,
    )
    expect(errors.isRetryable(Cause.fromReasons([fail(retryable), Cause.makeInterruptReason()]))).toBe(false)
    expect(errors.isRetryable(Cause.fail(new Error("application")))).toBe(false)
    expect(errors.isRetryable(Cause.die(new Error("defect")))).toBe(false)
    expect(errors.isRetryable(Cause.interrupt())).toBe(false)
    expect(errors.isRetryable(Cause.fromReasons([]))).toBe(false)
    expect(native.errors.isRetryable).toBe(errors.isRetryable)
})

test("retryAfterMs reads the wait of an SDK error and the largest wait among the failures of a Cause", () => {
    const waiting = (retryAfterMs: number | null) =>
        new GuildOperationError({ operation: "roles.edit", reason: "rateLimit", outcome: "rejected", retryAfterMs })
    expect(errors.retryAfterMs(waiting(1_500))).toBe(1_500)
    expect(errors.retryAfterMs(waiting(0))).toBe(0)
    expect(errors.retryAfterMs(new RateLimitError("gateway", 2_000))).toBe(2_000)
    expect(errors.retryAfterMs(new MessageError({ reason: "rateLimit", outcome: "rejected", retryAfterMs: 700 }))).toBe(
        700,
    )
    // A shard failure carries the wait of the failure that stopped it
    expect(errors.retryAfterMs(new ShardConnectionError(1, new RateLimitError("gateway", 3_000)))).toBe(3_000)
    // No usable wait, other errors and other values give undefined
    for (const value of [
        waiting(null),
        new ShardConnectionError(1, new AuthenticationError()),
        new GuildOperationError({ operation: "roles.edit", reason: "network", outcome: "unknown" }),
        new RateLimitError("http", null),
        new Error("application"),
        // A look-alike is not an SDK error
        Object.assign(new Error("look-alike"), { retryAfterMs: 5 }),
        { retryAfterMs: 5 },
        "text",
        undefined,
        null,
    ])
        expect(errors.retryAfterMs(value)).toBeUndefined()
    const fail = (error: unknown) => Cause.makeFailReason(error)
    expect(errors.retryAfterMs(Cause.fail(waiting(900)))).toBe(900)
    expect(
        errors.retryAfterMs(
            Cause.fromReasons([
                fail(waiting(900)),
                fail(new Error("application")),
                fail(new RateLimitError("http", 4_000)),
                fail(waiting(null)),
                Cause.makeDieReason(waiting(9_000)),
            ]),
        ),
    ).toBe(4_000)
    expect(errors.retryAfterMs(Cause.fromReasons([Cause.makeInterruptReason()]))).toBeUndefined()
    expect(errors.retryAfterMs(Cause.die(new Error("defect")))).toBeUndefined()
    expect(errors.retryAfterMs(Cause.fromReasons([]))).toBeUndefined()
    expect(native.errors.retryAfterMs).toBe(errors.retryAfterMs)
})

test("retryAfterMs never throws for values that reject inspection", () => {
    const hostile = new Proxy(
        {},
        {
            getPrototypeOf() {
                throw new Error("trap")
            },
            get() {
                throw new Error("trap")
            },
        },
    )
    expect(errors.retryAfterMs(hostile)).toBeUndefined()
    // A proxy of an SDK error passes the instance check, so its throwing property reads must be guarded as well
    const throwingReads = new Proxy(new RateLimitError("gateway", 2_000), {
        get() {
            throw new Error("trap")
        },
    })
    expect(errors.retryAfterMs(throwingReads)).toBeUndefined()
    expect(errors.retryAfterMs(Cause.fail(throwingReads))).toBeUndefined()
})

test("match calls the handler for the error tag or the fallback", () => {
    const pick = (value: ConfigurationError | AuthenticationError) => value
    const failure = pick(new ConfigurationError("token", "Token must be a string"))
    expect(
        errors.match(failure, {
            ConfigurationError: (error) => `field ${error.field}`,
            AuthenticationError: () => "auth",
        }),
    ).toBe("field token")
    expect(errors.match(new Error("x"), { _: (error) => (error as Error).message })).toBe("x")
    expect(errors.match(pick(new AuthenticationError()), { ConfigurationError: () => 1 })).toBeUndefined()
})

test("common mistakes produce actionable hints", async () => {
    expect(() => createClient({ token: process.env.FLUXERLY_TEST_UNSET_TOKEN_VARIABLE })).toThrow(
        expect.objectContaining({ _tag: "ConfigurationError", field: "token", hint: expect.any(String) }),
    )
    const client = createClient({ token: "fixture-only-not-a-credential" })
    // The quoted suggestion is not a substring of the quoted misspelled name, so only a real suggestion matches
    expect(() => client.on("messageCreated" as "messageCreate", () => undefined)).toThrow(
        expect.objectContaining({
            _tag: "ConfigurationError",
            field: "event",
            hint: expect.stringContaining('"messageCreate"'),
        }),
    )
    await client.shutdown()
    const exit = await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const nativeClient = yield* native.createClient({ token: "fixture-only-not-a-credential" })
                const scope = yield* Scope.make()
                return yield* nativeClient
                    .on("guildMemberAdded" as "guildMemberAdd", () => Effect.void)
                    .pipe(Scope.provide(scope))
            }),
        ),
    )
    expect(Exit.isFailure(exit) ? exit.cause.reasons : undefined).toEqual([
        expect.objectContaining({
            _tag: "Die",
            defect: expect.objectContaining({
                _tag: "ConfigurationError",
                field: "event",
                hint: expect.stringContaining('"guildMemberAdd"'),
            }),
        }),
    ])
    expect(new AuthenticationError().hint).toEqual(expect.any(String))
})

test("misspelled wait, collector and command keys are named with the closest supported key", async () => {
    const named = (key: string, suggestion: string) =>
        expect.objectContaining({
            _tag: "ConfigurationError",
            message: expect.stringContaining(`"${key}"`),
            hint: expect.stringContaining(`"${suggestion}"`),
        })
    const client = createClient({ token: "fixture-only-not-a-credential" })
    const waited = await client.waitFor("messageCreate", { timeout: 10 } as never)
    expect(waited.isErr() ? waited.error : undefined).toEqual(named("timeout", "timeoutMs"))
    expect(() => client.messages.collect("1", { maxMessage: 1 } as never)).toThrow(named("maxMessage", "maxMessages"))
    const router = commands.create({ prefix: "!" })
    expect(() => router.register({ name: "ping", descriptions: "Ping", execute() {} } as never)).toThrow(
        named("descriptions", "description"),
    )
    expect(() =>
        router.register({ name: "add", arguments: { count: { type: "integer", mn: 1 } }, execute() {} } as never),
    ).toThrow(
        expect.objectContaining({ message: expect.stringContaining("count"), hint: expect.stringContaining('"min"') }),
    )
    await client.shutdown()
    const exit = await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const nativeClient = yield* native.createClient({ token: "fixture-only-not-a-credential" })
                return yield* nativeClient.waitFor("messageCreate", { timeout: 10 } as never)
            }),
        ),
    )
    expect(Exit.isFailure(exit) ? exit.cause.reasons : undefined).toEqual([
        expect.objectContaining({ _tag: "Fail", error: named("timeout", "timeoutMs") }),
    ])
})

test("application callback faults are named and kept as SdkDefect causes", () => {
    const thrown = new RangeError("installer broke")
    const wrapped = new ApplicationError("runBot setup", thrown)
    const defect = new SdkDefect("runBot", [{ kind: "Defect", defect: wrapped, origin: "application" }])
    expect(defect.cause).toBe(wrapped)
    expect(wrapped.cause).toBe(thrown)
    // The application-provided source name and thrown text are quoted, while the surrounding prose is not fixed
    expect(defect.message).toContain("runBot setup")
    expect(defect.message).toContain("installer broke")
    expect(defect.code).toBe("application.defect")
})

test("the expiry queue removes live entries in deadline order and ignores replaced ones", () => {
    const live = new Set<{ expires: number; id: string }>()
    const queue = new ExpiryQueue<{ expires: number; id: string }>((entry) => live.has(entry))
    const make = (id: string, expires: number) => {
        const entry = { id, expires }
        live.add(entry)
        queue.push(entry)
        return entry
    }
    const first = make("a", 30)
    make("b", 10)
    make("c", 20)
    live.delete(first)
    make("a", 40)
    const removed: string[] = []
    queue.purge(25, (entry) => {
        live.delete(entry)
        removed.push(entry.id)
    })
    expect(removed).toEqual(["b", "c"])
    expect(queue.next()).toBe(40)
    for (let index = 0; index < 200; index++) live.delete(make(`stale${index}`, 100 + index))
    queue.compact(live.size)
    expect(queue.size).toBeLessThanOrEqual(live.size * 2 + 64)
    expect(queue.next()).toBe(40)
})

test("the expiry queue releases replaced and removed snapshots before their stale entries reach the top", async () => {
    // Obtains a full garbage collection, as leak detectors do, then restores the flag for the rest of the worker
    let gc: () => void
    setFlagsFromString("--expose-gc")
    try {
        gc = runInNewContext("gc") as () => void
    } finally {
        setFlagsFromString("--no-expose-gc")
    }
    type Entry = { readonly id: string; readonly expires: number; readonly snapshot: object }
    const live = new Map<string, Entry>()
    const queue = new ExpiryQueue<Entry>((entry) => live.get(entry.id) === entry)
    const set = (id: string, expires: number) => {
        const entry = { id, expires, snapshot: {} }
        live.set(id, entry)
        queue.push(entry)
        return entry
    }
    // The earliest entry stays live at the top, so no stale entry is popped before the collection
    set("earliest", 10)
    const released = (() => {
        const replaced = set("replaced", 50)
        set("replaced", 60)
        const removed = set("removed", 70)
        live.delete("removed")
        return [new WeakRef(replaced.snapshot), new WeakRef(removed.snapshot)]
    })()
    // A new WeakRef keeps its target alive until the current job ends
    await turn()
    gc()
    expect(released.map((reference) => reference.deref())).toEqual([undefined, undefined])
    expect(queue.next()).toBe(10)
})

test("error text, JSON and descriptions stay total and masked for unusual or credential-bearing values", () => {
    const hostile = new Proxy(
        {},
        {
            get: () => {
                throw new Error("hostile get")
            },
            getPrototypeOf: () => {
                throw new Error("hostile prototype")
            },
        },
    )
    const values: unknown[] = [Object.create(null), hostile, null, undefined, Symbol("thrown"), 10n]
    for (const value of values) {
        const defect = new SdkDefect("runBot", [{ kind: "Defect", defect: value, origin: "application" }])
        expect(defect).toMatchObject({ code: "application.defect", message: expect.stringMatching(/\S/) })
        expect(() => JSON.stringify(defect)).not.toThrow()
        expect(describeError(value)).toMatch(/\S/)
        const application = new ApplicationError("keepTyping task", value)
        expect(application).toMatchObject({
            code: "application.callbackFailed",
            message: expect.stringContaining("keepTyping task"),
        })
        expect(() => JSON.stringify(application)).not.toThrow()
        const sdk = new SdkDefect("run", [{ kind: "Defect", defect: value, origin: "sdk" }])
        expect(sdk).toMatchObject({ code: "sdk.defect", message: expect.stringMatching(/\S/) })
        expect(() => JSON.stringify(sdk)).not.toThrow()
    }
    const webhook = "https://api.fluxer.app/v1/webhooks/123/webhook-canary-secret"
    const inner = new Error(`request to ${webhook} failed with Authorization: Bot other-canary`)
    const wrapped = new ApplicationError("runBot install", inner)
    const json = JSON.stringify(wrapped.toJSON())
    for (const text of [wrapped.message, json, describeError(wrapped)]) {
        expect(text).not.toContain("webhook-canary-secret")
        expect(text).not.toContain("other-canary")
    }
    // The cause keeps the original value unchanged for the application
    expect(wrapped.cause).toBe(inner)
    expect(inner.message).toContain("webhook-canary-secret")
})

test("a read failure records details.read and drops the write-reconciliation hint", () => {
    const read = new GuildOperationError({ operation: "roles.edit", reason: "network", outcome: "unknown", read: true })
    expect(read.details).toMatchObject({ read: true })
    expect(errors.isRetryable(read)).toBe(true)
    const write = new GuildOperationError({ operation: "roles.edit", reason: "network", outcome: "unknown" })
    expect(write.details).not.toHaveProperty("read")
    expect(write.hint).toEqual(expect.any(String))
    // Only the write is told to check whether the change was applied
    expect(read.hint).not.toBe(write.hint)
    expect(write.message.length).toBeGreaterThan(read.message.length)
    expect(errors.isRetryable(write)).toBe(false)
})

test.each(modes)("%s apiCode reads the rejection category from any error of an operation Result", async (mode) => {
    onTestFinished(() => void vi.unstubAllGlobals())
    stubFetchWithHostedDiscovery(async () =>
        Response.json({ code: "MISSING_PERMISSIONS", message: "Missing Permissions" }, { status: 403 }),
    )
    const client = await setup(mode)
    const rejected = await settle<unknown, unknown>(client.members.kick({ guildId: "20", userId: "30" })).then(
        () => expect.fail("The kick should be rejected"),
        (error: unknown) => error,
    )
    expect(errors.apiCode(rejected)).toBe("missingPermissions")
    expect(native.errors.apiCode(rejected)).toBe("missingPermissions")
    // Failures without a Fluxer rejection body have no category, so the same condition is safe on every error
    const invalid = await settle<unknown, unknown>(client.members.kick({ guildId: "x", userId: "30" })).then(
        () => expect.fail("The kick should fail locally"),
        (error: unknown) => error,
    )
    expect(errors.apiCode(invalid)).toBeUndefined()
    expect(errors.apiCode(new Error("application"))).toBeUndefined()
    expect(errors.apiCode(undefined)).toBeUndefined()
})

test("describeError collapses SDK and Effect frames, keeps application frames and omits expected SDK error stacks", () => {
    const sdkFrame = fileURLToPath(new URL("../../src/internal/rest/owner.ts", import.meta.url))
    const failure = new Error("handler broke")
    failure.stack = [
        "Error: handler broke",
        "    at handler (/app/bot.js:10:5)",
        `    at run (${sdkFrame}:1:1)`,
        `    at next (${sdkFrame}:2:2)`,
        "    at step (/app/node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/Effect.js:3:3)",
        "    at main (/app/bot.js:20:1)",
    ].join("\n")
    const lines = describeError(failure).split("\n")
    expect(lines.filter((line) => line.includes("/app/bot.js"))).toHaveLength(2)
    expect(lines.some((line) => line.includes(sdkFrame) || line.includes("effect@"))).toBe(false)
    // The three internal frames between the application frames become one line that still says how many were hidden
    expect(lines.filter((line) => line.includes("3"))).toHaveLength(1)

    const rejected = new MessageError({ reason: "rejected", outcome: "rejected", status: 403 })
    expect(describeError(rejected)).not.toMatch(/\n\s+at /)
})

test("describeError collapses SDK frames printed as percent-encoded file URLs", () => {
    // A file URL percent-encodes a space or non-ASCII character in the install path. Encoding one plain letter stands in
    // for that, since this checkout's own path may need no escapes
    const url = new URL("../../src/internal/rest/owner.ts", import.meta.url).href
    const letter = url.lastIndexOf("/src/") - 1
    const encoded = `${url.slice(0, letter)}%${url.charCodeAt(letter).toString(16).toUpperCase()}${url.slice(letter + 1)}`
    const failure = new Error("handler broke")
    failure.stack = [
        "Error: handler broke",
        "    at handler (file:///app/bot.js:10:5)",
        `    at run (${encoded}:1:1)`,
        `    at next (${encoded}:2:2)`,
        "    at main (file:///app/bot%20100%.js:20:1)",
    ].join("\n")
    const lines = describeError(failure).split("\n")
    expect(lines.some((line) => line.includes(encoded))).toBe(false)
    expect(lines.filter((line) => line.includes("/app/bot"))).toHaveLength(2)
    expect(lines.filter((line) => /\.\.\. 2 SDK and Effect frames/.test(line))).toHaveLength(1)
})

test("describeError describes every reason of an Effect Cause, masked", () => {
    const token = `1456074443980800001.${"fixtureOnlyNotACredential".padEnd(43, "x")}`
    const cause = Cause.fromReasons([
        Cause.makeFailReason(new ConfigurationError("token", "Token must be a non-empty string")),
        Cause.makeDieReason(new Error(`cleanup broke with ${token}`)),
        Cause.makeInterruptReason(),
    ])
    const text = describeError(cause, { stack: false })
    expect(text).toMatch(/Failure:\n\s+ConfigurationError \[configuration\.invalid\]/)
    expect(text).toMatch(/Defect:\n\s+Error: cleanup broke/)
    expect(text).toContain("Interrupted")
    expect(text).not.toContain("fixtureOnlyNotACredential")
})

test.each([
    ["createClient", () => createClient({ token: "" })],
    ["runBot", () => runBot({ token: fixtureToken, setup: 5 as never })],
])("a configuration error thrown by %s points at the caller's line", (_name, call) => {
    let thrown: unknown
    try {
        call()
    } catch (error) {
        thrown = error
    }
    expect(thrown).toBeInstanceOf(ConfigurationError)
    const frames = String((thrown as Error).stack)
        .split("\n")
        .filter((line) => /^\s+at /.test(line))
    expect(frames[0]).toContain("error-tools.test.ts")
})

const outcomes = ["notDispatched", "rejected", "unknown"] as const

/** One error of every SDK class that reports an outcome, built with the given outcome */
const outcomeErrors: readonly (readonly [string, (outcome: (typeof outcomes)[number]) => unknown])[] = [
    [
        "GuildOperationError",
        (outcome) => new GuildOperationError({ operation: "roles.edit", reason: "network", outcome }),
    ],
    [
        "ChannelOperationError",
        (outcome) => new ChannelOperationError({ operation: "channels.fetch", reason: "network", outcome }),
    ],
    [
        "WebhookOperationError",
        (outcome) => new WebhookOperationError({ operation: "webhooks.fetch", reason: "network", outcome }),
    ],
    [
        "UserOperationError",
        (outcome) => new UserOperationError({ operation: "users.fetch", reason: "network", outcome }),
    ],
    [
        "BotApplicationOperationError",
        (outcome) => new BotApplicationOperationError({ operation: "application.fetch", reason: "network", outcome }),
    ],
    ["RestRequestError", (outcome) => new RestRequestError({ operation: "rest.request", reason: "network", outcome })],
    [
        "AttachmentRefreshError",
        (outcome) => new AttachmentRefreshError({ operation: "attachments.refreshUrls", reason: "network", outcome }),
    ],
    [
        "MessageOperationError",
        (outcome) => new MessageOperationError({ operation: "fetch", reason: "network", outcome }),
    ],
    ["MessageError", (outcome) => new MessageError({ reason: "network", outcome })],
    [
        "OAuthOperationError",
        (outcome) => new OAuthOperationError({ operation: "oauth.refresh", reason: "network", outcome }),
    ],
    [
        "MessageCleanupError",
        (outcome) =>
            new MessageCleanupError({
                phase: "cleanup",
                reason: "network",
                outcome,
                status: null,
                retryAfterMs: null,
                scannedCount: 0,
                selectedMessageIds: [],
                submittedBatches: [],
                terminalBatchIds: null,
            }),
    ],
    ["ClientClosedError", (outcome) => new ClientClosedError({ outcome })],
]

test.each(outcomeErrors)("outcome reads the outcome of %s", (_name, make) => {
    for (const outcome of outcomes) expect(errors.outcome(make(outcome))).toBe(outcome)
})

test("outcome is undefined where the SDK cannot establish one", () => {
    const failure = new GuildOperationError({ operation: "roles.edit", reason: "network", outcome: "unknown" })
    for (const value of [
        new ClientClosedError(),
        new CancelledError("presence.set"),
        new SdkDefect("run", [{ kind: "Defect", defect: failure, origin: "sdk" }]),
        new AttachmentDownloadError({ reason: "network" }),
        new CollectorError("notConnected"),
        new Error("application"),
        // A look-alike is not an SDK error
        Object.assign(new Error("look-alike"), { outcome: "unknown" }),
        { outcome: "unknown" },
        "text",
        undefined,
        null,
    ])
        expect(errors.outcome(value)).toBeUndefined()
    expect(native.errors.outcome).toBe(errors.outcome)
})

test("outcome of an Effect Cause is the least certain outcome when every failure has one", () => {
    const operation = (outcome: (typeof outcomes)[number]) =>
        new GuildOperationError({ operation: "roles.edit", reason: "network", outcome })
    const fail = (outcome: (typeof outcomes)[number]) => Cause.makeFailReason(operation(outcome))
    expect(errors.outcome(Cause.fail(operation("rejected")))).toBe("rejected")
    expect(errors.outcome(Cause.fromReasons([fail("notDispatched"), fail("rejected")]))).toBe("rejected")
    expect(errors.outcome(Cause.fromReasons([fail("rejected"), fail("unknown"), fail("notDispatched")]))).toBe(
        "unknown",
    )
    expect(errors.outcome(Cause.fromReasons([fail("notDispatched"), fail("notDispatched")]))).toBe("notDispatched")
    // A failure, defect or interruption without a known outcome leaves the whole Cause unknown to the SDK
    expect(
        errors.outcome(Cause.fromReasons([fail("unknown"), Cause.makeDieReason(new Error("cleanup"))])),
    ).toBeUndefined()
    expect(errors.outcome(Cause.fromReasons([fail("rejected"), Cause.makeInterruptReason()]))).toBeUndefined()
    expect(
        errors.outcome(Cause.fromReasons([fail("rejected"), Cause.makeFailReason(new Error("application"))])),
    ).toBeUndefined()
    expect(errors.outcome(Cause.interrupt())).toBeUndefined()
    expect(errors.outcome(Cause.die(new Error("defect")))).toBeUndefined()
    expect(errors.outcome(Cause.fromReasons([]))).toBeUndefined()
    expect(errors.outcome(Cause.fail(new Cause.TimeoutError()))).toBeUndefined()
})

test("a closed client records its outcome in details and tells an unknown write to be checked", () => {
    const bare = new ClientClosedError()
    expect(bare.outcome).toBeUndefined()
    expect(bare.details).not.toHaveProperty("outcome")
    expect(bare.code).toBe("client.closed")
    const unknown = new ClientClosedError({ outcome: "unknown" })
    expect(unknown).toMatchObject({ code: "client.closed", outcome: "unknown", details: { outcome: "unknown" } })
    expect(unknown.hint).toContain("Check whether Fluxer applied the change")
    expect(describeError(unknown)).toContain("outcome=unknown")
    expect(unknown.toJSON().details).toMatchObject({ outcome: "unknown" })
    for (const outcome of ["notDispatched", "rejected"] as const) {
        const closed = new ClientClosedError({ outcome })
        expect(closed.details).toMatchObject({ outcome })
        expect(closed.hint).toBe(bare.hint)
    }
    // A read has no change to check, so it keeps the plain hint and records details.read
    const read = new ClientClosedError({ outcome: "unknown", read: true })
    expect(read.details).toEqual({ outcome: "unknown", read: true })
    expect(read.hint).toBe(bare.hint)
    expect(errors.isRetryable(unknown)).toBe(false)
})

test("isNotFound is true for a 404 status and, with a resource, only for that resource's Fluxer code", () => {
    const guild = new MessageOperationError({
        operation: "fetch",
        reason: "notFound",
        outcome: "rejected",
        status: 404,
        apiError: apiErrorDetail({ code: "UNKNOWN_GUILD" }),
    })
    expect(errors.isNotFound(guild)).toBe(true)
    expect(errors.isNotFound(guild, "guild")).toBe(true)
    expect(errors.isNotFound(guild, "member")).toBe(false)
    // A 404 reported as a rejection still counts, and one without a recognized code names no resource
    const rejected404 = new MessageError({ reason: "rejected", outcome: "rejected", status: 404 })
    expect(errors.isNotFound(rejected404)).toBe(true)
    expect(errors.isNotFound(rejected404, "channel")).toBe(false)
    const forbidden = new MessageError({ reason: "rejected", outcome: "rejected", status: 403 })
    expect(errors.isNotFound(forbidden)).toBe(false)
    expect(errors.isNotFound(new Error("application"))).toBe(false)
    expect(errors.isNotFound({ status: 404 })).toBe(false)
    expect(errors.isNotFound(undefined, "guild")).toBe(false)
    expect(native.errors.isNotFound).toBe(errors.isNotFound)
})

test("isNotFound accepts every NotFoundResource and throws HelperError for another resource", () => {
    const codes: Record<NotFoundResource, string> = {
        application: "UNKNOWN_APPLICATION",
        channel: "UNKNOWN_CHANNEL",
        emoji: "UNKNOWN_EMOJI",
        forumTag: "UNKNOWN_FORUM_TAG",
        guild: "UNKNOWN_GUILD",
        invite: "UNKNOWN_INVITE",
        member: "UNKNOWN_MEMBER",
        message: "UNKNOWN_MESSAGE",
        role: "UNKNOWN_ROLE",
        sticker: "UNKNOWN_STICKER",
        threadMember: "UNKNOWN_THREAD_MEMBER",
        user: "UNKNOWN_USER",
        webhook: "UNKNOWN_WEBHOOK",
    }
    const resources = Object.keys(codes) as NotFoundResource[]
    for (const resource of resources) {
        const error = new GuildOperationError({
            operation: "roles.edit",
            reason: "notFound",
            outcome: "rejected",
            status: 404,
            apiError: apiErrorDetail({ code: codes[resource] }),
        })
        for (const other of resources) expect(errors.isNotFound(error, other)).toBe(other === resource)
    }
    for (const invalid of ["thread", "Guild", "", "toString", null, 5, ["channel"], { toString: () => "guild" }]) {
        expect(() => errors.isNotFound(new Error("x"), invalid as never)).toThrow(
            expect.objectContaining({ _tag: "HelperError", operation: "errors.isNotFound", reason: "resource" }),
        )
    }
    expect(new HelperError("errors.isNotFound", "resource").code).toBe("helper.resource")
})

test.each(modes)(
    "%s isNotFound separates a missing guild from a missing member and a deleted channel",
    async (mode) => {
        onTestFinished(() => void vi.unstubAllGlobals())
        stubFetchWithHostedDiscovery(async (url) =>
            Response.json(
                url.includes("/channels/")
                    ? { code: "UNKNOWN_CHANNEL", message: "Unknown Channel" }
                    : { code: "UNKNOWN_GUILD", message: "Unknown Guild" },
                { status: 404 },
            ),
        )
        const client = await setup(mode)
        const member = await settle<unknown, unknown>(client.members.fetch({ guildId: "20", userId: "30" })).then(
            () => expect.fail("The fetch should find no guild"),
            (error: unknown) => error,
        )
        expect(errors.isNotFound(member)).toBe(true)
        expect(errors.isNotFound(member, "guild")).toBe(true)
        expect(errors.isNotFound(member, "member")).toBe(false)
        // The send reports its 404 as a rejection, so only the status identifies a missing channel
        const sent = await settle<unknown, unknown>(client.messages.send("20", { content: "Hello" })).then(
            () => expect.fail("The send should find no channel"),
            (error: unknown) => error,
        )
        expect(sent).toMatchObject({ reason: "rejected", status: 404 })
        expect(errors.isNotFound(sent)).toBe(true)
        expect(errors.isNotFound(sent, "channel")).toBe(true)
        expect(errors.isNotFound(sent, "guild")).toBe(false)
        expect(errors.outcome(sent)).toBe("rejected")
    },
)

test("wrapping a native SDK write in Effect.timeout gives no outcome, while the operation's timeoutMs keeps it", async () => {
    onTestFinished(() => void vi.unstubAllGlobals())
    // Each request signals when it reaches fetch, so the controlled clock moves only once the write is in flight
    let signalDispatch = () => {}
    stubFetchWithHostedDiscovery((_url, init) => {
        signalDispatch()
        return new Promise<Response>((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
        )
    })
    const expireInFlight = <A, E>(write: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
            const dispatched = new Promise<void>((resolve) => (signalDispatch = resolve))
            const fiber = yield* Effect.forkChild(Effect.exit(write))
            yield* Effect.promise(() => dispatched)
            yield* Effect.yieldNow
            yield* TestClock.adjust(25)
            return yield* Fiber.join(fiber)
        })
    const { bounded, kept } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* native.createClient({ token: fixtureToken })
                const bounded = yield* expireInFlight(
                    client.messages.send("20", { content: "Hello" }).pipe(Effect.timeout(25)),
                )
                const kept = yield* expireInFlight(client.messages.send("20", { content: "Hello" }, { timeoutMs: 25 }))
                return { bounded, kept }
            }),
        ).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" }))),
    )
    expect(Exit.isFailure(bounded) ? bounded.cause.reasons.map((reason) => reason._tag) : undefined).toEqual(["Fail"])
    expect(
        Exit.isFailure(bounded) && bounded.cause.reasons[0]?._tag === "Fail"
            ? Cause.isTimeoutError(bounded.cause.reasons[0].error)
            : false,
    ).toBe(true)
    expect(Exit.isFailure(bounded) ? errors.outcome(bounded.cause) : "succeeded").toBeUndefined()
    expect(Exit.isFailure(kept) ? errors.outcome(kept.cause) : "succeeded").toBe("unknown")
})
