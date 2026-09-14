import { Context, Effect, Stream, type Scope } from "effect"
import {
    createClient,
    oauth,
    OAuthScopes,
    colors,
    permissionBits,
    text,
    type ColorInput,
    type RgbColor,
    type PermissionBitInspection,
    type TextSplitOptions,
    canManageHierarchy,
    compareHierarchy,
    ChannelType,
    Permissions,
    MessageFlags,
    builders,
    commands,
    supervisor,
    type ForwardMessageInput,
    type MessageSnapshot,
    type UserProfile,
    type GuildChannel,
    type Client,
    type ShardRecoveryDiagnostic,
    type ShardState,
    type ShardingOptions,
    type ConfigurationError,
    type MessageReference,
    type MessageOperationFailure,
    type InputValidationDetail,
    type Message,
    type MessageNonce,
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
    type VoiceConnectionReference,
    type VoiceState,
    type VoiceStateSnapshot,
    type RoleHierarchyInput,
    type InstanceOptions,
    type ResolvedInstance,
    type AttachmentFileSource,
    type AttachmentInput,
    type AttachmentStreamSource,
    type SupervisorOptions,
    type PrefixCommandMetadata,
    type CommandHelpOptions,
    type DiscoverySearchPage,
    type DirectMessageLatestMessages,
    type WebhookClient,
    type WebhookMessageReference,
    type WebhookTokenEdit,
    type SupervisorWaitOptions,
    type OAuthClient,
    type OAuthConnection,
    type OAuthIntrospection,
} from "@neontechspace/fluxerly/effect"
const exampleEmbed = { title: "Build finished", fields: [{ name: "Status", value: "Passed", inline: true }] }

/** Packed typed commands retain their handler service requirement */
export function typedCommandTypes(client: Client) {
    return Effect.gen(function* () {
        const created = yield* commands.create({ prefix: "!" })
        const registered = yield* created.register({
            name: "typed",
            arguments: {
                count: { type: "integer" },
                mode: { type: "choice", choices: ["fast", "slow"] },
                target: { type: "user", candidates: [{ id: "1", username: "sample", privateField: true }] },
                userId: { type: "id", mention: "user" },
                channelId: { type: "id", mention: "channel" },
                roleId: { type: "id", mention: "role" },
                note: { type: "text", optional: true },
            },
            execute: ({ values, args }) => {
                const count: number = values.count
                const mode: "fast" | "slow" = values.mode
                const note: string | undefined = values.note
                const raw: readonly string[] = args
                const target: string = values.target.id
                const mentionIds: readonly string[] = [values.userId, values.channelId, values.roleId]
                void mentionIds
                // @ts-expect-error Integer conversion yields a number
                const wrong: string = values.count
                // @ts-expect-error An omitted trailing argument may be undefined
                const required: string = values.note
                // @ts-expect-error Undeclared arguments are not exposed
                values.missing
                // @ts-expect-error Resource projections omit caller-private fields
                values.target.privateField
                void [count, mode, note, raw, target, wrong, required]
                return Effect.service(CommandService)
            },
        })
        const attached = Effect.scoped(registered.attach(client))
        const helpOptions: CommandHelpOptions = { prefix: "!", maxLength: 100 }
        const help: Effect.Effect<readonly string[], unknown> = registered.help(helpOptions)
        void help
        // @ts-expect-error A page ceiling must be explicit
        registered.help({ prefix: "!" })
        // @ts-expect-error Help visibility is synchronous
        registered.help({ prefix: "!", maxLength: 100, include: async () => true })
        // @ts-expect-error Typed handlers still require their declared service
        Effect.runPromise(attached)
        return Effect.provideService(attached, CommandService, { enabled: true })
    })
}

/** Packed declaration coverage for combined code-grant URLs, connections reads, and confidential introspection */
export function oauthCompletion(client: OAuthClient) {
    const pkce = oauth.createPkce()
    return Effect.gen(function* () {
        const authorization = yield* client.authorizationUrl({
            redirectUri: "https://app.example.test/oauth/callback",
            scopes: [OAuthScopes.Identify, OAuthScopes.Bot],
            state: "caller-owned-state",
            codeChallenge: pkce.challenge,
            guildId: "1",
            permissions: 0n,
            disableGuildSelect: true,
        })
        const connections = yield* client.fetchConnections("delegated-access-token")
        const introspection: OAuthIntrospection = yield* client.introspect("candidate-token")
        const connection: OAuthConnection | undefined = connections[0]
        void connection
        return { authorization, introspection }
    })
}

export function oauthInstanceTypes() {
    const credentials = { clientId: "100", clientSecret: "fixture-only" }
    oauth.create(credentials)
    oauth.create({ ...credentials, instance: { url: "https://fluxer.example.test" } })
    oauth.create({ ...credentials, instance: { url: "http://localhost:8080", allowInsecure: true } })
    // @ts-expect-error A supplied instance requires its URL, unlike omitting the whole option
    oauth.create({ ...credentials, instance: {} })
    // @ts-expect-error Plaintext permission does not select an instance
    oauth.create({ ...credentials, instance: { allowInsecure: true } })
}

/** Packed declaration coverage for token lifecycle and tagged webhook references */
export const webhookReferenceTypes = (client: WebhookClient) => {
    const reply: WebhookMessageReference = { type: "reply", target: { id: "100", channelId: "200" } }
    const forward: WebhookMessageReference = {
        type: "forward",
        source: { source: { id: "100", channelId: "200" } },
    }
    const edit: WebhookTokenEdit = { name: "Packed webhook", avatar: null }
    return {
        reply: client.send({ content: "Reply", messageReference: reply }),
        forward: client.send({ messageReference: forward }),
        edit: client.edit(edit),
        fetch: client.fetch(),
        remove: client.delete(),
    }
}
const CommandService = Context.Service<{ readonly enabled: true }>("command-service")

const structuralAttachmentStream: AttachmentStreamSource = {
    getReader(_options?: { readonly mode?: "byob" }) {
        return {
            read: async () => ({ done: true as const }),
            cancel: async () => undefined,
            releaseLock: () => undefined,
        }
    },
}

const structuralAttachmentFile: AttachmentFileSource = {
    size: 2,
    slice: () => structuralAttachmentFile,
    stream: () => structuralAttachmentStream,
}

export const pureHelperTypes = (bits: bigint) =>
    Effect.gen(function* () {
        const input: ColorInput = [255, 136, 0]
        const rgb: RgbColor = [255, 136, 0]
        const options: TextSplitOptions = { maxLength: 2_000 }
        const snapshot: PermissionBitInspection = yield* permissionBits.inspect(bits)
        // @ts-expect-error Inspection names are immutable
        snapshot.names.push("ManageRoles")
        // @ts-expect-error RGB channels are immutable
        rgb[0] = 0
        // @ts-expect-error Permission names are checked by the public type
        permissionBits.from(["UnknownPermission"])
        return {
            color: yield* colors.parse(input),
            hex: yield* colors.toHex(0xff8800),
            rgb: yield* colors.toRgb(0xff8800),
            chunks: yield* text.split("text", options),
        }
    })

/** Packed declaration coverage for explicit self-hosted selection and lifetime discovery */
export const resolveSelectedInstance = (client: Client) =>
    Effect.gen(function* () {
        const selected: InstanceOptions = { url: "https://community.example" }
        const created = createClient({ token: "fixture-only", instance: selected })
        const resolved: ResolvedInstance = yield* client.instance.resolve()
        return {
            resolved,
            link: resolved.links.channel({ id: "20" }),
            asset: resolved.assets.defaultAvatar("20"),
            created,
        }
    })

export function shardingTypes(client: Client) {
    const plan: ShardingOptions = { totalShards: 2, shardIds: [0, 1] }
    const states: readonly ShardState[] = client.shards
    const recovery: ShardRecoveryDiagnostic | null = states[0]?.recovery ?? null
    // @ts-expect-error Client shard snapshots cannot be replaced
    client.shards = []
    // @ts-expect-error Snapshot arrays cannot be mutated
    states.push({ shardId: 2, state: "Connected", gatewayLatencyMs: null })
    // @ts-expect-error Shard totals are numeric
    createClient({ token: "fixture-only", sharding: { totalShards: "2" } })
    client.messages.collect("20", { guildId: "40" })
    client.messages.collectReactions({ id: "10", channelId: "20" }, { guildId: "40", idleMs: 1_000 })
    return { recovery, created: createClient({ token: "fixture-only", sharding: plan }) }
}

/** Packed native directory and explicitly selected private-message reads preserve public result types */
export function readDiscoveryAndLatestMessages(client: Client, channelId: string) {
    return Effect.gen(function* () {
        const page: DiscoverySearchPage = yield* client.discovery.search({ limit: 1 })
        const result: DirectMessageLatestMessages = yield* client.directMessages.fetchLatestMessages([channelId])
        return { page, result }
    })
}

/** Packed native command routers keep registered service requirements while earlier snapshots remain service-free */
export function optionalCommandTypes(client: Client) {
    const empty = builders.message()
    // @ts-expect-error Empty builders cannot build a message payload
    empty.build()
    // @ts-expect-error Empty variadic calls do not select a message body
    empty.addEmbeds()
    // @ts-expect-error Empty variadic calls do not select a message body
    empty.addAttachments()
    // @ts-expect-error Empty variadic calls do not select a message body
    empty.addStickers()
    return Effect.gen(function* () {
        const original = yield* commands.create({ prefix: "!" })
        const extended = yield* original.register({
            name: "service",
            description: "Uses the command service",
            usage: "[target]",
            onReject: (_context, rejection) =>
                Effect.sync(() => {
                    const retryAtMs: number | null | undefined =
                        rejection._tag === "CommandGuardRejected" ? undefined : rejection.retryAtMs
                    void retryAtMs
                }),
            execute: () => Effect.service(CommandService),
        })
        const listing: readonly PrefixCommandMetadata[] = extended.commands
        const parsed = commands.parseQuoted({ message: null as never, prefix: "!", source: 'service "two words"' })
        const originalAttachment: Effect.Effect<unknown, unknown> = Effect.scoped(original.attach(client))
        void originalAttachment
        const needsService = Effect.scoped(extended.attach(client))
        // @ts-expect-error Registered command services remain required until the caller provides CommandService
        Effect.runPromise(needsService)
        return { listing, parsed, attachment: Effect.provideService(needsService, CommandService, { enabled: true }) }
    })
}

/** Packed native waits infer their payload without a default cancellation error or detached environment */
export function eventWaitTypes(client: Client) {
    const waiting: Effect.Effect<
        import("@neontechspace/fluxerly/effect").TypingStart,
        import("@neontechspace/fluxerly/effect").EventWaitFailure
    > = client.waitFor("typingStart", {
        filter: (event) => {
            // @ts-expect-error Typing events are not message bodies
            event.content
            return event.channelId === "20"
        },
        timeoutMs: 10,
    })
    return waiting
}

/** Packed native supervisor tools retain callback services while child.run owns its nested Scope */
export function supervisorTypes(entry: string) {
    const plan: SupervisorOptions = {
        entry,
        totalShards: 1,
        assignments: [{ id: "worker", shardIds: [0] }],
    }
    const readiness: SupervisorWaitOptions = {}
    const child = supervisor.child.run({
        token: "fixture-only",
        configure: () => Effect.service(CommandService).pipe(Effect.asVoid),
    })
    // @ts-expect-error Callback services remain required until the caller provides CommandService
    Effect.runPromise(child)
    const scopedChild = supervisor.child.run({
        token: "fixture-only",
        configure: () => Effect.forkScoped(Effect.void).pipe(Effect.asVoid),
    })
    Effect.runPromise(scopedChild)
    return Effect.gen(function* () {
        const managed = yield* supervisor.create(plan)
        void readiness
        yield* managed.waitForReady()
        return yield* Effect.provideService(
            child.pipe(Effect.as([managed.status(), managed.start()])),
            CommandService,
            {
                enabled: true,
            },
        )
    })
}

export const useConsumerFeatures = (client: Client, channelId: string, source: MessageReference, userId: string) =>
    Effect.gen(function* () {
        const correlation: MessageNonce = 42
        const input: ForwardMessageInput = { source, nonce: correlation, attachmentIds: [], embedIndices: [0] }
        const forwarded = yield* client.messages.forward(channelId, input)
        const snapshot: MessageSnapshot | undefined = forwarded.messageSnapshots?.[0]
        const sent = yield* client.messages.send(channelId, {
            attachments: [{ data: new Uint8Array([1, 2]), filename: "chart.png" }],
            embeds: [{ image: { url: "attachment://chart.png" } }],
            flags: MessageFlags.SuppressNotifications,
            nonce: "packed-send-nonce",
        })
        const reply = yield* client.messages.reply(sent, { content: "Packed reply", nonce: "packed-reply-nonce" })
        const returnedNonce: string | null | undefined = reply.nonce
        void returnedNonce
        yield* client.messages.edit(sent, { flags: MessageFlags.SuppressEmbeds })
        yield* client.messages.edit(sent, {
            attachments: sent.attachments.map(({ id }) => ({ id, title: "Chart", description: null })),
        })
        const observed: UserProfile = yield* client.users.fetchProfile(userId, { guildId: "20" })
        // @ts-expect-error Forward inputs cannot add content
        client.messages.forward(channelId, { source, content: "extra" })
        // @ts-expect-error Profile observations are immutable
        observed.profile.bio = "changed"
        return { snapshot, observed }
    })

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

/** Typechecked local occupancy, lazy enumeration and synchronous release through the packed native package */
export function inspectCache(client: Client): Effect.Effect<Message | undefined, ConfigurationError> {
    const diagnostics: import("@neontechspace/fluxerly/effect").ClientDiagnostics = client.diagnostics()
    const options: import("@neontechspace/fluxerly/effect").CacheEntriesOptions = { limit: 10 }
    client.cache.clear()
    return client.cache.entries("messages", options).pipe(
        Effect.map((entries) => {
            const snapshots: readonly import("@neontechspace/fluxerly/effect").CachedResources["messages"][] = entries
            const capacity: number = diagnostics.gatewayRequests.activeCapacity
            void capacity
            // @ts-expect-error Enumerated arrays are readonly
            snapshots.push(entries[0]!)
            return snapshots[0]
        }),
    )
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
        idleMs: 1_000,
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
        const reason: "idle" | "limit" | "timeout" | "stopped" = result.reason
        return reason
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

/** Packed declarations expose non-media guild voice moderation and observations */
export function voiceOperations(client: Client, target: VoiceConnectionReference, channelId: string) {
    return Effect.gen(function* () {
        const moved = yield* client.members.move(target, channelId)
        const muted: boolean | undefined = moved.isMuted
        const deafened: boolean | undefined = moved.isDeafened
        yield* client.members.disconnect(target)
        yield* client.members.setMute(target, true)
        yield* client.members.setDeaf(target, false)
        const initial = yield* client.on("voiceStateSnapshot", (snapshot) =>
            Effect.sync(() => {
                const current: VoiceStateSnapshot = snapshot
                void current.voiceStates
            }),
        )
        const updates = client.events("voiceStateUpdate")
        yield* client.on("voiceStateUpdate", (state) =>
            Effect.sync(() => {
                const current: VoiceState = state
                const channel: string | null = current.channelId
                void channel
            }),
        )
        // @ts-expect-error Server deafen state is boolean
        client.members.setDeaf(target, "yes")
        // @ts-expect-error Connection IDs are strings
        const invalid: VoiceConnectionReference = { ...target, connectionId: 1 }
        void invalid
        return { muted, deafened, initial, updates }
    })
}

export function useAttachments(client: Client, channelId: string) {
    return Effect.gen(function* () {
        const file = { data: new Uint8Array([1, 2]), filename: "fixture.bin" }
        const sources = [
            { file: structuralAttachmentFile, filename: "sized.bin" },
            { stream: structuralAttachmentStream, size: 2, filename: "streamed.bin" },
        ] as const satisfies readonly AttachmentInput[]
        const sent = yield* client.messages.send(channelId, { attachments: [file, ...sources] })
        const attachment = sent.attachments[0]!
        const bytes: Uint8Array = yield* client.attachments.download(attachment, {
            maxBytes: 1_024,
            timeoutMs: 5_000,
        })
        yield* Stream.runForEach(
            client.attachments.stream(attachment, { maxBytes: 1_024, timeoutMs: 5_000 }),
            (chunk) => Effect.sync(() => void chunk),
        )
        yield* client.messages.reply(sent, { attachments: [file] })
        yield* client.messages.edit(sent, { attachments: [{ id: attachment.id }, file] })
        yield* client.messages.edit(sent, { content: "Cleared", attachments: [] })
        // @ts-expect-error References are edit-only
        client.messages.send(channelId, { attachments: [{ id: attachment.id }] })
        client.messages.send(channelId, {
            attachments: [
                // @ts-expect-error Stream uploads need an exact byte size
                { stream: structuralAttachmentStream, filename: "unknown.bin" },
            ],
        })
        // @ts-expect-error Bounded downloads require maxBytes
        client.attachments.download(attachment, {})
        // @ts-expect-error Bounded streamed downloads require maxBytes
        client.attachments.stream(attachment, {})
        // @ts-expect-error Attachment input lists remain readonly
        sources.push({ file: structuralAttachmentFile, filename: "later.bin" })
        // @ts-expect-error Received arrays are immutable
        sent.attachments.push(attachment)
        return { url: attachment.url, bytes }
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

/** Typechecked fresh hierarchy, optional guild-list fields, and exact cleanup-plan use through the packed Effect entry point */
export function previewModerationCleanup(client: Client, guildId: string, channelId: string, authorId: string) {
    return Effect.gen(function* () {
        const hierarchy = yield* client.members.fetchHierarchyCheck({ guildId, userId: authorId })
        const memberships = yield* client.guilds.fetchPage({ withCounts: true })
        const permissions: bigint | undefined = memberships[0]?.permissions
        const plan = yield* client.messages.previewCleanup(channelId, {
            authorId,
            filter: (message) => message.attachments.length > 0,
            maxScanned: 500,
            maxSelected: 200,
        })
        const report = yield* client.messages.cleanup(plan, { onProgress: (event) => void event.batch.batchIndex })
        void permissions
        return { hierarchy, report }
    })
}

/** Packed native input extensions retain lazy Effect composition */
export function approvedRequestInputs(client: Client) {
    const options: import("@neontechspace/fluxerly/effect").TimeoutOptions = {
        timeoutReason: "Timeout context",
        auditReason: "Moderator action",
    }
    const mention: import("@neontechspace/fluxerly/effect").CommandArgumentMention = "role"
    return Effect.gen(function* () {
        yield* client.members.timeout({ guildId: "1", userId: "2" }, 60_000, options)
        yield* client.members.clearTimeout({ guildId: "1", userId: "2" }, { timeoutReason: null })
        yield* client.directMessages.editGroup("3", { name: null })
        return mention
    })
}

/** Typechecked local-validation facts through the packed Effect entry point */
export function describeNativeInputValidation(error: MessageOperationFailure): InputValidationDetail | null {
    return error._tag === "MessageOperationError" ? error.inputValidation : null
}
