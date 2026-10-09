---
"@neontechspace/fluxerly": major
---

`Embed.provider` and `EmbedChild.provider` now have their own `EmbedProvider` type, with only `name` and `url`, matching what Fluxer sends. They were typed as `EmbedAuthor`, whose `iconUrl` and `proxyIconUrl` never arrived on a provider. `EmbedProvider` is exported from both entry points, and a provider's icon fields are no longer decoded
