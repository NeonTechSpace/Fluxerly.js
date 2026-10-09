import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { ChannelType, ThreadAutoArchiveMinutes, type FluxerlyError, type GuildChannel } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient, type TestClientOptions } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { expectErr, settle, type Operation } from "../../support/settle.js"

// Fluxer 4749eb7f: ThreadController and ForumController answer thread creation with 201, list routes with threads beside
// the bot's memberships, and a search with 202 and a SEARCH_INDEX_NOT_READY body while the guild's index is built
async function open(mode: Mode, options: Pick<TestClientOptions, "cache"> = {}) {
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        onTestFinished(() => test.shutdown())
        return test
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
}

const joinedAt = "2026-10-08T12:00:00.000Z"
const membership = (threadId: string, userId: string) => ({
    id: threadId,
    user_id: userId,
    join_timestamp: joinedAt,
    flags: 1,
})

test.each(modes)("%s creates threads from Fluxer's 201 answers through their routes", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    const parent = fixtures.ids.channel
    const created = fixtures.thread({ type: ChannelType.PrivateThread, name: "Planning" })
    const create = api.rest.respond(`POST /channels/${parent}/threads`, { status: 201, body: created })

    const thread = await settle(
        api.client.threads.create(
            parent,
            {
                name: "Planning",
                type: ChannelType.PrivateThread,
                autoArchiveMinutes: ThreadAutoArchiveMinutes.OneDay,
                rateLimitPerUser: 5,
                invitable: false,
            },
            { auditReason: "Release work" },
        ),
    )
    expect(thread).toMatchObject({ id: created.id, type: ChannelType.PrivateThread, parentId: parent })
    expect(Object.isFrozen(thread)).toBe(true)
    expect(create.requests()[0]).toMatchObject({
        body: { name: "Planning", type: 12, auto_archive_duration: 1440, rate_limit_per_user: 5, invitable: false },
        headers: { "x-audit-log-reason": "Release work" },
    })
    // Fluxer requires a type, so an omitted one is sent as a public thread
    await settle(api.client.threads.create(parent, { name: "Open" }))
    expect(create.requests()[1]!.body).toEqual({ name: "Open", type: ChannelType.PublicThread })

    const source = fixtures.message()
    const started = fixtures.thread({ id: source.id, name: "Discussion" })
    const fromMessage = api.rest.respond(`POST /channels/${source.channel_id}/messages/${source.id}/threads`, {
        status: 201,
        body: started,
    })
    const result = await settle(
        api.client.threads.createFromMessage({ id: source.id, channelId: source.channel_id }, { name: "Discussion" }),
    )
    expect(result).toMatchObject({ id: source.id, parentId: parent, type: ChannelType.PublicThread })
    expect(fromMessage.requests()[0]!.body).toEqual({ name: "Discussion" })
})

test.each(modes)("%s rejects a created thread from another parent or with another ID", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    api.rest.respond(`POST /channels/${fixtures.ids.channel}/threads`, {
        status: 201,
        body: fixtures.thread({ parent_id: "999" }),
    })
    const source = fixtures.message()
    api.rest.respond(`POST /channels/${source.channel_id}/messages/${source.id}/threads`, {
        status: 201,
        body: fixtures.thread(),
    })
    const operations: Operation<unknown, unknown>[] = [
        api.client.threads.create(fixtures.ids.channel, { name: "Planning" }),
        api.client.threads.createFromMessage({ id: source.id, channelId: source.channel_id }, { name: "Planning" }),
    ]
    for (const operation of operations)
        // The write was dispatched, so its outcome stays unknown
        expect(await expectErr(operation)).toMatchObject({ reason: "response", outcome: "unknown" })
})

test.each(modes)("%s rejects invalid thread input before sending a request", async (mode) => {
    const api = await open(mode)
    const { client, fixtures } = api
    const parent = fixtures.ids.channel
    const cases: { call: () => Operation<unknown, unknown>; path: string }[] = [
        { call: () => client.threads.create(parent, { name: "Planning", invitable: true }), path: "invitable" },
        { call: () => client.threads.create(parent, { name: "  " }), path: "name" },
        {
            call: () => client.threads.create(parent, { name: "Planning", autoArchiveMinutes: 30 }),
            path: "autoArchiveMinutes",
        },
        {
            call: () => client.threads.create(parent, { name: "Planning", type: ChannelType.Text as never }),
            path: "type",
        },
        { call: () => client.threads.edit("10", {}), path: "input" },
        { call: () => client.threads.edit("10", { pinned: "yes" as never }), path: "pinned" },
        {
            call: () => client.threads.edit("10", { appliedTagIds: ["1", "2", "3", "4", "5", "6"] }),
            path: "appliedTagIds",
        },
        {
            call: () =>
                client.threads.fetchArchived(parent, { scope: "joinedPrivate", before: "2026-10-08T12:00:00Z" }),
            path: "query.before",
        },
        { call: () => client.threads.fetchArchived(parent, { limit: 1 }), path: "query.limit" },
        { call: () => client.threads.search(parent, { limit: 26 }), path: "query.limit" },
        { call: () => client.threads.search(parent, { sortBy: "newest" as never }), path: "query.sortBy" },
        { call: () => client.threads.join("10", { auditReason: "joined" } as never), path: "options" },
    ]
    for (const { call, path } of cases)
        expect(await expectErr(call()), path).toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path },
        })
    expect(api.requests()).toEqual([])
})

test.each(modes)("%s edits a thread and sends pinned as the thread's flags", async (mode) => {
    const api = await open(mode)
    const thread = api.fixtures.thread({ parent_id: api.fixtures.forumChannel().id, flags: 2, applied_tags: ["7"] })
    const edit = api.rest.respond(`PATCH /channels/${thread.id}`, { body: thread })

    const edited = await settle(
        api.client.threads.edit(
            thread.id,
            { archived: false, locked: true, pinned: true, appliedTagIds: ["7"] },
            { auditReason: "Pin the guide" },
        ),
    )
    expect(edited).toMatchObject({ id: thread.id, flags: 2, appliedTagIds: ["7"] })
    expect(edit.requests()[0]).toMatchObject({
        body: { archived: false, locked: true, flags: 2, applied_tags: ["7"] },
        headers: { "x-audit-log-reason": "Pin the guide" },
    })
    await settle(api.client.threads.edit(thread.id, { pinned: false }))
    expect(edit.requests()[1]!.body).toEqual({ flags: 0 })
})

test.each(modes)("%s folds the bot's memberships into active and archived thread lists", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    const parent = fixtures.ids.channel
    const joined = fixtures.thread({ name: "joined" })
    const other = fixtures.thread({ name: "other" })
    api.rest.respond(`GET /guilds/${fixtures.ids.guild}/threads/active`, {
        body: { threads: [joined, other], members: [membership(joined.id, fixtures.ids.bot)] },
    })
    const active = await settle(api.client.threads.fetchActive(fixtures.ids.guild))
    expect(active.map((thread) => [thread.id, thread.membership])).toEqual([
        [joined.id, { joinedAt, flags: 1 }],
        [other.id, undefined],
    ])

    const archived = fixtures.thread({ type: ChannelType.PrivateThread })
    const joinedPrivate = api.rest.respond(`GET /channels/${parent}/users/@me/threads/archived/private`, {
        body: { threads: [archived], members: [membership(archived.id, fixtures.ids.bot)], has_more: true },
    })
    const page = await settle(
        api.client.threads.fetchArchived(parent, { scope: "joinedPrivate", before: "900", limit: 10 }),
    )
    expect(page).toMatchObject({ hasMore: true, threads: [{ id: archived.id, membership: { joinedAt, flags: 1 } }] })
    expect(Object.isFrozen(page)).toBe(true)
    expect(joinedPrivate.requests()[0]!.query).toEqual({ limit: "10", before: "900" })

    const publicPage = api.rest.respond(`GET /channels/${parent}/threads/archived/public`, {
        body: { threads: [], members: [], has_more: false },
    })
    await settle(api.client.threads.fetchArchived(parent, { before: joinedAt }))
    expect(publicPage.requests()[0]!.query).toEqual({ limit: "50", before: joinedAt })
})

test.each(modes)("%s rejects thread lists that name another community, parent or thread", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    const parent = fixtures.ids.channel
    api.rest.respond(`GET /guilds/${fixtures.ids.guild}/threads/active`, {
        body: { threads: [fixtures.thread({ guild_id: "999" })], members: [] },
    })
    api.rest.respond(`GET /channels/${parent}/threads/archived/public`, {
        body: { threads: [fixtures.thread({ parent_id: "999" })], members: [], has_more: false },
    })
    const thread = fixtures.thread()
    api.rest.respond(`GET /channels/${parent}/threads/archived/private`, {
        // A membership must name a listed thread, or the bot's memberships would be lost
        body: { threads: [thread], members: [membership("999", fixtures.ids.bot)], has_more: false },
    })
    const operations: Operation<unknown, unknown>[] = [
        api.client.threads.fetchActive(fixtures.ids.guild),
        api.client.threads.fetchArchived(parent),
        api.client.threads.fetchArchived(parent, { scope: "private" }),
    ]
    for (const operation of operations) expect(await expectErr(operation)).toMatchObject({ reason: "response" })
})

test.each(modes)("%s returns an indexing page for a 202 search without retrying it", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel()
    const search = api.rest.respond(`GET /channels/${forum.id}/threads/search`, {
        status: 202,
        body: {
            code: "SEARCH_INDEX_NOT_READY",
            message: "Search index not ready",
            documents_indexed: 0,
            retry_after: 2,
        },
    })
    const page = await settle(
        api.client.threads.search(forum.id, {
            name: "crash",
            tagIds: ["5", "6"],
            tagSetting: "match_all",
            archived: false,
            sortBy: "creation_time",
            sortOrder: "asc",
            limit: 10,
            offset: 20,
            minId: "1",
        }),
    )
    expect(page).toEqual({ indexing: true })
    expect(search.requests()).toHaveLength(1)
    const params = new URL(search.requests()[0]!.url).searchParams
    expect(params.getAll("tag")).toEqual(["5", "6"])
    expect(Object.fromEntries([...params].filter(([key]) => key !== "tag"))).toEqual({
        name: "crash",
        tag_setting: "match_all",
        archived: "false",
        sort_by: "creation_time",
        sort_order: "asc",
        limit: "10",
        offset: "20",
        min_id: "1",
    })
})

test.each(modes)("%s fails a 202 search answer that does not say the index is building", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel()
    api.rest.respond(`GET /channels/${forum.id}/threads/search`, {
        status: 202,
        body: { code: "UNKNOWN_CHANNEL", message: "Unknown Channel" },
    })
    expect(await expectErr(api.client.threads.search(forum.id))).toMatchObject({ reason: "response", status: 202 })
})

test.each(modes)("%s reads search results with memberships and the first message of each post", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    const forum = fixtures.forumChannel()
    const post = fixtures.thread({ parent_id: forum.id, applied_tags: [] })
    const first = fixtures.message({ channel_id: post.id, content: "Steps to reproduce" })
    api.rest.respond(`GET /channels/${forum.id}/threads/search`, {
        body: {
            threads: [post],
            members: [membership(post.id, fixtures.ids.bot)],
            has_more: true,
            total_results: 3,
            first_messages: [first],
        },
    })
    const page = await settle(api.client.threads.search(forum.id))
    expect(page).toMatchObject({
        indexing: false,
        total: 3,
        hasMore: true,
        threads: [{ id: post.id, membership: { joinedAt, flags: 1 } }],
        firstMessages: [{ id: first.id, channelId: post.id, content: "Steps to reproduce" }],
    })

    // A text channel's results carry no first messages
    const thread = fixtures.thread()
    api.rest.respond(`GET /channels/${fixtures.ids.channel}/threads/search`, {
        body: { threads: [thread], members: [], has_more: false, total_results: 1 },
    })
    expect(await settle(api.client.threads.search(fixtures.ids.channel))).toMatchObject({ firstMessages: [] })

    // A first message outside the listed posts cannot belong to this page
    api.rest.respond(`GET /channels/${forum.id}/threads/search`, {
        body: { threads: [post], members: [], has_more: false, total_results: 1, first_messages: [fixtures.message()] },
    })
    expect(await expectErr(api.client.threads.search(forum.id))).toMatchObject({ reason: "response" })
})

test.each(modes)("%s keeps the active list in the channel cache but never a page", async (mode) => {
    const api = await open(mode, { cache: { channels: true } })
    const { fixtures } = api
    const active = fixtures.thread()
    const archived = fixtures.thread()
    const found = fixtures.thread()
    api.rest.respond(`GET /guilds/${fixtures.ids.guild}/threads/active`, { body: { threads: [active], members: [] } })
    api.rest.respond(`GET /channels/${fixtures.ids.channel}/threads/archived/public`, {
        body: { threads: [archived], members: [], has_more: false },
    })
    api.rest.respond(`GET /channels/${fixtures.ids.channel}/threads/search`, {
        body: { threads: [found], members: [], has_more: false, total_results: 1 },
    })
    await settle(api.client.threads.fetchActive(fixtures.ids.guild))
    await settle(api.client.threads.fetchArchived(fixtures.ids.channel))
    await settle(api.client.threads.search(fixtures.ids.channel))

    expect(await settle(api.client.channels.get(active.id))).toMatchObject({ id: active.id })
    expect(await settle(api.client.channels.get(archived.id))).toBeUndefined()
    expect(await settle(api.client.channels.get(found.id))).toBeUndefined()
    // A page object stored as a channel would surface as an entry without an ID
    const entries = (await settle(api.client.cache.entries("channels") as never)) as readonly GuildChannel[]
    expect(entries.map((channel) => channel.id)).toEqual([active.id])
})

test.each(modes)("%s keeps cached channels when a new thread is created", async (mode) => {
    const api = await open(mode, { cache: { channels: true } })
    const { fixtures } = api
    const active = fixtures.thread()
    api.rest.respond(`GET /guilds/${fixtures.ids.guild}/threads/active`, { body: { threads: [active], members: [] } })
    api.rest.respond(`POST /channels/${fixtures.ids.channel}/threads`, { status: 201, body: fixtures.thread() })
    await settle(api.client.threads.fetchActive(fixtures.ids.guild))

    // A new thread has no descendants or sibling order, so creating one cannot make another snapshot stale
    await settle(api.client.threads.create(fixtures.ids.channel, { name: "Planning" }))
    expect(await settle(api.client.channels.get(active.id))).toMatchObject({ id: active.id })
})

test.each(modes)("%s names the permissions a rejected thread creation needs", async (mode) => {
    const api = await open(mode)
    api.rest.respond(`POST /channels/${api.fixtures.ids.channel}/threads`, {
        status: 403,
        body: { code: "MISSING_PERMISSIONS", message: "Missing Permissions" },
    })
    const error = (await expectErr(
        api.client.threads.create(api.fixtures.ids.channel, { name: "Planning" }),
    )) as FluxerlyError
    expect(error).toMatchObject({ operation: "threads.create", reason: "rejected" })
    expect(error.details).toMatchObject({ requiredPermissions: ["ViewChannel", "CreatePublicThreads"] })
})

// ThreadDenials, ThreadRepository and ThreadCreationService answer these with a code, and the SDK names the category and
// the fix, so a bot can tell an archived thread from a full one without reading raw responses
test.each(modes)("%s categorizes the reasons Fluxer refuses a thread operation", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    const parent = fixtures.ids.channel
    const thread = fixtures.thread().id
    const source = fixtures.message()
    const cases: Array<{
        route: string
        run: () => Operation<unknown, unknown>
        status: number
        code: string
        category: string
    }> = [
        {
            route: `PUT /channels/${thread}/thread-members/@me`,
            run: () => api.client.threads.join(thread),
            status: 400,
            code: "THREAD_ARCHIVED",
            category: "threadArchived",
        },
        {
            route: `PUT /channels/${thread}/thread-members/40`,
            run: () => api.client.threads.addMember(thread, "40"),
            status: 400,
            code: "THREAD_LOCKED",
            category: "threadLocked",
        },
        {
            route: `PUT /channels/${thread}/thread-members/41`,
            run: () => api.client.threads.addMember(thread, "41"),
            status: 400,
            code: "MAX_THREAD_MEMBERS",
            category: "resourceLimit",
        },
        {
            route: `DELETE /channels/${thread}/thread-members/42`,
            run: () => api.client.threads.removeMember(thread, "42"),
            status: 404,
            code: "UNKNOWN_THREAD_MEMBER",
            category: "unknownResource",
        },
        {
            route: `POST /channels/${parent}/threads`,
            run: () => api.client.threads.create(parent, { name: "Planning" }),
            status: 400,
            code: "MAX_ACTIVE_THREADS",
            category: "resourceLimit",
        },
        {
            route: `POST /channels/${source.channel_id}/messages/${source.id}/threads`,
            run: () =>
                api.client.threads.createFromMessage(
                    { id: source.id, channelId: source.channel_id },
                    { name: "Discussion" },
                ),
            status: 400,
            code: "THREAD_ALREADY_CREATED_FOR_MESSAGE",
            category: "threadAlreadyCreated",
        },
        {
            route: `PATCH /channels/${thread}`,
            run: () => api.client.threads.edit(thread, { pinned: true }),
            status: 400,
            code: "MAX_PINNED_THREADS_IN_FORUM",
            category: "resourceLimit",
        },
    ]
    for (const reviewed of cases)
        api.rest.respond(reviewed.route, { status: reviewed.status, body: { code: reviewed.code } })

    for (const reviewed of cases)
        expect(await expectErr(reviewed.run())).toMatchObject({
            status: reviewed.status,
            apiError: { providerCode: reviewed.code, code: reviewed.category },
            hint: expect.stringMatching(/\S/),
        })
})
