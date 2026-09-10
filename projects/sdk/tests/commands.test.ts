import { once } from "node:events"
import { createServer } from "node:http"
import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { commands, createClient, SdkDefect, type Client, type DefaultPrefixCommand } from "../src/index.js"
import { commands as nativeCommands, createClient as createNative } from "../src/effect.js"
import { WebSocketServer } from "ws"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "", socket: undefined as import("ws").WebSocket | undefined }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(_url: string, options: import("ws").ClientOptions) {
                super(transport.url, options)
                transport.socket = this
            }
        },
    }
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    transport.socket = undefined
})

function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

async function fixture() {
    let sequence = 0
    const sockets: import("ws").WebSocket[] = []
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString())
            if (packet.op === 2)
                socket.send(JSON.stringify({ op: 0, s: ++sequence, t: "READY", d: { session_id: "fixture" } }))
            if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture port missing")
    transport.url = `ws://127.0.0.1:${address.port}`
    stubFetchWithHostedDiscovery((url) => {
        throw new Error(`Unexpected command fixture HTTP request ${url}`)
    })
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        deliver(content: string, isBot = false) {
            const wire = {
                id: `${sequence + 100}`,
                channel_id: "20",
                content,
                author: { id: "30", username: "fixture", bot: isBot },
            }
            transport.socket!.emit(
                "message",
                Buffer.from(JSON.stringify({ op: 0, s: ++sequence, t: "MESSAGE_CREATE", d: wire })),
                false,
            )
        },
    }
}

async function defaultClient(): Promise<Client> {
    const client = value(createClient({ token: "fixture-only-not-a-credential" }))
    onTestFinished(async () => {
        value(await client.shutdown())
    })
    value(await client.connect())
    return client
}

async function nativeClient() {
    const scope = Scope.makeUnsafe()
    const registration = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createNative({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(scope)),
    )
    onTestFinished(async () => {
        await Effect.runPromise(Scope.close(registration, Exit.void))
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    await Effect.runPromise(client.connect())
    return { client, scope, registration }
}

test("default command router uses the existing subscription for longest prefix, aliases, guards and cooldowns", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const received: { prefix: string; args: readonly string[]; rawArgs: string; signal: AbortSignal }[] = []
    const errors: unknown[] = []
    const cooldowns = value(commands.memoryCooldowns({ maxEntries: 1 }))
    let router = value(
        commands.create({
            prefix: ["!", "!!"],
            parse: ({ source }) => {
                if (source.trim() === "skip") return undefined
                const [name = "", ...args] = source.trim().split("|")
                return { name, args, rawArgs: args.join("|") }
            },
        }),
    )
    router = value(
        router.register({
            name: "ping",
            aliases: ["p"],
            cooldown: { store: cooldowns, durationMs: 60_000 },
            execute: ({ prefix, args, rawArgs, signal }) => {
                received.push({ prefix, args, rawArgs, signal: signal as AbortSignal })
            },
        }),
    )
    router = value(
        router.register({
            name: "blocked",
            guard: () => false,
            execute: () => {
                received.push({} as never)
            },
        }),
    )
    router = value(
        router.register({ name: "broken", execute: () => Promise.reject(new Error("private command failure")) }),
    )
    value(
        router.attach(client, {
            onError: (report) => {
                errors.push(report)
            },
        }),
    )

    remote.deliver("!!P|one|two")
    remote.deliver("!!PING|ignored")
    remote.deliver("!!blocked")
    remote.deliver("!!ping|bot", true)
    remote.deliver("!!skip")
    remote.deliver("!!broken")

    await vi.waitFor(() => expect(received).toHaveLength(1))
    await vi.waitFor(() => expect(errors).toEqual([{ event: "messageCreate", kind: "handler" }]))
    expect(received[0]).toMatchObject({ prefix: "!!", args: ["one", "two"], rawArgs: "one|two" })
    expect(received[0]!.signal.aborted).toBe(false)
    expect(cooldowns.size).toBe(1)
    expect(value(cooldowns.claim({ key: "another", durationMs: 1 }))._tag).toBe("CooldownCapacity")
    cooldowns.clear()
    expect(cooldowns.size).toBe(0)
})

test("native command router preserves the registration scope and executes handler Effects without a detached runtime", async () => {
    const remote = await fixture()
    const { client, registration } = await nativeClient()
    const received: string[] = []
    let router = await Effect.runPromise(nativeCommands.create({ prefix: "!", ignoreBots: false }))
    router = await Effect.runPromise(
        router.register({
            name: "ping",
            execute: ({ name, rawArgs }) => Effect.sync(() => received.push(`${name}:${rawArgs}`)),
        }),
    )
    await Effect.runPromise(router.attach(client).pipe(Scope.provide(registration)))

    remote.deliver("!PING first second")
    await vi.waitFor(() => expect(received).toEqual(["ping:first second"]))
    await Effect.runPromise(Scope.close(registration, Exit.void))
    remote.deliver("!ping after-close")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received).toEqual(["ping:first second"])
})

test("command configuration and local cooldown limits fail without retaining arbitrary prefix or message data", async () => {
    const invalid = commands.create({ prefix: "" })
    expect(invalid.isErr() && invalid.error.field).toBe("prefix")
    const store = value(commands.memoryCooldowns({ maxEntries: 1 }))
    const first = value(store.claim({ key: "only", durationMs: 60_000 }))
    expect(first._tag).toBe("CooldownAcquired")
    expect(value(store.claim({ key: "only", durationMs: 60_000 }))._tag).toBe("CooldownActive")
    expect(value(store.claim({ key: "other", durationMs: 60_000 }))._tag).toBe("CooldownCapacity")
    const malformed = store.claim({ key: "", durationMs: 60_000 })
    expect(malformed.isErr() && malformed.error.field).toBe("cooldown")
    const nullCapacity = commands.memoryCooldowns({ maxEntries: null } as never)
    expect(nullCapacity.isErr() && nullCapacity.error.field).toBe("maxEntries")
    const getterInput = {
        get key(): string {
            throw new Error("private cooldown getter")
        },
        durationMs: 1,
    }
    expect(() => store.claim(getterInput as never)).toThrow(SdkDefect)
    try {
        store.claim(getterInput as never)
    } catch (error) {
        expect(error).toMatchObject({ operation: "commands", reasons: [{ kind: "Defect" }] })
        expect((error as Error).message).not.toContain("private cooldown getter")
    }
    store.clear()
    const nativeInvalid = await Effect.runPromise(Effect.result(nativeCommands.memoryCooldowns({ maxEntries: 0 })))
    expect(nativeInvalid._tag).toBe("Failure")
})

test("default registration leaves the original alias and its existing attachment unchanged", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const received: string[] = []
    const original = value(commands.create({ prefix: "!" }))
    const originalAlias = original
    expect(Object.isFrozen(original)).toBe(true)
    expect(Reflect.ownKeys(original)).toEqual([])
    value(original.attach(client))
    const extended = value(
        original.register({
            name: "ping",
            execute: () => {
                received.push("extended")
            },
        }),
    )
    expect(Object.isFrozen(extended)).toBe(true)
    value(extended.attach(client))

    remote.deliver("!ping")
    await vi.waitFor(() => expect(received).toEqual(["extended"]))
    expect(originalAlias).toBe(original)
})

test("native registration keeps earlier router attachments and environments independent", async () => {
    const remote = await fixture()
    const { client, registration } = await nativeClient()
    const received: string[] = []
    const original = await Effect.runPromise(nativeCommands.create({ prefix: "!" }))
    expect(Object.isFrozen(original)).toBe(true)
    expect(Reflect.ownKeys(original)).toEqual([])
    await Effect.runPromise(original.attach(client).pipe(Scope.provide(registration)))
    const extended = await Effect.runPromise(
        original.register({ name: "ping", execute: () => Effect.sync(() => received.push("extended")) }),
    )
    expect(Object.isFrozen(extended)).toBe(true)
    await Effect.runPromise(extended.attach(client).pipe(Scope.provide(registration)))

    remote.deliver("!ping")
    await vi.waitFor(() => expect(received).toEqual(["extended"]))
})

test("command snapshots copy metadata while retaining only registered callback and store references", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const received: string[] = []
    const aliases = ["p"]
    const definition = {
        name: "ping",
        aliases,
        execute: () => {
            received.push("initial")
        },
    } satisfies DefaultPrefixCommand
    const router = value(commands.create({ prefix: "!" }))
    const registered = value(router.register(definition))
    definition.name = "changed"
    aliases.push("later")
    definition.execute = () => {
        received.push("changed")
    }
    value(registered.attach(client))

    remote.deliver("!p")
    remote.deliver("!later")
    await vi.waitFor(() => expect(received).toEqual(["initial"]))
})

test("sparse command arrays reject configuration and the default parser ignores unknown or invalid command-shaped chat", async () => {
    const sparsePrefix: string[] = []
    sparsePrefix[1] = "!"
    const invalidPrefix = commands.create({ prefix: sparsePrefix })
    expect(invalidPrefix.isErr() && invalidPrefix.error.field).toBe("prefix")

    const router = value(commands.create({ prefix: "!" }))
    const sparseAliases: string[] = []
    sparseAliases[1] = "p"
    const invalidAliases = router.register({ name: "ping", aliases: sparseAliases, execute: () => undefined })
    expect(invalidAliases.isErr() && invalidAliases.error.field).toBe("aliases")

    const remote = await fixture()
    const client = await defaultClient()
    const received: string[] = []
    const errors: unknown[] = []
    const registered = value(
        router.register({
            name: "ping",
            execute: () => {
                received.push("ping")
            },
        }),
    )
    value(
        registered.attach(client, {
            onError: (report) => {
                errors.push(report)
            },
        }),
    )
    remote.deliver("!missing")
    remote.deliver("!💥")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received).toEqual([])
    expect(errors).toEqual([])
})

test("custom parser sparse arguments and nonboolean guards report safely without execution", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const errors: unknown[] = []
    const executed: string[] = []
    const sparseArgs: string[] = []
    sparseArgs[1] = "later"
    let router = value(
        commands.create({
            prefix: "!",
            parse: ({ source }) =>
                source.trim() === "parse"
                    ? { name: "parse", args: sparseArgs, rawArgs: "later" }
                    : { name: "guard", args: [], rawArgs: "" },
        }),
    )
    router = value(
        router.register({
            name: "parse",
            execute: () => {
                executed.push("parse")
            },
        }),
    )
    router = value(
        router.register({
            name: "guard",
            guard: () => 1 as never,
            execute: () => {
                executed.push("guard")
            },
        }),
    )
    value(
        router.attach(client, {
            onError: (report) => {
                errors.push(report)
            },
        }),
    )
    remote.deliver("!parse")
    remote.deliver("!guard")
    await vi.waitFor(() => expect(errors).toHaveLength(2))
    expect(executed).toEqual([])
})

test("default cancellation during a guard prevents execution after the guard settles", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const executed: string[] = []
    let release: ((allowed: boolean) => void) | undefined
    const gate = new Promise<boolean>((resolve) => {
        release = resolve
    })
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "ping",
            guard: () => gate,
            execute: () => {
                executed.push("execute")
            },
        }),
    )
    const subscription = value(router.attach(client))
    remote.deliver("!ping")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    subscription.unsubscribe()
    release!(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(executed).toEqual([])
})

test("default cancellation during cooldown admission prevents execution after the claim settles", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const executed: string[] = []
    let release: ((claim: { _tag: "CooldownAcquired"; retryAtMs: number }) => void) | undefined
    const claim = new Promise<{ _tag: "CooldownAcquired"; retryAtMs: number }>((resolve) => {
        release = resolve
    })
    const store = { claim: () => claim }
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "ping",
            cooldown: { store, durationMs: 1_000 },
            execute: () => {
                executed.push("execute")
            },
        }),
    )
    const subscription = value(router.attach(client))
    remote.deliver("!ping")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    subscription.unsubscribe()
    release!({ _tag: "CooldownAcquired", retryAtMs: Date.now() + 1_000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(executed).toEqual([])
})

test("native configuration keeps unexpected construction defects in the Effect cause", async () => {
    const options = {
        get prefix(): string {
            throw new Error("private fixture defect")
        },
    }
    const exit = await Effect.runPromiseExit(nativeCommands.create(options as never))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
})

test("default configuration hides unexpected getter defects behind SdkDefect commands", () => {
    const options = {
        get prefix(): string {
            throw new Error("private fixture defect")
        },
    }
    try {
        commands.create(options as never)
        throw new Error("Expected default creation to throw")
    } catch (error) {
        expect(error).toBeInstanceOf(SdkDefect)
        expect(error).toMatchObject({ operation: "commands", reasons: [{ kind: "Defect" }] })
        expect((error as Error).message).not.toContain("private fixture defect")
    }
})
