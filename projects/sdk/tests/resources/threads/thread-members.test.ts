import { Effect, Exit, Scope, Stream } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { ThreadMember } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient, type TestClientOptions } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { expectErr, settle, typedResult } from "../../support/settle.js"

// Fluxer 4749eb7f: ThreadController serves /channels/:id/thread-members, and ThreadMemberService lists members in user ID
// order with a guild member only when with_member is set. Neither payload carries the thread's guild ID
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

type Api = Awaited<ReturnType<typeof open>>

/** A REST thread member, whose guild member has no guild_id */
function wireMember(api: Api, threadId: string, userId: string, withMember = false) {
    const { guild_id: _guild, ...member } = api.fixtures.member({ user: api.fixtures.user({ id: userId }) })
    return {
        id: threadId,
        user_id: userId,
        join_timestamp: "2026-10-08T12:00:00.000Z",
        flags: 0,
        ...(withMember ? { member } : {}),
    }
}

async function collect(source: AsyncIterable<unknown> | Stream.Stream<ThreadMember, unknown>) {
    if (Stream.isStream(source)) {
        const result = await Effect.runPromise(typedResult(Stream.runCollect(source)))
        if (result._tag === "Failure") throw result.failure
        return [...result.success]
    }
    const items: ThreadMember[] = []
    for await (const result of source as AsyncIterable<{ isErr(): boolean; error?: unknown; value?: ThreadMember }>) {
        if (result.isErr()) throw result.error
        items.push(result.value!)
    }
    return items
}

test.each(modes)("%s joins, leaves, adds and removes thread members through their routes", async (mode) => {
    const api = await open(mode)
    const thread = api.fixtures.thread().id
    const put = api.rest.respond(`PUT /channels/${thread}/thread-members/:user`, { status: 204 })
    const remove = api.rest.respond(`DELETE /channels/${thread}/thread-members/:user`, { status: 204 })

    expect(await settle(api.client.threads.join(thread))).toBeUndefined()
    expect(await settle(api.client.threads.addMember(thread, "40"))).toBeUndefined()
    expect(await settle(api.client.threads.removeMember(thread, "40"))).toBeUndefined()
    expect(await settle(api.client.threads.leave(thread))).toBeUndefined()
    expect(put.requests().map((request) => request.path)).toEqual([
        `/channels/${thread}/thread-members/@me`,
        `/channels/${thread}/thread-members/40`,
    ])
    expect(remove.requests().map((request) => request.path)).toEqual([
        `/channels/${thread}/thread-members/40`,
        `/channels/${thread}/thread-members/@me`,
    ])
    expect(await expectErr(api.client.threads.addMember(thread, "not-an-id"))).toMatchObject({
        reason: "input",
        inputValidation: { path: "userId" },
    })
})

test.each(modes)("%s drops only the changed thread from the channel cache after a membership change", async (mode) => {
    const api = await open(mode, { cache: { channels: true } })
    const thread = api.fixtures.thread({ member: { join_timestamp: "2026-10-08T12:00:00.000Z", flags: 0 } })
    const other = api.fixtures.thread()
    for (const cached of [thread, other]) api.rest.respond(`GET /channels/${cached.id}`, { body: cached })
    api.rest.respond(`PUT /channels/${thread.id}/thread-members/:user`, { status: 204 })
    api.rest.respond(`DELETE /channels/${thread.id}/thread-members/:user`, { status: 204 })
    await settle(api.client.channels.fetch(other.id))

    // Without a gateway connection no event replaces the cached membership and member count
    const changes = [
        () => api.client.threads.leave(thread.id),
        () => api.client.threads.join(thread.id),
        () => api.client.threads.addMember(thread.id, "40"),
        () => api.client.threads.removeMember(thread.id, "40"),
    ]
    for (const change of changes) {
        await settle(api.client.channels.fetch(thread.id))
        expect(await settle(api.client.channels.get(thread.id))).toMatchObject({ membership: { flags: 0 } })
        await settle(change())
        expect(await settle(api.client.channels.get(thread.id))).toBeUndefined()
    }
    expect(await settle(api.client.channels.get(other.id))).toMatchObject({ id: other.id })
})

test.each(modes)("%s reads a thread member without its community membership by default", async (mode) => {
    const api = await open(mode)
    const thread = api.fixtures.thread().id
    // An unrequested guild member cannot be decoded without the thread's community, so it is left out
    const route = api.rest.respond(`GET /channels/${thread}/thread-members/40`, {
        body: wireMember(api, thread, "40", true),
    })
    const member = await settle(api.client.threads.fetchMember(thread, "40"))
    expect(member).toEqual({ threadId: thread, userId: "40", joinedAt: "2026-10-08T12:00:00.000Z", flags: 0 })
    expect(Object.isFrozen(member)).toBe(true)
    expect(route.requests()[0]!.query).toEqual({})
    expect(api.requests()).toHaveLength(1)
})

test.each(modes)("%s decodes withMember with the cached thread's community and no extra read", async (mode) => {
    const api = await open(mode, { cache: { channels: true } })
    const thread = api.fixtures.thread()
    api.rest.respond(`GET /channels/${thread.id}`, { body: thread })
    const route = api.rest.respond(`GET /channels/${thread.id}/thread-members/40`, {
        body: wireMember(api, thread.id, "40", true),
    })
    await settle(api.client.channels.fetch(thread.id))

    const member = await settle(api.client.threads.fetchMember(thread.id, "40", { withMember: true }))
    expect(member.member).toMatchObject({ guildId: thread.guild_id, userId: "40" })
    expect(route.requests()[0]!.query).toEqual({ with_member: "true" })
    expect(api.requests().map((request) => request.path)).toEqual([
        `/channels/${thread.id}`,
        `/channels/${thread.id}/thread-members/40`,
    ])
})

test.each(modes)("%s reads the thread first when withMember finds it outside the cache", async (mode) => {
    const api = await open(mode)
    const thread = api.fixtures.thread({ guild_id: "77" })
    api.rest.respond(`GET /channels/${thread.id}`, { body: thread })
    api.rest.respond(`GET /channels/${thread.id}/thread-members/40`, { body: wireMember(api, thread.id, "40", true) })
    const member = await settle(api.client.threads.fetchMember(thread.id, "40", { withMember: true }))
    expect(member.member).toMatchObject({ guildId: "77", userId: "40" })
    expect(api.requests().map((request) => request.path)).toEqual([
        `/channels/${thread.id}`,
        `/channels/${thread.id}/thread-members/40`,
    ])

    // A failed thread read fails the operation before the member read
    const missing = api.fixtures.thread().id
    api.rest.respond(`GET /channels/${missing}`, { status: 404, body: { code: "UNKNOWN_CHANNEL", message: "Unknown" } })
    const members = api.rest.respond(`GET /channels/${missing}/thread-members`, { body: [] })
    expect(await expectErr(api.client.threads.fetchMembers(missing, { withMember: true }))).toMatchObject({
        operation: "threads.fetchMembers",
        reason: "notFound",
    })
    expect(members.requests()).toEqual([])
})

test.each(modes)("%s pages thread members in user ID order and checks the order", async (mode) => {
    const api = await open(mode)
    const thread = api.fixtures.thread().id
    const route = api.rest.respond(`GET /channels/${thread}/thread-members`, {
        body: [wireMember(api, thread, "41"), wireMember(api, thread, "42")],
    })
    const page = await settle(api.client.threads.fetchMembers(thread, { after: "40", limit: 2 }))
    expect(page.map((member) => member.userId)).toEqual(["41", "42"])
    expect(route.requests()[0]!.query).toEqual({ limit: "2", after: "40" })

    route.remove()
    api.rest.respond(`GET /channels/${thread}/thread-members`, {
        body: [wireMember(api, thread, "42"), wireMember(api, thread, "41")],
    })
    expect(await expectErr(api.client.threads.fetchMembers(thread))).toMatchObject({ reason: "response" })
    expect(await expectErr(api.client.threads.fetchMembers(thread, { limit: 101 }))).toMatchObject({
        reason: "input",
        inputValidation: { path: "query.limit" },
    })
})

test.each(modes)("%s iterates thread members and resolves their community once per traversal", async (mode) => {
    const api = await open(mode)
    const thread = api.fixtures.thread({ guild_id: "77" })
    const read = api.rest.respond(`GET /channels/${thread.id}`, { body: thread })
    const pages = api.rest.respond(`GET /channels/${thread.id}/thread-members`, (request) => ({
        body:
            request.query.after === undefined
                ? [wireMember(api, thread.id, "41", true), wireMember(api, thread.id, "42", true)]
                : request.query.after === "42"
                  ? [wireMember(api, thread.id, "43", true)]
                  : [],
    }))
    const members = await collect(
        api.client.threads.iterateMembers(thread.id, { maxItems: 10, pageSize: 2, withMember: true }),
    )
    expect(members.map((member) => [member.userId, member.member?.guildId])).toEqual([
        ["41", "77"],
        ["42", "77"],
        ["43", "77"],
    ])
    expect(read.requests()).toHaveLength(1)
    expect(pages.requests().map((request) => request.query)).toEqual([
        { limit: "2", with_member: "true" },
        { limit: "2", after: "42", with_member: "true" },
        { limit: "2", after: "43", with_member: "true" },
    ])
})
