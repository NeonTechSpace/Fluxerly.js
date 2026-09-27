---
title: Use emoji, reactions and stickers
navTitle: Emoji & stickers
description: Put custom emoji in messages, add reactions, send community stickers and create emoji
---

Unicode emoji such as 🎉 work directly in message content and reactions. Custom emoji belong to a [community](/docs/{{version}}/glossary/#guild) and have a name and an ID. Fluxer displays them from markup such as `<:name:id>` for a static image or `<a:name:id>` for an animated one

| Task | Input |
| --- | --- |
| Display an emoji in a message | Unicode or custom markup in `content` |
| React to a message | Unicode, custom markup, parsed emoji fields or a `GuildEmoji` |
| Send a sticker | Its ID in `stickerIds` |
| Manage community emoji or stickers | The `client.emojis` or `client.stickers` namespace |

The SDK does not turn shortcodes such as `:party:` into emoji IDs. Look up the name in application code, or configure the ID when several communities have an emoji with the same name

## Find an emoji and use it twice

Fetch a community's emoji and find the configured ID. The helper uses that emoji in a message and as a reaction to it. Add it to a bot that already has a [client](/docs/{{version}}/quick-start/)

```ts
import { format, type Client } from "@neontechspace/fluxerly"

export async function celebrateWithEmoji(
    client: Client,
    guildId: string,
    channelId: string,
    emojiId: string,
) {
    const listed = await client.emojis.fetchAll(guildId)
    if (listed.isErr()) return listed
    const emoji = listed.value.find((item) => item.id === emojiId)
    if (!emoji) return

    const sent = await client.messages.send(channelId, `Build passed ${format.customEmoji(emoji)}`)
    if (sent.isErr()) return sent

    return await client.messages.addReaction(sent.value, emoji)
}
```

The helper returns `undefined` when the configured emoji is not in the community. If adding the reaction fails, the sent message stays posted. Fluxer checks that the emoji is available and that the bot has permission for each request

Custom markup can also be passed directly, for example `client.messages.addReaction(message, "<a:party:123>")`, with the example ID replaced by an available emoji. The SDK converts it to the form Fluxer's reaction endpoint expects

## Reuse a received or parsed emoji

Reaction [events](/docs/{{version}}/glossary/#event) already contain everything needed to add the same reaction. This [handler](/docs/{{version}}/glossary/#handler), registered with `client.on`, mirrors each person's reaction with the bot's own. Supply the connected bot's ID so the bot ignores its own reactions

```ts
import { describeError, type Client } from "@neontechspace/fluxerly"

export function mirrorReactions(client: Client, botId: string) {
    return client.on("messageReactionAdd", async (reaction) => {
        if (reaction.userId === botId) return
        const added = await client.messages.addReaction(reaction, reaction.emoji)
        if (added.isErr()) console.warn(describeError(added.error))
    })
}
```

The `client.on` method returns a subscription. Keep it and call its `close()` method when mirroring should end. The same emoji inputs work for removing reactions, listing the people who reacted and choosing a [collector](/docs/{{version}}/glossary/#collector)'s emoji. To read custom emoji markup typed by a user, use `format.tryParseCustomEmoji()`, which returns a [Result](/docs/{{version}}/glossary/#result) instead of throwing on invalid text, and pass the parsed value on

<details>
<summary>Grouped reactions and emoji matching</summary>

This example handles one added reaction at a time, which is how reactions in a community always arrive. Fluxer groups additions into a `messageReactionAddMany` event only in direct messages, and only when `gateway.flags.debounceMessageReactions` is set. For a time or item limit that handles both forms, use a [reaction collector](/docs/{{version}}/events-and-collectors/#accept-a-confirmation-reaction).
Collectors match custom emoji by ID, even after a rename. Unicode emoji match the exact text, including skin tone and variation selectors

</details>

## Send a community sticker

Fetch the community's stickers and select one by configured ID. A message can contain up to three sticker IDs, with optional text, embeds and attachments

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function sendGuildSticker(
    client: Client,
    guildId: string,
    channelId: string,
    stickerId: string,
) {
    const listed = await client.stickers.fetchAll(guildId)
    if (listed.isErr()) return listed
    const sticker = listed.value.find((item) => item.id === stickerId)
    if (!sticker) return

    return await client.messages.send(channelId, {
        content: "Ready for the next round",
        stickerIds: [sticker.id],
    })
}
```

Received messages list their stickers in `message.stickers`. Image URLs come from the [asset helpers](/docs/{{version}}/api/modules/js-ts/#assets), and image bytes are downloaded only on request

## Create a reusable community emoji

Supply image bytes from a trusted source. Community emoji uploads accept at most 512 KiB of image data. Fluxer checks the image format, dimensions, the community's remaining emoji slots and the bot's permission to manage emoji

```ts
import type { Client } from "@neontechspace/fluxerly"

export function createBuildEmoji(client: Client, guildId: string, image: Uint8Array) {
    return client.emojis.create(guildId, {
        name: "build_passed",
        image: Buffer.from(image).toString("base64"),
    })
}
```

The returned `GuildEmoji` can be formatted into a message or used as a reaction. Stickers are created with `client.stickers.create` and a name, image and optional description and tags. Both namespaces can also fetch, rename, copy and delete. To find which community owns a custom emoji or sticker, use `emojis.fetchSource(id)` or `stickers.fetchSource(id)`, which Fluxer answers when that community is discoverable or the bot is a member of it

<details>
<summary>Creating several emoji at once</summary>

Batch creation with `createMany` returns separate `success` and `failed` lists, so inspect both. If the whole request fails with an unknown outcome, some emoji may still have been created, so fetch the community's emoji before retrying. The [reliability guide](/docs/{{version}}/reliability/) explains these uncertain writes

</details>

## Send and react with Effect

The [Effect](/docs/{{version}}/glossary/#effect) API accepts the same reaction inputs. This function sends a reply, parses a custom emoji, then reacts to the reply. Run it inside the [Effect bot](/docs/{{version}}/effect-first-bot/)'s existing runtime

```ts
import { Effect } from "effect"
import { format, type Client, type Message } from "@neontechspace/fluxerly/effect"

export function celebrateWithEffect(client: Client, message: Message, emojiMarkup: string) {
    return Effect.gen(function* () {
        const emoji = yield* format.tryParseCustomEmoji(emojiMarkup)
        const sent = yield* client.messages.reply(message, "Build passed")
        yield* client.messages.addReaction(sent, emoji)
        return sent
    })
}
```

Each step adds its possible failures to the function's Effect type. Interrupting the surrounding task stops the remaining steps. A completed reply stays posted if a later step fails

## Wire it up

In a `runBot` bot, a command can reply and then react to its own reply with the `client` from its context. This bot answers `!celebrate` and adds 🎉 to the answer

```ts
import { runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    commands: {
        prefix: "!",
        commands: {
            celebrate: {
                description: "Celebrate with a reaction",
                execute: async ({ client, reply, signal }) => {
                    const sent = await reply("Build passed")
                    if (sent.isErr()) return sent
                    return client.messages.addReaction(sent.value, "🎉", { signal })
                },
            },
        },
    },
})
```

Returning the reaction's Result lets the router report a failed reaction with the command name. To mirror reactions instead, add a `messageReactionAdd` handler to the `events` option. Its `event` is the same reaction that `mirrorReactions` above receives, and its context also provides the `client`
