import { Effect, Exit, Scope, Stream } from "effect"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { createWebhookClient, oauth, type Attachment } from "../../src/index.js"
import { createWebhookClient as createNativeWebhook, oauth as nativeOAuth } from "../../src/effect.js"
import { modes, setup, type Mode } from "../support/both-apis.js"
import { hostedOperationCalls, stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"

// Every public operation that takes an options, input or query object rejects a misspelled key before sending,
// names the key and suggests the supported key it resembles, in both API styles

afterEach(() => {
    vi.unstubAllGlobals()
})

// Loosely typed on purpose: Each case passes a misspelled key that the public types reject
type Loose = any
type Target = "client" | "webhook" | "oauth"

interface Case {
    readonly name: string
    readonly target: Target
    readonly call: (api: Loose, mode: Mode) => unknown
    /** The inputValidation path that names the containing object */
    readonly path: string
    readonly key: string
    readonly suggestion: string
    /** Limit a case to the API style whose public member takes that argument */
    readonly only?: Mode
}

const guildId = "20"
const channelId = "21"
const userId = "30"
const message = { id: "10", channelId }
const member = { guildId, userId }
const role = { guildId, id: "40" }
const expression = { guildId, id: "50" }
const attachment = {
    id: "60",
    filename: "fixture.txt",
    size: 4,
    url: "https://fluxerusercontent.com/attachments/21/60/fixture.txt",
} as unknown as Attachment
const image = "iVBORw0KGgo="
const exchange = { code: "fixture-code", redirectUri: "https://example.com/callback", codeVerifier: "a".repeat(43) }

/** A misspelled timeoutMs in the options argument */
const option = (
    name: string,
    call: (api: Loose, options: object, mode: Mode) => unknown,
    target: Target = "client",
): Case => ({
    name: `${name} options`,
    target,
    call: (api, mode) => call(api, { timeotMs: 1_000 }, mode),
    path: "options",
    key: "timeotMs",
    suggestion: "timeoutMs",
})

/** A misspelled key in an input or query argument */
const input = (
    name: string,
    path: string,
    key: string,
    suggestion: string,
    call: (api: Loose, mode: Mode) => unknown,
    target: Target = "client",
): Case => ({ name: `${name} ${path}`, target, call, path, key, suggestion })

const cases: readonly Case[] = [
    option("application.fetch", (api, o) => api.application.fetch(o)),
    option("users.fetch", (api, o) => api.users.fetch(userId, o)),
    option("users.fetchSelf", (api, o) => api.users.fetchSelf(o)),
    option("users.fetchProfile", (api, o) => api.users.fetchProfile(userId, undefined, o)),
    input("users.fetchProfile", "query", "guildI", "guildId", (api) =>
        api.users.fetchProfile(userId, { guildI: guildId }),
    ),
    option("directMessages.send", (api, o) => api.directMessages.send(userId, "x", o)),
    input("directMessages.send", "input", "contnet", "content", (api) =>
        api.directMessages.send(userId, { contnet: "x" }),
    ),
    option("directMessages.open", (api, o) => api.directMessages.open(userId, o)),
    option("directMessages.fetch", (api, o) => api.directMessages.fetch(channelId, o)),
    option("directMessages.fetchAll", (api, o) => api.directMessages.fetchAll(o)),
    option("directMessages.fetchLatestMessages", (api, o) => api.directMessages.fetchLatestMessages([channelId], o)),
    option("directMessages.editGroup", (api, o) => api.directMessages.editGroup(channelId, { name: "x" }, o)),
    input("directMessages.editGroup", "input", "nme", "name", (api) =>
        api.directMessages.editGroup(channelId, { nme: "x" }),
    ),
    option("directMessages.close", (api, o) => api.directMessages.close(channelId, o)),
    option("directMessages.removeRecipient", (api, o) => api.directMessages.removeRecipient(channelId, userId, o)),
    option("webhooks.create", (api, o) => api.webhooks.create(channelId, { name: "x" }, o)),
    input("webhooks.create", "input", "nme", "name", (api) => api.webhooks.create(channelId, { name: "x", nme: "x" })),
    option("webhooks.fetch", (api, o) => api.webhooks.fetch("70", o)),
    option("webhooks.fetchForChannel", (api, o) => api.webhooks.fetchForChannel(channelId, o)),
    option("webhooks.fetchForGuild", (api, o) => api.webhooks.fetchForGuild(guildId, o)),
    option("webhooks.edit", (api, o) => api.webhooks.edit("70", { name: "x" }, o)),
    input("webhooks.edit", "input", "nme", "name", (api) => api.webhooks.edit("70", { nme: "x" })),
    option("webhooks.delete", (api, o) => api.webhooks.delete("70", o)),
    ...(["emojis", "stickers"] as const).flatMap((kind) => {
        // A sticker edit replaces every sticker field, so it needs them all
        const edited = kind === "stickers" ? { name: "fixture", description: "fixture", tags: ["fixture"] } : {}
        return [
            option(`${kind}.fetchAll`, (api, o) => api[kind].fetchAll(guildId, o)),
            option(`${kind}.fetchMetadata`, (api, o) => api[kind].fetchMetadata("50", o)),
            option(`${kind}.fetchSource`, (api, o) => api[kind].fetchSource("50", o)),
            option(`${kind}.create`, (api, o) => api[kind].create(guildId, { name: "fixture", image }, o)),
            input(`${kind}.create`, "input", "nme", "name", (api) => api[kind].create(guildId, { nme: "x", image })),
            option(`${kind}.createMany`, (api, o) => api[kind].createMany(guildId, [{ name: "fixture", image }], o)),
            input(`${kind}.createMany`, "inputs[]", "nme", "name", (api) =>
                api[kind].createMany(guildId, [{ nme: "x", image }]),
            ),
            option(`${kind}.clone`, (api, o) => api[kind].clone(guildId, "50", o)),
            option(`${kind}.edit`, (api, o) => api[kind].edit(expression, { ...edited, name: "fixture" }, o)),
            input(`${kind}.edit`, "input", "nme", "name", (api) => api[kind].edit(expression, { ...edited, nme: "x" })),
            option(`${kind}.delete`, (api, o) => api[kind].delete(expression, o)),
        ]
    }),
    option("auditLogs.fetchPage", (api, o) => api.auditLogs.fetchPage(guildId, { userId }, o)),
    input("auditLogs.fetchPage", "query", "limt", "limit", (api) =>
        api.auditLogs.fetchPage(guildId, { userId, limt: 5 }),
    ),
    option("auditLogs.iterate", (api, o) => api.auditLogs.iterate(guildId, { userId, maxItems: 5 }, o)),
    input("auditLogs.iterate", "query", "befor", "before", (api) =>
        api.auditLogs.iterate(guildId, { userId, maxItems: 5, befor: "1" }),
    ),
    option("invites.fetch", (api, o) => api.invites.fetch("fixture", o)),
    option("invites.create", (api, o) => api.invites.create(channelId, {}, o)),
    input("invites.create", "input", "maxUse", "maxUses", (api) => api.invites.create(channelId, { maxUse: 1 })),
    option("invites.fetchForChannel", (api, o) => api.invites.fetchForChannel(channelId, o)),
    option("invites.fetchForGuild", (api, o) => api.invites.fetchForGuild(guildId, o)),
    option("invites.delete", (api, o) => api.invites.delete("fixture", o)),
    option("discovery.search", (api, o) => api.discovery.search({}, o)),
    input("discovery.search", "query", "qury", "query", (api) => api.discovery.search({ qury: "x" })),
    option("discovery.fetchStatus", (api, o) => api.discovery.fetchStatus(guildId, o)),
    option("discovery.fetchCategories", (api, o) => api.discovery.fetchCategories(o)),
    option("discovery.apply", (api, o) =>
        api.discovery.apply(guildId, { description: "A fixture community", categoryId: 1 }, o),
    ),
    input("discovery.apply", "input", "categoryI", "categoryId", (api) =>
        api.discovery.apply(guildId, { description: "A fixture community", categoryId: 1, categoryI: 1 }),
    ),
    option("discovery.edit", (api, o) => api.discovery.edit(guildId, { description: "A fixture community" }, o)),
    input("discovery.edit", "input", "descripton", "description", (api) =>
        api.discovery.edit(guildId, { descripton: "x" }),
    ),
    option("discovery.withdraw", (api, o) => api.discovery.withdraw(guildId, o)),
    option("guilds.fetchCounts", (api, o) => api.guilds.fetchCounts([guildId], o)),
    option("guilds.fetchPage", (api, o) => api.guilds.fetchPage({}, o)),
    input("guilds.fetchPage", "query", "limt", "limit", (api) => api.guilds.fetchPage({ limt: 5 })),
    option("guilds.iterate", (api, o) => api.guilds.iterate({ maxItems: 5 }, o)),
    input("guilds.iterate", "query", "aftr", "after", (api) => api.guilds.iterate({ maxItems: 5, aftr: "1" })),
    option("guilds.leave", (api, o) => api.guilds.leave(guildId, o)),
    input("guilds.deleteOwnMessages", "options", "timeotMs", "timeoutMs", (api) =>
        api.guilds.deleteOwnMessages(guildId, { confirm: true, timeotMs: 1 }),
    ),
    option("guilds.fetchVanityUrl", (api, o) => api.guilds.fetchVanityUrl(guildId, o)),
    option("guilds.editVanityUrl", (api, o) => api.guilds.editVanityUrl(guildId, null, o)),
    option("guilds.edit", (api, o) => api.guilds.edit(guildId, { name: "fixture" }, o)),
    input("guilds.edit", "input", "nme", "name", (api) => api.guilds.edit(guildId, { nme: "x" })),
    option("guilds.fetch", (api, o) => api.guilds.fetch(guildId, o)),
    option("channels.fetchMemberCounts", (api, o) => api.channels.fetchMemberCounts(guildId, [channelId], o)),
    option("channels.fetch", (api, o) => api.channels.fetch(channelId, o)),
    option("channels.fetchAll", (api, o) => api.channels.fetchAll(guildId, o)),
    option("channels.create", (api, o) => api.channels.create(guildId, { type: 0, name: "fixture" }, o)),
    input("channels.create", "input", "topik", "topic", (api) =>
        api.channels.create(guildId, { type: 0, name: "fixture", topik: "x" }),
    ),
    option("channels.edit", (api, o) => api.channels.edit(channelId, { name: "fixture" }, o)),
    input("channels.edit", "input", "nme", "name", (api) => api.channels.edit(channelId, { nme: "x" })),
    option("channels.delete", (api, o) => api.channels.delete(channelId, o)),
    option("channels.reorder", (api, o) => api.channels.reorder(guildId, [{ id: channelId, position: 1 }], o)),
    input("channels.reorder", "positions[]", "positon", "position", (api) =>
        api.channels.reorder(guildId, [{ id: channelId, positon: 1 }]),
    ),
    option("channels.setPermissionOverwrite", (api, o) =>
        api.channels.setPermissionOverwrite(channelId, { id: userId, type: "member", allow: 0n, deny: 0n }, o),
    ),
    input("channels.setPermissionOverwrite", "permissionOverwrite", "allw", "allow", (api) =>
        api.channels.setPermissionOverwrite(channelId, { id: userId, type: "member", allw: 0n, deny: 0n }),
    ),
    option("channels.removePermissionOverwrite", (api, o) =>
        api.channels.removePermissionOverwrite(channelId, userId, o),
    ),
    option("members.setRoles", (api, o) => api.members.setRoles(member, ["40"], o)),
    option("members.search", (api, o) => api.members.search(guildId, {}, o)),
    input("members.search", "query", "qury", "query", (api) => api.members.search(guildId, { qury: "x" })),
    option("members.iterateSearch", (api, o) => api.members.iterateSearch(guildId, {}, { maxItems: 5 }, o)),
    input("members.iterateSearch", "limits", "pageSze", "pageSize", (api) =>
        api.members.iterateSearch(guildId, {}, { maxItems: 5, pageSze: 5 }),
    ),
    option("members.editSelf", (api, o) => api.members.editSelf(guildId, { nickname: "x" }, o)),
    input("members.editSelf", "input", "nicknam", "nickname", (api) => api.members.editSelf(guildId, { nicknam: "x" })),
    option("members.setNickname", (api, o) => api.members.setNickname(member, "x", o)),
    option("members.move", (api, o) => api.members.move(member, channelId, o)),
    option("members.disconnect", (api, o) => api.members.disconnect(member, o)),
    option("members.setMute", (api, o) => api.members.setMute(member, { muted: true }, o)),
    input("members.setMute", "input", "mutd", "muted", (api) => api.members.setMute(member, { mutd: true })),
    option("members.setDeaf", (api, o) => api.members.setDeaf(member, { deafened: true }, o)),
    option("members.timeout", (api, o) => api.members.timeout(member, 60_000, o)),
    option("members.clearTimeout", (api, o) => api.members.clearTimeout(member, o)),
    option("members.kick", (api, o) => api.members.kick(member, o)),
    option("members.ban", (api, o) => api.members.ban(member, {}, o)),
    input("members.ban", "input", "deleteMessageMs", "deleteMessagesMs", (api) =>
        api.members.ban(member, { deleteMessageMs: 0 }),
    ),
    option("members.unban", (api, o) => api.members.unban(member, o)),
    option("members.fetchBans", (api, o) => api.members.fetchBans(guildId, o)),
    option("members.iterate", (api, o) => api.members.iterate(guildId, { maxItems: 5 }, o)),
    input("members.iterate", "query", "aftr", "after", (api) =>
        api.members.iterate(guildId, { maxItems: 5, aftr: "1" }),
    ),
    option("members.fetch", (api, o) => api.members.fetch(member, o)),
    option("members.fetchSelf", (api, o) => api.members.fetchSelf(guildId, o)),
    option("members.fetchCanManage", (api, o) => api.members.fetchCanManage(member, o)),
    option("members.fetchPage", (api, o) => api.members.fetchPage(guildId, {}, o)),
    input("members.fetchPage", "query", "limt", "limit", (api) => api.members.fetchPage(guildId, { limt: 5 })),
    option("members.addRole", (api, o) => api.members.addRole(member, "40", o)),
    option("members.removeRole", (api, o) => api.members.removeRole(member, "40", o)),
    option("permissions.fetch", (api, o) => api.permissions.fetch(member, o)),
    option("roles.setHoistPositions", (api, o) =>
        api.roles.setHoistPositions(guildId, [{ id: "40", hoistPosition: 1 }], o),
    ),
    input("roles.setHoistPositions", "positions[]", "hoistPositon", "hoistPosition", (api) =>
        api.roles.setHoistPositions(guildId, [{ id: "40", hoistPositon: 1 }]),
    ),
    option("roles.resetHoistPositions", (api, o) => api.roles.resetHoistPositions(guildId, o)),
    option("roles.fetchAll", (api, o) => api.roles.fetchAll(guildId, o)),
    option("roles.create", (api, o) => api.roles.create(guildId, { name: "fixture" }, o)),
    input("roles.create", "input", "nme", "name", (api) => api.roles.create(guildId, { name: "x", nme: "x" })),
    option("roles.edit", (api, o) => api.roles.edit(role, { name: "fixture" }, o)),
    input("roles.edit", "input", "nme", "name", (api) => api.roles.edit(role, { nme: "x" })),
    option("roles.delete", (api, o) => api.roles.delete(role, o)),
    option("roles.reorder", (api, o) => api.roles.reorder(guildId, [{ id: "40", position: 1 }], o)),
    input("roles.reorder", "positions[]", "positon", "position", (api) =>
        api.roles.reorder(guildId, [{ id: "40", positon: 1 }]),
    ),
    option("attachments.refreshUrls", (api, o) => api.attachments.refreshUrls([attachment.url], o)),
    input("attachments.download", "options", "maxByte", "maxBytes", (api) =>
        api.attachments.download(attachment, { maxBytes: 10, maxByte: 10 }),
    ),
    input("attachments.stream", "options", "maxByte", "maxBytes", (api) =>
        api.attachments.stream(attachment, { maxBytes: 10, maxByte: 10 }),
    ),
    option("messages.iterateHistory", (api, o) => api.messages.iterateHistory(channelId, { maxItems: 5 }, o)),
    input("messages.iterateHistory", "query", "befor", "before", (api) =>
        api.messages.iterateHistory(channelId, { maxItems: 5, befor: "1" }),
    ),
    option("messages.search", (api, o) => api.messages.search({ channelId }, {}, o)),
    input("messages.search", "query", "contnet", "content", (api) =>
        api.messages.search({ channelId }, { contnet: "x" }),
    ),
    option("messages.iterateSearch", (api, o) => api.messages.iterateSearch({ channelId }, {}, { maxItems: 5 }, o)),
    input("messages.iterateSearch", "limits", "pageSze", "pageSize", (api) =>
        api.messages.iterateSearch({ channelId }, {}, { maxItems: 5, pageSze: 5 }),
    ),
    option("messages.iterateReactionUsers", (api, o) =>
        api.messages.iterateReactionUsers(message, "👍", { maxItems: 5 }, o),
    ),
    input("messages.iterateReactionUsers", "query", "aftr", "after", (api) =>
        api.messages.iterateReactionUsers(message, "👍", { maxItems: 5, aftr: "1" }),
    ),
    option("messages.iteratePins", (api, o) => api.messages.iteratePins(channelId, { maxItems: 5 }, o)),
    input("messages.iteratePins", "query", "befor", "before", (api) =>
        api.messages.iteratePins(channelId, { maxItems: 5, befor: "1" }),
    ),
    option("messages.removeUserReaction", (api, o) => api.messages.removeUserReaction(message, "👍", userId, o)),
    option("messages.clearReaction", (api, o) => api.messages.clearReaction(message, "👍", o)),
    option("messages.clearReactions", (api, o) => api.messages.clearReactions(message, o)),
    option("messages.pin", (api, o) => api.messages.pin(message, o)),
    option("messages.unpin", (api, o) => api.messages.unpin(message, o)),
    option("messages.fetchPins", (api, o) => api.messages.fetchPins(channelId, {}, o)),
    input("messages.fetchPins", "query", "limt", "limit", (api) => api.messages.fetchPins(channelId, { limt: 5 })),
    option("messages.fetchReactionUsers", (api, o) => api.messages.fetchReactionUsers(message, "👍", {}, o)),
    input("messages.fetchReactionUsers", "query", "limt", "limit", (api) =>
        api.messages.fetchReactionUsers(message, "👍", { limt: 5 }),
    ),
    option("messages.addReaction", (api, o) => api.messages.addReaction(message, "👍", o)),
    option("messages.removeReaction", (api, o) => api.messages.removeReaction(message, "👍", o)),
    option("messages.send", (api, o) => api.messages.send(channelId, "x", o)),
    input("messages.send", "input", "contnet", "content", (api) => api.messages.send(channelId, { contnet: "x" })),
    option("messages.forward", (api, o) => api.messages.forward(channelId, { source: message }, o)),
    input("messages.forward", "input", "sorce", "source", (api) =>
        api.messages.forward(channelId, { source: message, sorce: message }),
    ),
    option("messages.typing", (api, o) => api.messages.typing(channelId, o)),
    option("messages.keepTyping", (api, o, mode) =>
        api.messages.keepTyping(channelId, mode === "default" ? async () => undefined : Effect.void, o),
    ),
    option("messages.reply", (api, o) => api.messages.reply(message, "x", o)),
    input("messages.reply", "input", "contnet", "content", (api) => api.messages.reply(message, { contnet: "x" })),
    option("messages.fetch", (api, o) => api.messages.fetch(message, o)),
    option("messages.fetchHistory", (api, o) => api.messages.fetchHistory(channelId, {}, o)),
    input("messages.fetchHistory", "query", "limt", "limit", (api) =>
        api.messages.fetchHistory(channelId, { limt: 5 }),
    ),
    option("messages.previewCleanup", (api, o) =>
        api.messages.previewCleanup(channelId, { authorId: userId, maxScanned: 10, maxSelected: 1 }, o),
    ),
    input("messages.previewCleanup", "selection", "authrId", "authorId", (api) =>
        api.messages.previewCleanup(channelId, { authrId: userId, maxScanned: 10, maxSelected: 1 }),
    ),
    option("messages.edit", (api, o) => api.messages.edit(message, "x", o)),
    input("messages.edit", "input", "contnet", "content", (api) => api.messages.edit(message, { contnet: "x" })),
    option("messages.delete", (api, o) => api.messages.delete(message, o)),
    option("messages.deleteAttachment", (api, o) => api.messages.deleteAttachment(message, "60", o)),
    option("messages.deleteMany", (api, o) => api.messages.deleteMany(channelId, ["10", "11"], o)),
    input("messages.deleteOwnMessages", "options", "timeotMs", "timeoutMs", (api) =>
        api.messages.deleteOwnMessages(channelId, { confirm: true, timeotMs: 1 }),
    ),
    input("presence.set", "input", "statu", "status", (api) => api.presence.set({ status: "online", statu: "idle" })),
    {
        ...input("gateway.send", "options", "signl", "signal", (api) =>
            api.gateway.send(0, 3, null, { signl: undefined }),
        ),
        only: "default",
    },
    input("members.iterateChunks", "query", "presence", "presences", (api) =>
        api.members.iterateChunks(guildId, { all: true, presence: true }),
    ),
    input("members.iterateChunks", "options", "timeotMs", "timeoutMs", (api) =>
        api.members.iterateChunks(guildId, { all: true }, { timeotMs: 1 }),
    ),
    input("cache.entries", "options", "limt", "limit", (api) => api.cache.entries("guilds", { limt: 5 })),
    input("cache.onChange", "options", "concurency", "concurrency", (api, mode) =>
        mode === "native"
            ? Effect.scoped(api.cache.onChange(() => Effect.void, { concurency: 1 }))
            : api.cache.onChange(() => undefined, { concurency: 1 }),
    ),
    input("rest.request", "input", "queri", "query", (api) =>
        api.rest.request({ method: "GET", path: "/users/@me", queri: {} }),
    ),
    option("instance.resolve", (api, o) => api.instance.resolve(o)),
    option("webhook fetch", (api, o) => api.fetch(o), "webhook"),
    option("webhook send", (api, o) => api.send("x", o), "webhook"),
    option("webhook deleteMessage", (api, o) => api.deleteMessage("10", o), "webhook"),
    input("webhook send", "input", "contnet", "content", (api) => api.send({ contnet: "x" }), "webhook"),
    input("webhook edit", "input", "nme", "name", (api) => api.edit({ nme: "x" }), "webhook"),
    input(
        "webhook editMessage",
        "input",
        "contnet",
        "content",
        (api) => api.editMessage("10", { contnet: "x" }),
        "webhook",
    ),
    option("OAuth exchangeCode", (api, o) => api.exchangeCode(exchange, o), "oauth"),
    option("OAuth fetchIdentity", (api, o) => api.fetchIdentity("fixture-token", o), "oauth"),
    input(
        "OAuth authorizationUrl",
        "input",
        "scope",
        "scopes",
        (api) =>
            api.authorizationUrl({
                redirectUri: "https://example.com/callback",
                scope: ["identify"],
                state: "fixture-state",
                codeChallenge: "a".repeat(43),
            }),
        "oauth",
    ),
    input(
        "OAuth exchangeCode",
        "input",
        "codeVerifer",
        "codeVerifier",
        (api) => api.exchangeCode({ ...exchange, codeVerifer: "x" }),
        "oauth",
    ),
    input(
        "OAuth revoke",
        "input",
        "tokenTypeHnt",
        "tokenTypeHint",
        (api) => api.revoke({ token: "fixture-token", tokenTypeHnt: "access_token" }),
        "oauth",
    ),
    input(
        "OAuth fetchGuilds",
        "query",
        "limt",
        "limit",
        (api) => api.fetchGuilds("fixture-token", { limt: 5 }),
        "oauth",
    ),
]

async function api(mode: Mode, target: Target): Promise<Loose> {
    if (target === "client") return setup(mode)
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const options = { id: "70", token: "fixture-webhook-token" }
    const config = { clientId: "1", clientSecret: "fixture-client-secret" }
    if (mode === "native")
        return target === "webhook"
            ? Effect.runPromise(createNativeWebhook(options).pipe(Scope.provide(scope)))
            : Effect.runPromise(nativeOAuth.create(config).pipe(Scope.provide(scope)))
    const client = target === "webhook" ? createWebhookClient(options) : oauth.create(config)
    onTestFinished(async () => void (await client.shutdown()))
    return client
}

/** The failure of any operation shape: A thrown error, Result, ResultAsync, iterator of Results, Effect or Stream */
async function failure(call: () => unknown): Promise<unknown> {
    let result: unknown
    try {
        result = call()
    } catch (error) {
        return error
    }
    if (Stream.isStream(result))
        return Effect.runPromise(Effect.flip(Stream.runCollect(result as Stream.Stream<unknown, unknown>)))
    if (Effect.isEffect(result)) {
        // Misuse, such as invalid cache lookup options, is a defect in the Effect API
        const exit = await Effect.runPromiseExit(result as Effect.Effect<unknown, unknown>)
        if (Exit.isSuccess(exit)) return expect.fail("Expected the Effect to fail")
        const reason = exit.cause.reasons[0]
        return reason?._tag === "Fail" ? reason.error : reason?._tag === "Die" ? reason.defect : undefined
    }
    if (typeof result === "object" && result !== null && Symbol.asyncIterator in result) {
        for await (const item of result as AsyncIterable<Loose>) if (item.isErr()) return item.error
        return expect.fail("Expected the iterator to yield an error")
    }
    const settled: Loose = await result
    if (!settled.isErr()) return expect.fail("Expected an error result")
    return settled.error
}

describe.each(modes)("%s unsupported operation keys", (mode) => {
    const applicable = cases.filter((item) => item.only === undefined || item.only === mode)
    test.each(applicable.map((item) => [item.name, item] as const))("%s", async (_name, item) => {
        const fetch = stubFetchWithHostedDiscovery(async () => new Response(null, { status: 500 }))
        const client = await api(mode, item.target)
        const error: Loose = await failure(() => item.call(client, mode))
        // Operation input failures describe the object in inputValidation, and option misuse is a ConfigurationError
        if (error._tag !== "ConfigurationError")
            expect(error.inputValidation).toMatchObject({ path: item.path, constraint: "allowedFields" })
        const text = `${error.message} ${error.hint ?? ""}`
        expect(text).toContain(`"${item.key}"`)
        expect(text).toContain(`Did you mean "${item.suggestion}"?`)
        expect(hostedOperationCalls(fetch)).toEqual([])
    })
})
