import { Effect, Exit, Scope, Stream } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { ChannelType, type GuildThreadChannel } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient, type Fixtures } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { typedResult } from "../../support/settle.js"

async function open(mode: Mode) {
    if (mode === "default") {
        const test = createDefaultTestClient()
        onTestFinished(() => test.shutdown())
        return test
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
}

/** Read an iterator or Stream to its end, returning the threads before a failure and the failure itself */
async function drain(source: AsyncIterable<unknown> | Stream.Stream<GuildThreadChannel, unknown>) {
    const threads: GuildThreadChannel[] = []
    if (Stream.isStream(source)) {
        const result = await Effect.runPromise(
            typedResult(Stream.runForEach(source, (thread) => Effect.sync(() => threads.push(thread)))),
        )
        return { threads, failure: result._tag === "Failure" ? result.failure : undefined }
    }
    for await (const result of source as AsyncIterable<{
        isErr(): boolean
        error?: unknown
        value?: GuildThreadChannel
    }>) {
        if (result.isErr()) return { threads, failure: result.error }
        threads.push(result.value!)
    }
    return { threads, failure: undefined }
}

const archivedAt = (fixtures: Pick<Fixtures, "thread">, id: string, at: string, type = 11) =>
    fixtures.thread({
        id,
        type,
        thread_metadata: {
            archived: true,
            auto_archive_duration: 4320,
            archive_timestamp: at,
            locked: false,
            ...(type === ChannelType.PrivateThread ? { invitable: true } : {}),
            create_timestamp: "2026-10-01T00:00:00.000Z",
        },
    })

// Fluxer lists public and private archived threads at or before the cursor minus 1 ms, newest archive time first, and
// joined private threads by thread ID below the cursor (ThreadRepository.ts:159 to 185 and :537 to 610 at 5f3fc0b1)
test.each(modes)(
    "%s reads every archived thread across pages, keeping threads archived in one millisecond",
    async (mode) => {
        const api = await open(mode)
        const parent = api.fixtures.ids.channel
        const newest = archivedAt(api.fixtures, "50", "2026-10-08T12:00:00.005Z")
        const tieA = archivedAt(api.fixtures, "40", "2026-10-08T12:00:00.003Z")
        const tieB = archivedAt(api.fixtures, "30", "2026-10-08T12:00:00.003Z")
        const tieC = archivedAt(api.fixtures, "20", "2026-10-08T12:00:00.003Z")
        const oldest = archivedAt(api.fixtures, "10", "2026-10-08T12:00:00.001Z")
        const all = [newest, tieA, tieB, tieC, oldest]
        const route = api.rest.respond(`GET /channels/${parent}/threads/archived/public`, (request) => {
            const before = request.query.before === undefined ? Infinity : Date.parse(request.query.before) - 1
            const limit = Number(request.query.limit)
            const listed = all.filter((thread) => Date.parse(thread.thread_metadata.archive_timestamp) <= before)
            return { body: { threads: listed.slice(0, limit), members: [], has_more: listed.length > limit } }
        })
        const { threads, failure } = await drain(
            api.client.threads.iterateArchived(parent, { maxItems: 10, pageSize: 2 }),
        )
        expect(failure).toBeUndefined()
        // tieC shares tieA's millisecond, so a cursor of that time would have skipped it. A full page of that millisecond
        // moves the cursor to it, which skips only what a full page could not hold
        expect(threads.map((thread) => thread.id)).toEqual(["50", "40", "30", "10"])
        expect(route.requests().map((request) => request.query)).toEqual([
            { limit: "2" },
            { limit: "2", before: "2026-10-08T12:00:00.004Z" },
            { limit: "2", before: "2026-10-08T12:00:00.003Z" },
        ])
        // With room for the whole millisecond on one page, every thread is read
        const wide = await drain(api.client.threads.iterateArchived(parent, { maxItems: 10, pageSize: 3 }))
        expect(wide.threads.map((thread) => thread.id)).toEqual(["50", "40", "30", "20", "10"])
    },
)

// When fewer items remain than a page holds, a shorter page could fill with the previous page's repeated millisecond
// and move the cursor past a tie that fits a full page
test.each(modes)("%s keeps a tie that fits a page when maxItems leaves fewer items than a page", async (mode) => {
    const api = await open(mode)
    const parent = api.fixtures.ids.channel
    for (const scope of ["public", "private"] as const) {
        const type = scope === "public" ? ChannelType.PublicThread : ChannelType.PrivateThread
        const all = [
            archivedAt(api.fixtures, "50", "2026-10-08T12:00:00.005Z", type),
            archivedAt(api.fixtures, "40", "2026-10-08T12:00:00.003Z", type),
            archivedAt(api.fixtures, "30", "2026-10-08T12:00:00.003Z", type),
            archivedAt(api.fixtures, "20", "2026-10-08T12:00:00.003Z", type),
            archivedAt(api.fixtures, "10", "2026-10-08T12:00:00.001Z", type),
        ]
        const route = api.rest.respond(`GET /channels/${parent}/threads/archived/${scope}`, (request) => {
            const before = request.query.before === undefined ? Infinity : Date.parse(request.query.before) - 1
            const limit = Number(request.query.limit)
            const listed = all.filter((thread) => Date.parse(thread.thread_metadata.archive_timestamp) <= before)
            return { body: { threads: listed.slice(0, limit), members: [], has_more: listed.length > limit } }
        })
        const { threads, failure } = await drain(
            api.client.threads.iterateArchived(parent, { scope, maxItems: 5, pageSize: 3 }),
        )
        expect(failure).toBeUndefined()
        expect(threads.map((thread) => thread.id)).toEqual(["50", "40", "30", "20", "10"])
        expect(route.requests().map((request) => request.query.limit)).toEqual(["3", "3", "3"])
    }
})

test.each(modes)("%s pages joined private threads by ID and private threads by archive time", async (mode) => {
    const api = await open(mode)
    const parent = api.fixtures.ids.channel
    const joined = [
        archivedAt(api.fixtures, "90", "2026-10-08T12:00:00.000Z", 12),
        archivedAt(api.fixtures, "80", "2026-10-08T13:00:00.000Z", 12),
        archivedAt(api.fixtures, "70", "2026-10-08T11:00:00.000Z", 12),
    ]
    const joinedRoute = api.rest.respond(`GET /channels/${parent}/users/@me/threads/archived/private`, (request) => {
        const listed = joined.filter(
            (thread) => request.query.before === undefined || BigInt(thread.id) < BigInt(request.query.before),
        )
        return { body: { threads: listed.slice(0, 2), members: [], has_more: listed.length > 2 } }
    })
    const read = await drain(
        api.client.threads.iterateArchived(parent, { scope: "joinedPrivate", maxItems: 10, pageSize: 2, before: "95" }),
    )
    expect(read.threads.map((thread) => thread.id)).toEqual(["90", "80", "70"])
    expect(joinedRoute.requests().map((request) => request.query)).toEqual([
        { limit: "2", before: "95" },
        { limit: "2", before: "80" },
    ])

    const privateRoute = api.rest.respond(`GET /channels/${parent}/threads/archived/private`, {
        body: { threads: [joined[1]], members: [], has_more: false },
    })
    const single = await drain(api.client.threads.iterateArchived(parent, { scope: "private", maxItems: 1 }))
    expect(single.threads.map((thread) => thread.id)).toEqual(["80"])
    // Pages by thread ID never repeat a thread, so a later page asks only for the threads that remain
    const remaining = await drain(
        api.client.threads.iterateArchived(parent, { scope: "joinedPrivate", maxItems: 3, pageSize: 2, before: "95" }),
    )
    expect(remaining.threads.map((thread) => thread.id)).toEqual(["90", "80", "70"])
    expect(
        joinedRoute
            .requests()
            .slice(2)
            .map((request) => request.query),
    ).toEqual([
        { limit: "2", before: "95" },
        { limit: "2", before: "80" },
    ])
    // Fluxer reads at least 2 threads a page, and the traversal still stops after maxItems
    expect(privateRoute.requests().map((request) => request.query)).toEqual([{ limit: "2" }])
})

test.each(modes)("%s fails locally for invalid settings and on a cursor that does not move", async (mode) => {
    const api = await open(mode)
    const parent = api.fixtures.ids.channel
    const invalid = [
        [{ maxItems: 5, pageSize: 1 }, "query.pageSize"],
        [{ maxItems: 5, scope: "everything" }, "query.scope"],
        [{ maxItems: 5, scope: "joinedPrivate", before: "2026-10-08T12:00:00Z" }, "query.before"],
        [{ maxItems: 5, before: "90" }, "query.before"],
        [{ maxItems: 5, limit: 10 }, "query"],
        [{ pageSize: 10 }, "query.maxItems"],
    ] as const
    for (const [query, path] of invalid)
        expect((await drain(api.client.threads.iterateArchived(parent, query as never))).failure).toMatchObject({
            _tag: "PaginationError",
            operation: "threads.iterateArchived",
            reason: "input",
            inputValidation: { path },
        })
    expect(api.requests()).toEqual([])

    // A page whose last thread is not older than the cursor would repeat itself
    api.rest.respond(`GET /channels/${parent}/users/@me/threads/archived/private`, {
        body: {
            threads: [archivedAt(api.fixtures, "99", "2026-10-08T12:00:00.000Z", 12)],
            members: [],
            has_more: true,
        },
    })
    const stalled = await drain(
        api.client.threads.iterateArchived(parent, { scope: "joinedPrivate", maxItems: 10, before: "50" }),
    )
    expect(stalled.threads.map((thread) => thread.id)).toEqual(["99"])
    expect(stalled.failure).toMatchObject({ _tag: "PaginationError", reason: "cursorStalled" })
})

test.each(modes)("%s keeps threads.fetchArchived's error for a rejected page", async (mode) => {
    const api = await open(mode)
    const parent = api.fixtures.ids.channel
    api.rest.respond(`GET /channels/${parent}/threads/archived/private`, {
        status: 403,
        body: { code: "MISSING_PERMISSIONS", message: "Missing Permissions" },
    })
    const { threads, failure } = await drain(
        api.client.threads.iterateArchived(parent, { scope: "private", maxItems: 5 }),
    )
    expect(threads).toEqual([])
    expect(failure).toMatchObject({
        _tag: "ChannelOperationError",
        operation: "threads.fetchArchived",
        reason: "rejected",
    })
})
