import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import {
    ChannelFlags,
    ChannelType,
    ForumLayout,
    ForumSortOrder,
    ThreadAutoArchiveMinutes,
    type ChannelAuditOperationOptions,
    type ChannelCreate,
    type ChannelEdit,
    type ForumTagInput,
    type GuildChannel,
} from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

// Fluxer 4749eb7f: ChannelRequestSchemas (ChannelCreateForumRequest, ChannelCreateMediaRequest, the thread-parent
// defaults and the update bodies), ForumRequestSchemas (ForumTagRequest, ForumChannelRequestFields), ForumController
// (the three tag routes), ThreadParentSettings (buildThreadParentPatch) and ChannelRequestService.editForumTags

const bug = { id: "70", name: "bug", moderated: false, emoji_id: null, emoji_name: "🐛" }
const staff = { id: "71", name: "staff", moderated: true, emoji_id: "300", emoji_name: null }

test.each(modes)("%s creates a forum channel with every forum setting under Fluxer's wire names", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel({
        name: "help",
        topic: "Ask a question",
        available_tags: [bug, staff],
        default_reaction_emoji: { emoji_id: null, emoji_name: "👍" },
        default_sort_order: 1,
        default_forum_layout: 2,
        default_tag_setting: "match_all",
        default_auto_archive_duration: 1440,
        default_thread_rate_limit_per_user: 10,
        flags: 16,
    })
    const route = api.rest.respond("POST /guilds/:id/channels", { body: forum })

    const created = await api.create(api.fixtures.ids.guild, {
        type: ChannelType.Forum,
        name: "help",
        topic: "Ask a question",
        availableTags: [
            { name: "bug", emojiName: "🐛" },
            { name: "staff", moderated: true, emojiId: "300" },
        ],
        defaultReactionEmoji: { emojiName: "👍" },
        defaultSortOrder: ForumSortOrder.CreationTime,
        defaultForumLayout: ForumLayout.Grid,
        defaultTagSetting: "match_all",
        defaultAutoArchiveMinutes: ThreadAutoArchiveMinutes.OneDay,
        defaultThreadRateLimitPerUser: 10,
        flags: ChannelFlags.RequireTag,
    })

    expect(route.requests().map((request) => request.body)).toEqual([
        {
            type: 15,
            name: "help",
            topic: "Ask a question",
            available_tags: [
                { name: "bug", emoji_name: "🐛" },
                { name: "staff", moderated: true, emoji_id: "300" },
            ],
            default_reaction_emoji: { emoji_name: "👍" },
            default_sort_order: 1,
            default_forum_layout: 2,
            default_tag_setting: "match_all",
            default_auto_archive_duration: 1440,
            default_thread_rate_limit_per_user: 10,
            flags: 16,
        },
    ])
    expect(created).toMatchObject({
        id: forum.id,
        type: ChannelType.Forum,
        availableTags: [
            { id: "70", name: "bug", moderated: false, emojiId: null, emojiName: "🐛" },
            { id: "71", name: "staff", moderated: true, emojiId: "300", emojiName: null },
        ],
        defaultReactionEmoji: { emojiId: null, emojiName: "👍" },
        defaultSortOrder: 1,
        defaultForumLayout: 2,
        defaultTagSetting: "match_all",
        defaultAutoArchiveMinutes: 1440,
        defaultThreadRateLimitPerUser: 10,
        flags: 16,
    })
    expect(Object.isFrozen(created)).toBe(true)
})

test.each(modes)("%s creates a media channel that can hide download options and has no layout", async (mode) => {
    const api = await open(mode)
    const media = api.fixtures.forumChannel({ type: 16, flags: 32784 })
    const route = api.rest.respond("POST /guilds/:id/channels", { body: media })

    const created = await api.create(api.fixtures.ids.guild, {
        type: ChannelType.Media,
        name: "gallery",
        availableTags: [{ name: "art" }],
        flags: ChannelFlags.RequireTag | ChannelFlags.HideMediaDownloadOptions,
    })

    expect(route.requests().map((request) => request.body)).toEqual([
        { type: 16, name: "gallery", available_tags: [{ name: "art" }], flags: 32784 },
    ])
    expect(created).toMatchObject({ type: ChannelType.Media, flags: 32784 })
    expect(created).not.toHaveProperty("defaultForumLayout")
})

test.each(modes)(
    "%s sends the thread defaults of text and announcement channels, and null clears them",
    async (mode) => {
        const api = await open(mode)
        const text = api.fixtures.channel()
        const created = api.rest.respond("POST /guilds/:id/channels", { body: text })
        const edited = api.rest.respond("PATCH /channels/:id", { body: text })

        await api.create(api.fixtures.ids.guild, {
            type: ChannelType.Text,
            name: "general",
            defaultAutoArchiveMinutes: ThreadAutoArchiveMinutes.OneHour,
            defaultThreadRateLimitPerUser: 30,
        })
        await api.create(api.fixtures.ids.guild, {
            type: ChannelType.Announcement,
            name: "news",
            defaultAutoArchiveMinutes: ThreadAutoArchiveMinutes.OneWeek,
        })
        await api.edit(text.id, { defaultAutoArchiveMinutes: null, defaultThreadRateLimitPerUser: null })

        expect(created.requests().map((request) => request.body)).toEqual([
            { type: 0, name: "general", default_auto_archive_duration: 60, default_thread_rate_limit_per_user: 30 },
            { type: 5, name: "news", default_auto_archive_duration: 10080 },
        ])
        expect(edited.requests().map((request) => request.body)).toEqual([
            { default_auto_archive_duration: null, default_thread_rate_limit_per_user: null },
        ])
    },
)

test.each(modes)("%s edits forum settings and sends a received channel's tags back unchanged", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel({ available_tags: [bug, staff] })
    api.rest.respond("GET /channels/:id", { body: forum })
    const edited = api.rest.respond("PATCH /channels/:id", { body: forum })

    const received = await api.fetch(forum.id)
    if (received.type !== ChannelType.Forum) throw new Error("Expected a forum channel")
    await api.edit(forum.id, { availableTags: received.availableTags ?? [] })
    await api.edit(forum.id, {
        availableTags: [{ id: "70", name: "bug fixes" }, { name: "new" }],
        defaultReactionEmoji: null,
        defaultSortOrder: null,
        defaultForumLayout: ForumLayout.List,
        defaultTagSetting: null,
        flags: 0,
        topic: "t".repeat(4096),
    })

    expect(edited.requests().map((request) => request.body)).toEqual([
        {
            available_tags: [
                { id: "70", name: "bug", moderated: false, emoji_id: null, emoji_name: "🐛" },
                { id: "71", name: "staff", moderated: true, emoji_id: "300", emoji_name: null },
            ],
        },
        {
            topic: "t".repeat(4096),
            default_reaction_emoji: null,
            default_sort_order: null,
            default_forum_layout: 1,
            default_tag_setting: null,
            flags: 0,
            available_tags: [{ id: "70", name: "bug fixes" }, { name: "new" }],
        },
    ])
})

// Fluxer silently drops a setting that its channel type does not own (pickThreadParentSettings), so a created
// channel's type decides locally which settings are valid, and every value Fluxer would reject is refused before dispatch
test.each(modes)("%s refuses forum and thread-default settings that cannot apply, before any request", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("/guilds/:id/channels", { body: api.fixtures.forumChannel() })
    const edit = api.rest.respond("PATCH /channels/:id", { body: api.fixtures.forumChannel() })
    const guild = api.fixtures.ids.guild
    const tags = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `tag ${index}` }))
    const create: Array<[string, unknown, string, string]> = [
        ["forum settings on a text channel", { type: 0, name: "a", availableTags: [] }, "input", "allowedFields"],
        [
            "thread defaults on a voice channel",
            { type: 2, name: "a", defaultAutoArchiveMinutes: 60 },
            "input",
            "allowedFields",
        ],
        ["a layout on a media channel", { type: 16, name: "a", defaultForumLayout: 1 }, "input", "allowedFields"],
        [
            "an existing tag ID on a new channel",
            { type: 15, name: "a", availableTags: [{ id: "1", name: "a" }] },
            "availableTags[]",
            "allowedFields",
        ],
        [
            "the media flag on a forum channel",
            { type: 15, name: "a", flags: ChannelFlags.HideMediaDownloadOptions },
            "flags",
            "allowedValue",
        ],
        [
            "a topic over 4,096 units on a forum channel",
            { type: 15, name: "a", topic: "t".repeat(4097) },
            "topic",
            "length",
        ],
        [
            "a topic over 1,024 units on a text channel",
            { type: 0, name: "a", topic: "t".repeat(1025) },
            "topic",
            "length",
        ],
    ]
    const shared: Array<[string, Record<string, unknown>, string, string]> = [
        ["an unnamed archive period", { defaultAutoArchiveMinutes: 61 }, "defaultAutoArchiveMinutes", "allowedValue"],
        [
            "a thread slowmode over 21,600",
            { defaultThreadRateLimitPerUser: 21_601 },
            "defaultThreadRateLimitPerUser",
            "range",
        ],
        ["a negative thread slowmode", { defaultThreadRateLimitPerUser: -1 }, "defaultThreadRateLimitPerUser", "range"],
        ["an unnamed sort order", { defaultSortOrder: 2 }, "defaultSortOrder", "allowedValue"],
        ["an unnamed layout", { defaultForumLayout: 3 }, "defaultForumLayout", "allowedValue"],
        ["an unknown tag setting", { defaultTagSetting: "match_none" }, "defaultTagSetting", "allowedValue"],
        ["flags outside the settable bits", { flags: ChannelFlags.Pinned }, "flags", "allowedValue"],
        ["negative flags", { flags: -16 }, "flags", "allowedValue"],
        ["21 tags", { availableTags: tags(21) }, "availableTags", "length"],
        ["tags that are not a list", { availableTags: "bug" }, "availableTags", "type"],
        ["a tag that is not an object", { availableTags: ["bug"] }, "availableTags[]", "type"],
        ["a tag without a name", { availableTags: [{ moderated: true }] }, "availableTags[].name", "required"],
        ["a tag name over 50 units", { availableTags: [{ name: "n".repeat(51) }] }, "availableTags[].name", "length"],
        ["a blank tag name", { availableTags: [{ name: "  " }] }, "availableTags[].name", "length"],
        [
            "a tag with a non-boolean moderated",
            { availableTags: [{ name: "a", moderated: "yes" }] },
            "availableTags[].moderated",
            "type",
        ],
        [
            "a tag with both emojis",
            { availableTags: [{ name: "a", emojiId: "1", emojiName: "🐛" }] },
            "availableTags[]",
            "relationship",
        ],
        [
            "a tag emoji ID that is not decimal",
            { availableTags: [{ name: "a", emojiId: "x" }] },
            "availableTags[].emojiId",
            "format",
        ],
        [
            "a tag emoji name over 64 units",
            { availableTags: [{ name: "a", emojiName: "e".repeat(65) }] },
            "availableTags[].emojiName",
            "length",
        ],
        ["an unknown tag key", { availableTags: [{ name: "a", color: 1 }] }, "availableTags[]", "allowedFields"],
        ["a reaction that is not an object", { defaultReactionEmoji: "👍" }, "defaultReactionEmoji", "type"],
        [
            "a reaction with both emojis",
            { defaultReactionEmoji: { emojiId: "1", emojiName: "👍" } },
            "defaultReactionEmoji",
            "relationship",
        ],
        ["an unknown reaction key", { defaultReactionEmoji: { name: "👍" } }, "defaultReactionEmoji", "allowedFields"],
    ]
    for (const [, input, path, constraint] of create)
        await expect(api.create(guild, input as ChannelCreate)).rejects.toMatchObject({
            _tag: "ChannelOperationError",
            operation: "channels.create",
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path, constraint },
        })
    for (const [, input, path, constraint] of shared) {
        await expect(api.create(guild, { type: 15, name: "a", ...input } as ChannelCreate)).rejects.toMatchObject({
            operation: "channels.create",
            reason: "input",
            inputValidation: { path, constraint },
        })
        await expect(api.edit("10", input as ChannelEdit)).rejects.toMatchObject({
            operation: "channels.edit",
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path, constraint },
        })
    }
    await expect(api.edit("10", { topic: "t".repeat(4097) })).rejects.toMatchObject({
        inputValidation: { path: "topic", constraint: "length" },
    })
    expect(route.requests()).toEqual([])
    expect(edit.requests()).toEqual([])
})

test.each(modes)("%s manages one forum tag through its own routes and returns the updated channel", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel({ available_tags: [bug, staff] })
    const media = api.fixtures.forumChannel({ type: 16, available_tags: [bug] })
    const created = api.rest.respond("POST /channels/:id/tags", { body: forum })
    const replaced = api.rest.respond("PUT /channels/:id/tags/:tag", { body: media })
    const deleted = api.rest.respond("DELETE /channels/:id/tags/:tag", { body: forum })
    const options = { auditReason: "tag cleanup" }

    const afterCreate = await api.createTag(forum.id, { name: "staff", moderated: true, emojiId: "300" }, options)
    const afterEdit = await api.editTag(media.id, "70", { name: "bug" }, options)
    const afterDelete = await api.deleteTag(forum.id, "71", options)

    expect(created.requests()).toMatchObject([
        { path: `/channels/${forum.id}/tags`, body: { name: "staff", moderated: true, emoji_id: "300" } },
    ])
    // The replacement sends only what the caller supplied, so Fluxer resets everything else to its default
    expect(replaced.requests()).toMatchObject([{ path: `/channels/${media.id}/tags/70`, body: { name: "bug" } }])
    expect(replaced.requests()[0]!.body).toEqual({ name: "bug" })
    expect(deleted.requests()).toMatchObject([{ path: `/channels/${forum.id}/tags/71`, body: undefined }])
    for (const route of [created, replaced, deleted])
        expect(route.requests().map((request) => request.headers["x-audit-log-reason"])).toEqual(["tag cleanup"])
    expect(afterCreate).toMatchObject({ id: forum.id, type: ChannelType.Forum })
    expect(afterCreate.availableTags?.map((tag) => tag.name)).toEqual(["bug", "staff"])
    expect(afterEdit.type).toBe(ChannelType.Media)
    expect(afterDelete.id).toBe(forum.id)
    expect(Object.isFrozen(afterCreate)).toBe(true)
})

// Fluxer assigns the ID of a new tag and takes the edited tag's ID from the route, so a received ForumTag, which carries
// its own ID, is valid input that the SDK keeps out of the body, unless it names another tag than the route does
test.each(modes)("%s accepts a received tag for the single-tag routes without sending its ID", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel({ available_tags: [bug] })
    const created = api.rest.respond("POST /channels/:id/tags", { body: forum })
    const replaced = api.rest.respond("PUT /channels/:id/tags/:tag", { body: forum })
    const received = { id: "70", name: "bug", moderated: false, emojiId: null, emojiName: "🐛" }

    await api.createTag(forum.id, received)
    await api.editTag(forum.id, "70", { ...received, moderated: true })
    await expect(api.editTag(forum.id, "71", received)).rejects.toMatchObject({
        operation: "channels.editForumTag",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "id", constraint: "relationship" },
    })

    expect(created.requests().map((request) => request.body)).toEqual([
        { name: "bug", moderated: false, emoji_id: null, emoji_name: "🐛" },
    ])
    expect(replaced.requests().map((request) => request.body)).toEqual([
        { name: "bug", moderated: true, emoji_id: null, emoji_name: "🐛" },
    ])
})

test.each(modes)("%s refuses a malformed forum tag before any request", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("/channels/:id/tags", { body: api.fixtures.forumChannel() })
    const routeById = api.rest.respond("/channels/:id/tags/:tag", { body: api.fixtures.forumChannel() })
    const cases: Array<[unknown, string, string]> = [
        [undefined, "input", "type"],
        [{}, "name", "required"],
        [{ name: "" }, "name", "length"],
        [{ name: "n".repeat(51) }, "name", "length"],
        [{ name: "a", moderated: null }, "moderated", "type"],
        [{ name: "a", emojiId: "1", emojiName: "🐛" }, "input", "relationship"],
        [{ name: "a", emojiId: 1 }, "emojiId", "format"],
        [{ id: 70, name: "a" }, "id", "format"],
        [{ name: "a", color: 1 }, "input", "allowedFields"],
    ]
    for (const [input, path, constraint] of cases) {
        const failure = { reason: "input", outcome: "notDispatched", inputValidation: { path, constraint } }
        await expect(api.createTag("10", input as ForumTagInput)).rejects.toMatchObject({
            operation: "channels.createForumTag",
            ...failure,
        })
        await expect(api.editTag("10", "70", input as ForumTagInput)).rejects.toMatchObject({
            operation: "channels.editForumTag",
            ...failure,
        })
    }
    await expect(api.createTag("x", { name: "a" })).rejects.toMatchObject({ inputValidation: { path: "channelId" } })
    await expect(api.editTag("10", "x", { name: "a" })).rejects.toMatchObject({ inputValidation: { path: "tagId" } })
    await expect(api.deleteTag("10", "x")).rejects.toMatchObject({
        operation: "channels.deleteForumTag",
        inputValidation: { path: "tagId", constraint: "format" },
    })
    await expect(api.deleteTag("x", "70")).rejects.toMatchObject({ inputValidation: { path: "channelId" } })
    expect(route.requests()).toEqual([])
    expect(routeById.requests()).toEqual([])
})

test.each(modes)("%s treats a tag response that is not the forum channel as malformed", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel()
    const thread = api.fixtures.thread()
    const route = api.rest.respond("POST /channels/:id/tags", (request) => ({
        body: request.path === `/channels/${forum.id}/tags` ? { ...forum, id: "999" } : thread,
    }))

    // The first answer describes another channel, and the second describes the requested ID as a thread
    for (const channelId of [forum.id, thread.id])
        await expect(api.createTag(channelId, { name: "a" })).rejects.toMatchObject({
            operation: "channels.createForumTag",
            reason: "response",
        })
    expect(route.requests()).toHaveLength(2)
})

test.each(modes)("%s names the permissions a tag change needs when Fluxer refuses it", async (mode) => {
    const api = await open(mode)
    api.rest.respond("/channels/:id/tags", { status: 403, body: { code: "MISSING_PERMISSIONS" } })
    api.rest.respond("/channels/:id/tags/:tag", { status: 403, body: { code: "MISSING_PERMISSIONS" } })

    const refused = {
        details: { apiError: "MISSING_PERMISSIONS", requiredPermissions: ["ViewChannel", "ManageChannels"] },
    }
    await expect(api.createTag("10", { name: "a" })).rejects.toMatchObject(refused)
    await expect(api.editTag("10", "70", { name: "a" })).rejects.toMatchObject(refused)
    await expect(api.deleteTag("10", "70")).rejects.toMatchObject(refused)
})

// ForumTagService, ThreadParentSettings and ForumTagRules answer these rejections with a code, and the SDK names the
// category and the fix, so a bot can tell a duplicate name from a full tag list without reading raw responses
test.each(modes)("%s categorizes the reasons Fluxer refuses a tag or forum setting change", async (mode) => {
    const api = await open(mode)
    let rejection = { status: 400, code: "FORUM_TAG_NAMES_MUST_BE_UNIQUE" }
    const answer = () => ({ status: rejection.status, body: { code: rejection.code } })
    api.rest.respond("/channels/:id/tags", answer)
    api.rest.respond("/channels/:id/tags/:tag", answer)
    api.rest.respond("PATCH /channels/:id", answer)

    for (const [status, providerCode, code] of [
        [400, "FORUM_TAG_NAMES_MUST_BE_UNIQUE", "forumTagNamesNotUnique"],
        [400, "MAX_FORUM_TAGS", "resourceLimit"],
        [404, "UNKNOWN_FORUM_TAG", "unknownResource"],
        [400, "NO_TAGS_AVAILABLE_TO_NON_MODERATORS", "noTagsAvailable"],
        [400, "HIDE_MEDIA_DOWNLOAD_OPTION_MEDIA_ONLY", "mediaChannelRequired"],
    ] as const) {
        rejection = { status, code: providerCode }
        const explained = { status, apiError: { providerCode, code }, hint: expect.stringMatching(/\S/) }
        await expect(api.createTag("10", { name: "a" })).rejects.toMatchObject(explained)
        await expect(api.editTag("10", "70", { name: "a" })).rejects.toMatchObject(explained)
        await expect(api.deleteTag("10", "70")).rejects.toMatchObject(explained)
        await expect(api.edit("10", { flags: ChannelFlags.HideMediaDownloadOptions })).rejects.toMatchObject(explained)
    }
})

async function open(mode: Mode) {
    const options = { gateway: { ignoredEvents: [] } } as const
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
    const test = (defaultTest ?? nativeTest)!
    return {
        fixtures: test.fixtures,
        rest: test.rest,
        requests: () => test.requests(),
        fetch: (channelId: string): Promise<GuildChannel> =>
            defaultTest
                ? settle(defaultTest.client.channels.fetch(channelId))
                : settle(nativeTest!.client.channels.fetch(channelId)),
        create: (guildId: string, input: ChannelCreate) =>
            defaultTest
                ? settle(defaultTest.client.channels.create(guildId, input))
                : settle(nativeTest!.client.channels.create(guildId, input)),
        edit: (channelId: string, input: ChannelEdit) =>
            defaultTest
                ? settle(defaultTest.client.channels.edit(channelId, input))
                : settle(nativeTest!.client.channels.edit(channelId, input)),
        createTag: (channelId: string, input: ForumTagInput, options?: ChannelAuditOperationOptions) =>
            defaultTest
                ? settle(defaultTest.client.channels.createForumTag(channelId, input, options))
                : settle(nativeTest!.client.channels.createForumTag(channelId, input, options)),
        editTag: (channelId: string, tagId: string, input: ForumTagInput, options?: ChannelAuditOperationOptions) =>
            defaultTest
                ? settle(defaultTest.client.channels.editForumTag(channelId, tagId, input, options))
                : settle(nativeTest!.client.channels.editForumTag(channelId, tagId, input, options)),
        deleteTag: (channelId: string, tagId: string, options?: ChannelAuditOperationOptions) =>
            defaultTest
                ? settle(defaultTest.client.channels.deleteForumTag(channelId, tagId, options))
                : settle(nativeTest!.client.channels.deleteForumTag(channelId, tagId, options)),
    }
}
