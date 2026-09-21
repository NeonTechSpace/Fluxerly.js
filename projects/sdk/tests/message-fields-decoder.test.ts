import { expect, test, vi } from "vitest"
import { decodeMessage } from "../src/internal/message.js"
import type { MessageField } from "../src/messages.js"

const emptySelection = new Set<MessageField>()
const media = () => ({ url: "https://example.test/media", flags: 0, width: 1, height: 2, duration: 3 })
const embed = () => ({
    type: "rich",
    title: "Title",
    description: "Description",
    url: "https://example.test/embed",
    color: 1,
    timestamp: "2026-09-10T12:00:00.000Z",
    author: { name: "Author", url: "url", icon_url: "icon", proxy_icon_url: "proxy" },
    footer: { text: "Footer", icon_url: "icon", proxy_icon_url: "proxy" },
    image: media(),
    thumbnail: media(),
    fields: [{ name: "Field", value: "Value", inline: false }],
    provider: { name: "Provider" },
    video: media(),
    audio: media(),
    html: "html",
    html_width: 1,
    html_height: 2,
    nsfw: false,
})
const attachment = () => ({
    id: "4",
    filename: "file.txt",
    size: 1,
    flags: 0,
    title: "Title",
    description: "Description",
    content_type: "text/plain",
    content_hash: "hash",
    url: "url",
    proxy_url: "proxy",
    placeholder: "placeholder",
    waveform: "waveform",
    expires_at: "expires",
    width: 1,
    height: 2,
    duration: 3,
    nsfw: false,
    expired: false,
})
const sticker = () => ({ id: "5", name: "Sticker", animated: false })
const channel = () => ({ id: "6", name: "Channel", type: 0 })
const wire = () => ({
    id: "1",
    channel_id: "2",
    content: "Content",
    guild_id: "3",
    author: { id: "7", username: "fixture", bot: false },
    nonce: null,
    webhook_id: "8",
    pinned: false,
    timestamp: "2026-09-10T12:00:00.000Z",
    edited_timestamp: null,
    type: 0,
    flags: 0,
    mention_everyone: false,
    embeds: [{ ...embed(), children: [embed()] }],
    attachments: [attachment()],
    stickers: [sticker()],
    mentions: [{ id: "9", username: "mentioned", bot: false }],
    mention_roles: ["10"],
    mention_channels: [channel()],
    reactions: [{ emoji: { name: "wave", id: null, animated: null }, count: 1, me: null }],
    message_reference: { message_id: "11", channel_id: "12", guild_id: null, type: 1 },
    referenced_message: {
        id: "11",
        channel_id: "12",
        content: "reply context",
        author: { id: "13", username: "reply-author", bot: true },
    },
    message_snapshots: [
        {
            content: null,
            timestamp: "2026-09-10T12:00:00.000Z",
            edited_timestamp: null,
            type: 0,
            flags: 0,
            mentions: ["9"],
            mention_roles: ["10"],
            mention_channels: [channel()],
            embeds: [{ ...embed(), children: [embed()] }],
            attachments: [attachment()],
            stickers: [sticker()],
        },
    ],
    unknown_future_field: { private: "not copied" },
})

test("empty and subset selections retain the mandatory core and omit excluded own keys", () => {
    const value = wire()
    const full = decodeMessage(value)!
    expect(decodeMessage(value, undefined)).toEqual(full)
    const core = decodeMessage(value, emptySelection)!
    expect(Reflect.ownKeys(core).sort()).toEqual(["author", "channelId", "content", "guildId", "id"])
    const subset = decodeMessage(value, new Set<MessageField>(["nonce", "embeds", "messageReference"]))!
    expect(Reflect.ownKeys(subset).sort()).toEqual([
        "author",
        "channelId",
        "content",
        "embeds",
        "guildId",
        "id",
        "messageReference",
        "nonce",
    ])
    for (const key of Reflect.ownKeys(subset))
        expect(subset[key as keyof typeof subset]).toEqual(full[key as keyof typeof full])
    expect(Object.hasOwn(full, "unknown_future_field")).toBe(false)
    expect(Object.hasOwn(core, "attachments")).toBe(false)
    expect(Object.hasOwn(core, "nonce")).toBe(false)
})

test("selected nested projections are copied and frozen, including complete forward snapshots", () => {
    const value = wire()
    const selected = decodeMessage(value, new Set<MessageField>(["embeds", "messageSnapshots"]))!
    const full = decodeMessage(value)!
    expect(selected.messageSnapshots).toEqual(full.messageSnapshots)
    expect(selected.embeds).toEqual(full.embeds)
    expect(Object.hasOwn(selected, "attachments")).toBe(false)
    expect(selected.messageSnapshots![0]!.attachments).toEqual(full.attachments)
    const frozen: unknown[] = [
        selected,
        selected.author,
        selected.embeds,
        selected.embeds![0],
        selected.embeds![0]!.author,
        selected.embeds![0]!.fields,
        selected.embeds![0]!.fields![0],
        selected.embeds![0]!.children,
        selected.embeds![0]!.children![0],
        selected.messageSnapshots,
        selected.messageSnapshots![0],
        selected.messageSnapshots![0]!.attachments,
        selected.messageSnapshots![0]!.attachments![0],
        selected.messageSnapshots![0]!.mentionChannels,
        selected.messageSnapshots![0]!.mentionChannels![0],
    ]
    for (const projected of frozen) expect(Object.isFrozen(projected)).toBe(true)
    value.embeds[0]!.author.name = "changed"
    value.message_snapshots[0]!.attachments[0]!.filename = "changed.txt"
    expect(selected.embeds![0]!.author!.name).toBe("Author")
    expect(selected.messageSnapshots![0]!.attachments![0]!.filename).toBe("file.txt")
})

test("excluded groups perform no projected freezes while retained output still freezes", () => {
    const value = wire()
    const freeze = vi.spyOn(Object, "freeze")
    try {
        const result = decodeMessage(value, emptySelection)!
        expect(freeze.mock.calls.map(([projected]) => projected)).toEqual([result.author, result])
    } finally {
        freeze.mockRestore()
    }
})

test("selection preserves optional omission, explicit nulls, array defaults and sparse identifier acceptance", () => {
    const minimal = { id: "1", channel_id: "2", content: "", author: { id: "3", username: "fixture" } }
    expect(decodeMessage(minimal)).toEqual({
        id: "1",
        channelId: "2",
        content: "",
        author: { id: "3", username: "fixture", isBot: false },
        embeds: [],
        attachments: [],
        stickers: [],
    })
    const projected = decodeMessage(
        {
            ...minimal,
            nonce: null,
            mention_channels: null,
            reactions: null,
            message_reference: null,
            referenced_message: null,
            message_snapshots: null,
            webhook_id: null,
        },
        new Set<MessageField>([
            "nonce",
            "mentionChannels",
            "reactions",
            "messageReference",
            "referencedMessage",
            "messageSnapshots",
            "webhookId",
        ]),
    )!
    for (const key of [
        "nonce",
        "mentionChannels",
        "reactions",
        "messageReference",
        "referencedMessage",
        "messageSnapshots",
    ] as const)
        expect(projected[key]).toBeNull()
    expect(Object.hasOwn(projected, "webhookId")).toBe(false)
    expect(Object.hasOwn(projected, "guildId")).toBe(false)
    const sparse = { ...minimal, mention_roles: new Array(1) }
    expect(decodeMessage(sparse)!.mentionRoleIds).toEqual([undefined])
    expect(decodeMessage(sparse, emptySelection)).toBeDefined()
})

const malformed: [string, unknown][] = [
    ["id", "bad"],
    ["channel_id", "bad"],
    ["content", null],
    ["guild_id", null],
    ["author", null],
    ["author.id", "bad"],
    ["author.username", null],
    ["author.bot", null],
    ["pinned", null],
    ["timestamp", "bad"],
    ["edited_timestamp", "bad"],
    ["type", 0.5],
    ["flags", 0.5],
    ["mention_everyone", null],
    ["nonce", 1],
    ["webhook_id", "bad"],
    ["mentions", null],
    ["mentions.0", null],
    ["mentions.0.id", "bad"],
    ["mentions.0.username", null],
    ["mentions.0.bot", null],
    ["mention_roles", null],
    ["mention_roles.0", "bad"],
    ["mention_channels", {}],
    ["mention_channels.0", null],
    ["mention_channels.0.id", "bad"],
    ["mention_channels.0.name", null],
    ["mention_channels.0.type", 0.5],
    ["reactions", {}],
    ["reactions.0", null],
    ["reactions.0.emoji", null],
    ["reactions.0.count", -1],
    ["reactions.0.emoji.name", null],
    ["reactions.0.emoji.id", "bad"],
    ["reactions.0.emoji.animated", 1],
    ["reactions.0.me", 1],
    ["message_reference", []],
    ["message_reference.message_id", "bad"],
    ["message_reference.channel_id", "bad"],
    ["message_reference.guild_id", "bad"],
    ["message_reference.type", 0.5],
    ["referenced_message", []],
    ["referenced_message.id", "bad"],
    ["referenced_message.channel_id", "bad"],
    ["message_snapshots", {}],
    ["message_snapshots.0", null],
    ["message_snapshots.0.timestamp", "bad"],
    ["message_snapshots.0.type", 0.5],
    ["message_snapshots.0.flags", 0.5],
    ["message_snapshots.0.content", 1],
    ["message_snapshots.0.edited_timestamp", "bad"],
    ["message_snapshots.0.mentions", {}],
    ["message_snapshots.0.mentions.0", "bad"],
    ["message_snapshots.0.mention_roles", {}],
    ["message_snapshots.0.mention_roles.0", "bad"],
    ["message_snapshots.0.mention_channels", {}],
    ["message_snapshots.0.mention_channels.0", null],
    ["message_snapshots.0.mention_channels.0.id", "bad"],
    ["message_snapshots.0.mention_channels.0.name", null],
    ["message_snapshots.0.mention_channels.0.type", 0.5],
]
for (const prefix of ["", "message_snapshots.0."]) {
    malformed.push([`${prefix}stickers`, {}], [`${prefix}stickers.0`, null])
    for (const [field, invalid] of [
        ["id", "bad"],
        ["name", null],
        ["animated", null],
    ] as const)
        malformed.push([`${prefix}stickers.0.${field}`, invalid])
    malformed.push([`${prefix}attachments`, {}], [`${prefix}attachments.0`, null])
    for (const [field, invalid] of [
        ["id", "bad"],
        ["filename", null],
        ["size", -1],
        ["flags", -1],
    ] as const)
        malformed.push([`${prefix}attachments.0.${field}`, invalid])
    for (const field of [
        "title",
        "description",
        "content_type",
        "content_hash",
        "url",
        "proxy_url",
        "placeholder",
        "waveform",
        "expires_at",
    ])
        malformed.push([`${prefix}attachments.0.${field}`, 1])
    for (const field of ["width", "height", "duration"]) malformed.push([`${prefix}attachments.0.${field}`, 0.5])
    for (const field of ["nsfw", "expired"]) malformed.push([`${prefix}attachments.0.${field}`, 1])
    malformed.push([`${prefix}embeds`, {}], [`${prefix}embeds.0`, null], [`${prefix}embeds.0.children`, [{}, {}]])
    for (const embedded of [`${prefix}embeds.0.`, `${prefix}embeds.0.children.0.`]) {
        for (const field of ["type", "title", "description", "url", "html"]) malformed.push([`${embedded}${field}`, 1])
        for (const field of ["color", "html_width", "html_height"]) malformed.push([`${embedded}${field}`, -1])
        malformed.push(
            [`${embedded}timestamp`, "bad"],
            [`${embedded}nsfw`, 1],
            [`${embedded}fields`, {}],
            [`${embedded}fields.0`, null],
        )
        for (const field of ["name", "value", "inline"]) malformed.push([`${embedded}fields.0.${field}`, 1])
        for (const field of ["author", "provider", "footer"]) {
            malformed.push([`${embedded}${field}`, []])
            for (const key of field === "footer"
                ? ["text", "icon_url", "proxy_icon_url"]
                : ["name", "url", "icon_url", "proxy_icon_url"])
                malformed.push([`${embedded}${field}.${key}`, 1])
        }
        for (const field of ["image", "thumbnail", "video", "audio"]) {
            malformed.push([`${embedded}${field}`, []])
            for (const key of ["url", "proxy_url", "content_type", "content_hash", "description", "placeholder"])
                malformed.push([`${embedded}${field}.${key}`, 1])
            for (const key of ["width", "height", "duration", "flags"])
                malformed.push([`${embedded}${field}.${key}`, -1])
        }
    }
}

test.each(malformed)("excluded malformed %s rejects exactly as the full decoder", (path, invalid) => {
    const value = wire()
    const parts = path.split(".")
    const key = parts.pop()!
    let target: Record<string, unknown> = value
    for (const part of parts) {
        if (target[part] === undefined) target[part] = {}
        target = target[part] as Record<string, unknown>
    }
    target[key] = invalid
    expect(decodeMessage(value)).toBeUndefined()
    expect(decodeMessage(value, emptySelection)).toBeUndefined()
    expect(decodeMessage(value, new Set<MessageField>(["messageSnapshots"]))).toBeUndefined()
})
