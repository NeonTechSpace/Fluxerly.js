import { Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { ChannelType, createWebhookClient, type Client, type WebhookClient } from "../../src/index.js"
import {
    createWebhookClient as createNativeWebhookClient,
    type Client as NativeClient,
    type WebhookClient as NativeWebhookClient,
} from "../../src/effect.js"
import { defaultApi, modes, nativeApi, type Mode } from "../support/both-apis.js"
import { hostedOperationCalls, stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"

const member = { guildId: "20", userId: "30" }
const sticker = { guildId: "20", id: "40" }
const image = "aW1hZ2U="

type Clients = {
    readonly defaultApi?: Client
    readonly native?: NativeClient
}
type WebhookClients = {
    readonly defaultApi?: WebhookClient
    readonly native?: NativeWebhookClient
}

const wireUser = (id: string) => ({
    id,
    username: "fixture",
    discriminator: "0001",
    global_name: "Fixture",
    avatar: null,
    avatar_color: null,
    flags: 0,
    bot: false,
})
const wireMember = (nickname: string | null = null) => ({
    user: wireUser("30"),
    roles: [],
    joined_at: "2026-09-21T00:00:00.000Z",
    nick: nickname,
})
const wireGroup = (extra: Record<string, unknown> = {}) => ({
    id: "10",
    type: 3,
    recipients: [wireUser("30")],
    name: "fixture group",
    icon: null,
    owner_id: "30",
    nicks: {},
    last_message_id: null,
    ...extra,
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

function unwrap<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

async function inputFailure<A>(operation: ResultAsync<A, unknown> | Effect.Effect<A, unknown>, path: string) {
    await expect(settle(operation)).rejects.toMatchObject({
        reason: "input",
        inputValidation: { path },
    })
}

async function rejected<A>(operation: ResultAsync<A, unknown> | Effect.Effect<A, unknown>) {
    await expect(settle(operation)).rejects.toMatchObject({ reason: "rejected", outcome: "rejected", status: 403 })
}

async function clients(mode: Mode): Promise<Clients> {
    return mode === "default"
        ? { defaultApi: defaultApi({ token: "fixture" }) }
        : { native: await nativeApi({ token: "fixture" }) }
}

async function webhookClients(mode: Mode): Promise<WebhookClients> {
    const scope = Scope.makeUnsafe()
    const options = { id: "100", token: "fixture_secret" }
    const defaultApi = mode === "default" ? createWebhookClient(options) : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(createNativeWebhookClient(options).pipe(Scope.provide(scope)))
            : undefined
    onTestFinished(async () => {
        if (defaultApi) unwrap(await defaultApi.shutdown())
        if (native) await Effect.runPromise(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return { ...(defaultApi ? { defaultApi } : {}), ...(native ? { native } : {}) }
}

function exactUnits(maximum: number): string {
    if (maximum < 4) return "a".repeat(maximum)
    return `${"a".repeat(maximum - 4)}e\u0301\ud800a`
}

function paddedMaximum(maximum: number): string {
    return ` \f\u202e${exactUnits(maximum)} `
}

function astralAt(maximum: number): string {
    return "😀".repeat(maximum / 2)
}

function astralOver(maximum: number): string {
    return `${astralAt(maximum)}a`
}

function customNameAtRawLimit(): string {
    const core = `${"a".repeat(95)}\ufe0f\ud800   bc`
    return `  ${"\u200d\u200e".repeat(4_947)}${core}  `
}

type BoundaryApis = {
    readonly client: Client | NativeClient
    readonly webhook: WebhookClient | NativeWebhookClient
}
type BoundaryCase = readonly [
    label: string,
    path: string,
    call: (apis: BoundaryApis) => ResultAsync<unknown, unknown> | Effect.Effect<unknown, unknown>,
]

const messageTarget = { channelId: "50", id: "60" }
const textBoundaryCases: readonly BoundaryCase[] = [
    ["members.editSelf empty nickname", "nickname", ({ client }) => client.members.editSelf("20", { nickname: "" })],
    [
        "members.editSelf bidi-control nickname",
        "nickname",
        ({ client }) => client.members.editSelf("20", { nickname: "‮" }),
    ],
    ...[
        ["astral", "😀".repeat(17)],
        ["ASCII", "a".repeat(33)],
    ].flatMap(([kind, nickname]): BoundaryCase[] => [
        [
            `members.editSelf over-limit ${kind} nickname`,
            "nickname",
            ({ client }) => client.members.editSelf("20", { nickname: nickname! }),
        ],
        [
            `members.setNickname over-limit ${kind} nickname`,
            "nickname",
            ({ client }) => client.members.setNickname(member, nickname!),
        ],
    ]),
    ["members.editSelf over-limit bio", "bio", ({ client }) => client.members.editSelf("20", { bio: astralOver(320) })],
    ["members.editSelf bidi-control bio", "bio", ({ client }) => client.members.editSelf("20", { bio: "‮" })],
    [
        "members.editSelf over-limit pronouns",
        "pronouns",
        ({ client }) => client.members.editSelf("20", { pronouns: astralOver(40) }),
    ],
    [
        "members.editSelf bidi-control pronouns",
        "pronouns",
        ({ client }) => client.members.editSelf("20", { pronouns: "‮" }),
    ],
    ["members.setNickname empty nickname", "nickname", ({ client }) => client.members.setNickname(member, "")],
    ["guilds.edit over-limit name", "name", ({ client }) => client.guilds.edit("20", { name: astralOver(100) })],
    ["guilds.edit bidi-control name", "name", ({ client }) => client.guilds.edit("20", { name: "‮" })],
    [
        "guilds.edit over-limit contentWarningText",
        "contentWarningText",
        ({ client }) => client.guilds.edit("20", { contentWarningText: astralOver(200) }),
    ],
    ["roles.create over-limit name", "name", ({ client }) => client.roles.create("20", { name: astralOver(100) })],
    ["roles.create bidi-control name", "name", ({ client }) => client.roles.create("20", { name: "‮" })],
    [
        "members.timeout over-limit timeoutReason",
        "options.timeoutReason",
        ({ client }) => client.members.timeout(member, 60_000, { timeoutReason: astralOver(512) }),
    ],
    [
        "members.timeout bidi-control timeoutReason",
        "options.timeoutReason",
        ({ client }) => client.members.timeout(member, 60_000, { timeoutReason: "‮" }),
    ],
    [
        "members.ban over-limit reason",
        "input.reason",
        ({ client }) => client.members.ban(member, { reason: astralOver(512) }),
    ],
    [
        "members.move over-limit connectionId",
        "target.connectionId",
        ({ client }) => client.members.move({ ...member, connectionId: astralOver(32) }, "50"),
    ],
    [
        "members.move bidi-control connectionId",
        "target.connectionId",
        ({ client }) => client.members.move({ ...member, connectionId: "‮" }, "50"),
    ],
    [
        "channels.create name over the raw limit",
        "name",
        ({ client }) => client.channels.create("20", { type: ChannelType.Text, name: `${customNameAtRawLimit()}‍` }),
    ],
    [
        "channels.create name with a trailing variation selector",
        "name",
        ({ client }) => client.channels.create("20", { type: ChannelType.Text, name: `${"a".repeat(100)}️` }),
    ],
    [
        "channels.create name with a trailing lone surrogate",
        "name",
        ({ client }) => client.channels.create("20", { type: ChannelType.Text, name: `${"a".repeat(100)}\ud800` }),
    ],
    [
        "channels.create over-limit topic",
        "topic",
        ({ client }) =>
            client.channels.create("20", { type: ChannelType.Text, name: "valid", topic: astralOver(1024) }),
    ],
    [
        "channels.create bidi-control topic",
        "topic",
        ({ client }) => client.channels.create("20", { type: ChannelType.Text, name: "valid", topic: "‮" }),
    ],
    [
        "channels.create over-limit contentWarningText",
        "contentWarningText",
        ({ client }) =>
            client.channels.create("20", {
                type: ChannelType.Text,
                name: "valid",
                contentWarningText: astralOver(200),
            }),
    ],
    [
        "channels.edit over-limit rtcRegion",
        "rtcRegion",
        ({ client }) => client.channels.edit("50", { rtcRegion: astralOver(64) }),
    ],
    [
        "channels.edit bidi-control rtcRegion",
        "rtcRegion",
        ({ client }) => client.channels.edit("50", { rtcRegion: "‮" }),
    ],
    ["stickers.create under-limit name", "name", ({ client }) => client.stickers.create("20", { name: "a", image })],
    ["stickers.create bidi-control name", "name", ({ client }) => client.stickers.create("20", { name: "‮‮", image })],
    [
        "stickers.create bidi-control description",
        "description",
        ({ client }) => client.stickers.create("20", { name: "valid", description: "‮", image }),
    ],
    [
        "stickers.create over-limit name",
        "name",
        ({ client }) => client.stickers.create("20", { name: astralOver(30), image }),
    ],
    [
        "stickers.create over-limit description",
        "description",
        ({ client }) =>
            client.stickers.create("20", { name: "valid", description: astralOver(500), tags: ["tag"], image }),
    ],
    [
        "stickers.create over-limit tag",
        "tags[]",
        ({ client }) => client.stickers.create("20", { name: "valid", tags: [astralOver(30)], image }),
    ],
    [
        "stickers.create bidi-control tag",
        "tags[]",
        ({ client }) => client.stickers.create("20", { name: "valid", tags: ["‮"], image }),
    ],
    ["webhooks.create over-limit name", "name", ({ client }) => client.webhooks.create("50", { name: astralOver(80) })],
    ["webhooks.create bidi-control name", "name", ({ client }) => client.webhooks.create("50", { name: "‮" })],
    [
        "webhook send over-limit username",
        "username",
        ({ webhook }) => webhook.send({ content: "fixture", username: astralOver(80) }),
    ],
    [
        "webhook send bidi-control username",
        "username",
        ({ webhook }) => webhook.send({ content: "fixture", username: "‮" }),
    ],
    [
        "directMessages.editGroup name over the raw limit",
        "input",
        ({ client }) => client.directMessages.editGroup("10", { name: `${customNameAtRawLimit()}‍` }),
    ],
    [
        "directMessages.editGroup empty nickname",
        "nicknames",
        ({ client }) => client.directMessages.editGroup("10", { nicknames: { "30": "" } }),
    ],
    [
        "messages.edit over-limit embed title",
        "embeds[].title",
        ({ client }) =>
            client.messages.edit(messageTarget, { content: "fixture", embeds: [{ title: astralOver(256) }] }),
    ],
    [
        "messages.edit blank retained-attachment description",
        "attachments[].description",
        ({ client }) =>
            client.messages.edit(messageTarget, { content: "fixture", attachments: [{ id: "70", description: " " }] }),
    ],
    [
        "messages.edit blank embed author name",
        "embeds[].author.name",
        ({ client }) =>
            client.messages.edit(messageTarget, { content: "fixture", embeds: [{ author: { name: " " } }] }),
    ],
    [
        "messages.edit blank embed description",
        "embeds[].description",
        ({ client }) => client.messages.edit(messageTarget, { content: "fixture", embeds: [{ description: " " }] }),
    ],
    [
        "messages.send blank attachment title",
        "attachments[].title",
        ({ client }) =>
            client.messages.send("50", {
                content: "fixture",
                attachments: [{ filename: "fixture.txt", data: new Uint8Array(), title: " " }],
            }),
    ],
]

test.each(modes.flatMap((mode) => textBoundaryCases.map(([label, path, call]) => [mode, label, path, call] as const)))(
    "%s rejects the %s text boundary locally at path %s with no fetch",
    async (mode, _label, path, call) => {
        const fetch = vi.fn()
        vi.stubGlobal("fetch", fetch)
        const { defaultApi, native } = await clients(mode)
        const webhook = await webhookClients(mode)

        await inputFailure(
            call({ client: defaultApi ?? native!, webhook: webhook.defaultApi ?? webhook.native! }),
            path,
        )
        expect(fetch).not.toHaveBeenCalled()
    },
)

test.each(modes)("%s preserves valid member-profile and nickname wire values", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        bodies.push(body)
        return Response.json(wireMember(null))
    })
    const { defaultApi, native } = await clients(mode)
    const nickname = paddedMaximum(32)
    const bio = paddedMaximum(320)
    const pronouns = ` \f\u202e${astralAt(40)} `

    const edited = await settle(
        defaultApi
            ? defaultApi.members.editSelf("20", { nickname, bio, pronouns })
            : native!.members.editSelf("20", { nickname, bio, pronouns }),
    )
    const trimBlank = await settle(
        defaultApi ? defaultApi.members.setNickname(member, "\f") : native!.members.setNickname(member, "\f"),
    )
    await settle(defaultApi ? defaultApi.members.setNickname(member, null) : native!.members.setNickname(member, null))
    for (const admitted of ["😀".repeat(16), "a".repeat(32)]) {
        await settle(
            defaultApi
                ? defaultApi.members.editSelf("20", { nickname: admitted })
                : native!.members.editSelf("20", { nickname: admitted }),
        )
        await settle(
            defaultApi
                ? defaultApi.members.setNickname(member, admitted)
                : native!.members.setNickname(member, admitted),
        )
    }

    expect(edited.nickname).toBeNull()
    expect(trimBlank.nickname).toBeNull()
    expect(bodies).toEqual([
        { nick: nickname, bio, pronouns },
        { nick: "\f" },
        { nick: null },
        { nick: "😀".repeat(16) },
        { nick: "😀".repeat(16) },
        { nick: "a".repeat(32) },
        { nick: "a".repeat(32) },
    ])
})

test.each(modes)("%s preserves normalized guild and role text while warnings remain raw", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(null, { status: 403 })
    })
    const { defaultApi, native } = await clients(mode)
    const guildName = paddedMaximum(100)
    const roleName = ` \f\u202e${astralAt(100)} `
    const rawWarning = astralAt(200)

    await rejected(
        defaultApi
            ? defaultApi.guilds.edit("20", { name: guildName, contentWarningText: rawWarning })
            : native!.guilds.edit("20", { name: guildName, contentWarningText: rawWarning }),
    )
    await rejected(
        defaultApi
            ? defaultApi.guilds.edit("20", { contentWarningText: "" })
            : native!.guilds.edit("20", { contentWarningText: "" }),
    )
    await rejected(
        defaultApi ? defaultApi.roles.create("20", { name: roleName }) : native!.roles.create("20", { name: roleName }),
    )

    expect(bodies).toEqual([
        { name: guildName, content_warning_text: rawWarning },
        { content_warning_text: "" },
        { name: roleName, color: 0, permissions: "0" },
    ])
})

test.each(modes)("%s preserves timeout, ban, and voice connection wire text", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(null, { status: 403 })
    })
    const { defaultApi, native } = await clients(mode)
    const timeoutReason = paddedMaximum(512)
    const banReason = ` \f\u202e${astralAt(512)} `
    const connectionId = paddedMaximum(32)

    await rejected(
        defaultApi
            ? defaultApi.members.timeout(member, 60_000, { timeoutReason })
            : native!.members.timeout(member, 60_000, { timeoutReason }),
    )
    await rejected(
        defaultApi
            ? defaultApi.members.ban(member, { reason: banReason })
            : native!.members.ban(member, { reason: banReason }),
    )
    await rejected(
        defaultApi ? defaultApi.members.ban(member, { reason: "" }) : native!.members.ban(member, { reason: "" }),
    )
    await rejected(
        defaultApi
            ? defaultApi.members.move({ ...member, connectionId }, "50")
            : native!.members.move({ ...member, connectionId }, "50"),
    )

    expect(bodies[0]).toMatchObject({ timeout_reason: timeoutReason })
    expect(bodies[1]).toEqual({ ban_duration_seconds: 0, delete_message_seconds: 0, reason: banReason })
    expect(bodies[2]).toEqual({ ban_duration_seconds: 0, delete_message_seconds: 0, reason: "" })
    expect(bodies[3]).toEqual({ channel_id: "50", connection_id: connectionId })
})

test.each(modes)("%s preserves channel normalization inputs and raw warnings on the wire", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(null, { status: 403 })
    })
    const { defaultApi, native } = await clients(mode)
    const name = customNameAtRawLimit()
    const topic = paddedMaximum(1024)
    const rawWarning = `${"a".repeat(198)}😀`
    const rtcRegion = ` \f\u202e${astralAt(64)} `

    await rejected(
        defaultApi
            ? defaultApi.channels.create("20", {
                  type: ChannelType.Text,
                  name,
                  topic,
                  contentWarningText: rawWarning,
              })
            : native!.channels.create("20", {
                  type: ChannelType.Text,
                  name,
                  topic,
                  contentWarningText: rawWarning,
              }),
    )
    await rejected(
        defaultApi ? defaultApi.channels.edit("50", { rtcRegion }) : native!.channels.edit("50", { rtcRegion }),
    )
    await rejected(
        defaultApi
            ? defaultApi.channels.edit("50", { contentWarningText: "" })
            : native!.channels.edit("50", { contentWarningText: "" }),
    )

    expect(name.length).toBe(10_000)
    expect(bodies).toEqual([
        { type: ChannelType.Text, name, topic, content_warning_text: rawWarning },
        { rtc_region: rtcRegion },
        { content_warning_text: "" },
    ])
})

test.each(modes)("%s preserves sticker metadata wire text and maps edit-empty descriptions to null", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(null, { status: 403 })
    })
    const { defaultApi, native } = await clients(mode)
    const name = paddedMaximum(30)
    const description = ` \f\u202e${astralAt(500)} `
    const tag = paddedMaximum(30)

    await rejected(
        defaultApi
            ? defaultApi.stickers.create("20", { name: "😀", image })
            : native!.stickers.create("20", { name: "😀", image }),
    )
    await rejected(
        defaultApi
            ? defaultApi.stickers.create("20", { name, description, tags: [tag], image })
            : native!.stickers.create("20", { name, description, tags: [tag], image }),
    )
    await rejected(
        defaultApi
            ? defaultApi.stickers.edit(sticker, { name, description: "", tags: [tag] })
            : native!.stickers.edit(sticker, { name, description: "", tags: [tag] }),
    )

    expect(bodies).toEqual([
        { name: "😀", image, description: null, tags: [] },
        { name, image, description, tags: [tag] },
        { name, description: null, tags: [tag] },
    ])
})

test.each(modes)("%s preserves webhook name and per-message username wire text", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(null, { status: 403 })
    })
    const { defaultApi, native } = await clients(mode)
    const webhook = await webhookClients(mode)
    const name = paddedMaximum(80)
    const username = ` \f\u202e${astralAt(80)} `

    await rejected(defaultApi ? defaultApi.webhooks.create("50", { name }) : native!.webhooks.create("50", { name }))
    await rejected(
        webhook.defaultApi
            ? webhook.defaultApi.send({ content: "fixture", username })
            : webhook.native!.send({ content: "fixture", username }),
    )

    expect(bodies[0]).toEqual({ name })
    expect(bodies[1]).toMatchObject({ content: "fixture", username })
})

test.each(modes)("%s preserves group name and normalized-empty nickname inputs", async (mode) => {
    const patchBodies: Record<string, unknown>[] = []
    const fetch = stubFetchWithHostedDiscovery(async (_url, init) => {
        if (init.method === "GET") return Response.json(wireGroup())
        patchBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(null, { status: 403 })
    })
    const { defaultApi, native } = await clients(mode)
    const name = customNameAtRawLimit()
    const nicknames = { "30": "\u202e" }

    await rejected(
        defaultApi
            ? defaultApi.directMessages.editGroup("10", { name, nicknames })
            : native!.directMessages.editGroup("10", { name, nicknames }),
    )
    await rejected(
        defaultApi
            ? defaultApi.directMessages.editGroup("10", { nicknames: { "30": null } })
            : native!.directMessages.editGroup("10", { nicknames: { "30": null } }),
    )

    expect(patchBodies).toEqual([{ name, nicks: nicknames }, { nicks: { "30": null } }])
    expect(hostedOperationCalls(fetch).map(([, init]) => init?.method)).toEqual(["GET", "PATCH", "GET", "PATCH"])
})

test.each(modes)("%s preserves embed and retained-attachment metadata distinctions", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(null, { status: 403 })
    })
    const { defaultApi, native } = await clients(mode)
    const title = paddedMaximum(256)
    const attachmentDescription = paddedMaximum(4096)
    const input = {
        content: "fixture",
        embeds: [{ title, description: "" }],
        attachments: [{ id: "70", title: null, description: attachmentDescription }],
    }

    await rejected(
        defaultApi
            ? defaultApi.messages.edit({ channelId: "50", id: "60" }, input)
            : native!.messages.edit({ channelId: "50", id: "60" }, input),
    )

    expect(bodies[0]).toMatchObject({
        content: "fixture",
        embeds: [{ title, description: "" }],
        attachments: [{ id: "70", title: null, description: attachmentDescription }],
    })
})
