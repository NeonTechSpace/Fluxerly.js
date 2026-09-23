---
title: Run a bot with the SDK
navTitle: Bot lifetime
description: Let the SDK own connection and subscription cleanup while the application owns bot behavior
---

The public `runBot` helper creates a client, installs handlers before connecting and watches the subscriptions returned by the installer. The [first bot](/docs/{{version}}/quick-start/) uses it directly, so there is no separate lifecycle file to copy

## What the SDK and application handle

The SDK reconnects after recoverable connection failures, watches subscriptions needed to keep the bot running and waits for SDK cleanup. A permanent connection failure or a failed or unexpectedly closed subscription stops the bot. A failed handler does not stop its subscription and is not retried automatically

The application supplies the token and handlers, decides how to report errors and closes any resources outside the SDK. Return every subscription the bot needs from the installer so `runBot` can watch it. Track database writes and other Promises in application code, and wait for them when they must finish before exit

## Stop the bot

Pass `{ processSignals: true }` as the third argument to handle Ctrl+C (SIGINT) and SIGTERM. Simply importing the SDK does not add signal handlers. The runner removes its handlers when the bot stops

An `AbortSignal` can also be passed in the options object to stop the bot. Stopping waits for cleanup. If cleanup fails, the run still reports that failure

## Choose the API

The JavaScript and TypeScript runner returns a Result for expected failures. Catch unexpected defects and installer exceptions in the bot's top-level code. The [first-bot example](/docs/{{version}}/quick-start/) reports a safe failure message and sets the process exit code

The [Effect runner](/docs/{{version}}/effect-first-bot/) returns an Effect and keeps access to application services, scoped resources and failure causes. Run it once from the application's top-level code instead of starting a separate runtime inside handlers

For a custom startup or shutdown flow, the lower-level client and subscription APIs remain available. See [application supervision](/docs/{{version}}/application-supervision/) for tracking required subscriptions and waiting for work outside the SDK

## Extend the application

- Handle expected reply failures without blindly repeating writes after a lost response
- Keep command rejection, cooldown feedback and user-facing messages in command definitions
- Create a new client when restarting and limit how often the application retries. Restarting does not replay missed events or failed handlers
- Limit how many subscriptions the application creates at runtime. Store data and jobs that must survive a restart outside the SDK
