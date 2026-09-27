---
"@neontechspace/fluxerly": minor
---

Message operations accept a plain string as the whole message and an `EmbedBuilder` wherever they accept embeds, in both entry points.
A string such as `client.messages.send(channelId, "Hello")` is shorthand for `{ content: "Hello" }` in `messages.send`, `messages.reply`, `messages.edit`, `directMessages.send` and a webhook client's `send` and `editMessage`.
An `EmbedBuilder` in `embeds` is built once when the operation reads its input, so `client.messages.reply(message, { embeds: [builders.embed().title("Status")] })` needs no `build()` call and later changes to the builder do not affect that operation
