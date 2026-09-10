import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { SdkDefect, createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
const configuration = { token: "fixture-only-not-a-credential" }
const wire = (id: string, authorId = "30") => ({
    id,
    channel_id: "20",
    content: `private-${id}`,
    author: { id: authorId, username: "fixture" },
})

const unwrap = <A>(result: { readonly isOk: () => boolean; readonly value?: A; readonly error?: unknown }): A => {
    if (!result.isOk()) throw result.error
    return result.value as A
}

function responseWithCleanupFailure(status: number, cleanup: unknown, cancelled?: () => void): Response {
    return new Response(
        new ReadableStream({
            cancel: () => {
                cancelled?.()
                throw cleanup
            },
        }),
        { status },
    )
}

async function cleanupApi(mode: (typeof modes)[number]) {
    if (mode === "default") {
        const client = unwrap(createClient(configuration))
        return {
            preview: async (...input: Parameters<typeof client.messages.previewCleanup>) =>
                unwrap(await client.messages.previewCleanup(...input)),
            cleanup: async (...input: Parameters<typeof client.messages.cleanup>) =>
                unwrap(await client.messages.cleanup(...input)),
            close: async () => {
                unwrap(await client.shutdown())
            },
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createNative(configuration).pipe(Scope.provide(scope)))
    return {
        preview: (...input: Parameters<typeof client.messages.previewCleanup>) =>
            Effect.runPromise(client.messages.previewCleanup(...input)),
        cleanup: (...input: Parameters<typeof client.messages.cleanup>) =>
            Effect.runPromise(client.messages.cleanup(...input)),
        close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    }
}

afterEach(() => vi.unstubAllGlobals())

test.each(modes)(
    "%s cleanup submits only previewed IDs, ignores progress callback failures, and consumes the plan",
    async (mode) => {
        const posts: string[] = []
        let reads = 0
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            if (init.method === "POST") {
                posts.push(String(init.body))
                return new Response(null, { status: 204 })
            }
            reads++
            return Response.json(reads === 1 ? [wire("30"), wire("29"), wire("28", "31")] : [])
        })
        if (mode === "default") {
            const opened = createClient(configuration)
            if (opened.isErr()) throw opened.error
            onTestFinished(async () => {
                await opened.value.shutdown()
            })
            const preview = await opened.value.messages.previewCleanup("20", {
                authorId: "30",
                maxScanned: 500,
                maxSelected: 10,
            })
            if (preview.isErr()) throw preview.error
            const events: string[] = []
            const report = await opened.value.messages.cleanup(preview.value, {
                onProgress(event) {
                    events.push(event.state)
                    throw Error("private callback error")
                },
            })
            if (report.isErr()) throw report.error
            expect(report.value.selectedMessageIds).toEqual(["30", "29"])
            expect(report.value.submittedBatches).toMatchObject([{ batchIndex: 0, messageIds: ["30", "29"] }])
            expect(events).toEqual(["submitting", "submitted"])
            await expect(opened.value.messages.cleanup(preview.value)).resolves.toMatchObject({
                error: { _tag: "MessageCleanupError", reason: "input", outcome: "notDispatched" },
            })
        } else {
            await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const client = yield* createNative(configuration)
                        const plan = yield* client.messages.previewCleanup("20", {
                            authorId: "30",
                            maxScanned: 500,
                            maxSelected: 10,
                        })
                        const events: string[] = []
                        const report = yield* client.messages.cleanup(plan, {
                            onProgress(event) {
                                events.push(event.state)
                                throw Error("private callback error")
                            },
                        })
                        expect(report.selectedMessageIds).toEqual(["30", "29"])
                        expect(events).toEqual(["submitting", "submitted"])
                        const repeated = yield* Effect.result(client.messages.cleanup(plan))
                        expect(repeated).toMatchObject({
                            _tag: "Failure",
                            failure: { _tag: "MessageCleanupError", reason: "input", outcome: "notDispatched" },
                        })
                    }),
                ),
            )
        }
        expect(reads).toBe(2)
        expect(posts).toEqual(['{"message_ids":["30","29"]}'])
    },
)

test.each(modes)("%s cleanup retains submitted and terminal batch knowledge without message bodies", async (mode) => {
    const source = Array.from({ length: 101 }, (_, index) => wire(String(1_000 - index)))
    let reads = 0
    let writes = 0
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        if (init.method === "POST") {
            writes++
            if (writes === 2) throw new TypeError("private lost response")
            return new Response(null, { status: 204 })
        }
        reads++
        return Response.json(reads === 1 ? source.slice(0, 100) : reads === 2 ? source.slice(100) : [])
    })
    const selection = { authorId: "30", maxScanned: 200, maxSelected: 150 }
    if (mode === "default") {
        const opened = createClient(configuration)
        if (opened.isErr()) throw opened.error
        onTestFinished(async () => {
            await opened.value.shutdown()
        })
        const preview = await opened.value.messages.previewCleanup("20", selection)
        if (preview.isErr()) throw preview.error
        const result = await opened.value.messages.cleanup(preview.value)
        expect(result).toMatchObject({
            error: {
                _tag: "MessageCleanupError",
                phase: "cleanup",
                reason: "network",
                outcome: "unknown",
                submittedBatches: [{ batchIndex: 0 }],
                terminalBatchIds: source.slice(100).map((message) => message.id),
            },
        })
        expect(JSON.stringify(result)).not.toContain("private-")
        expect(JSON.stringify(result)).not.toContain("private lost response")
    } else {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* createNative(configuration)
                    const plan = yield* client.messages.previewCleanup("20", selection)
                    const result = yield* Effect.result(client.messages.cleanup(plan))
                    expect(result).toMatchObject({
                        _tag: "Failure",
                        failure: {
                            _tag: "MessageCleanupError",
                            phase: "cleanup",
                            reason: "network",
                            outcome: "unknown",
                            submittedBatches: [{ batchIndex: 0 }],
                            terminalBatchIds: source.slice(100).map((message) => message.id),
                        },
                    })
                    expect(JSON.stringify(result)).not.toContain("private-")
                    expect(JSON.stringify(result)).not.toContain("private lost response")
                }),
            ),
        )
    }
    expect(reads).toBe(3)
    expect(writes).toBe(2)
})

test("cleanup rejects a different client's in-memory plan before dispatch", async () => {
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) =>
        init.method === "POST" ? new Response(null, { status: 204 }) : Response.json([wire("30")]),
    )
    const first = createClient(configuration)
    const second = createClient(configuration)
    if (first.isErr() || second.isErr()) throw new Error("fixture client creation failed")
    try {
        const preview = await first.value.messages.previewCleanup("20", {
            authorId: "30",
            maxScanned: 1,
            maxSelected: 1,
        })
        if (preview.isErr()) throw preview.error
        await expect(second.value.messages.cleanup(preview.value)).resolves.toMatchObject({
            error: { _tag: "MessageCleanupError", reason: "input", outcome: "notDispatched" },
        })
    } finally {
        await first.value.shutdown()
        await second.value.shutdown()
    }
})

test.each(modes)(
    "%s bounds preview scans and selections, uses default options, and permits an empty exact plan",
    async (mode) => {
        const calls: URL[] = []
        const pages = [[wire("30"), wire("29", "31")], [wire("27"), wire("26")], []]
        let posts = 0
        stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
            calls.push(new URL(url))
            if (init.method === "POST") {
                posts++
                return new Response(null, { status: 204 })
            }
            return Response.json(pages.shift())
        })
        const api = await cleanupApi(mode)
        try {
            const scanBound = await api.preview("20", { authorId: "30", maxScanned: 2, maxSelected: 5 })
            expect(scanBound).toMatchObject({ scannedCount: 2, stopReason: "scanLimit" })
            expect(scanBound.selectedMessages.map((message) => message.id)).toEqual(["30"])

            const selectionBound = await api.preview("20", { authorId: "30", maxScanned: 5, maxSelected: 1 })
            expect(selectionBound).toMatchObject({ scannedCount: 1, stopReason: "selectionLimit" })
            expect(selectionBound.selectedMessages.map((message) => message.id)).toEqual(["27"])

            const empty = await api.preview("20", { authorId: "30", maxScanned: 5, maxSelected: 5 })
            expect(empty).toMatchObject({ scannedCount: 0, stopReason: "historyExhausted", selectedMessages: [] })
            expect((await api.cleanup(empty)).submittedBatches).toEqual([])
        } finally {
            await api.close()
        }
        expect(posts).toBe(0)
        expect(calls.map((call) => Object.fromEntries(call.searchParams))).toEqual([
            { limit: "2" },
            { limit: "5" },
            { limit: "5" },
        ])
    },
)

test.each(modes)("%s rejects throwing, nonboolean, and thenable cleanup filters before any deletion", async (mode) => {
    const filters: readonly ((message: unknown) => unknown)[] = [
        () => {
            throw new Error("private filter failure")
        },
        () => "not a boolean",
        () => Promise.reject(new Error("private thenable failure")),
    ]
    for (const filter of filters) {
        const calls: RequestInit[] = []
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            calls.push(init)
            return Response.json([wire("30")])
        })
        const api = await cleanupApi(mode)
        try {
            await expect(
                api.preview("20", {
                    filter: filter as never,
                    maxScanned: 1,
                    maxSelected: 1,
                }),
            ).rejects.toMatchObject({
                _tag: "MessageCleanupError",
                phase: "preview",
                reason: "filter",
                outcome: "notDispatched",
            })
        } finally {
            await api.close()
        }
        expect(calls).toHaveLength(1)
        expect(calls[0]?.method).toBe("GET")
        vi.unstubAllGlobals()
    }
})

test.each(modes)("%s permits at most one concurrent cleanup execution for an owned plan", async (mode) => {
    let release!: () => void
    const posted = new Promise<void>((resolve) => {
        release = resolve
    })
    let posts = 0
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        if (init.method === "POST") {
            posts++
            await posted
            return new Response(null, { status: 204 })
        }
        return Response.json([wire("30")])
    })
    const api = await cleanupApi(mode)
    try {
        const plan = await api.preview("20", { authorId: "30", maxScanned: 1, maxSelected: 1 })
        const first = api.cleanup(plan).then(
            () => "success" as const,
            (error: unknown) => error,
        )
        const second = api.cleanup(plan).then(
            () => "success" as const,
            (error: unknown) => error,
        )
        await vi.waitFor(() => expect(posts).toBe(1))
        release()
        const outcomes = await Promise.all([first, second])
        expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1)
        expect(outcomes.find((outcome) => outcome !== "success")).toMatchObject({
            _tag: "MessageCleanupError",
            phase: "cleanup",
            reason: "input",
            outcome: "notDispatched",
        })
    } finally {
        await api.close()
    }
    expect(posts).toBe(1)
})

test.each(modes)(
    "%s interruption between cleanup batches reports progress and never dispatches a later batch",
    async (mode) => {
        const source = Array.from({ length: 101 }, (_, index) => wire(String(1_000 - index)))
        let reads = 0
        let posts = 0
        const events: string[] = []
        const controller = new AbortController()
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            if (init.method === "POST") {
                posts++
                return new Response(null, { status: 204 })
            }
            reads++
            return Response.json(reads === 1 ? source.slice(0, 100) : source.slice(100))
        })

        if (mode === "default") {
            const client = unwrap(createClient(configuration))
            try {
                const plan = unwrap(
                    await client.messages.previewCleanup("20", { authorId: "30", maxScanned: 101, maxSelected: 101 }),
                )
                const result = await client.messages.cleanup(plan, {
                    signal: controller.signal,
                    onProgress(event) {
                        events.push(`${event.state}:${event.batch.batchIndex}`)
                        if (event.state === "submitted") controller.abort()
                    },
                })
                expect(result).toMatchObject({ error: { _tag: "CancelledError" } })
            } finally {
                unwrap(await client.shutdown())
            }
        } else {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(createNative(configuration).pipe(Scope.provide(scope)))
            try {
                const plan = await Effect.runPromise(
                    client.messages.previewCleanup("20", { authorId: "30", maxScanned: 101, maxSelected: 101 }),
                )
                const exit = await Effect.runPromiseExit(
                    client.messages.cleanup(plan, {
                        onProgress(event) {
                            events.push(`${event.state}:${event.batch.batchIndex}`)
                            if (event.state === "submitted") controller.abort()
                        },
                    }),
                    { signal: controller.signal },
                )
                expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
            } finally {
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        }
        expect(events).toEqual(["submitting:0", "submitted:0"])
        expect(posts).toBe(1)
    },
)

test.each(modes)(
    "%s shares a cleanup deadline across batches and awaits the timed-out response cleanup",
    async (mode) => {
        const source = Array.from({ length: 101 }, (_, index) => wire(String(1_000 - index)))
        let reads = 0
        let posts = 0
        let resolveLate!: (response: Response) => void
        let observeAbort!: () => void
        const aborted = new Promise<void>((resolve) => {
            observeAbort = resolve
        })
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            if (init.method === "POST") {
                posts++
                if (posts === 1) {
                    await new Promise<void>((resolve) => setTimeout(resolve, 30))
                    return new Response(null, { status: 204 })
                }
                return new Promise<Response>((resolve) => {
                    resolveLate = resolve
                    init.signal?.addEventListener("abort", observeAbort, { once: true })
                })
            }
            reads++
            return Response.json(reads === 1 ? source.slice(0, 100) : source.slice(100))
        })
        const api = await cleanupApi(mode)
        try {
            const plan = await api.preview("20", { authorId: "30", maxScanned: 101, maxSelected: 101 })
            const result = api.cleanup(plan, { timeoutMs: 100 }).then(
                () => "success" as const,
                (error: unknown) => error,
            )
            await vi.waitFor(() => expect(posts).toBe(2))
            await aborted
            let settled = false
            void result.then(() => {
                settled = true
            })
            await Promise.resolve()
            expect(settled).toBe(false)
            resolveLate(new Response(null, { status: 204 }))
            await expect(result).resolves.toMatchObject({
                _tag: "MessageCleanupError",
                phase: "cleanup",
                reason: "timeout",
                submittedBatches: [{ batchIndex: 0 }],
                terminalBatchIds: source.slice(100).map((message) => message.id),
            })
        } finally {
            await api.close()
        }
        expect(posts).toBe(2)
    },
)

test.each(modes)("%s preserves cleanup expected failures alongside response cleanup defects", async (mode) => {
    const cleanup = new Error("private cleanup response defect")
    let stage: "preview" | "cleanup" = "preview"
    let cancellations = 0
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        if (stage === "preview") return responseWithCleanupFailure(503, cleanup, () => cancellations++)
        if (init.method === "POST") return responseWithCleanupFailure(503, cleanup, () => cancellations++)
        return Response.json([wire("30")])
    })

    if (mode === "default") {
        const client = unwrap(createClient(configuration))
        try {
            const previewFailure = await Promise.resolve(
                client.messages.previewCleanup("20", { authorId: "30", maxScanned: 1, maxSelected: 1 }),
            ).catch((error) => error)
            expect(previewFailure).toMatchObject({
                name: "SdkDefect",
                operation: "previewCleanup",
                reasons: expect.arrayContaining([
                    {
                        kind: "Failure",
                        failure: expect.objectContaining({
                            _tag: "MessageCleanupError",
                            phase: "preview",
                            reason: "rejected",
                        }),
                    },
                    { kind: "Defect" },
                ]),
            } satisfies Partial<SdkDefect>)
            stage = "cleanup"
            const plan = unwrap(
                await client.messages.previewCleanup("20", { authorId: "30", maxScanned: 1, maxSelected: 1 }),
            )
            const executionFailure = await Promise.resolve(client.messages.cleanup(plan)).catch((error) => error)
            expect(executionFailure).toMatchObject({
                name: "SdkDefect",
                operation: "cleanup",
                reasons: expect.arrayContaining([
                    {
                        kind: "Failure",
                        failure: expect.objectContaining({
                            _tag: "MessageCleanupError",
                            phase: "cleanup",
                            reason: "rejected",
                        }),
                    },
                    { kind: "Defect" },
                ]),
            } satisfies Partial<SdkDefect>)
        } finally {
            unwrap(await client.shutdown())
        }
    } else {
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(createNative(configuration).pipe(Scope.provide(scope)))
        try {
            const previewExit = await Effect.runPromiseExit(
                client.messages.previewCleanup("20", { authorId: "30", maxScanned: 1, maxSelected: 1 }),
            )
            expect(Exit.isFailure(previewExit)).toBe(true)
            if (Exit.isFailure(previewExit)) {
                expect(previewExit.cause.reasons).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            _tag: "Fail",
                            error: expect.objectContaining({ _tag: "MessageCleanupError", phase: "preview" }),
                        }),
                        expect.objectContaining({ _tag: "Die", defect: cleanup }),
                    ]),
                )
            }
            stage = "cleanup"
            const plan = await Effect.runPromise(
                client.messages.previewCleanup("20", { authorId: "30", maxScanned: 1, maxSelected: 1 }),
            )
            const cleanupExit = await Effect.runPromiseExit(client.messages.cleanup(plan))
            expect(Exit.isFailure(cleanupExit)).toBe(true)
            if (Exit.isFailure(cleanupExit)) {
                expect(cleanupExit.cause.reasons).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            _tag: "Fail",
                            error: expect.objectContaining({ _tag: "MessageCleanupError", phase: "cleanup" }),
                        }),
                        expect.objectContaining({ _tag: "Die", defect: cleanup }),
                    ]),
                )
            }
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
    expect(cancellations).toBe(2)
})

test.each(modes)("%s keeps cancellation and a cleanup defect together at the cleanup boundary", async (mode) => {
    const cleanup = new Error("private late cleanup defect")
    let resolveFetch!: (response: Response) => void
    let observeAbort!: () => void
    const aborted = new Promise<void>((resolve) => {
        observeAbort = resolve
    })
    stubFetchWithHostedDiscovery(
        (_url: string, init: RequestInit) =>
            new Promise<Response>((resolve) => {
                resolveFetch = resolve
                init.signal?.addEventListener("abort", observeAbort, { once: true })
            }),
    )
    const controller = new AbortController()
    if (mode === "default") {
        const client = unwrap(createClient(configuration))
        try {
            const result = Promise.resolve(
                client.messages.previewCleanup(
                    "20",
                    { authorId: "30", maxScanned: 1, maxSelected: 1 },
                    { signal: controller.signal },
                ),
            )
            await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"))
            controller.abort()
            await aborted
            resolveFetch(responseWithCleanupFailure(200, cleanup))
            await expect(result).rejects.toMatchObject({
                name: "SdkDefect",
                operation: "previewCleanup",
                reasons: expect.arrayContaining([{ kind: "Interruption" }, { kind: "Defect" }]),
            } satisfies Partial<SdkDefect>)
        } finally {
            unwrap(await client.shutdown())
        }
    } else {
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(createNative(configuration).pipe(Scope.provide(scope)))
        try {
            const result = Effect.runPromiseExit(
                client.messages.previewCleanup("20", { authorId: "30", maxScanned: 1, maxSelected: 1 }),
                { signal: controller.signal },
            )
            await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"))
            controller.abort()
            await aborted
            resolveFetch(responseWithCleanupFailure(200, cleanup))
            const exit = await result
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(Cause.hasInterrupts(exit.cause)).toBe(true)
                expect(exit.cause.reasons).toEqual(
                    expect.arrayContaining([expect.objectContaining({ _tag: "Die", defect: cleanup })]),
                )
            }
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
})
