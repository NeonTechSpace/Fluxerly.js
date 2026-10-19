---
"@neontechspace/fluxerly": minor
---

Command routers can now wait for a partition's own setup before its commands run. The `partitionReady` option works for `router.attach` and for the `commands` option of `runBot` and `createTestBot` (`BotCommandsOptions`), in both APIs, with the same rules as the `partitionReady` option of `client.on`. Before the first waiting message of a key starts, the SDK calls the hook, and the key's messages stay in the queue without using a command slot until it settles, while other keys keep running. The option needs `partition` and otherwise fails with `ConfigurationError` whose `field` is `"partitionReady"`. A hook that fails reports each waiting message of that key to the `onError` option of the commands, and those messages run no command

Behavior change for command routers that have an `onError`: A failing `partitionReady` hook, a throwing `partition` function and an overflow report of the router's subscription now reach that `onError`, in arrival order with the command failures. Before, a throwing `partition` function and an overflow report went to the client-level `onError` or the log, so a bot that replied from `commands.onError` stayed silent. A router without its own `onError` is unchanged

In the Effect API the hook returns an Effect, and its required services are added to the requirements of `runBot` and `createTestBot`, which gain a trailing type parameter for them, and `BotCommandsOptions` gains a fifth one
