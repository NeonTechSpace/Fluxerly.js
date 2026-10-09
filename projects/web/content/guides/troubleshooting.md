---
title: Diagnose a bot that is not behaving as expected
navTitle: Troubleshooting
description: Match log lines and errors with their fixes, and separate command, worker, connection and request problems
---

Start with what the bot printed. The client logs startup, readiness, lost connections, rate-limit waits, shutdown and every application error by default. Each readable log line shows its record code in brackets after the category, such as `[lifecycle.connectionLost]`. Then check the operation's [Result](/docs/{{version}}/glossary/#result) or native Effect error. The `describeError(error)` function prints any SDK error with its code, suggested fix and cause chain

The [error and log codes](/docs/{{version}}/error-and-log-codes/) page lists every code with its meaning and fix. The table below covers the most common ones

## Match a log line with its fix

| Record code | What it means | What to do |
| --- | --- | --- |
| `configuration.invalid` with field `token` | The token was missing or empty, or it started with `Bot ` or `Bearer ` | The environment variable holding the token is probably unset. Start the bot with `node --env-file=.env bot.js` from the folder that holds `.env`, or set the variable in the shell, and pass only the token without a scheme. Surrounding spaces and one pair of quotes are removed. In a project made by `fluxerly init`, set `FLUXER_BOT_TOKEN` in the `.env` file that init wrote |
| `configuration.invalid` for an unknown option | An option name is misspelled or not supported where it was passed | The hint names the closest supported option, as in `Did you mean "logging"?`, then lists every supported one |
| `lifecycle.connectionEnded` with close 4004 | Fluxer rejected the bot token | Check that the configured value is the whole bot token, or regenerate the token in the application settings and update the configuration. The SDK does not retry a rejected token |
| `lifecycle.connectionEnded` with close 4011 or 4010 | The gateway requires more [shards](/docs/{{version}}/glossary/#shard), or rejected the shard assignment | Set `sharding: "auto"` for a bot in one process, or configure `sharding` with the total shard count the gateway expects. See [sharding](/docs/{{version}}/sharding/) |
| `lifecycle.resharded` | Fluxer closed a shard with 4011 under `sharding: "auto"`, so the SDK counted the communities again and moved every shard to a larger plan. Events sent during the move were missed | Nothing, unless it repeats. After 3 moves within an hour, the next 4011 ends the client with `lifecycle.connectionEnded` |
| `supervisor.resharded` | A child's shard was closed with 4011 under the supervisor's `totalShards: "auto"`. At Warn, the supervisor stopped every child, counted again and started a larger plan. At Error, it had already moved 3 times within an hour or reached 16,384 shards, so it shut down | At Error, check why the community count keeps growing, or choose a larger numeric `totalShards` |
| `lifecycle.connected` | Every shard is connected. The message names the bot and how many communities it is in. At Warn, the bot is not in any community | At Warn, open the installation link in the message and add the bot to a community. See [Create a bot](/docs/{{version}}/create-a-bot/#3-invite-the-bot-to-a-community) |
| `lifecycle.retry` | A startup connection attempt failed and the SDK is trying again | Nothing, unless startup then fails. The message names the reason and the delay |
| `lifecycle.connectionLost` | A connection dropped and the SDK is reconnecting | Nothing, unless it repeats. The message names the close code, its meaning and whether the session resumes |
| `lifecycle.sessionReset` | The session could not resume, so the next connection starts a new one | Events sent while disconnected are not replayed. Refresh state that matters |
| `lifecycle.cacheRefill` | Shards resumed sessions from the [session store](/docs/{{version}}/sharding/#resume-after-a-restart), which carry no community data, so the SDK refilled the enabled community, role and channel caches through REST. At Warn, some communities failed or the refill stopped early | At Warn, read the error. The missing cache entries fill as events and requests arrive |
| `lifecycle.draining`, `lifecycle.drained` | A shutdown with `drainMs` stopped accepting new events and waited for running handlers, their waiting events and REST requests. `lifecycle.drained` means all of it finished in time | Nothing |
| `lifecycle.drainTimedOut` | The drain time ran out, so shutdown cancelled the work that had not finished. The fields name how many handlers, events and requests | Make handlers finish sooner, or raise `drainMs` if the process may take longer to stop |
| `rest.busy` | A request failed with reason `busy` because the REST queue or the upload byte budget was full. It is logged at most once a minute, and every such failure is counted in `diagnostics().counters.restBusy` | Send fewer requests at once, or raise the limit the message names |
| `rest.rejected` | Fluxer rejected a request with HTTP 401 or 403, usually a token or permission problem that persists. It is logged as Warn even when the application handles the Result. A handler or command that fails with the rejection logs only its own failure record, and [identical repeats collapse](/docs/{{version}}/logging/#collapse-repeated-errors) into one record per minute by default | Follow the record's hint. A bot that expects these rejections can set the `rest` category to `error`, as [logging](/docs/{{version}}/logging/#choose-levels-and-categories) shows |
| `ratelimit.wait` | A request waited for Fluxer's [rate limit](/docs/{{version}}/glossary/#rate-limit) | Spread out bursts on the named route. Waits under one second are logged at Debug |
| `ratelimit.deadline` | A rate limit's required wait would pass the request deadline, so the request failed without waiting | Raise the operation's `timeoutMs`, or retry after the wait named in the record |
| `events.handlerFailed` | An event handler threw, rejected or returned an Err | Fix the error shown with its stack. The handler keeps receiving later events. When an `onError` hook exists but did not receive the report, `fields.reportOutcome` says why: `queueFull`, `interrupted`, `clientClosed` or `subscriptionClosed` |
| `events.dropped` | A subscription queue was full, so an event was dropped. By default the oldest waiting event is dropped | Handle events faster, raise `maxPendingMessages` or `concurrency`, or accept the drops |
| `events.overflow` | A subscription registered with the opt-in overflow `stop` ended because its queue was full | Keep the default `dropOldest`, or observe `waitForClose` and register again |
| `events.hookFailed` | The `onError` hook itself threw | Fix the hook. The original failure is logged right after it |
| `events.registeredAfterShutdown` | A handler, subscription or command router was registered after shutdown began, often from a handler still running at the time. It received an already-closed handle and never runs | Nothing during shutdown. At other times, register everything before stopping the client |
| `gateway.ignoredEventRegistered` | A handler is registered for an event whose dispatch types are all listed in `gateway.ignoredEvents` | Remove those types from `gateway.ignoredEvents`, or remove the handler. See [configuration](/docs/{{version}}/configuration/) |
| `gateway.dispatchRejected` | Fluxer sent an event the SDK could not validate, so it was skipped | Update the SDK. The record names the event type and failing field. Cached entries it could affect were cleared |
| `commands.rejected` and `commands.unmatched` (Debug) | A command guard, cooldown or argument rejected a message, or no command matched | With `runBot`, argument errors, active cooldowns and guards with a deny reason get a reply unless `onReject` is `"silent"`. A guard returning `false` sends nothing, even with the reply default. Add `onReject` to a router from `commands.create`, and `onUnmatched` where users need feedback for unknown commands |
| A rejected `SdkDefect` with code `sdk.defect` | An unexpected SDK or cleanup fault | Report it with the output of `describeError`. Code `application.defect` instead points at application code: The callback named in its cause, or a property getter on passed options or input that threw the cause |

Run with `FLUXERLY_DEBUG=1` to add Debug records for every area, or `FLUXERLY_DEBUG=rest,ratelimit` for selected ones. See [logging](/docs/{{version}}/logging/)

<details>
<summary>What happens to collectors registered after shutdown began</summary>

A `messages.collect` or `messages.collectReactions` call made after shutdown began returns a collector whose `result` fails with `ClientClosedError`, as for a collector that was already running when shutdown started. Registering middleware with `client.use` on a closing client still throws `ClientClosedError` in the default API, or dies with it in the Effect API. Invalid arguments remain misuse and throw `ConfigurationError` whatever the client state

</details>

## Node.js prints .env: not found

```text
node: .env: not found
```

Node.js could not open the file named after `--env-file`. Run the command from the bot's folder, and check that the file is named exactly `.env`. Some editors, such as Notepad, save it as `.env.txt`. Show file extensions in the file manager to spot that

## The process fails with a Node.js version error

```text
Error: Fluxerly needs Node.js 24.15 or newer, but this is Node.js 22.12.0. Install a current Node.js release from https://nodejs.org, then run the bot again
```

The SDK checks the Node.js version when it loads. Run `node --version` to see the version in use, install a newer release, and open a new terminal so that it is found first

## The process fails with a require error

```text
Error: Fluxerly is ESM-only. Use import, and set "type": "module" in package.json (or use .mjs files)
```

The SDK ships only ECMAScript modules. Replace `require("@neontechspace/fluxerly")` with `import`, and either add `"type": "module"` to the project's `package.json` or name the file with `.mjs`

## TypeScript cannot find AbortSignal or AsyncDisposable

Install the Node.js types as a development dependency and include them, for example with `"types": ["node"]` in `tsconfig.json`. Handler signals are `AbortSignal` values and clients support `await using`, so the SDK's declarations use those Node.js types

```command
{"kind":"dev","package":"@types/node"}
```

## No reply arrives

Check these in order:

1. The bot is running, and the message is from a person, not a bot. The starter answers only the exact text `!ping`
2. The bot can view the channel and send messages there
3. A command router uses the expected prefix, and the attached router is the one returned by the last `register` or `registerMany` call. Each call returns a new router, so attaching an earlier one misses later commands
4. No guard, cooldown or argument rejected the command. Rejected and unmatched commands are logged at Debug and counted in `diagnostics().counters`. With `runBot`, argument errors, active cooldowns and guards with a deny reason get an explanation unless `onReject` is `"silent"`. A guard returning `false` intentionally sends nothing. A router from `commands.create` needs `onReject` for that, and `onUnmatched` answers unknown commands
5. The reply did not fail. The starter returns its reply, so a failed reply is logged as `events.handlerFailed` with a message that tells local validation, provider rejection, timeout and delivery uncertainty apart

A callback that returns an `Err` result fails like one that throws, so its error reaches `onError` or the log. Handle an expected failure inside the callback when it should not count as a failure. See [commands](/docs/{{version}}/commands/) and [failure handling](/docs/{{version}}/reliability/)

## A webhook or OAuth call fails with HTTP 401

A [webhook or OAuth](/docs/{{version}}/webhooks-and-oauth/) call can fail because Fluxer rejected a credential other than the bot token. The `hint` of the `WebhookOperationError` or `OAuthOperationError` then names the credential the request sent:

- Webhook token: Check the webhook ID and token, or recreate the webhook and use its new token
- OAuth client: Check the configured OAuth client ID and client secret
- User access token: Refresh it, or ask the user to authorize the application again

## A moderation action fails with HTTP 400

Suppose a kick, ban, timeout, role change or deletion of another person's message fails with HTTP 400 and [`errors.apiCode(error)`](/docs/{{version}}/api/modules/js-ts/#errors) returns `"twoFactorRequired"`, although the bot holds the permission. The community requires two-factor authentication for moderation, and the account that owns the bot's application does not have it enabled. The community's `mfaLevel` is `GuildMfaLevels.Elevated` in such a community

Enable two-factor authentication on the account that owns the bot's application, then try again. Retrying without that change fails the same way. See [communities that require two-factor authentication](/docs/{{version}}/guilds-and-permissions/#communities-that-require-two-factor-authentication)

## The gateway is connected but commands stopped

Look for `events.dropped` records and `diagnostics().counters.eventsDropped`, which mean handlers are slower than incoming events. A handler or middleware failure, including a synchronous throw, releases its handler slot and partition key without stopping the subscription. A full queue drops the oldest waiting event instead of stopping

<details>
<summary>Subscriptions that stop on overflow</summary>

A `client.on` subscription registered with `overflow: "stop"` closes when its queue is full, while the gateway stays connected. Observe its `waitForClose()` outcome. The [SDK runner](/docs/{{version}}/starter-lifetime/) watches its event subscriptions, its command router and the client connection. The `diagnostics().events` counters show registrations and running callbacks, but cannot tell whether a particular application task is working

</details>

## A request is slow

Enable Debug records for REST with `logging: { categories: { rest: "debug", ratelimit: "debug" } }` or `FLUXERLY_DEBUG=rest,ratelimit`. Each request prints its method, route template, status, duration and attempt, and each rate-limit wait prints its route and delay. Retries and waits are also counted in `diagnostics().counters`

<details>
<summary>Queues, deadlines and timeouts after sending</summary>

The `diagnostics().rest.queuedRequests` and `activeRequests` values show local queueing for this client. An operation deadline includes the wait in that queue and required SDK cleanup. A timeout after the request was sent does not prove that the write failed on Fluxer, so it is an [uncertain write](/docs/{{version}}/glossary/#uncertain-write). Do not replay it blindly

</details>

## The connection is recovering

Each `lifecycle.connectionLost` record names the close code, its meaning and the next step. Transient recovery differs from terminal authentication or protocol rejection, which ends with `lifecycle.connectionEnded` and the error shown in full. The retained `run()` or `waitForClose()` outcome supplies the terminal result

Do not create another client or repeat `connect()` merely because the existing client is recovering. The client already owns that recovery lifetime. A closed client requires a new explicitly owned instance

## Shutdown is waiting, or application work finishes afterward

Check which work is still running. SDK shutdown waits for its own resources to close. It also waits for collector progress callbacks and native scoped [finalizers](/docs/{{version}}/glossary/#finalizer), so one of those that never finishes can hold up shutdown. The `lifecycle.shutdownComplete` record reports how long cleanup took, and each failed cleanup step is logged as `lifecycle.cleanupFailed`

Handlers are different. A stop requested through the `runBot` signal or a process signal, or a call to `client.shutdown({ drainMs })`, lets running handlers and their REST requests finish for a limited time, logged as `lifecycle.draining`, and then cancels what is left. A plain `client.shutdown()` cancels them at once. No shutdown waits for work a handler did not return, so database writes or detached Promises can finish after the subscription closes. Use [explicit application tracking](/docs/{{version}}/application-supervision/#drain-application-owned-work) when that work must settle before exit

Avoid `process.exit()` as a cleanup shortcut. Set `process.exitCode` after application cleanup instead. Neither cancellation nor a timeout proves rollback of an external mutation

## Keep diagnostics safe and useful

Record the SDK version from the `lifecycle.starting` record, the Node version, the record codes and the output of `describeError`. The SDK masks tokens, Authorization headers, client secrets and invite codes in every record. Message content appears only when unsafe payload logging is switched on, so leave that off when sharing logs
