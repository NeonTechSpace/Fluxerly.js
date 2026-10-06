---
"@neontechspace/fluxerly": major
---

The `runBot` function now skips `messageCreate` and `messageUpdate` events written by bots, including the bot's own messages, before they reach its `events` handlers, in both entry points. A reply can no longer trigger the handler that sent it, and handlers no longer need a `message.author.isBot` check.
The new `ignoreBots` option controls this and defaults to `true`, matching the existing `commands.ignoreBots` setting of prefix commands, which is unchanged. A value other than a boolean is misuse. The `createTestBot` functions of both testing entry points accept the same option

Migration: A bridge, logging or moderation bot that handles messages from other bots passes `ignoreBots: false` to `runBot`. Bots built with `createClient` and `client.on` are not affected
