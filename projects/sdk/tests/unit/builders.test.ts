// oxlint-disable no-constant-condition -- if (false) statements hold compile-time type checks that must never run
import { afterEach, expect, test, vi } from "vitest"
import {
    builders,
    ConfigurationError,
    createClient,
    HelperError,
    MessageBuilder,
    type AllowedMentions,
    type MissingMessageBody,
    type AttachmentInput,
    type EmbedAuthorInput,
    type EmbedFieldInput,
    type EmbedFooterInput,
    type EmbedInput,
    type EmbedMediaInput,
    type MessageInput,
    type MessageReference,
} from "../../src/index.js"
import { builders as nativeBuilders, MessageBuilder as NativeMessageBuilder } from "../../src/effect.js"
import { Effect } from "effect"
import { createClient as createNative } from "../../src/effect.js"
import { modes, setup } from "../support/both-apis.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { expectErr } from "../support/settle.js"

afterEach(() => vi.unstubAllGlobals())

test.each([
    ["default", builders],
    ["native", nativeBuilders],
])("%s EmbedBuilder.field rejects the removed boolean argument and a non-boolean inline", (_mode, api) => {
    for (const options of [true, "yes", null, { inline: "yes" }]) {
        let thrown: unknown
        try {
            api.embed().field("State", "queued", options as never)
        } catch (error) {
            thrown = error
        }
        expect(thrown).toMatchObject({ _tag: "ConfigurationError", field: "embedField" })
        expect((thrown as ConfigurationError).hint).toContain("{ inline: true }")
    }
    expect(api.embed().field("State", "queued", { inline: false }).build().fields).toEqual([
        { name: "State", value: "queued", inline: false },
    ])
})

test("builders produce independent default plain-input snapshots without taking attachment-byte ownership", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const embed = builders.embed().title("Initial").field("State", "queued", { inline: true })
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

test.each([
    ["default", () => builders.embed()],
    ["native", () => nativeBuilders.embed()],
] as const)("%s embed color converts number, hex and RGB input and rejects the rest with HelperError", (_, embed) => {
    expect(embed().color(0xff8800).build()).toEqual({ color: 0xff8800 })
    expect(embed().color("#ff8800").build()).toEqual({ color: 0xff8800 })
    expect(embed().color([255, 136, 0]).build()).toEqual({ color: 0xff8800 })
    expect(embed().color(0).build()).toEqual({ color: 0 })
    for (const invalid of ["#ff88", "orange", [256, 0, 0], [1, 2], -1, 0x1000000, 1.5, NaN])
        expect(() => embed().color(invalid as never)).toThrow(
            expect.objectContaining({ _tag: "HelperError", operation: "embed.color", reason: "color" }),
        )
    const failure = (() => {
        try {
            embed().color("orange")
        } catch (error) {
            return error
        }
    })()
    expect(failure).toBeInstanceOf(HelperError)
})

test.each([
    ["default", () => builders.embed()],
    ["native", () => nativeBuilders.embed()],
] as const)("%s embed timestamp converts Date and epoch input, keeps strings and rejects invalid times", (_, embed) => {
    const instant = "2023-11-14T22:13:20.000Z"
    expect(embed().timestamp(new Date(instant)).build()).toEqual({ timestamp: instant })
    expect(embed().timestamp(Date.parse(instant)).build()).toEqual({ timestamp: instant })
    expect(embed().timestamp(0).build()).toEqual({ timestamp: "1970-01-01T00:00:00.000Z" })
    // Strings stay unchanged for the message operation to validate
    expect(embed().timestamp("2023-11-14T22:13:20+01:00").build()).toEqual({ timestamp: "2023-11-14T22:13:20+01:00" })
    expect(embed().timestamp("not a time").build()).toEqual({ timestamp: "not a time" })
    for (const invalid of [new Date(Number.NaN), Number.NaN, Infinity, 8.64e15 + 1]) {
        const builder = embed()
        let failure: unknown
        try {
            builder.timestamp(invalid)
        } catch (error) {
            failure = error
        }
        expect(failure).toBeInstanceOf(HelperError)
        expect(failure).toMatchObject({ operation: "embed.timestamp", reason: "time" })
        expect(builder.build()).toEqual({})
    }
})

test("an empty message builder cannot build until a body field is selected", () => {
    const empty = builders.message()
    const missing: MissingMessageBody = empty.build
    expect(typeof missing).toBe("function")
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
    try {
        const direct = await defaultClient.messages.send("20", directInput)
        if (direct.isErr()) throw direct.error
        const built = await defaultClient.messages.send(
            "20",
            builders.message().addEmbeds(new GetterEmbed(), hiddenTitle).build(),
        )
        if (built.isErr()) throw built.error
    } finally {
        await defaultClient.shutdown()
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

class UnknownEmbed implements EmbedInput {
    readonly unsupported = true

    get title() {
        return "Known title"
    }
}

type BuilderValidationRow = {
    readonly label: string
    readonly input: (entry: typeof builders) => MessageInput
    readonly path: string
    readonly constraint: string
}

const mentionSelections = [
    { label: "a string", path: "allowedMentions.users", value: { users: "2222222222222222222" } },
    { label: "a string", path: "allowedMentions.roles", value: { roles: "2222222222222222222" } },
    { label: "a Set", path: "allowedMentions.users", value: { users: new Set(["2222222222222222222"]) } },
    { label: "a Set", path: "allowedMentions.roles", value: { roles: new Set(["2222222222222222222"]) } },
] as const

const nestedInputs = [
    ...[null, {}, "fields"].map((fields) => ({
        label: `embed fields ${JSON.stringify(fields)}`,
        path: "embeds[].fields",
        direct: { embeds: [{ fields }] } as unknown as MessageInput,
        built: (entry: typeof builders) =>
            entry
                .message()
                .embed({ fields } as unknown as EmbedInput)
                .build(),
    })),
    ...[null, []].map((allowedMentions) => ({
        label: `allowedMentions ${JSON.stringify(allowedMentions)}`,
        path: "allowedMentions",
        direct: { content: "x", allowedMentions } as unknown as MessageInput,
        built: (entry: typeof builders) =>
            entry
                .message()
                .content("x")
                .allowedMentions(allowedMentions as unknown as AllowedMentions)
                .build(),
    })),
    {
        label: "embed null",
        path: "embeds[]",
        direct: { embeds: [null] } as unknown as MessageInput,
        built: (entry: typeof builders) =>
            entry
                .message()
                .embed(null as unknown as EmbedInput)
                .build(),
    },
]

const builderValidationRows: readonly BuilderValidationRow[] = [
    {
        label: "a built embed with an unknown own field",
        input: (entry) => entry.message().embed(new UnknownEmbed()).build(),
        path: "embeds[]",
        constraint: "allowedFields",
    },
    ...mentionSelections.map(({ label, path, value }) => ({
        label: `built ${path} as ${label}`,
        input: (entry: typeof builders) =>
            entry
                .message()
                .content("x")
                .allowedMentions(value as unknown as AllowedMentions)
                .build(),
        path,
        constraint: "type",
    })),
    ...nestedInputs.flatMap(({ label, path, direct, built }) => [
        { label: `direct ${label}`, input: () => direct, path, constraint: "type" },
        { label: `built ${label}`, input: built, path, constraint: "type" },
    ]),
]

// Builders pass malformed or unknown input through unchanged, so the send operation owns its rejection
test.each(modes.flatMap((mode) => builderValidationRows.map((row) => ({ mode, ...row }))))(
    "$mode send rejects $label at $path with $constraint before fetch",
    async ({ mode, input, path, constraint }) => {
        const fetch = vi.fn(async () => {
            throw new Error("Operation validation must reject the input before a request")
        })
        vi.stubGlobal("fetch", fetch)
        const client = await setup(mode)
        const message = input(mode === "default" ? builders : nativeBuilders)

        expect(await expectErr(client.messages.send("20", message))).toMatchObject({
            _tag: "MessageError",
            reason: "input",
            inputValidation: { path, constraint },
        })
        expect(fetch).not.toHaveBeenCalled()
    },
)

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
