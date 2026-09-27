---
"@neontechspace/fluxerly": minor
---

A client logs one `lifecycle.connected` record once every shard it owns is connected, such as `Connected to Fluxer as MyBot in 3 communities`. When the bot owns every shard and is in no community, the record is a Warn that includes the bot's installation link

Loading any entry point on a Node.js version older than 24.11 throws an error that names the required and the found version, instead of failing later with an unrelated error

Several configuration errors explain the likely fix:

- An event named `ready`, `clientReady`, `onReady` or `connected` points to the connected record, the `setup` option of `runBot` and `client.connect()`
- An unsupported command argument type suggests the supported type it most likely meant, such as `text` for `string`, and lists every supported type
- A missing bot token mentions `node --env-file=.env bot.js`, the current folder and a `.env` file saved as `.env.txt`
- A command definition placed next to `prefix` in the `commands` option of `runBot` is explained as belonging in the inner `commands` object, an unknown key there lists `commands` and `onError` among the supported keys, and a missing `prefix` is reported as required
