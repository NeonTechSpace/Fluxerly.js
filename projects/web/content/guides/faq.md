---
title: Frequently asked questions
navTitle: FAQ
description: Short answers to common questions about the SDK
---

Each answer is short and links to the page that covers the topic in full

## Why does loading the SDK fail with a require error?

The SDK ships only ECMAScript modules, so `require("@neontechspace/fluxerly")` fails with an error saying that Fluxerly is ESM-only. Use `import`, and add `"type": "module"` to the project's `package.json` or name the file with `.mjs`. See [troubleshooting](/docs/troubleshooting/#the-process-fails-with-a-require-error)

## Does Fluxerly support voice?

Not yet. Fluxerly waits for Fluxer's new voice system and does not support voice over LiveKit. Fluxer is replacing LiveKit with its own voice system, which should arrive soon, and bot voice will come with it. Until then, voice states, member voice controls such as move, mute, deafen and disconnect, voice notes, and audio or video attachments work

## Which Node.js version is required?

Fluxerly is tested against Node.js 24.15 or newer. A bot runs as a Node.js program on a computer or server, not inside a web page. See [support and compatibility](/docs/support-and-compatibility/)

## Does TypeScript need extra setup?

Install `@types/node` as a development dependency and include the Node.js types, for example with `"types": ["node"]` in `tsconfig.json`. The SDK's types use Node.js `AbortSignal` and `AsyncDisposable`. The SDK supports TypeScript 7. JavaScript projects need no TypeScript installation. See the [quick start](/docs/quick-start/), under **Using TypeScript or Effect?**

## Where should the bot token be stored?

Keep it out of the code, in the `FLUXER_BOT_TOKEN` environment variable. For local development, put it in a `.env` file, start the bot with `node --env-file=.env bot.js`, and add `.env` to `.gitignore`. The SDK never writes the token to its logs. Regenerate a token that has been shared or committed. See [create a bot](/docs/create-a-bot/)

## Why does the bot not see or answer messages?

The bot must be a member of the community and have permission to view the channel and send messages there. [Create a bot](/docs/create-a-bot/) lists the minimum permissions. The SDK sends no gateway intents, so no intent setting is required. The `gateway.ignoredEvents` option suppresses listed dispatches, with exceptions for messages that mention the bot, @here or @everyone, and for reaction batches. See [event filtering](/docs/testing/#match-gateway-event-filtering) for those exceptions. The starter also ignores messages from bots and anything other than `!ping`. See [troubleshooting](/docs/troubleshooting/#no-reply-arrives)

## Why do methods return Results instead of throwing?

Failures such as a missing permission, a network error or a rate limit are expected in a running bot. A [Result](/docs/glossary/#result) makes them visible in the return type, so they are handled where they happen instead of stopping the bot. Invalid options still throw `ConfigurationError` at once, while invalid request input comes back as a failed Result. The `orThrow` function returns a Result's value or throws its error when throwing suits the code better. See [reliability](/docs/reliability/)

## What is Effect?

Effect is a TypeScript library for writing programs that handle failures, cancellation and cleanup in a structured way. Work is written as an Effect value that describes what to do, and each possible failure is part of its type. When the work stops, whether it succeeded, failed or was cancelled, Effect runs the cleanup it owns. The [Effect website](https://effect.website) introduces it

## Is Effect required?

No. The default `@neontechspace/fluxerly` entry point works with plain JavaScript or TypeScript, Promises and Results. The SDK uses Effect internally, and npm, pnpm and Bun install it automatically. The `@neontechspace/fluxerly/effect` entry point is for applications that already use Effect. See [first Effect bot](/docs/effect-first-bot/)

## Does the bot need to handle rate limits?

Usually not. For Fluxer API requests, an HTTP 429 with a usable retry delay is retried when the request body can be reused and the wait fits within the request's deadline. An inline attachment or webhook request carrying a `file` or `stream` attachment fails instead, because that body cannot be sent again

A response without a usable retry delay also fails. Waits of a second or longer are logged as `ratelimit.wait`. For a request whose body can be reused, a known wait that would reach or pass its deadline fails with a `ratelimit.deadline` record instead. See [rate limit](/docs/glossary/#rate-limit) and [troubleshooting](/docs/troubleshooting/)

## How can a bot be tested without Fluxer?

The `@neontechspace/fluxerly/testing` entry point creates a real client connected to an in-memory Fluxer. Its `createTestBot` function runs a bot from the same options object it passes to `runBot`. Tests deliver events, answer requests and check what the bot sent, without a network, token or account. Effect applications use `@neontechspace/fluxerly/effect/testing`. See [Test a bot without Fluxer](/docs/testing/)

## Does the bot need sharding?

Most bots do not. One [shard](/docs/glossary/#shard) carries up to 2,500 communities, Fluxer's limit. For a larger bot in one process, `sharding: "auto"` counts its communities when it first connects and opens one shard per 2,000 communities, which leaves room to grow

A bot without `sharding` settings that passes the limit moves to that automatic count when Fluxer refuses its one shard, so it keeps running. Running shards in several processes without a supervisor needs an explicit shard total. A [supervisor](/docs/sharding/#run-shards-in-several-processes) can choose the total itself with `totalShards: "auto"`. See [sharding](/docs/sharding/)
