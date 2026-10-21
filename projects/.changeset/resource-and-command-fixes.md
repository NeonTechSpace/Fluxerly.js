---
"@neontechspace/fluxerly": patch
---

Fixes for the guild cache, command replies, retry classification and message cleanup. A successful `discovery.apply`, `discovery.edit` or `guilds.editVanityUrl` call no longer stores its reply as a cached guild, so `guilds.get` and guild enumeration no longer return an application or vanity object after one of these writes. These writes now only remove the cached guild

The `MessageCleanupError` from a `preview` whose `filter` threw now keeps the thrown value as `cause`, as documented

With `mentionPrefix`, help pages and the usage line of a rejection reply now put one space between the bot mention and the command name, such as `<@99> say <text...>` instead of `<@99>say <text...>`. A cooldown reply now gives a wait over 60 seconds in minutes, hours or days, with at most two units rounded up, such as "Try again in 1 hour 1 minute" or "Try again in 1 day 1 hour", instead of a count of seconds

The `errors.isRetryable` function now returns `false` for a `ConnectionError` with reason `network` and an HTTP 4xx status, such as a discovery 404, matching the SDK's own retries. A network failure without a status or with a 5xx status stays retryable

The default API `client.observeState` now throws `ConfigurationError` for a listener that is not a function, instead of logging an observer failure on every state change

The `CommandArgumentMetadata` comments no longer give `user`, which registration rejects, as a type example, and say that a custom argument can also use `rest`
