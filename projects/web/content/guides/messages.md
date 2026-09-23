---
title: Send messages, embeds and files
navTitle: Messages
description: Build replies, edit bot messages and send a file
---

Start with a bot that can reply to `!ping`. Add these helpers to the [first bot example](/docs/{{version}}/quick-start/) and call them from a command or message handler. They use its existing `client` rather than opening another connection

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

This example sends a message, then edits it. If the edit fails, the first message stays posted. If the connection fails, the write may still have reached Fluxer. Check the returned Result before deciding whether to try again

## Build an embed

Builders assemble messages with several parts into plain input objects. The same objects can be written directly. Calling `build()` does not send anything

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

The send operation checks the embed and Fluxer's limits. Each `build()` returns a new value, so later builder changes do not edit a sent message. Use `messages.edit` for that

## Attach a small generated file

For text already in memory, encode it to bytes and name the attachment. No temporary disk file is needed

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

## Download an attachment when needed

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
