---
title: Run a bot with the SDK
navTitle: Bot lifetime
description: What runBot does from start to stop, and what stays with the application
---

The `runBot` function runs a whole bot from one options object. It creates the client, registers every handler and command before connecting, keeps the connection alive and stops cleanly. The [quick start](/docs/{{version}}/quick-start/) bot is a complete example, and no separate lifecycle file is needed

## From start to stop

1. **Check.** The `runBot` call checks every option first. An unknown event name or an invalid command throws `ConfigurationError` before anything connects. A missing token is logged with a hint instead, the run ends with exit code 1, and `runBot` returns the error
2. **Register.** Event handlers and commands are registered, then the optional `setup(client, { signal })` callback runs for other startup work. Its `signal` aborts when the bot begins stopping, so timers that `setup` starts can stop with the bot. A failed `setup` stops the bot before it connects
3. **Connect.** The client connects to the gateway and handlers start receiving events. Messages written by bots, including the bot's own replies, skip handlers and commands unless `ignoreBots` is `false`
4. **Run.** The SDK reconnects after a lost connection and keeps each [handler](/docs/{{version}}/glossary/#handler) running. A failed handler is not retried and does not stop the bot. Its error is logged in full, or sent to `onError` when one is set. If a handler's subscription closes while the bot is running, the bot stops with `CriticalWorkerStoppedError`
5. **Stop.** Ctrl+C (SIGINT) and SIGTERM stop the bot unless `processSignals` is `false`, while the Effect API handles them only with `processSignals: true`. A `signal` option stops it from application code. Stopping accepts no new events and gives running handlers up to 5 seconds to finish, a time the `drainMs` option changes. Then it cancels the handlers still running through their `signal`, closes the connection and waits for the SDK's cleanup. The stop request and the shutdown duration are logged at Info, and a failed cleanup step is logged at Error and still reported by the run
6. **Report.** After a failure the bot could not recover from, such as a rejected token, the runner logs that failure once and sets `process.exitCode` to 1. A normal stop reports nothing
7. **Return.** The returned [Result](/docs/{{version}}/glossary/#result) is Ok after a normal stop, or an Err with the failure

The [deploying guide](/docs/{{version}}/deploying/#what-happens-on-shutdown) lists each shutdown step. Importing the SDK adds no signal handlers, and `runBot` removes its own when the bot stops. It never exits the process

## What each handler receives

In the default API, each event handler receives one context object with `event`, `client` and `signal`. Effect handlers receive `event` and `client` without a signal, because stopping the bot interrupts their Effect instead. A `messageCreate` handler also receives `message` and `reply`

The `reply` helper accepts a string or full message content and already applies the handler's cancellation signal. Return its Result so a failed reply is reported like a thrown error, as [reliability](/docs/{{version}}/reliability/#return-the-replys-result) explains. In the Effect API, `reply` returns an Effect. Return it or compose it into the handler's Effect so the SDK can run and interrupt it

By default `messageCreate` handlers run up to eight at a time and other events one at a time. A burst that fills a handler's queue drops the oldest waiting event with a Warn record instead of stopping the bot. [Configuration](/docs/{{version}}/configuration/#events-and-the-gateway) shows how to change this for one event

## What the application owns

The application supplies the token and handlers and decides how to report errors. It also owns everything outside the SDK:

- Work outside the drain: A returned handler Promise and its REST requests get the drain window to finish, 5 seconds by default, set by `drainMs`. Track detached Promises, timers, background jobs and work that needs more than that window, as shown in [application supervision](/docs/{{version}}/application-supervision/#drain-application-owned-work)
- Other resources: Close database connections, timers and servers after `runBot` resolves, so the process can exit
- Restarts: A process manager or a new `runBot` call starts a new client. Restarting does not replay missed events or failed handlers
- Durable work: Store data and jobs that must survive a restart outside the SDK

## Choose the API

The JavaScript and TypeScript `runBot` returns a Result for expected failures and reports them itself, so the [quick start](/docs/{{version}}/quick-start/) bot only awaits it. Invalid options still throw `ConfigurationError` at once, and an unexpected SDK defect rejects with `SdkDefect`. Set `reportFailure: false` when the application handles the returned failure and the exit status itself, for example to restart the bot in the same process

The [Effect `runBot`](/docs/{{version}}/effect-first-bot/) returns an Effect and keeps access to application services, scoped resources and failure causes. It reports a failure the same way, so running it with `Effect.runPromiseExit` is enough. Run it once from the application's top-level code instead of starting a separate runtime inside handlers

For prefix commands, pass `commands`, as shown in [commands](/docs/{{version}}/commands/). The lower-level `createClient` and subscription APIs remain available for flows that need direct control of the client's lifetime. See [application supervision](/docs/{{version}}/application-supervision/) for watching required subscriptions in application code
