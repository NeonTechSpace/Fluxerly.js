import { setImmediate as turn } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { Cause, Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test, vi } from "vitest"
import {
    ApplicationError,
    commands,
    AuthenticationError,
    ConfigurationError,
    ConnectionError,
    createClient,
    runBot,
    describeError,
    errors,
    FluxerlyError,
    GuildOperationError,
    MessageError,
    RateLimitError,
    SdkDefect,
    ShardConnectionError,
} from "../../src/index.js"
import * as native from "../../src/effect.js"
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
