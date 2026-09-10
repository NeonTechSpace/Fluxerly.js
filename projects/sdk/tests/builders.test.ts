import { expect, test } from "vitest"
import { builders, type EmbedInput, type MessageInput } from "../src/index.js"
import { builders as nativeBuilders } from "../src/effect.js"

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
