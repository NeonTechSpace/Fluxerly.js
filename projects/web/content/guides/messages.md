---
title: Send messages, embeds and files
navTitle: Messages
description: Build replies, edit your bot's messages and send a file without changing APIs
---

Start with a bot that can reply to `!ping`. These helpers take the `client` from [your first bot](/docs/{{version}}/quick-start/), so they do not create another connection. Add the helpers to your bot and call them from a command or message handler

## Reply and check what happened

Use `reply` when the answer belongs to an incoming message. An awaited default API operation returns a Result. Read `value` only after checking `isErr()`

```ts
import type { Client, Message } from "@neontechspace/fluxerly"

export async function replyHello(client: Client, message: Message) {
    if (message.author.isBot) return

    const result = await client.messages.reply(message, {
        content: `Hello, ${message.author.username}!`,
    })
    if (result.isErr()) {
        console.error("Reply failed", result.error._tag)
        return
    }
    return result.value
}
```

The successful value is the message Fluxer returned, including its ID. Mention notifications are disabled by default, including notification of the replied-to author

## Mention someone deliberately

Create a mention with `format.userMention`, then allow notification of that specific user. Role and channel markup have matching `roleMention` and `channelMention` helpers

```ts
import { format, type Client } from "@neontechspace/fluxerly"

export async function notifyParticipant(client: Client, channelId: string, userId: string) {
    const mention = format.userMention(userId)
    if (mention.isErr()) return mention
    return await client.messages.send(channelId, {
        content: `${mention.value} The game is starting`,
        allowedMentions: { users: [userId] },
    })
}
```

Use `format.parseMention` to extract the kind and ID from a complete mention. Methods that take a user, role or channel ID expect the decimal ID. [Command arguments](/docs/{{version}}/commands/) can accept ID-or-mention tokens when their descriptor enables that mention kind

## Send, then edit the returned message

Use `send` for a channel announcement without a reply reference. Keep the returned message as the target for a later edit

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function postStatus(client: Client, channelId: string) {
    const sent = await client.messages.send(channelId, { content: "Preparing the report…" })
    if (sent.isErr()) return sent

    return await client.messages.edit(sent.value, { content: "Report ready" })
}
```

This example performs two SDK operations. An edit failure does not undo the first message, and a connection failure does not prove that a write failed remotely. The caller should inspect the returned Result rather than retry the whole function automatically

## Compose an embed

Builders help when a message has several parts. They produce plain input objects, so you can also write those objects directly. Building is local and sends nothing

```ts
import { builders, type Client } from "@neontechspace/fluxerly"

export async function postSchedule(client: Client, channelId: string) {
    const embed = builders.embed()
        .title("Tonight's game")
        .description("Meet in the lobby before the first round")
        .color(0x8b7cf8)
        .addFields(
            { name: "Start", value: "19:00 UTC", inline: true },
            { name: "Mode", value: "Co-op", inline: true },
        )
        .footer({ text: "Bring your own snacks" })
        .build()

    return await client.messages.send(channelId, { embeds: [embed] })
}
```

The send operation checks the embed and Fluxer's limits. Each `build()` returns a fresh snapshot, so later builder changes do not edit a message you already sent. Use `messages.edit` for that

## Attach a small generated file

For text you already have in memory, encode it to bytes and name the attachment. You do not need a temporary disk file

```ts
import { builders, type Client } from "@neontechspace/fluxerly"

export async function sendChecklist(client: Client, channelId: string) {
    const data = new TextEncoder().encode("[ ] Check permissions\n[ ] Test !ping\n")
    const message = builders.message()
        .content("Your bot checklist")
        .attachment({ data, filename: "checklist.txt", contentType: "text/plain" })
        .build()

    return await client.messages.send(channelId, message)
}
```

Builders retain the byte reference. The default send operation copies data-byte input when called. For larger files, use the [attachment input reference](/docs/{{version}}/api/modules/js-ts/) to choose a sized file or stream rather than loading everything into memory

## Download only when you need the bytes

Received messages contain attachment metadata, not downloaded files. Require a byte limit and handle download failures before processing any content

```ts
import type { Client, Message } from "@neontechspace/fluxerly"

export async function readFirstSmallFile(client: Client, message: Message) {
    const attachment = message.attachments[0]
    if (!attachment) return

    const downloaded = await client.attachments.download(attachment, { maxBytes: 64 * 1024 })
    if (downloaded.isErr()) {
        console.error("Download failed", downloaded.error._tag)
        return
    }
    return downloaded.value
}
```

Validate the expected file type and contents before processing downloaded bytes. The SDK's download API uses the attachment's discovered instance media route and rejects arbitrary URLs from message text

## Send a requested direct message

Call this helper after the recipient explicitly asks for a private response, for example through an opt-in command. Opening the conversation can succeed even when a later send is blocked by provider permissions or privacy rules

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function sendRequestedDm(client: Client, recipientId: string) {
    const opened = await client.directMessages.open(recipientId)
    if (opened.isErr()) return opened
    return await client.messages.send(opened.value.id, {
        content: "The requested game instructions are ready",
    })
}
```

Existing group conversations also use the normal message API with their channel ID. Group creation is outside the SDK's supported operations. See [private conversations](/docs/{{version}}/api/interfaces/js-ts.DirectMessages/) for reads and permitted management actions

Continue with [prefix commands](/docs/{{version}}/commands/) to turn these helpers into named bot actions, or see the [Effect workflow examples](/docs/{{version}}/effect-workflows/) for the same operations inside an Effect program
