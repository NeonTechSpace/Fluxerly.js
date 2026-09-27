---
title: Frequently asked questions
navTitle: FAQ
description: Short answers to common questions about the SDK
---

Each answer is short and links to the page that covers the topic in full

<details>
<summary>Why does loading the SDK fail with a require error?</summary>

The SDK ships only ECMAScript modules, so `require("@neontechspace/fluxerly")` fails with an error saying that Fluxerly is ESM-only. Use `import`, and add `"type": "module"` to the project's `package.json` or name the file with `.mjs`. See [troubleshooting](/docs/{{version}}/troubleshooting/#the-process-fails-with-a-require-error)

</details>

<details>
<summary>Which Node.js version is required?</summary>

Fluxerly is tested against Node.js 24.11 or newer. A bot runs as a Node.js program on a computer or server, not inside a web page. See [support and compatibility](/docs/{{version}}/support-and-compatibility/)

</details>

<details>
<summary>Does TypeScript need extra setup?</summary>

Install `@types/node` as a development dependency and include the Node.js types, for example with `"types": ["node"]` in `tsconfig.json`. The SDK's types use Node.js `AbortSignal` and `AsyncDisposable`. The SDK supports TypeScript 7. JavaScript projects need no TypeScript installation. See [create a bot](/docs/{{version}}/create-a-bot/)

</details>

<details>
<summary>Where should the bot token be stored?</summary>

Keep it out of the code, in the `FLUXER_BOT_TOKEN` environment variable. For local development, put it in a `.env` file, start the bot with `node --env-file=.env bot.js`, and add `.env` to `.gitignore`. The SDK never writes the token to its logs. Regenerate a token that has been shared or committed. See [create a bot](/docs/{{version}}/create-a-bot/)

</details>

<details>
<summary>Why does the bot not see or answer messages?</summary>

The bot must be a member of the community and have permission to view the channel and send messages there. [Create a bot](/docs/{{version}}/create-a-bot/) lists the minimum permissions. The SDK sends no gateway intents, so no intent setting is required, but an event type listed in `gateway.ignoredEvents` is not delivered. The starter also ignores messages from bots and anything other than `!ping`. See [troubleshooting](/docs/{{version}}/troubleshooting/#no-reply-arrives)

</details>

<details>
<summary>Why do methods return Results instead of throwing?</summary>

Failures such as a missing permission, a network error or a rate limit are expected in a running bot. A [Result](/docs/{{version}}/glossary/#result) makes them visible in the return type, so they are handled where they happen instead of stopping the bot. Programming mistakes, such as invalid options, still throw `ConfigurationError` at once. The `orThrow` function returns a Result's value or throws its error when throwing suits the code better. See [reliability](/docs/{{version}}/reliability/)

</details>

<details>
<summary>What is Effect?</summary>

Effect is a TypeScript library for writing programs that handle failures, cancellation and cleanup in a structured way. Work is written as an Effect value that describes what to do, and each possible failure is part of its type. When the work stops, whether it succeeded, failed or was cancelled, Effect runs the cleanup it owns. The [Effect website](https://effect.website) introduces it

</details>

<details>
<summary>Is Effect required?</summary>

No. The default `@neontechspace/fluxerly` entry point works with plain JavaScript or TypeScript, Promises and Results. The SDK uses Effect internally, and npm or pnpm installs it automatically. The `@neontechspace/fluxerly/effect` entry point is for applications that already use Effect. See [first Effect bot](/docs/{{version}}/effect-first-bot/)

</details>

<details>
<summary>Is the SDK stable?</summary>

Not yet. Fluxerly is a prerelease, and its API can still change between versions. The lockfile records the exact installed version and keeps installs reproducible. During the prerelease, install with `--save-exact`, which npm and pnpm both accept, so a fresh install without a lockfile cannot pick up a newer prerelease that may break the API. Read the [changelog](/docs/{{version}}/changelog/) before upgrading. See [support and compatibility](/docs/{{version}}/support-and-compatibility/)

</details>

<details>
<summary>Does the bot need to handle rate limits?</summary>

Usually not. When Fluxer answers with HTTP 429, the SDK waits for the required delay and sends the request again, within the request's deadline. Waits of a second or longer are logged as `ratelimit.wait`. A request whose wait would pass its deadline fails with a `ratelimit.deadline` record instead. See [rate limit](/docs/{{version}}/glossary/#rate-limit) and [troubleshooting](/docs/{{version}}/troubleshooting/)

</details>

<details>
<summary>How can a bot be tested without Fluxer?</summary>

The `@neontechspace/fluxerly/testing` entry point creates a real client connected to an in-memory Fluxer. Its `createTestBot` function runs a bot from the same options object it passes to `runBot`. Tests deliver events, answer requests and check what the bot sent, without a network, token or account. Effect applications use `@neontechspace/fluxerly/effect/testing`. See [Test a bot without Fluxer](/docs/{{version}}/testing/)

</details>

<details>
<summary>Does the bot need sharding?</summary>

Most bots do not. One [shard](/docs/{{version}}/glossary/#shard) carries up to 2,500 communities, Fluxer's limit. For a larger bot in one process, `sharding: "auto"` counts its communities when it first connects and opens one shard per 2,000 communities, which leaves room to grow. Spreading shards across processes needs an explicit shard total. See [sharding](/docs/{{version}}/sharding/)

</details>
