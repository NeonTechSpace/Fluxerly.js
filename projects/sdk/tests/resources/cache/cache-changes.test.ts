import { setImmediate as turn } from "node:timers/promises"
import { Effect, Exit, References, Scope } from "effect"
import { err } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { CacheChange, CacheObserverOptions } from "../../../src/cache.js"
import type { Client, FailureReport, LogRecord } from "../../../src/index.js"
import type { Client as NativeClient, FailureReport as NativeFailureReport } from "../../../src/effect.js"
import type { ClientOwner } from "../../../src/internal/client.js"
import { clientServices } from "../../../src/internal/client-registry.js"
import type { Message } from "../../../src/messages.js"
import { describeBothApis, setup, type FixtureClientOptions, type Mode } from "../../support/both-apis.js"

// No test here opens a socket, so any WebSocket creation is a defect
vi.mock("ws", () => ({
    default: vi.fn(function () {
        throw new Error("Unexpected WebSocket creation")
    }),
}))

afterEach(() => vi.restoreAllMocks())

type AnyClient = Client | NativeClient

const owner = (client: AnyClient) => clientServices(client) as unknown as ClientOwner<Message>

const message = (id: string, channelId = "20"): Message =>
    Object.freeze({
        id,
        channelId,
        content: `Message ${id}`,
        embeds: [],
        attachments: [],
        stickers: [],
        author: { id: "30", username: "fixture", isBot: false },
    })

/** Register a listener in either API style, closing native registrations with the test */
async function onChange(
    mode: Mode,
    client: AnyClient,
    listener: (change: CacheChange) => void = () => undefined,
    options?: CacheObserverOptions,
): Promise<{ readonly changes: CacheChange[]; close(): Promise<void> }> {
    const changes: CacheChange[] = []
    const record = (change: CacheChange) => {
        changes.push(change)
        listener(change)
    }
    if (mode === "default") {
        const observer = (client as Client).cache.onChange(record, options)
        return { changes, close: async () => observer.close() }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const observer = await Effect.runPromise(
        (client as NativeClient).cache
            .onChange((change) => Effect.sync(() => record(change)), options)
            .pipe(Scope.provide(scope)),
    )
    return { changes, close: () => Effect.runPromise(observer.close()) }
}

const clearCache = (client: AnyClient) => client.cache.clear()
const entries = (mode: Mode, client: AnyClient, kind: "users") =>
    mode === "default"
        ? (client as Client).cache.entries(kind)
        : Effect.runSync((client as NativeClient).cache.entries(kind))

const allCaches = {
    messages: true,
    guilds: true,
    members: true,
    roles: true,
    emojis: true,
    stickers: true,
    channels: true,
    users: true,
    directMessages: true,
} as const

function storeUser(client: AnyClient, id: string) {
    const users = owner(client).userCache
    users.complete(users.begin("users", { id }), [Object.freeze({ id, username: `user-${id}` }) as never])
}

describeBothApis("cache change notifications", (mode) => {
    test("report stores, replacements, removals and clears for every kind with its documented key", async () => {
        const client = await setup(mode, { cache: allCaches })
        const internal = owner(client)
        const { changes } = await onChange(mode, client)

        internal.cache!.observe(message("10"))
        internal.cache!.observe(message("10"))
        internal.cache!.delete({ id: "10", channelId: "20" })
        const guild = internal.resources!.begin({ selection: { kind: "guilds", guildId: "1" } })
        internal.resources!.complete(guild, Object.freeze({ id: "1", name: "Fixture" }))
        internal.resources!.event("guildMemberAdd", Object.freeze({ guildId: "1", userId: "5", roleIds: [] }) as never)
        internal.resources!.event("guildMemberRemove", Object.freeze({ guildId: "1", userId: "5" }))
        internal.resources!.event("guildRoleCreate", Object.freeze({ guildId: "1", id: "7", permissions: 0n }) as never)
        for (const [kind, id] of [
            ["emojis", "8"],
            ["stickers", "9"],
        ] as const) {
            const guard = internal.resources!.begin({ selection: { kind, guildId: "1" } })
            internal.resources!.complete(guard, [Object.freeze({ guildId: "1", id, name: kind })])
        }
        internal.channelCache!.event("guildChannelCreate", Object.freeze({ id: "20", guildId: "1", type: 0 }) as never)
        storeUser(client, "5")
        const conversation = internal.userCache.begin("directMessages", { id: "30" })
        internal.userCache.complete(conversation, [Object.freeze({ id: "30", recipients: [] }) as never])
        clearCache(client)
        expect(changes).toEqual([])
        await turn()

        const expected: CacheChange[] = [
            { kind: "messages", op: "set", key: "20:10" },
            { kind: "messages", op: "set", key: "20:10" },
            { kind: "messages", op: "delete", key: "20:10" },
            { kind: "guilds", op: "set", key: "1" },
            { kind: "members", op: "set", key: "1:5" },
            { kind: "members", op: "delete", key: "1:5" },
            { kind: "roles", op: "set", key: "1:7" },
            { kind: "emojis", op: "set", key: "1:8" },
            { kind: "stickers", op: "set", key: "1:9" },
            { kind: "channels", op: "set", key: "20" },
            { kind: "users", op: "set", key: "5" },
            { kind: "directMessages", op: "set", key: "30" },
            // A clear is reported once per kind that still held entries, and nothing for the emptied message and member caches
            { kind: "guilds", op: "clear", key: null },
            { kind: "roles", op: "clear", key: null },
            { kind: "emojis", op: "clear", key: null },
            { kind: "stickers", op: "clear", key: null },
            { kind: "channels", op: "clear", key: null },
            { kind: "users", op: "clear", key: null },
            { kind: "directMessages", op: "clear", key: null },
        ]
        // Each kind reports its own changes in order. The documentation defines no order across kinds
        expect(changes).toHaveLength(expected.length)
        for (const kind of new Set(expected.map((change) => change.kind)))
            expect(changes.filter((change) => change.kind === kind)).toEqual(
                expected.filter((change) => change.kind === kind),
            )
        expect(changes.every((change) => Object.isFrozen(change))).toBe(true)
    })

    test("deliver after the cache operation, so a listener sees the stored entry and can clear the cache", async () => {
        const client = await setup(mode, { cache: { users: true } })
        const seen: unknown[] = []
        const { changes } = await onChange(mode, client, (change) => {
            if (change.op !== "set") return
            seen.push(owner(client).userCache.get("users", "5"))
            client.cache.clear()
        })
        storeUser(client, "5")
        await turn()
        expect(seen).toEqual([expect.objectContaining({ id: "5" })])
        expect(changes).toEqual([
            { kind: "users", op: "set", key: "5" },
            { kind: "users", op: "clear", key: null },
        ])
    })

    test("report capacity eviction and expiry as deletions", async () => {
        let nanos = 1_000_000_000n
        vi.spyOn(process.hrtime, "bigint").mockImplementation(() => nanos)
        const client = await setup(mode, { cache: { users: { maxEntries: 1, maxAgeMs: 50 } } })
        const { changes } = await onChange(mode, client)
        storeUser(client, "1")
        storeUser(client, "2")
        nanos += 60_000_000n
        expect(entries(mode, client, "users")).toEqual([])
        await turn()
        expect(changes).toEqual([
            { kind: "users", op: "set", key: "1" },
            { kind: "users", op: "delete", key: "1" },
            { kind: "users", op: "set", key: "2" },
            { kind: "users", op: "delete", key: "2" },
        ])
    })

    test("report a gap limited to known servers per key and a gap of unknown scope as a clear", async () => {
        const client = await setup(mode, { cache: { messages: true, members: true } })
        const internal = owner(client)
        const { changes } = await onChange(mode, client)
        for (const guildId of ["1", "2"])
            internal.resources!.event("guildMemberAdd", Object.freeze({ guildId, userId: "5", roleIds: [] }) as never)
        internal.cache!.observe(message("10"))
        internal.resources!.gap((guildId) => guildId === "1")
        internal.cache!.gap()
        await turn()
        expect(changes.slice(3)).toEqual([
            { kind: "members", op: "delete", key: "1:5" },
            { kind: "messages", op: "clear", key: null },
        ])
    })

    test("deliver shutdown's final clears, then close every observer", async () => {
        const client = await setup(mode, { cache: { users: true } })
        const { changes } = await onChange(mode, client)
        storeUser(client, "5")
        if (mode === "default") expect((await (client as Client).shutdown()).isOk()).toBe(true)
        else await Effect.runPromise((client as NativeClient).shutdown())
        await turn()
        expect(changes).toEqual([
            { kind: "users", op: "set", key: "5" },
            { kind: "users", op: "clear", key: null },
        ])
        // A registration after shutdown never receives a change
        const late = await onChange(mode, client)
        await late.close()
        expect(late.changes).toEqual([])
    })

    test("hold at most concurrency unfinished calls and drop the oldest waiting change with a logged, counted Warn", async () => {
        // Without a bound, a listener that never finishes keeps one unfinished call per change, without limit
        const records: LogRecord[] = []
        const client = await setup(mode, {
            cache: { users: true },
            logging: { sink: (record) => void records.push(record), dedupe: false },
        })
        const started: (string | null)[] = []
        const releases: (() => void)[] = []
        const bounds = { concurrency: 2, maxPendingChanges: 3 }
        let id: string
        if (mode === "default")
            id = (client as Client).cache.onChange((change) => {
                started.push(change.key)
                return new Promise<void>((resolve) => releases.push(resolve))
            }, bounds).id
        else {
            const scope = Scope.makeUnsafe()
            onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
            const observer = await Effect.runPromise(
                (client as NativeClient).cache
                    .onChange(
                        (change) =>
                            Effect.callback<void>((resume) => {
                                started.push(change.key)
                                releases.push(() => resume(Effect.void))
                            }),
                        bounds,
                    )
                    .pipe(Scope.provide(scope)),
            )
            id = observer.id
        }
        // A synchronous listener finishes each call at once, so the same bounds never delay or drop its changes
        const synchronous = await onChange(mode, client, undefined, bounds)
        const keys = ["1", "2", "3", "4", "5", "6", "7"]
        for (const key of keys) storeUser(client, key)
        await turn()

        expect(started).toEqual(["1", "2"])
        expect(synchronous.changes.map((change) => change.key)).toEqual(keys)
        expect(client.diagnostics().counters.cacheChangesDropped).toBe(2)
        const dropped = records.filter((record) => record.code === "cache.changesDropped")
        expect(dropped.map((record) => [record.level, record.subscriptionId, record.fields?.dropped])).toEqual([
            ["warn", id, 1],
            ["warn", id, 2],
        ])
        // Finished calls start the waiting changes in applied order, without the two oldest that were dropped
        await vi.waitFor(() => {
            for (const release of releases.splice(0)) release()
            expect(started).toEqual(["1", "2", "5", "6", "7"])
        })
    })

    test("drop changes still waiting for a busy listener at shutdown with a logged, counted Warn", async () => {
        // Catches: Shutdown discarded the changes, including its final clear, that waited for an unfinished call
        // without any record, although a stuck listener must never hold shutdown either
        const records: LogRecord[] = []
        const client = await setup(mode, {
            cache: { users: true },
            logging: { sink: (record) => void records.push(record), dedupe: false },
        })
        const started: (string | null)[] = []
        const bounds = { concurrency: 1 }
        let id: string
        if (mode === "default")
            id = (client as Client).cache.onChange((change) => {
                started.push(change.key)
                return new Promise<void>(() => undefined)
            }, bounds).id
        else {
            const scope = Scope.makeUnsafe()
            onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
            const observer = await Effect.runPromise(
                (client as NativeClient).cache
                    .onChange(
                        (change) => Effect.sync(() => started.push(change.key)).pipe(Effect.andThen(Effect.never)),
                        bounds,
                    )
                    .pipe(Scope.provide(scope)),
            )
            id = observer.id
        }
        storeUser(client, "1")
        storeUser(client, "2")
        await turn()
        expect(started).toEqual(["1"])
        if (mode === "default") expect((await (client as Client).shutdown()).isOk()).toBe(true)
        else await Effect.runPromise((client as NativeClient).shutdown())
        await turn()
        expect(started).toEqual(["1"])
        // The waiting set of user 2 and shutdown's final clear of users
        expect(client.diagnostics().counters.cacheChangesDropped).toBe(2)
        const dropped = records.filter((record) => record.code === "cache.changesDropped")
        expect(dropped.map((record) => [record.level, record.subscriptionId, record.fields?.dropped])).toEqual([
            ["warn", id, 2],
        ])
    })

    test("reject bounds that would stop or never limit delivery as misuse", async () => {
        // A zero concurrency would queue every change and never call the listener
        const client = await setup(mode, { cache: { users: true } })
        const rejected = async (options: unknown) => {
            if (mode === "default")
                try {
                    ;(client as Client).cache.onChange(() => undefined, options as CacheObserverOptions)
                } catch (error) {
                    return error
                }
            else {
                const exit = await Effect.runPromiseExit(
                    Effect.scoped(
                        (client as NativeClient).cache.onChange(() => Effect.void, options as CacheObserverOptions),
                    ),
                )
                const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
                if (reason?._tag === "Die") return reason.defect
            }
            return expect.fail("Expected misuse")
        }
        for (const [options, field] of [
            [{ concurrency: 0 }, "concurrency"],
            [{ maxPendingChanges: 1.5 }, "maxPendingChanges"],
            [{ concurrency: Infinity }, "concurrency"],
            ["fast", "cacheObserverOptions"],
        ] as const)
            expect(await rejected(options)).toMatchObject({ _tag: "ConfigurationError", field })
    })

    test("give a new listener only later changes and drop undelivered ones on close", async () => {
        const client = await setup(mode, { cache: { users: true } })
        storeUser(client, "1")
        const { changes, close } = await onChange(mode, client)
        storeUser(client, "2")
        await turn()
        expect(changes).toEqual([{ kind: "users", op: "set", key: "2" }])
        // Closing drops changes recorded but not yet delivered
        storeUser(client, "3")
        await close()
        await turn()
        expect(changes).toHaveLength(1)
    })
})

test("default listener failures are reported as cache failures without changing the cache or other listeners", async () => {
    const reports: FailureReport[] = []
    const client = await setup("default", {
        cache: { users: true },
        onError: (report: FailureReport) => void reports.push(report),
    } as FixtureClientOptions)
    const thrown = new Error("listener broke")
    const rejected = new Error("listener rejected")
    const returned = new Error("listener returned Err")
    const defaultClient = client as Client
    defaultClient.cache.onChange(() => {
        throw thrown
    })
    defaultClient.cache.onChange(() => Promise.reject(rejected))
    defaultClient.cache.onChange(() => err(returned))
    const { changes } = await onChange("default", client)
    storeUser(client, "5")
    await vi.waitFor(() => expect(reports).toHaveLength(3))
    expect(reports.map((report) => [report.kind, report.error])).toEqual([
        ["cache", thrown],
        ["cache", returned],
        ["cache", rejected],
    ])
    expect(changes).toEqual([{ kind: "users", op: "set", key: "5" }])
    expect(defaultClient.users.get("5")).toMatchObject({ id: "5" })
})

test("native listener failures are reported with their Cause without changing the cache or other listeners", async () => {
    const reports: NativeFailureReport[] = []
    const client = (await setup("native", {
        cache: { users: true },
        onError: (report: NativeFailureReport) => Effect.sync(() => void reports.push(report)),
    } as FixtureClientOptions)) as NativeClient
    const failed = new Error("listener failed")
    const defect = new Error("listener died")
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    await Effect.runPromise(
        Effect.all([
            client.cache.onChange(() => Effect.fail(failed)),
            client.cache.onChange(() => Effect.die(defect)),
        ]).pipe(Scope.provide(scope)),
    )
    const { changes } = await onChange("native", client)
    storeUser(client, "5")
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    expect(reports.map((report) => [report.kind, report.error])).toEqual([
        ["cache", failed],
        ["cache", defect],
    ])
    expect(reports.every((report) => report.cause !== undefined)).toBe(true)
    expect(changes).toEqual([{ kind: "users", op: "set", key: "5" }])
    expect(await Effect.runPromise(client.users.get("5"))).toMatchObject({ id: "5" })
})

test("native listeners run with registration services and stop when their Scope closes", async () => {
    const client = (await setup("native", { cache: { users: true } })) as NativeClient
    const scope = Scope.makeUnsafe()
    const annotations: unknown[] = []
    await Effect.runPromise(
        client.cache
            .onChange(() =>
                Effect.gen(function* () {
                    annotations.push((yield* References.CurrentLogAnnotations).fixture)
                }),
            )
            .pipe(Scope.provide(scope), Effect.annotateLogs("fixture", "cache-changes")),
    )
    storeUser(client, "1")
    await vi.waitFor(() => expect(annotations).toEqual(["cache-changes"]))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    storeUser(client, "2")
    await turn()
    expect(annotations).toEqual(["cache-changes"])
})
