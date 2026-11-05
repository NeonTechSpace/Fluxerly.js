import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { createWebhookClient, MessageFlags } from "../../src/index.js"
import { createWebhookClient as createNativeWebhook } from "../../src/effect.js"
import { modes, type Mode } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { expectErr, settle } from "../support/settle.js"

// These follow Fluxer at commit 0098958f: Validator.ts turns "" into null on routes that read their body through it,
// and MessageValidationService.ts:47-68 refuses an edit without flags that has no visible content, embed or attachment.
// The SDK therefore sends an exact "" as given on those routes and refuses a request locally only where Fluxer would
// refuse it or where the empty value cannot mean anything

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

const body = (route: { requests(): readonly { body?: unknown }[] }, index = 0) => route.requests()[index]?.body

/** A guild member as Fluxer's REST routes answer it */
const httpMember = (userId: string, extra: Record<string, unknown> = {}) => ({
    user: {
        id: userId,
        username: "ada",
        discriminator: "0001",
        global_name: "Ada",
        avatar: null,
        avatar_color: null,
        flags: 0,
    },
    nick: null,
    avatar: null,
    banner: null,
    accent_color: null,
    roles: [],
    joined_at: "2026-10-08T12:00:00.000Z",
    mute: false,
    deaf: false,
    communication_disabled_until: null,
    ...extra,
})

/** The error of an input that never reached the transport */
const notDispatched = { reason: "input", outcome: "notDispatched" }

afterEach(() => vi.unstubAllGlobals())

test.each(modes)("%s sends empty community settings as given", async (mode) => {
    const api = await open(mode)
    const guild = api.fixtures.guild({ id: "200" })
    const route = api.rest.respond("PATCH /guilds/200", { body: guild })
    await settle(api.client.guilds.edit("200", { systemChannelId: "", afkChannelId: "", messageHistoryCutoff: "" }))
    expect(body(route)).toMatchObject({ system_channel_id: "", afk_channel_id: "", message_history_cutoff: "" })
})

test.each(modes)("%s sends an empty vanity code and accepts the null answer", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("PATCH /guilds/200/vanity-url", { body: { code: null } })
    expect(await settle(api.client.guilds.editVanityUrl("200", ""))).toMatchObject({ code: null, url: null })
    expect(body(route)).toEqual({ code: "" })
})

test.each(modes)("%s sends empty member profile fields and nicknames as given", async (mode) => {
    const api = await open(mode)
    const self = api.rest.respond("PATCH /guilds/200/members/@me", { body: httpMember(api.fixtures.ids.bot) })
    await settle(api.client.members.editSelf("200", { nickname: "", bio: "", pronouns: "" }))
    expect(body(self)).toMatchObject({ nick: "", bio: "", pronouns: "" })

    // A blank bio is not the exact empty string, so it still fails before sending
    const sent = self.requests().length
    expect(await expectErr(api.client.members.editSelf("200", { bio: " " }))).toMatchObject({
        ...notDispatched,
        inputValidation: { path: "bio" },
    })
    expect(self.requests()).toHaveLength(sent)

    const other = api.rest.respond("PATCH /guilds/200/members/31", { body: httpMember("31") })
    await settle(api.client.members.setNickname({ guildId: "200", userId: "31" }, ""))
    expect(body(other)).toEqual({ nick: "" })
})

test.each(modes)("%s sends an empty timeout reason as given", async (mode) => {
    const api = await open(mode)
    const until = new Date(Date.now() + 3_600_000).toISOString()
    const route = api.rest.respond("PATCH /guilds/200/members/31", {
        body: httpMember("31", { communication_disabled_until: until }),
    })
    await settle(api.client.members.timeout({ guildId: "200", userId: "31" }, 60_000, { timeoutReason: "" }))
    expect(body(route)).toMatchObject({ timeout_reason: "" })
})

test.each(modes)("%s sends an empty voice channel and connection as given", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("PATCH /guilds/200/members/31", { body: httpMember("31") })
    await settle(api.client.members.move({ guildId: "200", userId: "31", connectionId: "" }, ""))
    expect(body(route)).toEqual({ channel_id: "", connection_id: "" })
})

test.each(modes)("%s sends empty group conversation fields as given", async (mode) => {
    const api = await open(mode)
    const user = api.fixtures.user({ id: "30" })
    const group = {
        id: "11",
        type: 3,
        recipients: [user],
        name: "group",
        owner_id: "30",
        nicks: {},
        last_message_id: null,
    }
    api.rest.respond("GET /channels/11", { body: group })
    const route = api.rest.respond("PATCH /channels/11", { body: group })
    await settle(api.client.directMessages.editGroup("11", { name: "", ownerId: "", nicknames: { "30": "" } }))
    expect(body(route)).toEqual({ name: "", owner_id: "", nicks: { "30": "" } })
})

test.each(modes)("%s sends empty channel settings as given", async (mode) => {
    const api = await open(mode)
    const channel = api.fixtures.channel({ id: "300", guild_id: "200" })
    const create = api.rest.respond("POST /guilds/200/channels", { body: channel })
    await settle(api.client.channels.create("200", { type: 0, name: "general", topic: "", url: "", parentId: "" }))
    expect(body(create)).toMatchObject({ topic: "", url: "", parent_id: "" })

    const sent = create.requests().length
    expect(await expectErr(api.client.channels.create("200", { type: 0, name: "" }))).toMatchObject(notDispatched)
    expect(create.requests()).toHaveLength(sent)

    const edit = api.rest.respond("PATCH /channels/300", { body: channel })
    await settle(api.client.channels.edit("300", { name: "", topic: "", url: "", rtcRegion: "" }))
    expect(body(edit)).toMatchObject({ name: "", topic: "", url: "", rtc_region: "" })
    // Fluxer reads a default reaction whose values are all empty as null for the whole field, which clears it
    await settle(api.client.channels.edit("300", { defaultReactionEmoji: { emojiId: "", emojiName: "" } }))
    expect(body(edit, 1)).toEqual({ default_reaction_emoji: { emoji_id: "", emoji_name: "" } })

    const reorder = api.rest.respond("PATCH /guilds/200/channels", { status: 204 })
    await settle(api.client.channels.reorder("200", [{ id: "300", parentId: "", precedingSiblingId: "" }]))
    expect(body(reorder)).toEqual([{ id: "300", parent_id: "", preceding_sibling_id: "" }])
})

test.each(modes)("%s sends empty forum tag emoji fields as given", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel()
    const edit = api.rest.respond("POST /channels/:id/tags", { body: forum })
    await settle(api.client.channels.createForumTag(forum.id, { name: "Help", emojiName: "", emojiId: "" }))
    expect(body(edit)).toMatchObject({ name: "Help", emoji_name: "", emoji_id: "" })

    // Only one of the two emoji fields is really set, so the other one being empty is accepted
    await settle(api.client.channels.createForumTag(forum.id, { name: "Bug", emojiId: "1", emojiName: "" }))
    expect(edit.requests()).toHaveLength(2)
})

test.each(modes)("%s sends a null sticker description for an empty one", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("POST /guilds/200/stickers", {
        body: { id: "100", name: "Fixture", animated: false, description: "", tags: [] },
    })
    await settle(api.client.stickers.create("200", { name: "Fixture", image: "aW1hZ2U=", description: "" }))
    expect(body(route)).toMatchObject({ name: "Fixture", description: null })
})

test.each(modes)("%s refuses empty strings where Fluxer would refuse them", async (mode) => {
    const api = await open(mode)
    const search = api.rest.respond("POST /guilds/200/members-search", {
        body: { members: [], page_result_count: 0, total_result_count: 0, indexing: false },
    })
    expect(await expectErr(api.client.members.search("200", { sourceInviteCodes: [""] }))).toMatchObject(notDispatched)
    expect(search.requests()).toHaveLength(0)

    const refresh = api.rest.respond("POST /attachments/refresh-urls", { body: { urls: [] } })
    expect(await expectErr(api.client.attachments.refreshUrls([""]))).toMatchObject(notDispatched)
    expect(refresh.requests()).toHaveLength(0)
})

test.each(modes)("%s refuses a message edit without flags that shows nothing", async (mode) => {
    const api = await open(mode)
    const target = { channelId: "20", id: "10" }
    const route = api.rest.respond("PATCH /channels/20/messages/10", {
        body: api.fixtures.message({ id: "10", channel_id: "20" }),
    })
    for (const input of [{ content: "" }, { embeds: [] }, { content: " ​ " }, { attachments: [] }])
        expect(await expectErr(api.client.messages.edit(target, input as never))).toMatchObject(notDispatched)
    expect(route.requests()).toHaveLength(0)

    await settle(api.client.messages.edit(target, { content: "", flags: 0 }))
    expect(body(route, 0)).toMatchObject({ content: "", flags: 0 })
    await settle(api.client.messages.edit(target, { attachments: [], flags: 4 }))
    expect(body(route, 1)).toMatchObject({ attachments: [], flags: 4 })
    await settle(api.client.messages.edit(target, { content: "", embeds: [{ title: "x" }] }))
    expect(body(route, 2)).toMatchObject({ content: "" })
    expect(route.requests()).toHaveLength(3)
})

test.each(modes)("%s refuses blank or invisible message text", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("POST /channels/20/messages", {
        body: api.fixtures.message({ channel_id: "20" }),
    })
    expect(await expectErr(api.client.messages.send("20", { content: "  \u200b" }))).toMatchObject(notDispatched)
    // Fluxer does not count blank or invisible text as voice note content, so the content rule passes and the
    // attachment rule decides (MessageValidationService.ts:47, 203-205)
    expect(
        await expectErr(api.client.messages.send("20", { content: " \u200b", flags: MessageFlags.VoiceMessage })),
    ).toMatchObject({ ...notDispatched, inputValidation: { path: "attachments" } })
    expect(route.requests()).toHaveLength(0)
})

test.each(modes)("%s applies the same edit rule to webhook messages", async (mode) => {
    const options = { id: "100", token: "test_only_secret" }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const webhook =
        mode === "native"
            ? await Effect.runPromise(createNativeWebhook(options).pipe(Effect.provideService(Scope.Scope, scope)))
            : createWebhookClient(options)
    onTestFinished(async () => {
        const stopped = webhook.shutdown()
        await (Effect.isEffect(stopped) ? Effect.runPromise(stopped) : stopped)
    })
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json({
            id: "400",
            channel_id: "300",
            webhook_id: "100",
            content: "",
            author: { id: "100", username: "Deployments", bot: true },
        })
    })
    expect(await expectErr(webhook.editMessage("400", { content: "" }))).toMatchObject(notDispatched)
    expect(bodies).toHaveLength(0)
    await settle(webhook.editMessage("400", { content: "", flags: 0 }))
    expect(bodies).toEqual([expect.objectContaining({ content: "", flags: 0 })])
})
