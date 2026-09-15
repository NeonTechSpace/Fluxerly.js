---
title: Use emoji, reactions and stickers
navTitle: Emoji & stickers
description: Put custom emoji in messages, reuse emoji in reactions and send guild stickers
---

Unicode emoji such as 🎉 work directly in message content and reactions. Custom emoji also have a name and ID. Fluxer displays them using `<:name:id>` for a static image or `<a:name:id>` for an animated image

| Task | Input |
| --- | --- |
| Display an emoji in a message | Unicode or custom markup in `content` |
| React to a message | Unicode, custom markup, parsed emoji fields or a `GuildEmoji` |
| Send a sticker | Its ID in `stickerIds` |
| Manage guild emoji or stickers | The `client.emojis` or `client.stickers` namespace |

Shortcodes such as `:party:` need application-side name resolution. Use a configured ID when several guilds can contain an emoji with the same name

## Find an emoji and use it twice

Fetch a guild's emoji, select a configured ID, then use that same snapshot for message content and a reaction. Add this helper to a bot that already has a [client](/docs/{{version}}/quick-start/)

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

    const markup = format.customEmoji(emoji)
    if (markup.isErr()) return markup
    const sent = await client.messages.send(channelId, {
        content: `Build passed ${markup.value}`,
    })
    if (sent.isErr()) return sent

    return await client.messages.addReaction(sent.value, emoji)
}
```

The helper returns `undefined` when the configured emoji is absent. Once the message is sent, it remains posted if adding the reaction fails. Fluxer checks emoji availability and the bot's permissions for each request

Custom markup can also be passed directly, for example `client.messages.addReaction(message, "<a:party:123>")`. Replace the example ID with an available emoji. The SDK converts it to the reaction endpoint's `name:id` form, including the required URL encoding

## Reuse a received or parsed emoji

Reaction events already contain the identity needed for another reaction operation. This handler mirrors a person's reaction with the bot's own reaction. Supply the connected bot's ID so its own event is ignored

```ts
import type { Client } from "@neontechspace/fluxerly"

export function mirrorReactions(client: Client, botId: string) {
    return client.on("messageReactionAdd", async (reaction) => {
        if (reaction.userId === botId) return
        const added = await client.messages.addReaction(reaction, reaction.emoji)
        if (added.isErr()) {
            console.warn("Reaction failed", { kind: added.error._tag })
        }
    })
}
```

Keep the returned subscription and unsubscribe when mirroring should end. This example handles individual additions. Fluxer can also deliver grouped additions through `messageReactionAddMany`; use a [reaction collector](/docs/{{version}}/events-and-collectors/#accept-a-confirmation-reaction) for a bounded interaction that handles both forms

The same inputs work for removing reactions, reading or iterating reactor lists, and selecting a collector's emoji. A successful `format.parseCustomEmoji()` result can be reused directly. Collectors match custom emoji by ID even after a rename. Unicode selection matches the exact text, including skin tone and variation selectors

## Send a guild sticker

Fetch the available stickers and select one by configured ID. A message can contain up to three sticker IDs, with optional text, embeds and attachments

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

Sticker delivery uses the sticker's ID. Received messages expose sticker metadata through `message.stickers`. Image URLs are available from the [asset helpers](/docs/{{version}}/api/modules/js-ts/); image bytes are downloaded explicitly

## Create a reusable guild emoji

Supply image bytes from a trusted application source. Guild emoji uploads accept at most 512 KiB of decoded data. Fluxer checks the image format, dimensions, guild capacity and management permissions

```ts
import type { Client } from "@neontechspace/fluxerly"

export function createBuildEmoji(client: Client, guildId: string, image: Uint8Array) {
    return client.emojis.create(guildId, {
        name: "build_passed",
        image: Buffer.from(image).toString("base64"),
    })
}
```

The returned `GuildEmoji` can be formatted or used in a reaction. Sticker creation uses `client.stickers.create` with a name, image and optional description and tags. Both namespaces support fetching, renaming, cloning and deleting. Batch creation returns separate `success` and `failed` lists, so inspect both and retry only after reconciling any uncertain outcome

## Compose the same steps with Effect

The Effect API accepts the same reaction inputs. This reusable function sends a reply, parses a custom emoji, then reacts to the returned message. Run it inside the [Effect bot](/docs/{{version}}/effect-first-bot/)'s existing runtime

```ts
import { Effect } from "effect"
import { format, type Client, type Message } from "@neontechspace/fluxerly/effect"

export function celebrateWithEffect(client: Client, message: Message, emojiMarkup: string) {
    return Effect.gen(function* () {
        const emoji = yield* format.parseCustomEmoji(emojiMarkup)
        const sent = yield* client.messages.reply(message, { content: "Build passed" })
        yield* client.messages.addReaction(sent, emoji)
        return sent
    })
}
```

Each yielded operation contributes its typed failures to the function's Effect. Interruption follows the surrounding task's scope. A completed reply remains posted if a later step fails
