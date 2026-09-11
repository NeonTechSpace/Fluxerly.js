import { once } from "node:events"
import { createServer } from "node:http"
import { Cause, Effect, Exit, Logger, Pull, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import WebSocket, { WebSocketServer } from "ws"
import { createClient, type MemberChunk, type MemberChunkQuery, type DefaultMemberChunkOptions } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "", sockets: [] as import("ws").WebSocket[] }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(_url: string, options: import("ws").ClientOptions) {
                super(transport.url, options)
                transport.sockets.push(this)
            }
        },
    }
})
const fetch = globalThis.fetch
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    transport.sockets = []
})
const member = (id: string) => ({ user: { id, username: "fixture" }, roles: [], joined_at: "2026-09-10T00:00:00.000Z" })
const presence = (id: string) => ({ user: { id }, status: "online", mobile: false, afk: false })
type Mode = "default" | "native"

async function fixture(mode: Mode, connect = true) {
    const server = createServer((_req, res) => {
        res.setHeader("Content-Type", "application/json")
        res.end('{"url":"wss://gateway.fluxer.app"}')
    })
    const gateway = new WebSocketServer({ server })
    const sockets: WebSocket[] = []
    const commands: { op: number; d: Record<string, any> }[] = []
    let sequence = 1
    const dispatch = (event: string, data: unknown) =>
        sockets.at(-1)!.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: data }))
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (raw) => {
            const command = JSON.parse(raw.toString())
            commands.push(command)
            if (command.op === 2) dispatch("READY", { session_id: "member-chunks-fixture" })
            if (command.op === 6) dispatch("RESUMED", {})
            if (command.op === 1) socket.send('{"op":11}')
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Expected owned loopback address")
    transport.url = `ws://127.0.0.1:${address.port}`
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
        expect(url).toBe("https://api.fluxer.app/v1/gateway/bot")
        return fetch(`http://127.0.0.1:${address.port}`, init)
    })
    const scope = Scope.makeUnsafe()
    const defaultApi =
        mode === "default" ? createClient({ token: "fixture", cache: { members: true } })._unsafeUnwrap() : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "fixture", cache: { members: true } }).pipe(Scope.provide(scope)),
              )
            : undefined
    const closers: (() => Promise<unknown>)[] = []
    const shutdown = async () => {
        if (defaultApi) await defaultApi.shutdown()
        else await Effect.runPromise(native!.shutdown())
    }
    onTestFinished(async () => {
        await shutdown()
        for (const close of closers) await close()
        await Effect.runPromise(Scope.close(scope, Exit.void))
        for (const socket of [...sockets, ...transport.sockets]) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    if (connect) {
        if (defaultApi) expect((await defaultApi.connect()).isOk()).toBe(true)
        else await Effect.runPromise(native!.connect())
    }
    function iterate(
        query: unknown = { all: true },
        options?: unknown,
        controller = new AbortController(),
        guildId = "20",
    ) {
        if (defaultApi) {
            const source = defaultApi.members
                .iterateChunks(guildId, query as MemberChunkQuery, {
                    signal: controller.signal,
                    ...(options as DefaultMemberChunkOptions),
                })
                [Symbol.asyncIterator]()
            const close = async () => {
                await source.return?.()
            }
            closers.push(close)
            return {
                controller,
                next: async (): Promise<IteratorResult<MemberChunk>> => {
                    const result = await source.next()
                    if (result.done) return { done: true, value: undefined }
                    if (result.value.isErr()) throw result.value.error
                    return { done: false, value: result.value.value }
                },
                close,
            }
        }
        const streamScope = Scope.makeUnsafe()
        const stream = native!.members.iterateChunks(
            guildId,
            query as MemberChunkQuery,
            options as DefaultMemberChunkOptions,
        )
        const pull = Effect.runPromise(Stream.toPull(stream).pipe(Scope.provide(streamScope)))
        const close = async () => {
            await Effect.runPromise(Scope.close(streamScope, Exit.void))
        }
        closers.push(close)
        return {
            controller,
            next: async (): Promise<IteratorResult<MemberChunk>> => {
                const exit = await Effect.runPromiseExit(await pull, { signal: controller.signal })
                if (Exit.isSuccess(exit)) {
                    expect(exit.value).toHaveLength(1)
                    return { done: false, value: exit.value[0] }
                }
                if (Cause.hasDies(exit.cause)) throw exit.cause
                if (Pull.isDoneCause(exit.cause)) return { done: true, value: undefined }
                if (Cause.hasInterruptsOnly(exit.cause)) throw { _tag: "Interrupted" }
                const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                throw failure?._tag === "Fail" ? failure.error : exit.cause
            },
            close,
        }
    }
    const requestCount = () => commands.filter((c) => c.op === 8).length
    const request = async (count = requestCount() + 1) => {
        await vi.waitFor(() => expect(requestCount()).toBe(count), { interval: 5 })
        return commands.filter((c) => c.op === 8).at(-1)!.d
    }
    const chunk = (
        nonce: unknown,
        members = [member("30")],
        index = 0,
        count = 1,
        extra: Record<string, unknown> = {},
    ) =>
        dispatch("GUILD_MEMBERS_CHUNK", {
            nonce,
            guild_id: "20",
            members,
            chunk_index: index,
            chunk_count: count,
            ...extra,
        })
    return {
        iterate,
        commands,
        request,
        requestCount,
        chunk,
        dispatch,
        sockets,
        defaultApi,
        native,
        shutdown,
        state: () => defaultApi?.state ?? native!.state,
        counts: (ids: readonly string[] = ["20"], options?: unknown) =>
            defaultApi
                ? defaultApi.guilds
                      .fetchCounts(ids, options as import("../src/counts.js").DefaultCountOperationOptions)
                      .then((r) => (r.isErr() ? r.error : r.value))
                : Effect.runPromise(
                      native!.guilds
                          .fetchCounts(ids, options as import("../src/counts.js").CountOperationOptions)
                          .pipe(Effect.catch((error) => Effect.succeed(error))),
                  ),
    }
}

for (const mode of ["default", "native"] as const) {
    test(`${mode} drains a multi-batch response after its arrival deadline without retaining the member slot`, async () => {
        const f = await fixture(mode)
        const iterator = f.iterate({ all: true }, { timeoutMs: 250 })
        const first = iterator.next()
        const sent = await f.request(1)
        expect(sent).toMatchObject({ query: "", limit: 0, presences: false })
        f.chunk(sent.nonce, [member("30")], 0, 2)
        expect((await first).value!.index).toBe(0)
        f.chunk(sent.nonce, [member("31")], 1, 2)
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect((await iterator.next()).value).toMatchObject({ index: 1, count: 2, members: [{ userId: "31" }] })
        expect((await iterator.next()).done).toBe(true)
        const replacement = f.iterate({ query: "", limit: 1 })
        const next = replacement.next()
        const fresh = await f.request(2)
        expect(fresh).toMatchObject({ query: "", limit: 1 })
        f.chunk(fresh.nonce)
        expect((await next).value!.presences).toBeUndefined()
    })

    test(`${mode} releases paused incomplete intake on timeout and discards unread batches on closure`, async () => {
        const f = await fixture(mode)
        const iterator = f.iterate({ all: true }, { timeoutMs: 100 })
        const first = iterator.next()
        const sent = await f.request(1)
        f.chunk(sent.nonce, [member("30")], 0, 2)
        await first
        await new Promise((resolve) => setTimeout(resolve, 150))
        const replacement = f.iterate()
        const next = replacement.next()
        const fresh = await f.request(2)
        f.chunk(fresh.nonce, [member("31")], 0, 2)
        await next
        f.chunk(fresh.nonce, [member("32")], 1, 2)
        await new Promise((resolve) => setTimeout(resolve, 15))
        await f.shutdown()
        await expect(iterator.next()).rejects.toMatchObject({ reason: "timeout" })
        await expect(replacement.next()).rejects.toMatchObject({ _tag: "ClientClosedError" })
    })

    test(`${mode} preserves synchronous sender defects and releases admission without a retry`, async () => {
        const f = await fixture(mode)
        const original = WebSocket.prototype.send
        const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, data, ...args) {
            if (JSON.parse(String(data)).op === 8) throw Error("fixture-sender-defect")
            return Reflect.apply(original, this, [data, ...args])
        })
        const failure = await f
            .iterate()
            .next()
            .catch((error) => error)
        if (mode === "default") expect(failure).toMatchObject({ name: "SdkDefect", operation: "members.iterateChunks" })
        else {
            expect(Cause.hasDies(failure)).toBe(true)
            expect(failure.reasons.some((reason: Cause.Reason<unknown>) => reason._tag === "Fail")).toBe(false)
        }
        spy.mockRestore()
        const iterator = f.iterate()
        const next = iterator.next()
        const sent = await f.request(1)
        f.chunk(sent.nonce)
        await next
    })

    test(`${mode} streams requested members and visible presence without caching, with lazy copied input`, async () => {
        const f = await fixture(mode)
        const query = { userIds: ["30", "31"], presences: true }
        const iterator = f.iterate(query)
        query.userIds[1] = "32"
        expect(f.requestCount()).toBe(0)
        const next = iterator.next()
        const sent = await f.request(1)
        expect(sent).toMatchObject({ guild_id: "20", user_ids: ["30", "32"], presences: true })
        expect(sent.nonce).toMatch(/^[a-f0-9]{32}$/)
        query.userIds[0] = "33"
        f.chunk(sent.nonce, [member("30")], 0, 1, { presences: [presence("30")] })
        const result = (await next).value!
        expect(result).toMatchObject({
            guildId: "20",
            index: 0,
            count: 1,
            omittedUserIds: ["32"],
            presences: [{ guildId: "20", userId: "30", status: "online" }],
        })
        for (const value of [
            result,
            result.members,
            result.members[0],
            result.members[0]!.roleIds,
            result.presences,
            result.presences![0],
            result.omittedUserIds,
        ])
            expect(Object.isFrozen(value)).toBe(true)
        expect(await iterator.next()).toMatchObject({ done: true })
        const cached = f.defaultApi
            ? f.defaultApi.members.get({ guildId: "20", userId: "30" })._unsafeUnwrap()
            : await Effect.runPromise(f.native!.members.get({ guildId: "20", userId: "30" }))
        expect(cached).toBeUndefined()
        const empty = f.iterate({ query: "missing", presences: true })
        const pending = empty.next()
        const selected = await f.request(2)
        expect(selected).toMatchObject({ query: "missing", limit: 25 })
        f.chunk(selected.nonce, [])
        expect((await pending).value).toMatchObject({ members: [], presences: [] })
        expect((await empty.next()).done).toBe(true)
    })

    test(`${mode} validates input and readiness without dispatch`, async () => {
        const f = await fixture(mode, false)
        for (const [query, options, guild] of [
            [{}, undefined, "20"],
            [{ all: false }, undefined, "20"],
            [{ all: true, limit: 1 }, undefined, "20"],
            [{ userIds: [] }, undefined, "20"],
            [{ userIds: new Array(1) }, undefined, "20"],
            [{ userIds: ["30", "30"] }, undefined, "20"],
            [{ userIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) }, undefined, "20"],
            [{ userIds: ["0"] }, undefined, "20"],
            [{ userIds: ["18446744073709551616"] }, undefined, "20"],
            [{ query: "a", limit: 0 }, undefined, "20"],
            [{ query: "a", limit: 101 }, undefined, "20"],
            [{ query: "x".repeat(4_096) }, undefined, "20"],
            [{ all: true, presences: 1 }, undefined, "20"],
            [{ all: true }, { timeoutMs: null }, "20"],
            [{ all: true }, { maxPendingBytes: 0 }, "20"],
            [{ all: true }, { timeoutMs: 2_147_483_648 }, "20"],
            [{ all: true }, undefined, "00"],
        ] as const)
            await expect(f.iterate(query, options, undefined, guild).next()).rejects.toMatchObject({
                _tag: "MemberChunkError",
                reason: "input",
            })
        await expect(f.iterate().next()).rejects.toMatchObject({ reason: "notConnected" })
        await f.shutdown()
        await expect(f.iterate().next()).rejects.toMatchObject({ _tag: "ClientClosedError" })
        expect(f.requestCount()).toBe(0)
    })

    test(`${mode} reports safe member-chunk and count input detail before gateway dispatch`, async () => {
        const f = await fixture(mode, false)
        const memberFailure = await f
            .iterate({ all: true, callerSecret: "private rejected value" } as never)
            .next()
            .catch((error) => error)
        expect(memberFailure).toMatchObject({
            _tag: "MemberChunkError",
            reason: "input",
            inputValidation: { path: "query", constraint: "allowedFields" },
        })
        expect(Object.isFrozen(memberFailure.inputValidation)).toBe(true)
        expect(JSON.stringify(memberFailure)).not.toContain("callerSecret")
        expect(JSON.stringify(memberFailure)).not.toContain("private rejected value")

        const countFailure = await f.counts(["private-invalid-id"])
        expect(countFailure).toMatchObject({
            _tag: "CountOperationError",
            operation: "guilds.fetchCounts",
            reason: "input",
            inputValidation: { path: "guildIds", constraint: "format" },
        })
        expect(Object.isFrozen((countFailure as { readonly inputValidation: unknown }).inputValidation)).toBe(true)
        expect(JSON.stringify(countFailure)).not.toContain("private-invalid-id")
        expect(f.requestCount()).toBe(0)
    })

    if (mode === "default")
        test("default reports malformed member-chunk cancellation options before gateway dispatch", async () => {
            const f = await fixture(mode, false)
            const failure = await f
                .iterate({ all: true }, { signal: { callerSecret: "private rejected value" } } as never)
                .next()
                .catch((error) => error)
            expect(failure).toMatchObject({
                _tag: "MemberChunkError",
                reason: "input",
                inputValidation: { path: "options.signal", constraint: "type" },
            })
            expect(JSON.stringify(failure)).not.toContain("callerSecret")
            expect(JSON.stringify(failure)).not.toContain("private rejected value")
            expect(f.requestCount()).toBe(0)
        })

    test(`${mode} validates sequence and correlation, preserving already delivered batches on failure`, async () => {
        const f = await fixture(mode)
        for (const changed of [
            { guild_id: "21" },
            { chunk_index: 1 },
            { chunk_count: 0 },
            { chunk_count: 101 },
            { members: [member("30"), member("30")] },
            { members: [{ user: { id: "30" } }] },
            { presences: [presence("99")] },
            { presences: [presence("30"), presence("30")] },
        ]) {
            const index = f.requestCount() + 1
            const iterator = f.iterate({ all: true, presences: true })
            const outcome = iterator.next().catch((error) => error)
            const sent = await f.request(index)
            f.chunk("unmatched", [], 0, 1)
            f.chunk(null, [], 0, 1)
            f.chunk(sent.nonce, [member("30")], 0, 1, changed)
            expect(await outcome).toMatchObject({ _tag: "MemberChunkError", reason: "response" })
            expect(f.state()).toBe("Connected")
        }
        const index = f.requestCount() + 1
        const iterator = f.iterate()
        const first = iterator.next()
        const sent = await f.request(index)
        f.chunk(sent.nonce, [member("30")], 0, 2)
        const delivered = (await first).value!
        const second = iterator.next().catch((error) => error)
        f.chunk(sent.nonce, [member("30")], 1, 2)
        expect(await second).toMatchObject({ reason: "response" })
        expect(delivered.members[0]!.userId).toBe("30")
    })

    test(`${mode} admits one member stream and shares four slots with counts, releasing early termination`, async () => {
        const f = await fixture(mode)
        const iterator = f.iterate()
        const first = iterator.next()
        const sent = await f.request(1)
        await expect(f.iterate().next()).rejects.toMatchObject({ reason: "busy" })
        const counts = [f.counts(), f.counts(), f.counts()]
        await vi.waitFor(() => expect(f.commands.filter((c) => c.op === 15)).toHaveLength(3), { interval: 5 })
        expect(await f.counts()).toMatchObject({ _tag: "CountOperationError", reason: "busy", inputValidation: null })
        f.chunk(sent.nonce, [member("30")], 0, 2)
        await first
        await iterator.close()
        const fourth = f.counts()
        await vi.waitFor(() => expect(f.commands.filter((c) => c.op === 15)).toHaveLength(4), { interval: 5 })
        for (const command of f.commands.filter((c) => c.op === 15))
            f.dispatch("GUILD_COUNTS_UPDATE", { nonce: command.d.nonce, counts: [] })
        for (const value of await Promise.all([...counts, fourth]))
            expect(value).toMatchObject({ counts: [], omittedGuildIds: ["20"] })
        f.chunk(sent.nonce, [member("31")], 1, 2)
        const replacement = f.iterate()
        const next = replacement.next()
        const fresh = await f.request(2)
        expect(fresh.nonce).not.toBe(sent.nonce)
        f.chunk(fresh.nonce)
        expect((await next).value!.members[0]!.userId).toBe("30")
    })

    test(`${mode} fails slow-reader overflow and confirmed rate limits without retry`, async () => {
        const f = await fixture(mode)
        const iterator = f.iterate({ all: true }, { maxPendingBytes: 500 })
        const first = iterator.next()
        const sent = await f.request(1)
        f.chunk(sent.nonce, [member("30")], 0, 4)
        await first
        f.chunk(sent.nonce, [member("31")], 1, 4)
        f.chunk(sent.nonce, [member("32")], 2, 4)
        f.chunk(sent.nonce, [member("33")], 3, 4)
        await new Promise((resolve) => setTimeout(resolve, 20))
        await expect(iterator.next()).rejects.toMatchObject({ reason: "overflow" })
        const limited = f.iterate()
        const outcome = limited.next().catch((error) => error)
        const fresh = await f.request(2)
        f.dispatch("RATE_LIMITED", { opcode: 8, retry_after: 1.25, meta: { guild_id: "20", nonce: "unmatched" } })
        f.dispatch("RATE_LIMITED", { opcode: 8, retry_after: 1.25, meta: { guild_id: "20", nonce: fresh.nonce } })
        expect(await outcome).toMatchObject({ reason: "rateLimit", retryAfterMs: 1_250 })
        expect(f.requestCount()).toBe(2)
    })

    test(`${mode} rejects an incomplete response on deadline, cancellation, gap and closure without resend`, async () => {
        const f = await fixture(mode)
        const timed = f.iterate({ all: true }, { timeoutMs: 250 })
        const first = timed.next()
        const sent = await f.request(1)
        f.chunk(sent.nonce, [member("30")], 0, 2)
        await first
        await expect(timed.next()).rejects.toMatchObject({ reason: "timeout" })
        const cancelled = f.iterate()
        const pending = cancelled.next().catch((error) => error)
        await f.request(2)
        cancelled.controller.abort()
        expect(await pending).toMatchObject({ _tag: mode === "default" ? "CancelledError" : "Interrupted" })
        const interrupted = f.iterate()
        const lost = interrupted.next().catch((error) => error)
        const old = await f.request(3)
        f.sockets.at(-1)!.terminate()
        expect(await lost).toMatchObject({ reason: "connectionLost" })
        await vi.waitFor(
            () => {
                expect(f.sockets).toHaveLength(2)
                expect(f.state()).toBe("Connected")
            },
            { timeout: 3_000, interval: 5 },
        )
        expect(f.requestCount()).toBe(3)
        const recovered = f.iterate()
        const next = recovered.next()
        const fresh = await f.request(4)
        f.chunk(old.nonce)
        f.chunk(fresh.nonce)
        await next
        const closing = f.iterate()
        const closed = closing.next().catch((error) => error)
        await f.request(5)
        await f.shutdown()
        expect(await closed).toMatchObject({ _tag: "ClientClosedError" })
        expect(f.requestCount()).toBe(5)
    })
}

test("default abort while paused releases intake, and cleanup defects preserve interruption", async () => {
    const f = await fixture("default")
    const controller = new AbortController()
    const iterator = f.iterate({ all: true }, undefined, controller)
    const first = iterator.next()
    const sent = await f.request(1)
    f.chunk(sent.nonce, [member("30")], 0, 2)
    await first
    controller.abort()
    const replacement = f.iterate()
    const pending = replacement.next()
    const fresh = await f.request(2)
    f.chunk(fresh.nonce)
    await pending
    await expect(iterator.next()).rejects.toMatchObject({ _tag: "CancelledError" })
    const faulty = new AbortController()
    const remove = faulty.signal.removeEventListener.bind(faulty.signal)
    vi.spyOn(faulty.signal, "removeEventListener").mockImplementation((...args) => {
        remove(...args)
        throw Error("private-cleanup-sentinel")
    })
    const defect = f.iterate({ all: true }, undefined, faulty)
    const outcome = defect.next().catch((error) => error)
    await f.request(3)
    faulty.abort()
    const error = await outcome
    expect(error).toMatchObject({ name: "SdkDefect", operation: "members.iterateChunks" })
    expect(error.reasons).toEqual([{ kind: "Interruption" }, { kind: "Defect" }])
    expect(JSON.stringify(error)).not.toContain("private-cleanup-sentinel")
})

test("native member stream preserves caller logger context and releases on early stream termination", async () => {
    const f = await fixture("native")
    const logs: unknown[] = []
    const running = Effect.runPromise(
        f.native!.members.iterateChunks("20", { all: true }).pipe(
            Stream.take(1),
            Stream.runForEach(() => Effect.log("member-chunk-context")),
            Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry.message))])),
        ),
    )
    const sent = await f.request(1)
    f.chunk(sent.nonce, [member("30")], 0, 2)
    await running
    expect(logs.flat()).toContain("member-chunk-context")
    const next = f.iterate()
    const pending = next.next()
    const fresh = await f.request(2)
    f.chunk(fresh.nonce)
    await pending
})
