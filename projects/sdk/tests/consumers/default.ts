import {
    createClient,
    canManageHierarchy,
    compareHierarchy,
    ChannelType,
    Permissions,
    MessageFlags,
    type ForwardMessageInput,
    type MessageSnapshot,
    type UserProfile,
    type GuildChannel,
    type Client,
    type ConnectionState,
    type Message,
    type MessageHistoryQuery,
    type MessageSearchContext,
    type MessageSearchPage,
    type MessageSearchQuery,
    type MessageSearchIterationLimits,
    type MessageReference,
    type MessageOperationFailure,
    type MessageDeletion,
    type MessageBulkDeletion,
    type TypingStart,
    type PresenceUpdate,
    type PresenceUpdateBulk,
    type CachePolicyErrorReport,
    type MessageCacheOptions,
    type MessageCacheSettings,
    type Collector,
    type CollectorOptions,
    type DefaultCollectorOptions,
    type CollectorResult,
    type MemberReference,
    type RoleHierarchyInput,
} from "@neontechspace/fluxerly"
const exampleEmbed = { title: "Build finished", fields: [{ name: "Status", value: "Passed", inline: true }] }

export async function useConsumerFeatures(client: Client, channelId: string, source: MessageReference, userId: string) {
    const input: ForwardMessageInput = { source, attachmentIds: [], embedIndices: [0] }
    const forwarded = await client.messages.forward(channelId, input)
    if (forwarded.isErr()) return forwarded
    const snapshot: MessageSnapshot | undefined = forwarded.value.messageSnapshots?.[0]
    const sent = await client.messages.send(channelId, {
        attachments: [{ data: new Uint8Array([1, 2]), filename: "chart.png" }],
        embeds: [{ image: { url: "attachment://chart.png" } }],
        flags: MessageFlags.SuppressNotifications,
    })
    if (sent.isErr()) return sent
    await client.messages.edit(sent.value, { flags: MessageFlags.SuppressEmbeds })
    await client.messages.edit(sent.value, {
        attachments: sent.value.attachments.map(({ id }) => ({ id, title: "Chart", description: null })),
    })
    const profile = await client.users.fetchProfile(userId, { guildId: "20" })
    if (profile.isErr()) return profile
    const observed: UserProfile = profile.value
    // @ts-expect-error Forward inputs cannot add content
    client.messages.forward(channelId, { source, content: "extra" })
    // @ts-expect-error Profile observations are immutable
    observed.profile.bio = "changed"
    return { snapshot, observed }
}

export async function useChannels(client: Client, guildId: string, channelId: string) {
    const retained = client.channels.get(channelId)
    if (retained.isErr()) return retained
    const snapshot: GuildChannel | undefined = retained.value
    const created = await client.channels.create(guildId, {
        type: ChannelType.Text,
        name: "help",
        permissionOverwrites: [],
    })
    if (created.isErr()) return created
    await client.channels.fetchAll(guildId)
    await client.channels.fetch(created.value.id)
    await client.channels.edit(created.value.id, { topic: "Help desk" })
    await client.channels.reorder(guildId, [{ id: created.value.id, parentId: null }])
    await client.channels.setPermissionOverwrite(created.value.id, {
        id: guildId,
        type: "role",
        allow: 0n,
        deny: Permissions.ViewChannel,
    })
    await client.channels.removePermissionOverwrite(created.value.id, guildId)
    await client.channels.delete(created.value.id)
    // @ts-expect-error Permission masks must be bigint
    client.channels.setPermissionOverwrite(channelId, { id: guildId, type: "role", allow: "0", deny: 0n })
    // @ts-expect-error Received channels are immutable
    created.value.name = "changed"
    return snapshot
}

export async function useAttachments(client: Client, channelId: string) {
    const file = { data: new Uint8Array([1, 2]), filename: "fixture.bin" }
    const sent = await client.messages.send(channelId, { attachments: [file] })
    if (sent.isErr()) return sent
    const attachment = sent.value.attachments[0]!
    await client.messages.reply(sent.value, { attachments: [file] })
    await client.messages.edit(sent.value, { attachments: [{ id: attachment.id }, file] })
    await client.messages.edit(sent.value, { content: "Cleared", attachments: [] })
    // @ts-expect-error References are edit-only
    client.messages.send(channelId, { attachments: [{ id: attachment.id }] })
    // @ts-expect-error Paths are not file bytes
    client.messages.send(channelId, { attachments: [{ data: "path", filename: "x" }] })
    // @ts-expect-error Received metadata is immutable
    attachment.filename = "renamed"
    return attachment.url
}

export async function useEmbeds(client: Client, channelId: string) {
    const sent = await client.messages.send(channelId, { embeds: [exampleEmbed] })
    if (sent.isErr()) return sent
    const title: string | undefined = sent.value.embeds[0]?.title
    void title
    await client.messages.reply(sent.value, { embeds: [exampleEmbed] })
    await client.messages.edit(sent.value, { embeds: [{ title: "Replacement" }] })
    await client.messages.edit(sent.value, { content: "Plain text", embeds: [] })
    // @ts-expect-error A message body must specify content or embeds
    client.messages.send(channelId, {})
    // @ts-expect-error A reply cannot supply a separate reference
    client.messages.reply(sent.value, { embeds: [exampleEmbed], messageReference: sent.value })
    // @ts-expect-error Received arrays are readonly
    sent.value.embeds.push({ type: "rich" })
    // @ts-expect-error Received-only metadata is not a send field
    client.messages.send(channelId, { embeds: [{ type: "rich" }] })
}

export const cacheSettings: MessageCacheSettings = {
    maxAgeMs: (message) => (message.author.isBot ? 0 : null),
}

export function configuredLogging(token: string) {
    const client = createClient({ token, logging: { development: true, minimumLevel: "Warn" } })
    // @ts-expect-error An Effect adapter is required rather than an untyped logger object
    createClient({ token, logging: { logger: { log() {} } } })
    return client
}

export const cacheAgeModes: readonly MessageCacheSettings[] = [{ maxAgeMs: 30_000 }, { maxAgeMs: null }, cacheSettings]

export const cacheOptions: MessageCacheOptions = {
    maxEntries: 100,
    maxBytes: 1_048_576,
    maxAgeMs: (message) => (message.author.isBot ? 0 : null),
    onError: async (report) => {
        const safeReport: CachePolicyErrorReport = report
        const reason: "threw" | "invalidReturn" = safeReport.reason
        void reason
    },
}

export function createAndReadState(token: string): ConnectionState | "ConfigurationError" {
    return createClient({ token }).match(
        (client) => client.state,
        (error) => error._tag,
    )
}

/** Typechecked cache modes: disabled, default retention and configured synchronous policy with a default Promise reporter */
export function createWithMessageCache(token: string) {
    const disabled = createClient({ token, cache: { messages: false } })
    const defaults = createClient({ token, cache: { messages: true } })
    const configured = createClient({ token, cache: { messages: cacheOptions } })
    return [disabled, defaults, configured]
}

export function rejectedTypeShapes(client: Client): void {
    // @ts-expect-error The credential is required
    createClient({})
    // @ts-expect-error Credentials must be strings
    createClient({ token: 42 })
    // @ts-expect-error Only the SDK may change connection state
    client.state = "Connected"
    // @ts-expect-error Native Effect composition is not part of the default operation result
    client.connect().pipe()
    // @ts-expect-error Connection policy is client-wide, not a per-call override
    client.connect({ startupTimeoutMs: 1 })
    // @ts-expect-error Cache budgets are numeric
    createClient({ token: "fixture", cache: { messages: { maxEntries: "100" } } })
    // @ts-expect-error Retention policies are synchronous
    createClient({ token: "fixture", cache: { messages: { maxAgeMs: async () => null } } })
    // @ts-expect-error Default reporters return void or Promise<void>
    createClient({ token: "fixture", cache: { messages: { onError: () => 1 } } })
    // @ts-expect-error Message cache settings cannot be null
    createClient({ token: "fixture", cache: { messages: null } })
}

/** A local cache lookup is synchronous, returns a default Result and preserves immutable Message snapshots */
export function readCachedSnapshot(client: Client): Message | undefined {
    const cached = client.messages.get({ id: "10", channelId: "20" })
    if (cached.isErr()) return undefined
    const snapshot: Message | undefined = cached.value
    if (snapshot) {
        const content: string = snapshot.content
        void content
        // @ts-expect-error Cached snapshots are readonly
        snapshot.content = "replacement"
    }
    // @ts-expect-error Cache lookup accepts MessageReference, not a message ID
    client.messages.get("10")
    return snapshot
}

export async function manageClient(token: string): Promise<void> {
    const created = createClient({ token, connection: { startupTimeoutMs: 30_000, maxStartupAttempts: 3 } })
    if (created.isErr()) return
    const result = await created.value.run()
    if (result.isErr() && result.error._tag === "RateLimitError") {
        const delay: number | null = result.error.retryAfterMs
        void delay
    }
}

/** Typechecked registration fragment; the application must also observe client and subscription lifetimes */
export function registerReply(client: Client) {
    return client.on(
        "messageCreate",
        async (message, signal) => {
            if (message.author.isBot || message.content !== "!ping") return
            const result = await client.messages.reply(message, { content: "Pong!" }, { signal })
            if (result.isErr()) throw result.error
        },
        { concurrency: 4, maxPendingMessages: 256, maxPendingBytes: 4_194_304 },
    )
}

/** Typechecked typing calls and ephemeral gateway delivery through the packed default package. */
export async function typingOperations(client: Client, channelId: string) {
    const notice = await client.messages.typing(channelId, { timeoutMs: 5_000 })
    if (notice.isErr()) return notice.error
    const work = await client.messages.keepTyping(channelId, async (signal) => {
        if (signal.aborted) throw new Error("work cancelled")
        return "prepared"
    })
    const subscription = client.on("typingStart", (event) => {
        const typing: TypingStart = event
        void typing.timestamp
        // @ts-expect-error Typing notices are frozen observations
        event.channelId = "21"
    })
    return work.isErr() ? work.error : subscription
}

export function rejectedMessageShapes(client: Client): void {
    const reactionTarget = { id: "10", channelId: "20" }
    // @ts-expect-error Named removal requires an explicit user ID
    client.messages.removeUserReaction(reactionTarget, "👍")
    // @ts-expect-error Clearing one emoji requires its selector
    client.messages.clearReaction(reactionTarget)
    // @ts-expect-error Clear-all takes operation options, never an emoji selector
    client.messages.clearReactions(reactionTarget, "👍")
    // @ts-expect-error Collector filters must return synchronous booleans
    client.messages.collect("20", { filter: async () => true })
    // @ts-expect-error Collector IDs are decimal strings
    client.messages.collect(20)
    // @ts-expect-error Collector count is numeric
    client.messages.collect("20", { maxMessages: "1" })
    const page: readonly Message[] = []
    // @ts-expect-error History arrays cannot be mutated
    page.push(page[0]!)
    // @ts-expect-error History cursor modes are mutually exclusive
    client.messages.fetchHistory("20", { before: "10", after: "9" })
    // @ts-expect-error History IDs remain strings
    client.messages.fetchHistory("20", { around: 10 })
    // @ts-expect-error IDs must remain strings
    client.messages.send(123, { content: "hello" })
    // @ts-expect-error File lists must be arrays
    client.messages.send("20", { content: "hello", attachments: "file" })
    // @ts-expect-error Default typing work returns a promise, not an Effect
    client.messages.keepTyping("20", () => ({ pipe: () => undefined }))
    // @ts-expect-error Fetch takes a reference, not two positional IDs
    client.messages.fetch("20", "10")
    // @ts-expect-error Edit requires replacement content
    client.messages.edit({ channelId: "20", id: "10" }, {})
    client.messages.edit(
        { channelId: "20", id: "10" },
        // @ts-expect-error Uploads and retained references are mutually exclusive
        { attachments: [{ id: "40", data: new Uint8Array(1), filename: "x" }] },
    )
}

export async function collectReplies(client: Client) {
    const options: CollectorOptions = {
        maxMessages: 2,
        timeoutMs: 5_000,
        maxBytes: 1_024,
        maxPendingMessages: 10,
        maxPendingBytes: 2_048,
    }
    const opened = client.messages.collect("20", options)
    if (opened.isErr()) return opened.error._tag
    const collector: Collector = opened.value
    collector.stop()
    const result = await collector.waitForClose()
    if (result.isErr()) return result.error._tag
    const completed: CollectorResult = result.value
    // @ts-expect-error Successful collector results are immutable
    completed.messages.push(completed.messages[0]!)
    return completed.reason
}

export function collectWithProgress(client: Client) {
    const options: DefaultCollectorOptions = {
        onMessage: async (message, signal) => {
            const reply = await client.messages.reply(message, { content: "Accepted" }, { signal })
            if (reply.isErr()) throw reply.error
        },
    }
    client.messages.collect("20", {
        onMessage: (message) => {
            // @ts-expect-error Progress callbacks receive immutable message snapshots
            message.id = "21"
        },
    })
    return client.messages.collect("20", options)
}

/** Typechecked page-navigation fragment. The application owns client lifetime and decides when to request another page */
export async function readOlderMessages(client: Client): Promise<void> {
    const query: MessageHistoryQuery = { limit: 50 }
    const result = await client.messages.fetchHistory("20", query, { timeoutMs: 5_000 })
    if (result.isErr()) return
    const page: readonly Message[] = result.value
    const oldest = page.at(-1)
    if (oldest) await client.messages.fetchHistory("20", { before: oldest.id })
}

/** Packed-declaration usage for explicit indexed search and its independently bounded lazy traversal */
export async function searchIndexedMessages(
    client: Client,
    context: MessageSearchContext,
): Promise<MessageSearchPage | undefined> {
    const page = await client.messages.search(context, { content: "todo", has: ["link"] })
    if (page.isErr()) return undefined
    const observed: MessageSearchPage = page.value
    if (observed.indexing) return observed
    const filters: Omit<MessageSearchQuery, "limit" | "page" | "cursor"> = { content: "todo" }
    const limits: MessageSearchIterationLimits = { maxItems: 100, pageSize: 25 }
    for await (const result of client.messages.iterateSearch(context, filters, limits)) {
        if (result.isErr()) break
        const message: Message = result.value
        void message.id
    }
    // @ts-expect-error Search context requires a decimal guild or channel ID
    client.messages.search({})
    // @ts-expect-error Iterator filters cannot replay a provider cursor
    client.messages.iterateSearch(context, { cursor: ["opaque"] }, { maxItems: 1 })
    return observed
}

/** Typechecked message-management fragment with expected failures retained as default results */
export async function manageMessage(client: Client, target: MessageReference): Promise<void> {
    const fetched = await client.messages.fetch(target, { timeoutMs: 5_000 })
    if (fetched.isErr()) {
        const error: MessageOperationFailure | { readonly _tag: "CancelledError" } = fetched.error
        if (error._tag === "MessageOperationError") {
            const outcome: "notDispatched" | "rejected" | "unknown" = error.outcome
            void outcome
        }
        return
    }
    const message: Message = fetched.value
    const edited = await client.messages.edit(message, { content: "Updated" })
    if (edited.isErr()) return
    const deleted = await client.messages.delete(edited.value)
    if (deleted.isOk()) {
        const completion: void = deleted.value
        void completion
    }
}

export function moderationOperations(client: Client, target: import("@neontechspace/fluxerly").MemberReference) {
    const ban: import("@neontechspace/fluxerly").BanInput = { durationSeconds: 60, reason: "Spam" }
    const options: import("@neontechspace/fluxerly").DefaultModerationOptions = {
        auditReason: "Spam",
    }
    const clear = client.members.clearTimeout(target, options).map((member) => member.communicationDisabledUntil)
    const kick = client.members.kick(target, options)
    const create = client.guilds.ban(target, ban, options)
    const remove = client.guilds.unban(target, options)
    const list = client.guilds.fetchBans(target.guildId).map((bans) => {
        const first: import("@neontechspace/fluxerly").GuildBan | undefined = bans[0]
        // @ts-expect-error Ban observations are readonly
        if (first) first.expiresAt = null
        return first?.userId
    })
    const subscription = client.on("guildBanRemove", (notice) => {
        const id: string = notice.userId
        void id
    })
    // @ts-expect-error A string cannot be passed as a numeric timeout duration
    client.members.timeout(target, "60")
    return [clear, kick, create, remove, list, subscription]
}

/** Typechecked event registration fragments with payload inference for each event name */
export function watchMessageChanges(client: Client) {
    const updates = client.on("messageUpdate", (message) => {
        const current: Message = message
        void current
    })
    const deleted = client.on("messageDelete", (message) => {
        const deletion: MessageDeletion = message
        const content: string | null | undefined = deletion.content
        void content
        // @ts-expect-error A deletion need not have a full author object
        message.author.username
    })
    const batches = client.on("messageDeleteBulk", (batch) => {
        const deletion: MessageBulkDeletion = batch
        const ids: readonly string[] = deletion.ids
        void ids
        // @ts-expect-error Batch IDs cannot be mutated
        batch.ids.push("10")
    })
    // @ts-expect-error A full-message handler cannot safely consume deletion notices
    client.on("messageDelete", (message: Message) => {
        void message.content
    })
    const pull = client.events("messageDeleteBulk")
    if (pull.isOk()) pull.value.next().map((batch) => batch?.ids)
    return [updates, deleted, batches]
}
/** Typechecked targeted nickname and local hierarchy usage against the packed default entry point */
export function manageMemberHierarchy(client: Client, target: MemberReference, snapshot: RoleHierarchyInput) {
    const renamed = client.members.setNickname(target, null)
    const canTarget = canManageHierarchy(snapshot)
    const first = snapshot.roles[0]
    const order = first ? compareHierarchy(first, first) : undefined
    // @ts-expect-error Nicknames use explicit null to clear, not an omitted argument
    client.members.setNickname(target)
    return { renamed, canTarget, order }
}

/** Typechecked delivery-only presence subscription through the packed default entry point */
export function watchPresence(client: Client) {
    const subscription = client.on("presenceUpdate", (presence) => {
        const update: PresenceUpdate = presence
        const status: string = update.status
        const guildId: string | undefined = update.guildId
        void status
        void guildId
        // @ts-expect-error Presence observations are immutable
        update.mobile = false
    })
    const pull = client.events("presenceUpdate")
    if (pull.isOk()) pull.value.next().map((presence) => presence?.guildId)
    return subscription
}

/** Typechecked recovery presence batch through the packed default entry point */
export function watchPresenceRecovery(client: Client) {
    return client.on("presenceUpdateBulk", (batch) => {
        const update: PresenceUpdateBulk = batch
        const first: PresenceUpdate | undefined = update.presences[0]
        void first
        // @ts-expect-error Recovery observations and their batch are immutable
        update.presences.push(batch.presences[0]!)
    })
}

/** Typechecked explicit selected-member presence intent through the packed default entry point */
export function selectMemberPresence(client: Client, guildId: string, memberId: string) {
    return client.presence.setMembers(guildId, [memberId])
}
