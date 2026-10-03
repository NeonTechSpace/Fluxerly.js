import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { MessageFlags, MessageType, type MessageReference } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

const target = { channelId: "10", id: "20" }
// Fluxer 597116a: CrosspostSourceSchemas includes required nullable description and approximate counts
const sourceGuild = {
    id: "40",
    name: "Source community",
    description: null,
    features: ["VERIFIED", "PARTNERED", "DISCOVERABLE"],
    approximate_member_count: null,
    approximate_presence_count: null,
    discoverable: true,
    icon: null,
    banner: "banner-hash",
}

async function setup(mode: Mode) {
    const options = { cache: { messages: true, guilds: true } } as const
    const scope = Scope.makeUnsafe()
    const defaultTest = mode === "default" ? createDefaultTestClient(options) : undefined
    const nativeTest =
        mode === "native"
            ? await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
            : undefined
    onTestFinished(async () => {
        if (defaultTest) await defaultTest.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return (defaultTest ?? nativeTest)!
}

test.each(modes)("%s publishes without a body and updates only the cached source", async (mode) => {
    const api = await setup(mode)
    const wire = api.fixtures.message({ id: target.id, channel_id: target.channelId, flags: 0 })
    api.rest.respond("GET /channels/10/messages/20", { body: wire })
    const unrelated = { id: "21", channelId: "11" }
    api.rest.respond("GET /channels/11/messages/21", {
        body: api.fixtures.message({ id: unrelated.id, channel_id: unrelated.channelId }),
    })
    const published = api.rest.respond("POST /channels/10/messages/20/crosspost", {
        body: { ...wire, flags: MessageFlags.Crossposted },
    })
    await settle(api.client.messages.fetch(target))
    const retained = await settle(api.client.messages.fetch(unrelated))
    const result = await settle(api.client.messages.publish(target))
    expect(result).toMatchObject({ id: "20", channelId: "10", flags: MessageFlags.Crossposted })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.author)).toBe(true)
    expect(await settle(api.client.messages.get(target))).toBe(result)
    expect(await settle(api.client.messages.get(unrelated))).toBe(retained)
    expect(published.requests()[0]).toMatchObject({
        method: "POST",
        path: "/channels/10/messages/20/crosspost",
        body: undefined,
    })
    expect(published.requests()[0]!.headers).not.toHaveProperty("x-audit-log-reason")
    expect(api.requests()).toHaveLength(3)
})

test.each(modes)(
    "%s evicts an uncertain published source without retrying a lost or malformed response",
    async (mode) => {
        const api = await setup(mode)
        const wire = api.fixtures.message({ id: target.id, channel_id: target.channelId })
        api.rest.respond("GET /channels/10/messages/20", { body: wire })
        for (const failure of ["lost", "mismatched", "server"] as const) {
            await settle(api.client.messages.fetch(target))
            const route = api.rest.respond("POST /channels/10/messages/20/crosspost", () => {
                if (failure === "lost") throw new Error("Synthetic lost response")
                return failure === "server" ? { status: 500, body: {} } : { body: { ...wire, id: "99" } }
            })
            await expect(settle(api.client.messages.publish(target))).rejects.toMatchObject({
                _tag: "MessageOperationError",
                operation: "publish",
                outcome: "unknown",
                reason: failure === "lost" ? "network" : failure === "server" ? "rejected" : "response",
            })
            expect(route.requests()).toHaveLength(1)
            expect(await settle(api.client.messages.get(target))).toBeUndefined()
            route.remove()
        }
    },
)

test.each(modes)(
    "%s blocks a pre-publication read from restoring the source after an unknown outcome",
    async (mode) => {
        const api = await setup(mode)
        const wire = api.fixtures.message({ id: target.id, channel_id: target.channelId })
        let release!: () => void
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        const fetch = api.rest.respond("GET /channels/10/messages/20", async () => {
            await held
            return { body: wire }
        })
        api.rest.respond("POST /channels/10/messages/20/crosspost", () => {
            throw new Error("Synthetic lost response")
        })
        const reading = settle(api.client.messages.fetch(target))
        try {
            await fetch.next()
            await expect(settle(api.client.messages.publish(target))).rejects.toMatchObject({ outcome: "unknown" })
        } finally {
            release()
        }
        expect(await reading).toMatchObject({ id: target.id })
        expect(await settle(api.client.messages.get(target))).toBeUndefined()
    },
)

test.each(modes)("%s preserves a cached source on a confirmed publish rejection", async (mode) => {
    const api = await setup(mode)
    api.rest.respond("GET /channels/10/messages/20", {
        body: api.fixtures.message({ id: target.id, channel_id: target.channelId }),
    })
    const route = api.rest.respond("POST /channels/10/messages/20/crosspost", {
        status: 403,
        body: { code: "MISSING_PERMISSIONS" },
    })
    const before = await settle(api.client.messages.fetch(target))
    await expect(settle(api.client.messages.publish(target))).rejects.toMatchObject({
        _tag: "MessageOperationError",
        operation: "publish",
        reason: "rejected",
        outcome: "rejected",
    })
    expect(route.requests()).toHaveLength(1)
    expect(await settle(api.client.messages.get(target))).toBe(before)
})

test.each(modes)("%s reads frozen source metadata while preserving null counts and cache ownership", async (mode) => {
    const api = await setup(mode)
    api.rest.respond("GET /guilds/40", { body: api.fixtures.guild({ id: "40", name: "Cached full community" }) })
    api.rest.respond("GET /channels/10/messages/20", {
        body: api.fixtures.message({ id: target.id, channel_id: target.channelId, flags: MessageFlags.IsCrosspost }),
    })
    const route = api.rest.respond("GET /channels/10/messages/20/crosspost-source", { body: { guild: sourceGuild } })
    const cachedGuild = await settle(api.client.guilds.fetch("40"))
    const cachedMessage = await settle(api.client.messages.fetch(target))
    const result = await settle(api.client.messages.fetchCrosspostSource(target))
    expect(result).toEqual({
        guild: {
            id: "40",
            name: "Source community",
            description: null,
            features: sourceGuild.features,
            approximateMemberCount: null,
            approximatePresenceCount: null,
            discoverable: true,
            icon: null,
            banner: "banner-hash",
        },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.guild)).toBe(true)
    expect(Object.isFrozen(result.guild.features)).toBe(true)
    expect(await settle(api.client.guilds.get("40"))).toBe(cachedGuild)
    expect(await settle(api.client.messages.get(target))).toBe(cachedMessage)
    expect(route.requests()[0]).toMatchObject({
        method: "GET",
        path: "/channels/10/messages/20/crosspost-source",
        body: undefined,
    })
    expect(route.requests()[0]!.headers).not.toHaveProperty("x-audit-log-reason")
})

test.each(modes)(
    "%s accepts omitted source artwork and numeric approximate counts on a follow notice",
    async (mode) => {
        const api = await setup(mode)
        api.rest.respond("GET /channels/10/messages/20", {
            body: api.fixtures.message({
                id: target.id,
                channel_id: target.channelId,
                type: MessageType.ChannelFollowAdd,
                message_reference: { channel_id: "50", guild_id: "40" },
            }),
        })
        const notice = await settle(api.client.messages.fetch(target))
        expect(notice).toMatchObject({
            type: MessageType.ChannelFollowAdd,
            messageReference: { channelId: "50", guildId: "40" },
        })
        expect(notice.messageReference).not.toHaveProperty("id")
        const { icon: _icon, banner: _banner, ...guild } = sourceGuild
        api.rest.respond("GET /channels/10/messages/20/crosspost-source", {
            body: {
                guild: {
                    ...guild,
                    description: "Public description",
                    approximate_member_count: 12,
                    approximate_presence_count: 0,
                },
            },
        })
        const result = await settle(api.client.messages.fetchCrosspostSource(target))
        expect(result.guild).toMatchObject({
            description: "Public description",
            approximateMemberCount: 12,
            approximatePresenceCount: 0,
        })
        expect(result.guild).not.toHaveProperty("icon")
        expect(result.guild).not.toHaveProperty("banner")
        expect(await settle(api.client.guilds.get("40"))).toBeUndefined()
    },
)

test.each(modes)("%s preserves unknown public source feature strings", async (mode) => {
    const api = await setup(mode)
    api.rest.respond("GET /channels/10/messages/20/crosspost-source", {
        body: { guild: { ...sourceGuild, features: ["VERIFIED", "FUTURE_PUBLIC_BADGE"] } },
    })
    const result = await settle(api.client.messages.fetchCrosspostSource(target))
    expect(result.guild.features).toEqual(["VERIFIED", "FUTURE_PUBLIC_BADGE"])
    expect(Object.isFrozen(result.guild.features)).toBe(true)
})

test.each(modes)("%s rejects malformed source profiles and classifies a non-qualifying message", async (mode) => {
    const api = await setup(mode)
    for (const guild of [
        { ...sourceGuild, description: undefined },
        { ...sourceGuild, approximate_member_count: undefined },
        { ...sourceGuild, approximate_presence_count: "0" },
        { ...sourceGuild, features: [0] },
        { ...sourceGuild, discoverable: null },
    ]) {
        const route = api.rest.respond("GET /channels/10/messages/20/crosspost-source", { body: { guild } })
        await expect(settle(api.client.messages.fetchCrosspostSource(target))).rejects.toMatchObject({
            _tag: "MessageOperationError",
            operation: "fetchCrosspostSource",
            reason: "response",
            status: 200,
        })
        expect(route.requests()).toHaveLength(1)
        route.remove()
    }
    api.rest.respond("GET /channels/10/messages/20/crosspost-source", {
        status: 404,
        body: { code: "UNKNOWN_MESSAGE" },
    })
    await expect(settle(api.client.messages.fetchCrosspostSource(target))).rejects.toMatchObject({
        reason: "notFound",
        outcome: "rejected",
        apiError: { providerCode: "UNKNOWN_MESSAGE" },
    })
})

test.each(modes)("%s rejects invalid message references and audit options before dispatch", async (mode) => {
    const api = await setup(mode)
    for (const operation of ["publish", "fetchCrosspostSource"] as const) {
        for (const input of [{ id: "20" }, { id: "bad", channelId: "10" }, null]) {
            await expect(settle(api.client.messages[operation](input as MessageReference))).rejects.toMatchObject({
                operation,
                reason: "input",
                outcome: "notDispatched",
            })
        }
        await expect(
            settle(api.client.messages[operation](target, { auditReason: "Unsupported" } as never)),
        ).rejects.toMatchObject({ operation, reason: "input", outcome: "notDispatched" })
    }
    expect(api.requests()).toHaveLength(0)
})

test.each(modes)("%s applies the configured message selection to publish responses", async (mode) => {
    const scope = Scope.makeUnsafe()
    const options = { messageFields: ["flags"] } as const
    const defaultTest = mode === "default" ? createDefaultTestClient(options) : undefined
    const nativeTest =
        mode === "native"
            ? await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
            : undefined
    onTestFinished(async () => {
        if (defaultTest) await defaultTest.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const api = (defaultTest ?? nativeTest)!
    api.rest.respond("POST /channels/10/messages/20/crosspost", {
        body: api.fixtures.message({
            id: target.id,
            channel_id: target.channelId,
            flags: MessageFlags.Crossposted,
            pinned: true,
        }),
    })
    const result = await settle(api.client.messages.publish(target))
    expect(result).toMatchObject({ id: target.id, channelId: target.channelId, flags: MessageFlags.Crossposted })
    expect(result).not.toHaveProperty("pinned")
    expect(result).not.toHaveProperty("attachments")
    expect(Object.isFrozen(result)).toBe(true)
})
