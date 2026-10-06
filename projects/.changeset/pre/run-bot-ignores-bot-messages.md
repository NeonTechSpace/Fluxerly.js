---
"@neontechspace/fluxerly": major
---

The `runBot` function now skips `messageCreate` and `messageUpdate` events written by bots, including the bot's own messages, before they reach its `events` handlers or its `commands` router, in both entry points. A reply can no longer trigger the handler that sent it, and handlers no longer need a `message.author.isBot` check.
The new `ignoreBots` option controls this in one place and defaults to `true`. Setting it to `false` lets both the handlers and the prefix commands see bot-authored messages. A `commands.ignoreBots` setting, when present, still decides for the prefix commands alone. A value other than a boolean is misuse. The `createTestBot` functions of both testing entry points accept the same option

Migration: A bridge, logging or moderation bot that handles messages from other bots passes `ignoreBots: false` to `runBot`. Bots built with `createClient` and `client.on` are not affected
