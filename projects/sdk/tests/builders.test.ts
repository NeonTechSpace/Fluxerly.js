import { afterEach, expect, test, vi } from "vitest"
import {
    builders,
    createClient,
    MessageBuilder,
    type AllowedMentions,
    type AttachmentInput,
    type EmbedAuthorInput,
    type EmbedFieldInput,
    type EmbedFooterInput,
    type EmbedInput,
    type EmbedMediaInput,
    type MessageInput,
    type MessageReference,
} from "../src/index.js"
import { builders as nativeBuilders, MessageBuilder as NativeMessageBuilder } from "../src/effect.js"
import { Effect, Exit } from "effect"
import { createClient as createNative } from "../src/effect.js"
import { hostedDiscoveryDocument } from "./hosted-discovery.js"

afterEach(() => vi.unstubAllGlobals())

test("builders produce independent default plain-input snapshots without taking attachment-byte ownership", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const embed = builders.embed().title("Initial").field("State", "queued", true)
    const message = builders
        .message()
        .content("hello")
        .embed(embed)
        .attachment({ data: bytes, filename: "fixture.txt" })
        .allowedMentions({ users: ["1"], roles: ["2"] })

    const first: MessageInput = message.build()
    embed.title("Later").field("State", "sent")
    message
        .content("updated")
        .embed(embed)
        .allowedMentions({ users: ["3"] })
    const second: MessageInput = message.build()

    expect(first).toEqual({
        content: "hello",
        embeds: [{ title: "Initial", fields: [{ name: "State", value: "queued", inline: true }] }],
        attachments: [{ data: bytes, filename: "fixture.txt" }],
        allowedMentions: { users: ["1"], roles: ["2"] },
    })
    expect(second.embeds).toEqual([
        { title: "Initial", fields: [{ name: "State", value: "queued", inline: true }] },
        {
            title: "Later",
            fields: [
                { name: "State", value: "queued", inline: true },
                { name: "State", value: "sent" },
            ],
        },
    ])
    expect(first.attachments![0]).not.toBe(message.build().attachments![0])
    expect(first.attachments![0]!.data).toBe(bytes)
    expect(first.allowedMentions!.users).not.toBe(second.allowedMentions!.users)
    expect(Object.isFrozen(first)).toBe(false)
})

test("embed builder snapshots raw inputs and native entry exports the same optional builder surface", () => {
    const raw = {
        title: "Raw",
        author: { name: "Author" },
        fields: [{ name: "Field", value: "value" }],
    } satisfies EmbedInput
    const payload = nativeBuilders.message().embed(raw).build()
    raw.author!.name = "Changed"
    raw.fields[0]!.value = "changed"

    expect(payload).toEqual({
        embeds: [{ title: "Raw", author: { name: "Author" }, fields: [{ name: "Field", value: "value" }] }],
    })
})

test("an empty message builder cannot build until a body field is selected", () => {
    const empty = builders.message()
    // @ts-expect-error A message builder needs content, an embed, an attachment or a sticker before build
    if (false) empty.build()
    // @ts-expect-error Empty variadic calls cannot claim that a body was selected
    if (false) empty.addEmbeds().build()
    // @ts-expect-error Empty variadic calls cannot claim that a body was selected
    if (false) empty.addAttachments().build()
    // @ts-expect-error Empty variadic calls cannot claim that a body was selected
    if (false) empty.addStickers().build()
    const sticker: MessageInput = empty.sticker("7").build()
    expect(sticker).toEqual({ stickerIds: ["7"] })
})

test("direct message builders keep their body state internal across both public entries", () => {
    const direct = new MessageBuilder()
    const nativeDirect = new NativeMessageBuilder()

    // @ts-expect-error MessageBuilder's body state is not caller-selectable
    if (false) new MessageBuilder<true>().build()
    // @ts-expect-error A boolean type argument cannot make an empty builder buildable
    if (false) new MessageBuilder<boolean>().build()
    // @ts-expect-error A union type argument cannot make an empty builder buildable
    if (false) new MessageBuilder<true | false>().build()
    // @ts-expect-error A never type argument cannot make an empty builder buildable
    if (false) new MessageBuilder<never>().build()

    expect(NativeMessageBuilder).toBe(MessageBuilder)
    expect(direct).toBeInstanceOf(MessageBuilder)
    expect(nativeDirect).toBeInstanceOf(MessageBuilder)
    expect((direct as unknown as { build(): object }).build()).toEqual({})
})

test("builders snapshot supported structural getter fields across both public entries", async () => {
    class GetterAuthor implements EmbedAuthorInput {
        readonly #name: string

        constructor(name: string) {
            this.#name = name
        }

        get name() {
            return this.#name
        }

        get url() {
            return "https://example.com/author"
        }
    }

    class GetterFooter implements EmbedFooterInput {
        get text() {
            return "Footer"
        }
    }

    class GetterMedia implements EmbedMediaInput {
        readonly #url: string

        constructor(url: string) {
            this.#url = url
        }

        get url() {
            return this.#url
        }

        get description() {
            return "Alternative text"
        }
    }

    class GetterField implements EmbedFieldInput {
        get name() {
            return "Field"
        }

        get value() {
            return "Value"
        }

        get inline() {
            return true
        }
    }

    class GetterEmbed implements EmbedInput {
        readonly #author = new GetterAuthor("Author")

        get title() {
            return "Getter title"
        }

        get author() {
            return this.#author
        }

        get fields() {
            return [new GetterField()]
        }
    }

    class OwnHiddenEmbed implements EmbedInput {
        declare readonly title: string

        constructor() {
            Object.defineProperty(this, "title", { value: "Own non-enumerable title" })
        }
    }

    class GetterAttachment {
        constructor(readonly data: Uint8Array) {}

        get filename() {
            return "getter.txt"
        }

        get title() {
            return "Getter attachment"
        }
    }

    class GetterMentions implements AllowedMentions {
        get users() {
            return ["1"]
        }

        get roles() {
            return ["2"]
        }

        get everyone() {
            return true
        }

        get repliedUser() {
            return true
        }
    }

    class GetterReference implements MessageReference {
        get id() {
            return "3"
        }

        get channelId() {
            return "20"
        }
    }

    const bytes = new Uint8Array([1, 2, 3])
    const message = builders
        .message()
        .embed(new GetterEmbed())
        .addEmbeds(new GetterEmbed())
        .attachment(new GetterAttachment(bytes) satisfies AttachmentInput)
        .allowedMentions(new GetterMentions())
        .reference(new GetterReference())
        .build()

    expect(message).toEqual({
        embeds: [
            {
                title: "Getter title",
                author: { name: "Author", url: "https://example.com/author" },
                fields: [{ name: "Field", value: "Value", inline: true }],
            },
            {
                title: "Getter title",
                author: { name: "Author", url: "https://example.com/author" },
                fields: [{ name: "Field", value: "Value", inline: true }],
            },
        ],
        attachments: [{ data: bytes, filename: "getter.txt", title: "Getter attachment" }],
        allowedMentions: { users: ["1"], roles: ["2"], everyone: true, repliedUser: true },
        messageReference: { id: "3", channelId: "20" },
    })
    expect(message.attachments![0]!.data).toBe(bytes)

    expect(
        nativeBuilders
            .embed()
            .author(new GetterAuthor("Author"))
            .footer(new GetterFooter())
            .image(new GetterMedia("https://example.com/image.png"))
            .thumbnail(new GetterMedia("https://example.com/thumbnail.png"))
            .addFields(new GetterField())
            .build(),
    ).toEqual({
        author: { name: "Author", url: "https://example.com/author" },
        footer: { text: "Footer" },
        image: { url: "https://example.com/image.png", description: "Alternative text" },
        thumbnail: { url: "https://example.com/thumbnail.png", description: "Alternative text" },
        fields: [{ name: "Field", value: "Value", inline: true }],
    })

    const hiddenTitle = new OwnHiddenEmbed()
    const directInput: MessageInput = { embeds: [new GetterEmbed(), hiddenTitle] }
    const expectedEmbeds = [
        {
            title: "Getter title",
            author: { name: "Author", url: "https://example.com/author" },
            fields: [{ name: "Field", value: "Value", inline: true }],
        },
        { title: "Own non-enumerable title" },
    ]
    const requests: { embeds?: unknown }[] = []
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : String(input)
            if (url === "https://fluxer.app/.well-known/fluxer") {
                if (init?.method !== "GET") throw new Error(`Unexpected fetch: ${init?.method} ${url}`)
                return Response.json(hostedDiscoveryDocument)
            }
            if (url !== "https://api.fluxer.app/v1/channels/20/messages" || init?.method !== "POST")
                throw new Error(`Unexpected fetch: ${init?.method} ${url}`)
            if (typeof init?.body !== "string") throw new Error("Message fetch body must be JSON text")
            requests.push(JSON.parse(init.body) as { embeds?: unknown })
            return new Response(
                JSON.stringify({ id: "10", channel_id: "20", content: "", author: { id: "30", username: "fixture" } }),
                { headers: { "content-type": "application/json" } },
            )
        }),
    )

    const defaultClient = createClient({ token: "fixture-only-not-a-credential" })
    if (defaultClient.isErr()) throw defaultClient.error
    try {
        const direct = await defaultClient.value.messages.send("20", directInput)
        if (direct.isErr()) throw direct.error
        const built = await defaultClient.value.messages.send(
            "20",
            builders.message().addEmbeds(new GetterEmbed(), hiddenTitle).build(),
        )
        if (built.isErr()) throw built.error
    } finally {
        await defaultClient.value.shutdown()
    }

    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                yield* client.messages.send("20", directInput)
                yield* client.messages.send(
                    "20",
                    nativeBuilders.message().addEmbeds(new GetterEmbed(), hiddenTitle).build(),
                )
            }),
        ),
    )

    expect(requests.map((request) => request.embeds)).toEqual([
        expectedEmbeds,
        expectedEmbeds,
        expectedEmbeds,
        expectedEmbeds,
    ])
})

test("builders leave unknown own input fields for default and native operation validation", async () => {
    class UnknownEmbed implements EmbedInput {
        readonly unsupported = true

        get title() {
            return "Known title"
        }
    }

    const defaultClient = createClient({ token: "fixture-only-not-a-credential" })
    if (defaultClient.isErr()) throw defaultClient.error
    const defaultPayload = builders.message().embed(new UnknownEmbed()).build()
    const defaultResult = await defaultClient.value.messages.send("20", defaultPayload)
    await defaultClient.value.shutdown()

    expect(defaultResult.isErr()).toBe(true)
    if (defaultResult.isErr())
        expect(defaultResult.error).toMatchObject({
            _tag: "MessageError",
            reason: "input",
            inputValidation: { path: "embeds[]", constraint: "allowedFields" },
        })

    const nativeResult = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                return yield* Effect.exit(
                    client.messages.send("20", nativeBuilders.message().embed(new UnknownEmbed()).build()),
                )
            }),
        ),
    )

    expect(Exit.isFailure(nativeResult)).toBe(true)
    if (Exit.isFailure(nativeResult)) {
        const failure = nativeResult.cause.reasons.find((reason) => reason._tag === "Fail")
        expect(failure?.error).toMatchObject({
            _tag: "MessageError",
            reason: "input",
            inputValidation: { path: "embeds[]", constraint: "allowedFields" },
        })
    }
})

test("builders leave malformed mention selections for default and native operation validation", async () => {
    const invalidSelections = [
        { path: "allowedMentions.users", value: { users: "2222222222222222222" } },
        { path: "allowedMentions.roles", value: { roles: "2222222222222222222" } },
        { path: "allowedMentions.users", value: { users: new Set(["2222222222222222222"]) } },
        { path: "allowedMentions.roles", value: { roles: new Set(["2222222222222222222"]) } },
    ] as const
    const fetch = vi.fn(async () => {
        throw new Error("Malformed mention selections must not start a request")
    })
    vi.stubGlobal("fetch", fetch)

    const defaultClient = createClient({ token: "fixture-only-not-a-credential" })
    if (defaultClient.isErr()) throw defaultClient.error
    try {
        for (const { path, value } of invalidSelections) {
            const result = await defaultClient.value.messages.send(
                "20",
                builders
                    .message()
                    .content("x")
                    .allowedMentions(value as unknown as AllowedMentions)
                    .build(),
            )
            expect(result.isErr()).toBe(true)
            if (result.isErr())
                expect(result.error).toMatchObject({
                    _tag: "MessageError",
                    reason: "input",
                    inputValidation: { path, constraint: "type" },
                })
        }
    } finally {
        await defaultClient.value.shutdown()
    }

    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                for (const { path, value } of invalidSelections) {
                    const result = yield* Effect.exit(
                        client.messages.send(
                            "20",
                            nativeBuilders
                                .message()
                                .content("x")
                                .allowedMentions(value as unknown as AllowedMentions)
                                .build(),
                        ),
                    )
                    expect(Exit.isFailure(result)).toBe(true)
                    if (Exit.isFailure(result)) {
                        const failure = result.cause.reasons.find((reason) => reason._tag === "Fail")
                        expect(failure?.error).toMatchObject({
                            _tag: "MessageError",
                            reason: "input",
                            inputValidation: { path, constraint: "type" },
                        })
                    }
                }
            }),
        ),
    )

    expect(fetch).not.toHaveBeenCalled()
})

test("builders preserve non-record nested inputs for default and native operation validation", async () => {
    const inputs = [
        ...[null, {}, "fields"].map((fields) => ({
            path: "embeds[].fields",
            direct: { embeds: [{ fields }] } as unknown as MessageInput,
            defaultBuilder: () =>
                builders
                    .message()
                    .embed({ fields } as unknown as EmbedInput)
                    .build(),
            nativeBuilder: () =>
                nativeBuilders
                    .message()
                    .embed({ fields } as unknown as EmbedInput)
                    .build(),
        })),
        {
            path: "allowedMentions",
            direct: { content: "x", allowedMentions: null } as unknown as MessageInput,
            defaultBuilder: () =>
                builders
                    .message()
                    .content("x")
                    .allowedMentions(null as unknown as AllowedMentions)
                    .build(),
            nativeBuilder: () =>
                nativeBuilders
                    .message()
                    .content("x")
                    .allowedMentions(null as unknown as AllowedMentions)
                    .build(),
        },
        {
            path: "allowedMentions",
            direct: { content: "x", allowedMentions: [] } as unknown as MessageInput,
            defaultBuilder: () =>
                builders
                    .message()
                    .content("x")
                    .allowedMentions([] as unknown as AllowedMentions)
                    .build(),
            nativeBuilder: () =>
                nativeBuilders
                    .message()
                    .content("x")
                    .allowedMentions([] as unknown as AllowedMentions)
                    .build(),
        },
        {
            path: "embeds[]",
            direct: { embeds: [null] } as unknown as MessageInput,
            defaultBuilder: () =>
                builders
                    .message()
                    .embed(null as unknown as EmbedInput)
                    .build(),
            nativeBuilder: () =>
                nativeBuilders
                    .message()
                    .embed(null as unknown as EmbedInput)
                    .build(),
        },
    ] as const
    const fetch = vi.fn(async () => {
        throw new Error("Malformed nested inputs must not start a request")
    })
    vi.stubGlobal("fetch", fetch)
    const expectInputFailure = (error: unknown, path: string) =>
        expect(error).toMatchObject({
            _tag: "MessageError",
            reason: "input",
            inputValidation: { path, constraint: "type" },
        })

    const defaultClient = createClient({ token: "fixture-only-not-a-credential" })
    if (defaultClient.isErr()) throw defaultClient.error
    try {
        for (const { path, direct, defaultBuilder } of inputs) {
            const directResult = await defaultClient.value.messages.send("20", direct)
            expect(directResult.isErr()).toBe(true)
            if (directResult.isErr()) expectInputFailure(directResult.error, path)

            const builderResult = await defaultClient.value.messages.send("20", defaultBuilder())
            expect(builderResult.isErr()).toBe(true)
            if (builderResult.isErr()) expectInputFailure(builderResult.error, path)
        }
    } finally {
        await defaultClient.value.shutdown()
    }

    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                for (const { path, direct, nativeBuilder } of inputs) {
                    for (const input of [direct, nativeBuilder()]) {
                        const result = yield* Effect.exit(client.messages.send("20", input))
                        expect(Exit.isFailure(result)).toBe(true)
                        if (Exit.isFailure(result)) {
                            const failure = result.cause.reasons.find((reason) => reason._tag === "Fail")
                            expectInputFailure(failure?.error, path)
                        }
                    }
                }
            }),
        ),
    )

    expect(fetch).not.toHaveBeenCalled()
})

test("structural getter failures escape builder calls", () => {
    const failure = new Error("getter failure")
    const author: EmbedAuthorInput = Object.create(null, {
        name: {
            get() {
                throw failure
            },
        },
    })

    expect(() => builders.embed().author(author)).toThrow(failure)
})
