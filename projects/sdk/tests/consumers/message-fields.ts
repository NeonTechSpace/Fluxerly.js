import {
    createClient,
    commands,
    type Client,
    type ConfigurationError,
    type Message,
    type MessageCore,
    type MessageField,
    type MessageUser,
    type ReferencedMessage,
    type SelectedMessage,
} from "@neontechspace/fluxerly"
import {
    createClient as createNative,
    type Client as NativeClient,
    type ClientOptions as NativeClientOptions,
} from "@neontechspace/fluxerly/effect"
import { Context, Effect, Scope, Stream } from "effect"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function exact<T extends true>(value: T) {
    return value
}
type Fields = readonly ["embeds", "editedAt", "messageSnapshots"]
type Chosen = SelectedMessage<Fields>

export const selectedTypeContracts = [
    exact<Equal<SelectedMessage, Message>>(true),
    exact<Equal<SelectedMessage<readonly []>, MessageCore>>(true),
    exact<Equal<SelectedMessage<readonly ["embeds"]>["embeds"], Message["embeds"]>>(true),
    exact<Equal<Chosen["editedAt"], string | null | undefined>>(true),
    exact<Equal<Chosen["messageSnapshots"], Message["messageSnapshots"]>>(true),
    exact<Equal<SelectedMessage<readonly ["nsfwEmojiIds"]>["nsfwEmojiIds"], readonly string[] | undefined>>(true),
    exact<
        Equal<
            SelectedMessage<readonly ["referencedUsers"]>["referencedUsers"],
            readonly MessageUser[] | null | undefined
        >
    >(true),
    exact<
        Equal<
            SelectedMessage<readonly ["referencedMessage"]>["referencedMessage"],
            ReferencedMessage | null | undefined
        >
    >(true),
    exact<
        Equal<
            SelectedMessage<readonly ["nsfwEmojiIds"] | readonly ["referencedUsers"]>,
            SelectedMessage<readonly ["nsfwEmojiIds"]> | SelectedMessage<readonly ["referencedUsers"]>
        >
    >(true),
    exact<
        Equal<
            SelectedMessage<readonly ["embeds"] | readonly ["attachments"]>,
            SelectedMessage<readonly ["embeds"]> | SelectedMessage<readonly ["attachments"]>
        >
    >(true),
    exact<Equal<SelectedMessage<readonly ["embeds"] | undefined>, SelectedMessage<readonly ["embeds"]> | Message>>(
        true,
    ),
]

export async function defaultSelectedFields(token: string) {
    const opened = createClient({
        token,
        messageFields: ["embeds", "editedAt", "messageSnapshots"],
        cache: {
            messages: {
                maxAgeMs: (message) => {
                    const embeds: readonly import("@neontechspace/fluxerly").Embed[] = message.embeds
                    // @ts-expect-error Cache policy inference cannot widen the configured fields
                    message.attachments
                    return embeds.length ? 0 : null
                },
            },
        },
    })
    if (opened.isErr()) return opened
    const client = opened.value
    const chosen: Client<Chosen> = client
    const router = commands.create<Chosen>({ prefix: "!" })._unsafeUnwrap()
    router.attach(client)
    // @ts-expect-error A full-message router cannot attach to this selected client
    commands.create({ prefix: "!" })._unsafeUnwrap().attach(client)
    const fetched = await client.messages.fetch({ id: "10", channelId: "20" })
    if (fetched.isErr()) return fetched
    exact<Equal<typeof fetched.value, Chosen>>(true)
    const message = fetched.value
    const core: MessageCore = message
    const author: Message["author"] = message.author
    const edited: string | null | undefined = message.editedAt
    const snapshotAttachments = message.messageSnapshots?.[0]?.attachments
    // @ts-expect-error Selected snapshot media does not make top-level media available
    message.attachments
    // @ts-expect-error Selecting some fields does not produce a full Message
    const full: Message = message
    void full
    client.on("messageCreate", (event) => {
        exact<Equal<typeof event, Chosen>>(true)
        // @ts-expect-error Callback fields match the client selection
        event.attachments
    })
    client.on("messageUpdate", (event) => {
        exact<Equal<typeof event, Chosen>>(true)
    })
    client.waitFor("messageCreate", {
        filter: (event) => {
            exact<Equal<typeof event, Chosen>>(true)
            return event.embeds.length > 0
        },
    })
    const collector = client.messages
        .collect("20", {
            filter: (event) => {
                exact<Equal<typeof event, Chosen>>(true)
                return true
            },
            onMessage: (event) => {
                exact<Equal<typeof event, Chosen>>(true)
            },
        })
        ._unsafeUnwrap()
    const collected = await collector.waitForClose()
    if (collected.isOk()) exact<Equal<(typeof collected.value.messages)[number], Chosen>>(true)
    const pulled = await client.events("messageCreate")._unsafeUnwrap().next()
    if (pulled.isOk() && pulled.value) exact<Equal<typeof pulled.value, Chosen>>(true)
    const cached = client.messages.get(message)
    if (cached.isOk() && cached.value) exact<Equal<typeof cached.value, Chosen>>(true)
    const entries = client.cache.entries("messages")
    if (entries.isOk()) exact<Equal<(typeof entries.value)[number], Chosen>>(true)
    const history = await client.messages.fetchHistory("20")
    if (history.isOk()) exact<Equal<(typeof history.value)[number], Chosen>>(true)
    const pins = await client.messages.fetchPins("20")
    if (pins.isOk()) exact<Equal<(typeof pins.value.items)[number]["message"], Chosen>>(true)
    const search = await client.messages.search({ guildId: "40" }, { content: "text" })
    if (search.isOk() && !search.value.indexing) exact<Equal<(typeof search.value.messages)[number], Chosen>>(true)
    const latest = await client.directMessages.fetchLatestMessages(["20"])
    if (latest.isOk()) exact<Equal<(typeof latest.value.messages)[string], Chosen | null>>(true)
    const cleanup = await client.messages.previewCleanup("20", {
        maxScanned: 1,
        maxSelected: 1,
        filter: (event) => {
            exact<Equal<typeof event, Chosen>>(true)
            return true
        },
    })
    if (cleanup.isOk()) exact<Equal<(typeof cleanup.value.selectedMessages)[number], Chosen>>(true)
    return { chosen, core, author, edited, snapshotAttachments }
}

export async function defaultDynamicAndDefault(token: string, fields: readonly MessageField[]) {
    const dynamic = createClient({ token, messageFields: fields })._unsafeUnwrap()
    const message = await dynamic.messages.fetch({ id: "10", channelId: "20" })
    if (message.isOk()) {
        const embeds: Message["embeds"] | undefined = message.value.embeds
        const nsfwEmojiIds: Message["nsfwEmojiIds"] = message.value.nsfwEmojiIds
        const referencedUsers: Message["referencedUsers"] = message.value.referencedUsers
        const author: Message["author"] = message.value.author
        // @ts-expect-error Dynamic array membership cannot promise an embeds array
        const required: Message["embeds"] = message.value.embeds
        void embeds
        void nsfwEmojiIds
        void referencedUsers
        void author
        void required
    }
    const full = createClient({ token })._unsafeUnwrap()
    const response = await full.messages.fetch({ id: "10", channelId: "20" })
    if (response.isOk()) {
        const message: Message = response.value
        void message
    }
    const core = createClient({ token, messageFields: [] })._unsafeUnwrap()
    const result = await core.messages.fetch({ id: "10", channelId: "20" })
    if (result.isOk()) {
        exact<Equal<typeof result.value, MessageCore>>(true)
        // @ts-expect-error Empty tuples expose only always-retained fields
        result.value.embeds
    }
    createClient({ token, messageFields: ["id", "channelId", "content", "author", "guildId"] })
    // @ts-expect-error Unknown names are rejected at the public creation boundary
    createClient({ token, messageFields: ["timestamp"] })
    // @ts-expect-error A narrower full-message policy cannot influence field inference
    createClient({ token, messageFields: [], cache: { messages: { maxAgeMs: (_message: Message) => null } } })
    return { dynamic, full, core }
}

export async function defaultReceivedContext(token: string) {
    const client = createClient({
        token,
        messageFields: ["nsfwEmojiIds", "referencedUsers", "referencedMessage"],
    })._unsafeUnwrap()
    const result = await client.messages.fetch({ id: "10", channelId: "20" })
    if (result.isErr()) return result
    const message = result.value
    const emojiIds: readonly string[] | undefined = message.nsfwEmojiIds
    const users: readonly MessageUser[] | null | undefined = message.referencedUsers
    const reply: ReferencedMessage | null | undefined = message.referencedMessage
    const preference: 0 | 1 | 2 | undefined = reply?.author.mentionFlags
    // @ts-expect-error Embedded webhook and deleted-user placeholders are not complete User values
    const completeUser: import("@neontechspace/fluxerly").User = message.author
    // @ts-expect-error Selecting received context does not widen the message to unrelated media
    message.attachments
    return { emojiIds, users, reply, preference, completeUser }
}

interface Reporter {
    readonly report: () => void
}
const Reporter = Context.Service<Reporter>("message-fields-reporter")
type ReporterId = Context.Service.Identifier<typeof Reporter>

export function nativeFieldsAndEnvironment(token: string) {
    const inferred = createNative({
        token,
        messageFields: ["embeds", "editedAt", "messageSnapshots"],
        cache: {
            messages: {
                maxAgeMs: (message) => {
                    exact<Equal<typeof message, Chosen>>(true)
                    // @ts-expect-error Native cache policy observes the configured projection
                    message.attachments
                    return null
                },
                onError: () =>
                    Effect.gen(function* () {
                        const reporter = yield* Reporter
                        reporter.report()
                        return yield* Effect.fail("report-failure" as const)
                    }),
            },
        },
    })
    const creation: Effect.Effect<NativeClient<Chosen>, ConfigurationError, Scope.Scope | ReporterId> = inferred
    const options: NativeClientOptions<"report-failure", ReporterId, Fields> = {
        token,
        messageFields: ["embeds", "editedAt", "messageSnapshots"],
        cache: { messages: { onError: () => Effect.andThen(Reporter, Effect.fail("report-failure" as const)) } },
    }
    const explicit = createNative<"report-failure", ReporterId, Fields>(options)
    const explicitCreation: Effect.Effect<NativeClient<Chosen>, ConfigurationError, Scope.Scope | ReporterId> = explicit
    // @ts-expect-error Creation still requires the reporter service
    const missingEnvironment: Effect.Effect<NativeClient<Chosen>, ConfigurationError, Scope.Scope> = inferred
    void missingEnvironment
    // @ts-expect-error A full-message policy cannot widen a native empty selection
    createNative({ token, messageFields: [], cache: { messages: { maxAgeMs: (_message: Message) => null } } })
    const defaultFull: Effect.Effect<NativeClient, ConfigurationError, Scope.Scope> = createNative({ token })
    return { creation, explicitCreation, defaultFull }
}

export function nativeSelectedCarriers(client: NativeClient<Chosen>) {
    return Effect.gen(function* () {
        const message = yield* client.messages.fetch({ id: "10", channelId: "20" })
        exact<Equal<typeof message, Chosen>>(true)
        // @ts-expect-error Native operation results exclude unselected fields
        message.attachments
        yield* client.on("messageCreate", (event) =>
            Effect.sync(() => {
                exact<Equal<typeof event, Chosen>>(true)
            }),
        )
        yield* client.waitFor("messageCreate", {
            filter: (event) => {
                exact<Equal<typeof event, Chosen>>(true)
                return true
            },
        })
        const collector = yield* client.messages.collect("20", {
            onMessage: (event) =>
                Effect.sync(() => {
                    exact<Equal<typeof event, Chosen>>(true)
                }),
        })
        const collected = yield* collector.waitForClose()
        exact<Equal<(typeof collected.messages)[number], Chosen>>(true)
        const events = yield* Stream.runCollect(client.events("messageUpdate").pipe(Stream.take(1)))
        exact<Equal<(typeof events)[number], Chosen>>(true)
        const entries = yield* client.cache.entries("messages")
        exact<Equal<(typeof entries)[number], Chosen>>(true)
        const pins = yield* client.messages.fetchPins("20")
        exact<Equal<(typeof pins.items)[number]["message"], Chosen>>(true)
        const search = yield* client.messages.search({ guildId: "40" }, { content: "text" })
        if (!search.indexing) exact<Equal<(typeof search.messages)[number], Chosen>>(true)
        const latest = yield* client.directMessages.fetchLatestMessages(["20"])
        exact<Equal<(typeof latest.messages)[string], Chosen | null>>(true)
        const cleanup = yield* client.messages.previewCleanup("20", {
            maxScanned: 1,
            maxSelected: 1,
            filter: (event) => {
                exact<Equal<typeof event, Chosen>>(true)
                return true
            },
        })
        exact<Equal<(typeof cleanup.selectedMessages)[number], Chosen>>(true)
        return message
    })
}

export async function creationTupleUnion(token: string, fields: readonly ["embeds"] | readonly ["attachments"]) {
    const client = createClient({ token, messageFields: fields })._unsafeUnwrap()
    const result = await client.messages.fetch({ id: "10", channelId: "20" })
    if (result.isOk()) {
        exact<Equal<typeof result.value, SelectedMessage<typeof fields>>>(true)
        // @ts-expect-error The alternate tuple does not promise embeds
        result.value.embeds
        // @ts-expect-error The alternate tuple does not promise attachments
        result.value.attachments
    }
    return client
}

export function nativeDynamicCreation(token: string, fields: readonly MessageField[]) {
    const result = createNative({ token, messageFields: fields })
    const creation: Effect.Effect<
        NativeClient<SelectedMessage<typeof fields>>,
        ConfigurationError,
        Scope.Scope
    > = result
    return Effect.flatMap(creation, (client) =>
        Effect.map(client.messages.fetch({ id: "10", channelId: "20" }), (message) => {
            const embeds: Message["embeds"] | undefined = message.embeds
            // @ts-expect-error Native dynamic arrays cannot promise selected membership either
            const required: Message["embeds"] = message.embeds
            void required
            return { message, embeds }
        }),
    )
}
