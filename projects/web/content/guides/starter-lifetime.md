---
title: Run a bot with the SDK
navTitle: Bot lifetime
description: Let the SDK own connection and subscription cleanup while the application owns bot behavior
---

The public `runBot` helper creates a client, installs handlers before connecting and watches the connection and required subscriptions. The [first bot](/docs/{{version}}/quick-start/) passes one configuration object with a token, signal handling and event handlers. There is no separate lifecycle file to copy

## What the SDK and application handle

The SDK reconnects after recoverable connection failures, watches subscriptions needed to keep the bot running and waits for SDK cleanup. A permanent connection failure or a failed or unexpectedly closed subscription stops the bot. A failed handler does not stop its subscription and is not retried automatically

The application supplies the token and handlers, decides how to report errors and closes any resources outside the SDK. A missing token is a configuration failure. Track database writes and other Promises in application code, and wait for them when they must finish before exit. The runner does not drain arbitrary Promises started by handlers

Each configured handler receives `event` and `client`. The default API also supplies `signal`. A `messageCreate` handler receives `message` and `reply`. The `reply` helper accepts a `ReplyInput` and optional `SendOptions`. In the default API it applies the handler's cancellation signal, so await its Result. In the native API it returns an Effect. Return that Effect or compose it into the handler's Effect so the SDK can run and interrupt it

## Stop the bot

Set `processSignals: true` in the configuration object to handle Ctrl+C (SIGINT) and SIGTERM. Simply importing the SDK does not add signal handlers. The runner removes its handlers when the bot stops

Pass an `AbortSignal` as `signal` in the configuration object to stop the bot from application code. Stopping waits for cleanup. If cleanup fails, the run still reports that failure

## Choose the API

The JavaScript and TypeScript runner returns a Result for expected failures. Catch unexpected defects in the bot's top-level code. The [first-bot example](/docs/{{version}}/quick-start/) reports a safe failure message and sets the process exit code

The [Effect runner](/docs/{{version}}/effect-first-bot/) returns an Effect and keeps access to application services, scoped resources and failure causes. Run it once from the application's top-level code instead of starting a separate runtime inside handlers

For a custom startup flow, the advanced `runBot(options, install, runOptions)` form lets an installer return the subscriptions the runner must watch. Pass signal handling in `runOptions` with that form. The lower-level `createClient` and subscription APIs remain available for flows that need direct lifetime control. See [application supervision](/docs/{{version}}/application-supervision/) for tracking required subscriptions and waiting for work outside the SDK

## Extend the application

- Handle expected reply failures without blindly repeating writes after a lost response
- Keep command rejection, cooldown feedback and user-facing messages in command definitions
- Create a new client when restarting and limit how often the application retries. Restarting does not replay missed events or failed handlers
- Limit how many subscriptions the application creates at runtime. Store data and jobs that must survive a restart outside the SDK
