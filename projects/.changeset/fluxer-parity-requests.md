---
"@neontechspace/fluxerly": patch
---

Requests now send what Fluxer accepts:

- An empty `query` in `members.search` or `discovery.search`, an empty `tag` in `discovery.search` and an empty `name` in `threads.search` are left out of the request, so they match everything like an omitted value. Fluxer refused them, so such searches used to fail with reason `rejected`
- A `messageHistoryCutoff` in `guilds.edit` with an offset such as `+01:00`, or with the end-of-day time `24:00:00`, is now sent as the same instant in UTC with a `Z` suffix, keeping its fraction digits, because Fluxer accepts only that form. Such values used to fail with reason `rejected`
- The references now say that discovery searches accept only the language codes Fluxer supports, such as `en-US`, `fr` or `pt-BR`, and that `GuildVerificationLevels.Low` requires a verified account, which is a verified email address on instances that send email
