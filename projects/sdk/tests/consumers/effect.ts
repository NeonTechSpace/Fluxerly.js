import { Context, Effect, type Scope } from "effect"
import {
    createClient,
    canManageHierarchy,
    compareHierarchy,
    ChannelType,
    Permissions,
    type GuildChannel,
    type Client,
    type ConfigurationError,
    type MessageReference,
    type MessageOperationFailure,
    type Message,
    type MessageHistoryQuery,
    type MessageSearchContext,
    type MessageSearchPage,
    type MessageSearchQuery,
    type MessageSearchIterationLimits,
    type MessageDeletion,
    type MessageBulkDeletion,
    type TypingStart,
    type PresenceUpdate,
    type PresenceUpdateBulk,
    type CachePolicyErrorReport,
    type ClientOptions,
    type MessageCacheOptions,
    type MessageCacheSettings,
    type Collector,
    type CollectorOptions,
    type CollectorResult,
    type CollectorRegistrationError,
    type MemberReference,
    type RoleHierarchyInput,
} from "@neontechspace/fluxerly/effect"
const exampleEmbed = { title: "Build finished", fields: [{ name: "Status", value: "Passed", inline: true }] }

export const useChannels = (client: Client, guildId: string, channelId: string) =>
    Effect.gen(function* () {
        const retained: GuildChannel | undefined = yield* client.channels.get(channelId)
        const created = yield* client.channels.create(guildId, {
            type: ChannelType.Text,
            name: "help",
            permissionOverwrites: [],
        })
        yield* client.channels.fetchAll(guildId)
        yield* client.channels.fetch(created.id)
        yield* client.channels.edit(created.id, { topic: "Help desk" })
        yield* client.channels.reorder(guildId, [{ id: created.id, parentId: null }])
        yield* client.channels.setPermissionOverwrite(created.id, {
            id: guildId,
            type: "role",
            allow: 0n,
            deny: Permissions.ViewChannel,
        })
        yield* client.channels.removePermissionOverwrite(created.id, guildId)
        yield* client.channels.delete(created.id)
        // @ts-expect-error Permission masks must be bigint
        client.channels.setPermissionOverwrite(channelId, { id: guildId, type: "role", allow: "0", deny: 0n })
        // @ts-expect-error Received channels are immutable
        created.name = "changed"
        return retained
    })

export const useEmbeds = (client: Client, channelId: string) =>
    Effect.gen(function* () {
        const sent = yield* client.messages.send(channelId, { embeds: [exampleEmbed] })
        const title: string | undefined = sent.embeds[0]?.title
        void title
        yield* client.messages.reply(sent, { embeds: [exampleEmbed] })
        yield* client.messages.edit(sent, { embeds: [{ title: "Replacement" }] })
        yield* client.messages.edit(sent, { content: "Plain text", embeds: [] })
        // @ts-expect-error A message body must specify content or embeds
        client.messages.send(channelId, {})
        // @ts-expect-error A reply cannot supply a separate reference
        client.messages.reply(sent, { embeds: [exampleEmbed], messageReference: sent })
        // @ts-expect-error Received arrays are readonly
        sent.embeds.push({ type: "rich" })
        // @ts-expect-error Received-only metadata is not a send field
        client.messages.send(channelId, { embeds: [{ type: "rich" }] })
    })

export interface CacheReporter {
    readonly report: (report: CachePolicyErrorReport) => void
}

export const CacheReporter = Context.Service<CacheReporter>("packed-cache-reporter")

export const cacheSettings: MessageCacheSettings = {
    maxAgeMs: (message) => (message.author.isBot ? 0 : null),
}

export const cacheOptions: MessageCacheOptions<never, CacheReporter> = {
    maxEntries: 100,
    maxBytes: 1_048_576,
    maxAgeMs: (message) => (message.author.isBot ? 0 : null),
    onError: (report) =>
        Effect.gen(function* () {
            const reporter = yield* CacheReporter
            reporter.report(report)
        }),
}

/** The reporter's required service is part of client creation, while local cache reads remain lazy Effects */
export function createWithCacheReporter(
    token: string,
): Effect.Effect<Client, ConfigurationError, Scope.Scope | CacheReporter> {
    const options: ClientOptions<never, CacheReporter> = { token, cache: { messages: cacheOptions } }
    return createClient(options)
}

export function createWithinCallerScope(token: string): Effect.Effect<Client, ConfigurationError, Scope.Scope> {
    return createClient({ token, logging: { development: false } })
}

export function nativeLoggingOptions(token: string) {
    // @ts-expect-error Native minimum levels belong to the caller's Effect context
    createClient({ token, logging: { minimumLevel: "Info" } })
    return createClient({ token, logging: { development: true } })
}

export const handled = createClient({ token: "" }).pipe(
    Effect.catchTag("ConfigurationError", (error) => Effect.succeed(error.field)),
    Effect.scoped,
)

export function rejectedTypeShapes(): void {
    // @ts-expect-error Creation requires a caller-owned scope
    Effect.runSync(createClient({ token: "fixture-only-not-a-credential" }))
    // @ts-expect-error Only declared expected error tags can be handled here
    createClient({ token: "" }).pipe(Effect.catchTag("UnknownError", () => Effect.void))
    // @ts-expect-error Retention policies are synchronous
    createClient({ token: "fixture", cache: { messages: { maxAgeMs: async () => null } } })
    // @ts-expect-error Native reporters return Effects, not Promises
    createClient({ token: "fixture", cache: { messages: { onError: async () => {} } } })
    const options: ClientOptions<never, CacheReporter> = {
        token: "fixture",
        cache: {
            messages: {
                // @ts-expect-error Native cache reporters cannot request an unrelated service through this explicit options type
                onError: () => Effect.service(Context.Service<{ readonly other: true }>("other")),
            },
        },
    }
    void options
}

/** A native local cache read is a lazy Effect and retains the immutable Message snapshot type */
export function readCachedSnapshot(client: Client): Effect.Effect<Message | undefined, MessageOperationFailure> {
    const lookup = client.messages.get({ id: "10", channelId: "20" })
    return Effect.gen(function* () {
        const snapshot: Message | undefined = yield* lookup
        if (snapshot) {
            const content: string = snapshot.content
            void content
            // @ts-expect-error Cached snapshots are readonly
            snapshot.content = "replacement"
        }
        return snapshot
    })
}

export const managed = Effect.scoped(
    Effect.gen(function* () {
        const client = yield* createClient({ token: "fixture" })
        yield* client.run()
    }),
).pipe(Effect.catchTag("AuthenticationError", () => Effect.void))

/** Typechecked registration fragment inside the application's owning Effect scope */
export function registerReply(client: Client) {
    return client.on(
        "messageCreate",
        (message) =>
            Effect.gen(function* () {
                if (message.author.isBot || message.content !== "!ping") return
                yield* client.messages.reply(message, { content: "Pong!" })
            }),
        { concurrency: 4 },
    )
}

/** Typechecked typing calls and ephemeral gateway delivery through the packed native package. */
export function typingOperations(client: Client, channelId: string) {
    return Effect.gen(function* () {
        yield* client.messages.typing(channelId, { timeoutMs: 5_000 })
        const work = yield* client.messages.keepTyping(channelId, Effect.succeed("prepared"))
        yield* client.on("typingStart", (event) =>
            Effect.sync(() => {
                const typing: TypingStart = event
                void typing.timestamp
                // @ts-expect-error Typing notices are frozen observations
                event.channelId = "21"
            }),
        )
        return work
    })
}

export function rejectedMessageShapes(client: Client): void {
    const reactionTarget = { id: "10", channelId: "20" }
    // @ts-expect-error Named removal requires an explicit user ID
    client.messages.removeUserReaction(reactionTarget, "👍")
    // @ts-expect-error Clearing one emoji requires its selector
    client.messages.clearReaction(reactionTarget)
    // @ts-expect-error Clear-all takes operation options, never an emoji selector
    client.messages.clearReactions(reactionTarget, "👍")
    // @ts-expect-error Collector registration requires an owning scope
    Effect.runPromise(client.messages.collect("20"))
    // @ts-expect-error Native collector cancellation uses scope lifetime, not AbortSignal options
    client.messages.collect("20", { signal: new AbortController().signal })
    // @ts-expect-error Native filters also return synchronous booleans, not Effects
    client.messages.collect("20", { filter: () => Effect.succeed(true) })
    const page: readonly Message[] = []
    // @ts-expect-error History arrays cannot be mutated
    page.push(page[0]!)
    // @ts-expect-error History cursor modes are mutually exclusive
    client.messages.fetchHistory("20", { before: "10", around: "9" })
    // @ts-expect-error Native history cancellation uses interruption
    client.messages.fetchHistory("20", {}, { signal: new AbortController().signal })
    // @ts-expect-error Native registration retains its owning scope requirement
    Effect.runPromise(client.on("messageCreate", () => Effect.void))
    // @ts-expect-error Native send cancellation uses interruption, not AbortSignal options
    client.messages.send("20", { content: "hello" }, { signal: new AbortController().signal })
    // @ts-expect-error Native message management also uses interruption rather than AbortSignal options
    client.messages.fetch({ channelId: "20", id: "10" }, { signal: new AbortController().signal })
    // @ts-expect-error Native typing uses Effect interruption rather than AbortSignal options
    client.messages.typing("20", { signal: new AbortController().signal })
    // @ts-expect-error Native typing work is an Effect, not a Promise
    client.messages.keepTyping("20", Promise.resolve("prepared"))
    // @ts-expect-error Edit requires content
    client.messages.edit({ channelId: "20", id: "10" }, {})
}

export function collectReplies(client: Client) {
    const options: CollectorOptions = {
        maxMessages: 2,
        timeoutMs: 5_000,
        maxBytes: 1_024,
        maxPendingMessages: 10,
        maxPendingBytes: 2_048,
    }
    return Effect.gen(function* () {
        const collector: Collector = yield* client.messages.collect("20", options)
        yield* collector.stop()
        const result: CollectorResult = yield* collector.waitForClose()
        // @ts-expect-error Successful collector results are immutable
        result.messages.push(result.messages[0]!)
        return result.reason
    })
}

const MessageProgress = Context.Service<{ readonly accept: (message: Message) => void }>("packed-message-progress")

export function collectWithProgressService(client: Client) {
    const options: CollectorOptions<never, Context.Service.Identifier<typeof MessageProgress>> = {
        onMessage: (message) => Effect.map(MessageProgress, (service) => service.accept(message)),
    }
    const registration: Effect.Effect<
        Collector,
        CollectorRegistrationError,
        Scope.Scope | Context.Service.Identifier<typeof MessageProgress>
    > = client.messages.collect("20", options)
    // @ts-expect-error Providing the scope alone does not satisfy the callback's required service
    Effect.runPromise(Effect.scoped(registration))
    // @ts-expect-error Native progress callbacks return Effects, not Promises
    client.messages.collect("20", { onMessage: async () => {} })
    return registration.pipe(Effect.provideService(MessageProgress, { accept: () => {} }))
}

/** Typechecked explicit page navigation in the caller's Effect context */
export function readOlderMessages(client: Client): Effect.Effect<readonly Message[], MessageOperationFailure> {
    return Effect.gen(function* () {
        const query: MessageHistoryQuery = { limit: 50 }
        const page = yield* client.messages.fetchHistory("20", query, { timeoutMs: 5_000 })
        const oldest = page.at(-1)
        return oldest ? yield* client.messages.fetchHistory("20", { before: oldest.id }) : page
    })
}

/** Packed-declaration usage for explicit indexed search; indexing stays caller-visible and streams own their bounded cursor progress */
export function searchIndexedMessages(
    client: Client,
    context: MessageSearchContext,
): Effect.Effect<MessageSearchPage, MessageOperationFailure> {
    const filters: Omit<MessageSearchQuery, "limit" | "page" | "cursor"> = { content: "todo" }
    const limits: MessageSearchIterationLimits = { maxItems: 100, pageSize: 25 }
    const stream = client.messages.iterateSearch(context, filters, limits)
    void stream
    // @ts-expect-error Search context requires a decimal guild or channel ID
    client.messages.search({})
    // @ts-expect-error Native message search options do not accept AbortSignal
    client.messages.search(context, {}, { signal: new AbortController().signal })
    return client.messages.search(context, { content: "todo", has: ["link"] })
}

/** Typechecked message-management fragment in the application's Effect context */
export function manageMessage(client: Client, target: MessageReference): Effect.Effect<void, MessageOperationFailure> {
    return Effect.gen(function* () {
        const message = yield* client.messages.fetch(target, { timeoutMs: 5_000 })
        const edited = yield* client.messages.edit(message, { content: "Updated" })
        yield* client.messages.delete(edited)
    })
}

/** Typechecked event registration in the caller's scope, including existing explicit generic arguments */
export function watchMessageChanges(client: Client) {
    return Effect.gen(function* () {
        yield* client.on<never, never>("messageCreate", (message) =>
            Effect.sync(() => {
                const current: Message = message
                void current
            }),
        )
        yield* client.on("messageUpdate", (message) =>
            Effect.sync(() => {
                const current: Message = message
                void current
            }),
        )
        yield* client.on("messageDelete", (message) =>
            Effect.sync(() => {
                const deletion: MessageDeletion = message
                const content: string | null | undefined = deletion.content
                void content
                // @ts-expect-error Missing authors are not fabricated
                message.author.username
            }),
        )
        yield* client.on("messageDeleteBulk", (batch) =>
            Effect.sync(() => {
                const deletion: MessageBulkDeletion = batch
                void deletion.ids
                // @ts-expect-error Bulk IDs cannot be mutated
                batch.ids.push("10")
            }),
        )
    })
}
export function moderationOperations(client: Client, target: import("@neontechspace/fluxerly/effect").MemberReference) {
    const ban: import("@neontechspace/fluxerly/effect").BanInput = { durationSeconds: 60, reason: "Spam" }
    const options: import("@neontechspace/fluxerly/effect").ModerationOptions = { auditReason: "Spam" }
    return Effect.gen(function* () {
        const cleared = yield* client.members.clearTimeout(target, options)
        const expiry: string | null | undefined = cleared.communicationDisabledUntil
        yield* client.members.kick(target, options)
        yield* client.guilds.ban(target, ban, options)
        yield* client.guilds.unban(target, options)
        const list: readonly import("@neontechspace/fluxerly/effect").GuildBan[] = yield* client.guilds.fetchBans(
            target.guildId,
        )
        yield* client.on("guildBanAdd", (notice) =>
            Effect.sync(() => {
                const id: string = notice.userId
                void id
            }),
        )
        // @ts-expect-error A string cannot be passed as a numeric timeout duration
        client.members.timeout(target, "60")
        return { expiry, list }
    })
}

export function useAttachments(client: Client, channelId: string) {
    return Effect.gen(function* () {
        const file = { data: new Uint8Array([1, 2]), filename: "fixture.bin" }
        const sent = yield* client.messages.send(channelId, { attachments: [file] })
        const attachment = sent.attachments[0]!
        yield* client.messages.reply(sent, { attachments: [file] })
        yield* client.messages.edit(sent, { attachments: [{ id: attachment.id }, file] })
        yield* client.messages.edit(sent, { content: "Cleared", attachments: [] })
        // @ts-expect-error References are edit-only
        client.messages.send(channelId, { attachments: [{ id: attachment.id }] })
        // @ts-expect-error Received arrays are immutable
        sent.attachments.push(attachment)
        return attachment.url
    })
}
/** Typechecked targeted nickname and local hierarchy usage against the packed Effect entry point */
export function manageMemberHierarchy(client: Client, target: MemberReference, snapshot: RoleHierarchyInput) {
    return Effect.gen(function* () {
        const renamed = yield* client.members.setNickname(target, null)
        const canTarget = yield* canManageHierarchy(snapshot)
        const first = snapshot.roles[0]
        const order = first ? yield* compareHierarchy(first, first) : undefined
        // @ts-expect-error Nicknames use explicit null to clear, not an omitted argument
        client.members.setNickname(target)
        return { renamed, canTarget, order }
    })
}

/** Typechecked delivery-only presence subscription through the packed Effect entry point */
export function watchPresence(client: Client) {
    return client.on("presenceUpdate", (presence) =>
        Effect.sync(() => {
            const update: PresenceUpdate = presence
            const status: string = update.status
            const guildId: string | undefined = update.guildId
            void status
            void guildId
            // @ts-expect-error Presence observations are immutable
            update.afk = true
        }),
    )
}

/** Typechecked recovery presence batch through the packed Effect entry point */
export function watchPresenceRecovery(client: Client) {
    return client.on("presenceUpdateBulk", (batch) =>
        Effect.sync(() => {
            const update: PresenceUpdateBulk = batch
            const first: PresenceUpdate | undefined = update.presences[0]
            void first
            // @ts-expect-error Recovery observations and their batch are immutable
            update.presences.push(batch.presences[0]!)
        }),
    )
}

/** Typechecked explicit selected-member presence intent through the packed Effect entry point */
export function selectMemberPresence(client: Client, guildId: string, memberId: string) {
    return client.presence.setMembers(guildId, [memberId])
}
