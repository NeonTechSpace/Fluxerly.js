import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"
import { settle, type Operation } from "../support/settle.js"

// Every response example Fluxer's OpenAPI document calls valid must decode through the SDK's public operations.
// The generator in scripts/openapi-examples.js writes the fixture from the document at the upstream pin, so this check
// runs offline. Where the document allows more than Fluxer's server sends, the facts in
// fixtures/openapi-server-facts.json narrow the examples, with the server code as evidence, and each fact's probe must
// still be rejected so an unneeded fact is removed
interface Example {
    readonly name: string
    readonly value: Wire
}
interface Fixture {
    readonly source: { readonly repository: string; readonly commit: string; readonly sha256: string }
    readonly factsSha256: string
    readonly schemas: Readonly<Record<string, readonly Example[]>>
    readonly probes: readonly (Example & { readonly fact: string; readonly schema: string })[]
}
/** Schema-shaped example JSON, read by field name */
type Wire = any

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const fixture = JSON.parse(read("./fixtures/openapi-examples.json")) as Fixture

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

type Api = Awaited<ReturnType<typeof open>>

/** How one response schema reaches the SDK: The route Fluxer answers and the public operation that decodes it */
interface Decoder {
    readonly route: (value: Wire) => string
    readonly status?: (value: Wire) => number
    /** Links IDs that Fluxer keeps consistent across fields, which a schema example cannot express */
    readonly consistent?: (value: Wire) => Wire
    readonly run: (api: Api, value: Wire) => Operation<unknown, unknown>
}

// IDs a payload does not carry, such as the community of a member, so the request may name any value
const guildId = "1"
const channelId = "2"
const first = (list: Wire) => (Array.isArray(list) ? list[0] : undefined)
// Upstream fluxer_api/src/api/channel/services/thread/ThreadMappers.ts sends each listed membership with its thread ID
const linkMemberships = (page: Wire) =>
    page.threads?.length > 0
        ? {
              ...page,
              members: page.members.map((member: Wire, index: number) => ({
                  ...member,
                  id: page.threads[index % page.threads.length].id,
              })),
          }
        : page

const decoders: Record<string, Decoder> = {
    MessageResponseSchema: {
        route: (message) => `GET /channels/${message.channel_id}/messages/${message.id}`,
        run: (api, message) => api.client.messages.fetch({ channelId: message.channel_id, id: message.id }),
    },
    MessageListResponse: {
        route: (list) => `GET /channels/${first(list)?.channel_id ?? channelId}/messages`,
        run: (api, list) => api.client.messages.fetchHistory(first(list)?.channel_id ?? channelId),
    },
    ChannelResponse: {
        route: (channel) => `GET /channels/${channel.id}`,
        run: (api, channel) =>
            channel.type === 1 || channel.type === 3
                ? api.client.directMessages.fetch(channel.id)
                : api.client.channels.fetch(channel.id),
    },
    ThreadChannelResponse: {
        route: (thread) => `POST /channels/${thread.parent_id ?? channelId}/messages/${thread.id}/threads`,
        status: () => 201,
        run: (api, thread) =>
            api.client.threads.createFromMessage(
                { channelId: thread.parent_id ?? channelId, id: thread.id },
                { name: "Thread" },
            ),
    },
    // Thread creation reads the thread part. The post message is a MessageResponseSchema, decoded above
    StartForumThreadResponse: {
        route: (thread) => `POST /channels/${thread.parent_id ?? channelId}/threads`,
        status: () => 201,
        run: (api, thread) => api.client.threads.create(thread.parent_id ?? channelId, { name: "Thread" }),
    },
    GuildResponse: {
        route: (guild) => `GET /guilds/${guild.id}`,
        run: (api, guild) => api.client.guilds.fetch(guild.id),
    },
    GuildListResponse: {
        route: () => "GET /users/@me/guilds",
        run: (api) => api.client.guilds.fetchPage(),
    },
    GuildMemberResponse: {
        route: (member) => `GET /guilds/${guildId}/members/${member.user.id}`,
        run: (api, member) => api.client.members.fetch({ guildId, userId: member.user.id }),
    },
    GuildMemberListResponse: {
        route: () => `GET /guilds/${guildId}/members`,
        run: (api) => api.client.members.fetchPage(guildId),
    },
    GuildMemberSearchResponse: {
        route: (page) => `POST /guilds/${page.guild_id}/members-search`,
        // Upstream fluxer_api/src/api/guild/controllers/GuildMemberSearchController.ts counts the members it returns
        consistent: (page) => ({ ...page, page_result_count: page.members.length }),
        run: (api, page) => api.client.members.search(page.guild_id),
    },
    GuildBanListResponse: {
        route: () => `GET /guilds/${guildId}/bans`,
        run: (api) => api.client.members.fetchBans(guildId),
    },
    GuildRoleResponse: {
        route: (role) => `PATCH /guilds/${guildId}/roles/${role.id}`,
        run: (api, role) => api.client.roles.edit({ guildId, id: role.id }, { name: "Role" }),
    },
    GuildRoleListResponse: {
        route: () => `GET /guilds/${guildId}/roles`,
        run: (api) => api.client.roles.fetchAll(guildId),
    },
    UserPartialResponse: {
        route: (user) => `GET /users/${user.id}`,
        run: (api, user) => api.client.users.fetch(user.id),
    },
    UserPrivateResponse: {
        route: () => "GET /users/@me",
        run: (api) => api.client.users.fetchSelf(),
    },
    GuildEmojiResponse: {
        route: (emoji) => `PATCH /guilds/${guildId}/emojis/${emoji.id}`,
        run: (api, emoji) => api.client.emojis.edit({ guildId, id: emoji.id }, { name: "Emoji" }),
    },
    GuildEmojiWithUserListResponse: {
        route: () => `GET /guilds/${guildId}/emojis`,
        run: (api) => api.client.emojis.fetchAll(guildId),
    },
    GuildStickerResponse: {
        route: (sticker) => `PATCH /guilds/${guildId}/stickers/${sticker.id}`,
        run: (api, sticker) =>
            api.client.stickers.edit({ guildId, id: sticker.id }, { name: "Sticker", description: null, tags: [] }),
    },
    GuildStickerWithUserListResponse: {
        route: () => `GET /guilds/${guildId}/stickers`,
        run: (api) => api.client.stickers.fetchAll(guildId),
    },
    InviteResponseSchema: {
        route: (invite) => `GET /invites/${invite.code}`,
        run: (api, invite) => api.client.invites.fetch(invite.code),
    },
    InviteMetadataResponseSchema: {
        route: (invite) => `POST /channels/${invite.channel.id}/invites`,
        run: (api, invite) => api.client.invites.create(invite.channel.id),
    },
    InviteMetadataListResponse: {
        route: (list) => `GET /channels/${first(list)?.channel.id ?? channelId}/invites`,
        run: (api, list) => api.client.invites.fetchForChannel(first(list)?.channel.id ?? channelId),
    },
    WebhookResponse: {
        route: (webhook) => `GET /webhooks/${webhook.id}`,
        run: (api, webhook) => api.client.webhooks.fetch(webhook.id),
    },
    WebhookListResponse: {
        route: (list) => `GET /channels/${first(list)?.channel_id ?? channelId}/webhooks`,
        run: (api, list) => api.client.webhooks.fetchForChannel(first(list)?.channel_id ?? channelId),
    },
    GuildAuditLogListResponse: {
        route: (page) => `GET /guilds/${first(page.threads)?.guild_id ?? guildId}/audit-logs`,
        // Fluxer filters entries by the requested actor or action, so the request filters by what the entry holds
        run: (api, page) => {
            const entry = first(page.audit_log_entries)
            const filter =
                typeof entry?.user_id === "string"
                    ? { userId: entry.user_id }
                    : entry === undefined
                      ? { userId: "3" }
                      : { actionType: entry.action_type }
            return api.client.auditLogs.fetchPage(first(page.threads)?.guild_id ?? guildId, filter)
        },
    },
    MessageSearchResponse: {
        route: () => "POST /search/messages",
        // Upstream fluxer_api/src/api/search/MessageSearchResponseMapper.ts lists exactly the channels and threads of the
        // hits, with the bot's memberships of those threads, so each listed channel and thread gets a hit inside it
        consistent: (page) => {
            const [message] = page.messages ?? []
            if (message === undefined) return page
            const threads = page.threads?.map((thread: Wire) => ({ ...thread, id: "4" }))
            const members = page.members?.map((member: Wire) => ({ ...member, id: "4" }))
            const channels = [...page.channels, ...(threads ?? [])].map((channel: Wire) => channel.id)
            const messages = channels.map((id, index) => ({ ...message, id: String(index + 5), channel_id: id }))
            return { ...page, messages, threads, members }
        },
        run: (api) => api.client.messages.search({ guildId }),
    },
    ActiveThreadsResponse: {
        route: (page) => `GET /guilds/${first(page.threads)?.guild_id ?? guildId}/threads/active`,
        consistent: linkMemberships,
        run: (api, page) => api.client.threads.fetchActive(first(page.threads)?.guild_id ?? guildId),
    },
    ArchivedThreadsResponse: {
        route: (page) => `GET /channels/${first(page.threads)?.parent_id ?? channelId}/threads/archived/public`,
        consistent: linkMemberships,
        run: (api, page) => api.client.threads.fetchArchived(first(page.threads)?.parent_id ?? channelId),
    },
    ThreadSearchResult: {
        route: (page) => `GET /channels/${first(page.threads)?.parent_id ?? channelId}/threads/search`,
        // Upstream SearchIndexNotReadyError.ts in packages/errors sends the not-ready body with status 202
        status: (page) => (page.code === "SEARCH_INDEX_NOT_READY" ? 202 : 200),
        // Upstream fluxer_api/src/api/channel/services/thread/ThreadForumService.ts lists the first message of a post
        consistent: (result) => {
            const page = linkMemberships(result)
            return page.first_messages === undefined || !(page.threads?.length > 0)
                ? page
                : {
                      ...page,
                      first_messages: page.first_messages.map((message: Wire, index: number) => ({
                          ...message,
                          channel_id: page.threads[index % page.threads.length].id,
                      })),
                  }
        },
        run: (api, page) => api.client.threads.search(first(page.threads)?.parent_id ?? channelId),
    },
    ThreadMemberResponse: {
        route: (member) => `GET /channels/${member.id ?? "3"}/thread-members/${member.user_id ?? "4"}`,
        run: (api, member) => {
            const threadId = member.id ?? "3"
            // The nested guild member needs the thread's community, read from the thread first
            if (member.member !== undefined)
                api.rest.respond(`GET /channels/${threadId}`, { body: api.fixtures.thread({ id: threadId }) })
            return api.client.threads.fetchMember(threadId, member.user_id ?? "4", {
                withMember: member.member !== undefined,
            })
        },
    },
    ThreadMemberListResponse: {
        route: (list) => `GET /channels/${first(list)?.id ?? channelId}/thread-members`,
        run: (api, list) => {
            const withMember = first(list)?.member !== undefined
            const threadId = first(list)?.id ?? channelId
            if (withMember)
                api.rest.respond(`GET /channels/${threadId}`, { body: api.fixtures.thread({ id: threadId }) })
            return api.client.threads.fetchMembers(threadId, { withMember })
        },
    },
    ReactionUsersPageResponse: {
        route: () => `GET /channels/${channelId}/messages/3/reactions/:emoji/users`,
        // Upstream fluxer_api/src/api/channel/services/interaction/MessageReactionService.ts sets next_after to the last
        // user ID when has_more is set and to null otherwise
        consistent: (page) => ({ ...page, next_after: page.has_more ? (page.items.at(-1)?.id ?? null) : null }),
        run: (api) => api.client.messages.fetchReactionUsers({ channelId, id: "3" }, "👍"),
    },
    ApplicationsMeResponse: {
        route: () => "GET /oauth2/applications/@me",
        run: (api) => api.client.application.fetch(),
    },
    ChannelPinsResponse: {
        route: (page) => `GET /channels/${first(page.items)?.message.channel_id ?? channelId}/messages/pins`,
        run: (api, page) => api.client.messages.fetchPins(first(page.items)?.message.channel_id ?? channelId),
    },
}

/** Decode one example through its public operation, returning the failure or undefined when it decoded */
async function attempt(api: Api, decoder: Decoder, example: Wire): Promise<unknown> {
    const value = decoder.consistent?.(example) ?? example
    const route = api.rest.respond(decoder.route(value), { status: decoder.status?.(value) ?? 200, body: value })
    try {
        await settle(decoder.run(api, value))
        return undefined
    } catch (error) {
        return error ?? new Error("Rejected without an error value")
    } finally {
        route.remove()
    }
}

/** A short, value-free description of a failure for the assertion message */
function describe(error: unknown) {
    const { _tag, reason, status, code, message } = (error ?? {}) as Record<string, unknown>
    return _tag === undefined ? String(message) : [_tag, reason, status, code].filter(Boolean).join(" ")
}

test("the fixture is generated from the pinned document and the current server facts", () => {
    const manifest = JSON.parse(read("../../../release/upstream/manifest.json"))
    expect(fixture.source).toMatchObject({ commit: manifest.commit, sha256: manifest.files.openapi.sha256 })
    const facts = createHash("sha256").update(read("./fixtures/openapi-server-facts.json")).digest("hex")
    expect(fixture.factsSha256).toBe(facts)
    expect(Object.keys(fixture.schemas).sort()).toEqual(Object.keys(decoders).sort())
})

// Examples the SDK rejects on purpose. They must stay rejected, so a change that starts decoding one removes its entry
const rejectedByDesign: Readonly<Record<string, RegExp>> = {
    // A personal notes channel belongs to the account that owns it. The SDK models community channels, DMs and group
    // DMs, so channels.fetch rejects it like any other private channel
    ChannelResponse: /^type=999 /,
}

test.each(modes.flatMap((mode) => Object.keys(decoders).map((schema) => [mode, schema] as const)))(
    "%s decodes every %s example",
    async (mode, schema) => {
        const api = await open(mode)
        const unexpected: Record<string, string> = {}
        for (const { name, value } of fixture.schemas[schema]!) {
            const error = (await attempt(api, decoders[schema]!, value)) as { reason?: unknown } | undefined
            if (rejectedByDesign[schema]?.test(name) !== true) {
                if (error !== undefined) unexpected[name] = describe(error)
            } else if (error?.reason !== "response") unexpected[name] = "not rejected as designed"
        }
        expect(unexpected).toEqual({})
    },
)

test.each(modes)("%s rejects every probe that breaks a server fact", async (mode) => {
    const api = await open(mode)
    const accepted: string[] = []
    for (const probe of fixture.probes) {
        const error = (await attempt(api, decoders[probe.schema]!, probe.value)) as { reason?: unknown } | undefined
        // Only a rejected response proves the fact is needed, not a request the harness could not route
        if (error?.reason !== "response") accepted.push(`${probe.fact} (${probe.schema} ${probe.name})`)
    }
    expect(accepted).toEqual([])
})
