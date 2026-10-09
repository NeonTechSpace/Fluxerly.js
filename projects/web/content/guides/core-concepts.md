---
title: Core concepts
navTitle: Core concepts
description: Understand clients, events, results, caches and the gateway before building further
---

A few ideas explain most of how Fluxerly works. This page introduces each one briefly and points to the guide that covers it in depth. The [glossary](/docs/{{version}}/glossary/) defines the remaining terms

## Gateway and REST

A bot talks to Fluxer in two ways:

- The [gateway](/docs/{{version}}/glossary/#gateway) is a connection that stays open while the bot runs. Fluxer pushes events through it, such as a new message or a member joining
- [REST](/docs/{{version}}/glossary/#rest) requests are single HTTP calls that read or change something, such as sending a message or fetching a channel

Receiving events needs the gateway. Sending a message or reading data does not, so a script that only posts one message can skip connecting

<details>
<summary>Outgoing gateway commands and presence</summary>

Most outgoing work uses the SDK's named methods. The `gateway.send` method is an escape hatch for a command without one. Outgoing status, member subscriptions, count requests and custom commands share a pacing budget, so a command can wait locally before reaching the socket. An excess custom-command submission fails with reason `busy` when its waiting queue is full. Cancelling an unsent custom command immediately frees its place, and disconnecting abandons it rather than replaying it on the next connection

The `presence.set` method retains the latest requested status for each ready local shard. Changes replace an unsent update instead of building a backlog. The four-second spacing starts when the update reaches the socket, not when it enters the queue. The `presence.setMembers` method follows the same latest-intent rule for an unsent member selection, and clearing it withdraws the queued request

The `guilds.fetchCounts`, `channels.fetchMemberCounts` and `members.iterateChunks` methods require a ready gateway and share a separate request-slot budget. Their deadlines include gateway pacing waits. Cancellation or deadline expiry withdraws unsent commands and releases local capacity, but cannot stop work already sent to Fluxer

Fluxer accepts 12 member requests per account in 10 seconds and drops the rest without an answer. One client therefore sends at most 12 in any 11 seconds, and a further `members.iterateChunks` request fails at once with reason `rateLimit` and a `retryAfterMs` wait instead of timing out. A member request sent with `gateway.send` counts as well, but `gateway.send` never refuses one. Requests from other processes with the same token are not counted

</details>

## The client

A client holds the token, the connection and everything the bot has registered. There are two ways to get one:

- The `runBot` function creates a client from one options object, registers event handlers and commands, connects and keeps running until the bot stops. Most bots need only this, as the [quick start](/docs/{{version}}/quick-start/) and [small bot](/docs/{{version}}/small-bot/) show
- The `createClient` function returns a client without connecting it. Use it for scripts that only send requests, or when the application must control connecting, running and stopping itself

Invalid settings, such as a misspelled option name, throw a `ConfigurationError` right away, before anything connects. A missing token is reported instead: `runBot` logs it with a hint, sets exit code 1 and returns the error. A misspelled name comes with a suggestion, such as `Did you mean "processSignals"?`

## Events and handlers

An [event](/docs/{{version}}/glossary/#event) is something Fluxer reports through the gateway, such as `messageCreate` or `guildMemberAdd`. A [handler](/docs/{{version}}/glossary/#handler) is the function that runs for it. With `runBot`, handlers go in the `events` option, and prefix commands in the `commands` option. A [guild](/docs/{{version}}/glossary/#guild) in the API is a community in Fluxer, so `guildMemberAdd` reports a member joining a community

There is no ready event. The `runBot` function logs a line when the bot is connected, and its `setup` option runs startup work before the bot connects. With `createClient`, code after `await client.connect()` runs once the bot is connected

Handler failures are isolated. A failing handler is reported to `onError`, or logged when there is no `onError`, and the bot keeps running. Each handler also receives a cancellation `signal`, which the SDK triggers when the bot stops. The [events guide](/docs/{{version}}/events-and-collectors/) covers waiting for replies and handling bursts

## Results

Requests that can fail, such as sending a message, do not throw. They return a [ResultAsync](/docs/{{version}}/glossary/#resultasync), which becomes a [Result](/docs/{{version}}/glossary/#result) when awaited. A Result is either a success with a `value` or a failure with an `error`:

- Check `isErr()` when the code should handle a failure itself, for example by replying with an explanation
- Wrap the call in `orThrow(...)` when a failure should end the current function. It returns the value, or throws the error
- Return the Result from a handler or command to let the SDK report a failure to `onError`

Every SDK error has a stable `code`, a readable message and often a `hint`. Printing it with `describeError(error)` shows all of that and the chain of causes, with credentials masked. The [error and log codes](/docs/{{version}}/error-and-log-codes/) page lists every code. The [reliability guide](/docs/{{version}}/reliability/) explains which failures are safe to retry

## Caches

A [cache](/docs/{{version}}/glossary/#cache) keeps local copies of what Fluxer has sent, such as channels, members or messages. Caches are off unless enabled with the client's `cache` option, and each kind of data is switched on separately

A cache lookup and a remote read look similar but behave differently:

```ts
import { orThrow, type Client } from "@neontechspace/fluxerly"

export async function channelName(client: Client, channelId: string) {
    // A local snapshot: instant, but it can be missing or out of date
    const cached = client.channels.get(channelId)
    if (cached !== undefined) return cached.name
    // A REST read: current when it is read, but it takes a request and can fail
    const channel = await orThrow(client.channels.fetch(channelId))
    return channel.name
}
```

Use `get` when a recent copy is good enough, and `fetch` when the answer must be current. The [cache settings](/docs/{{version}}/configuration/#cache) turn on and bound each cache category, and the [history and cache guide](/docs/{{version}}/history-and-cache/) shows the message cache in use

## Effect API

Fluxerly has two entry points with the same features. The default one, `@neontechspace/fluxerly`, uses `async` functions and Results and works in JavaScript and TypeScript. The native one, `@neontechspace/fluxerly/effect`, returns [Effect](/docs/{{version}}/glossary/#effect) values for applications built with the Effect library, where failures, cancellation and cleanup are part of each value's type

Choose the default API unless the application already uses Effect. The [Effect learning path](/docs/{{version}}/effect-first-bot/) introduces the native API

## Shutdown

Whoever starts the client also stops it:

- With `runBot`, the runner owns the client. In the default API, Ctrl+C or a stop request from a process manager stops the bot unless `processSignals` is `false`. The runner then cancels handlers, closes the connection, waits for cleanup and returns. When the bot stopped because of a failure, the runner logs it and sets the process exit code to 1
- With `createClient`, the application owns the client and must call `shutdown()`, or declare it with `await using` so it shuts down at the end of the block

Shutdown waits for the SDK's own work, not for other promises the application started. The [bot lifetime guide](/docs/{{version}}/starter-lifetime/) covers what the runner owns and what the application owns
