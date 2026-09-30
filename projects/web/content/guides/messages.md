---
title: Send messages, embeds and files
navTitle: Messages
description: Reply, send and edit messages, build embeds, attach files and send direct messages
---

Start with a bot that can reply to `!ping`. Add these helpers to the [first bot example](/docs/{{version}}/quick-start/) and call them from a command or message [handler](/docs/{{version}}/glossary/#handler). They use the bot's existing `client` rather than opening another connection. The [last section](/docs/{{version}}/messages/#wire-it-up) shows where they plug into `runBot`

## Reply to a message and check what happened

Use `reply` when the answer belongs to an incoming message. Awaiting an operation in the default API gives a [Result](/docs/{{version}}/glossary/#result): Check `isErr()` first, then read `value`

```ts
import { describeError, type Client, type Message } from "@neontechspace/fluxerly"

export async function replyHello(client: Client, message: Message) {
    if (message.author.isBot) return

    const result = await client.messages.reply(message, `Hello, ${message.author.username}!`)
    if (result.isErr()) {
        console.error(describeError(result.error))
        return
    }
    return result.value
}
```

A plain string sends a text-only message. On success, `value` is the message Fluxer created, including its ID. The `describeError` helper prints the failure's message, code, suggested fix and cause. Replies do not notify anyone by default, not even the author of the replied-to message

<details>
<summary>What does a failed send say?</summary>

The error message names the operation and Fluxer's answer, then Fluxer's code and the HTTP status, for example `Message send failed: Fluxer reports that the bot lacks a required permission (MISSING_PERMISSIONS, HTTP 403)`.
The error's `hint` suggests a next step. When Fluxer answers with a code this SDK version does not know yet, `details.providerCode` holds it. When Fluxer's answer does not have the expected shape, `details.responseField` names the field that failed

A rejection with HTTP 401 or 403 that the application handles also logs a Warn record with the code `rest.rejected`, because it usually points at a lasting token or permission problem. When a handler fails with the rejection instead, the handler's failure record is the only one. [Identical repeats collapse](/docs/{{version}}/logging/#collapse-repeated-errors) into one record per minute by default. The [error and log codes](/docs/{{version}}/error-and-log-codes/) page lists every code with its meaning

</details>

<details>
<summary>Skip join notices and other system messages</summary>

Fluxer also delivers notices, such as a member joining or a pinned message, as messages. Compare `message.type` with a `MessageType` constant to tell them apart. For example, `message.type === MessageType.UserJoin` is a join notice, and ordinary messages are `MessageType.Default` or `MessageType.Reply`

</details>

## Mention someone deliberately

Create a mention with `format.userMention`, then allow a notification for that specific user. Role and channel mentions have matching `roleMention` and `channelMention` helpers

```ts
import { format, type Client } from "@neontechspace/fluxerly"

export async function notifyParticipant(client: Client, channelId: string, userId: string) {
    return await client.messages.send(channelId, {
        content: `${format.userMention(userId)} The game is starting`,
        allowedMentions: { users: [userId] },
    })
}
```

Methods that take a user, role or channel ID expect the decimal ID. To read a mention typed by a user, use `format.tryParseMention`, which returns a Result instead of throwing on invalid text. [Command arguments](/docs/{{version}}/commands/) can also accept either an ID or a mention

<details>
<summary>Send a text-to-speech message</summary>

Add `tts: true` to the content passed to `messages.send`, `messages.reply`, `directMessages.send` or the `reply` helper of a `runBot` handler or command. A value other than a boolean fails with reason `input` before any request.
In a community, a bot without the Send TTS Messages permission gets a normal message and no error

The `tts` field of a message is meaningful only on the message returned by the send and on the `messageCreate` event. Fluxer does not store it, so fetches, history pages and other later reads always report `false`.
Webhook messages do not accept `tts`: A webhook send, reply or forward that includes it fails with reason `input` before any request

</details>

## Send, then edit the returned message

Use `send` for a channel message that does not reply to anything. Keep the returned message to edit it later

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function postStatus(client: Client, channelId: string) {
    const sent = await client.messages.send(channelId, "Preparing the report…")
    if (sent.isErr()) return sent

    return await client.messages.edit(sent.value, "Report ready")
}
```

The helper posts a message, then edits it, and returns the edit's Result or the send's failure

<details>
<summary>What if the send or the edit fails?</summary>

If the edit fails, the first message stays posted. If the connection fails after a send or edit was dispatched, the change may still have reached Fluxer. Check the returned Result before deciding whether to try again, and avoid repeating a write whose outcome is unknown.
The [reliability guide](/docs/{{version}}/reliability/) explains these uncertain writes and when a retry is safe

</details>

## Build an embed

An [embed](/docs/{{version}}/glossary/#embed) is a formatted card with a title, description, color and fields. The embed builder assembles one step by step. Pass the builder in the message's `embeds` list

```ts
import { builders, type Client } from "@neontechspace/fluxerly"

export async function postSchedule(client: Client, channelId: string) {
    const embed = builders.embed()
        .title("Tonight's game")
        .description("Meet in the lobby before the first round")
        .color("#8b7cf8")
        .field("Start", "19:00 UTC", { inline: true })
        .field("Mode", "Co-op", { inline: true })
        .footer({ text: "Snacks provided" })

    return await client.messages.send(channelId, { embeds: [embed] })
}
```

The `inline` option places fields side by side. The `color` method accepts a hex string such as `"#8b7cf8"`, a number or an RGB tuple, and `timestamp` accepts a `Date`, epoch milliseconds or an ISO 8601 string with a time zone. The send checks the embed against Fluxer's limits. It reads the builder once, so later builder changes do not alter the sent message. Use `messages.edit` for that. The builder's `build()` method returns the same embed as a plain object, which could also be written by hand

In a community channel, sending or editing a message with embeds needs the `EmbedLinks` permission. New communities grant it to everyone, but where it is removed, Fluxer rejects the whole message with a missing-permissions error instead of sending it without the embeds

## Upload a small generated file

For text already in memory, encode it to bytes and give the attachment a file name. No temporary file on disk is needed

```ts
import { builders, type Client } from "@neontechspace/fluxerly"

export async function sendChecklist(client: Client, channelId: string) {
    const data = new TextEncoder().encode("[ ] Check permissions\n[ ] Test !ping\n")
    const message = builders.message()
        .content("Bot checklist")
        .attachment({ data, filename: "checklist.txt", contentType: "text/plain" })
        .build()

    return await client.messages.send(channelId, message)
}
```

The builder keeps a reference to the bytes, and the send copies them when it is called. For larger files, pass a `file` source such as a `Blob`, or a `stream` with its exact `size`, instead of `data`. The [attachment input reference](/docs/{{version}}/api/modules/js-ts/#attachmentinput) lists these forms, which avoid loading everything into memory

## Download an attachment when needed

Received messages describe their attachments but do not download them. Set a byte limit and handle a failed download before processing any content

```ts
import { describeError, type Client, type Message } from "@neontechspace/fluxerly"

export async function readFirstSmallFile(client: Client, message: Message) {
    const attachment = message.attachments[0]
    if (!attachment) return

    const downloaded = await client.attachments.download(attachment, { maxBytes: 64 * 1024 })
    if (downloaded.isErr()) {
        console.error(describeError(downloaded.error))
        return
    }
    return downloaded.value
}
```

Check the file type and contents before processing downloaded bytes. The download uses the attachment's media address on the bot's Fluxer instance and does not accept arbitrary URLs from message text

Buffered downloads and `attachments.stream` preserve a sanitized cause for discovery and transport failures, including a safe code such as `ECONNRESET` when available. The original transport error, attachment URL and response body are not retained in that cause

## Send a requested direct message

Send a private message only after the recipient asks for one, for example through an opt-in command. The `directMessages.send` method opens the conversation with that user and sends the message

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function sendRequestedDm(client: Client, recipientId: string) {
    return await client.directMessages.send(recipientId, "The requested game instructions are ready")
}
```

A send can still fail when the recipient's privacy settings block it. To reuse the conversation, `directMessages.open` returns its channel, and existing group conversations use the normal message methods with their channel ID. Creating groups is outside the SDK's supported operations. See [private conversations](/docs/{{version}}/api/interfaces/js-ts.DirectMessages/) for reads and permitted management actions

## Wire it up

In a `runBot` bot, each command receives a `reply` helper already bound to the incoming message. This bot answers `!schedule` with an embed, and `processSignals: true` lets Ctrl+C stop it cleanly

```ts
import { builders, runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    commands: {
        prefix: "!",
        commands: {
            schedule: {
                description: "Show tonight's game",
                execute: ({ reply }) => {
                    const embed = builders.embed()
                        .title("Tonight's game")
                        .description("Meet in the lobby before the first round")
                        .color("#8b7cf8")
                    return reply({ embeds: [embed] })
                },
            },
        },
    },
})
```

Returning the reply's Result lets the [command router](/docs/{{version}}/glossary/#command-router) report a failed reply with the command name. If the bot itself stops with a failure, such as a rejected token, `runBot` logs it once and sets `process.exitCode` to 1, so the file needs no error handling of its own

Helpers that take a `client`, such as `postSchedule` above, receive it from the command context, for example with `execute: ({ client, message }) => postSchedule(client, message.channelId)`

Continue with [prefix commands](/docs/{{version}}/commands/) to turn these helpers into named bot actions, or see the [Effect workflow examples](/docs/{{version}}/effect-workflows/) for the same operations inside an Effect program
