---
title: Start a bot
navTitle: Quick start
description: Send !ping and receive Pong! from a bot
---

Before starting, [create a Fluxer bot](/docs/{{version}}/create-a-bot/), store its token and add it to a community. Fluxerly is tested against Node.js 24.15 or newer

To generate the project instead of following steps 1 and 2, run `npx @neontechspace/fluxerly init`, `pnpm dlx @neontechspace/fluxerly init` or `bunx @neontechspace/fluxerly init` in a new, empty folder. It writes this bot with a test and prints the remaining steps, including where the token goes

## 1. Install the SDK

Open a terminal in the bot's folder, where `.env` is saved.
Create a `package.json` file in that folder:

```json
{
    "type": "module"
}
```

This lets the bot use `import` in Node.js

{{installation}}

When a coding agent helps write the bot, copy the SDK's rules for it into the project's `AGENTS.md`, which many coding agent tools read automatically. Run the same command again after updating the SDK

```command
{"kind":"agents"}
```

## 2. Create the bot

Save this as <code data-example-filename>bot.js</code>.
The bot reads its token from `FLUXER_BOT_TOKEN` in the process environment, so the token never appears in the file

```js
{{starter:bot.js}}
```

## 3. Start it

Start the bot with the token's `.env` file, as [Create a bot](/docs/{{version}}/create-a-bot/) sets up:

```command
{"kind":"run","command":"node --env-file=.env bot.js"}
```

When `FLUXER_BOT_TOKEN` is already set in the terminal, run the file without `--env-file=.env`

Once the bot is online, the terminal shows a line such as `Connected to Fluxer as MyBot in 1 community`. If it says instead that the bot is not in any community yet, open the link in that line to invite it

Type **!ping** in a channel the bot can read and reply to.
It should answer **Pong!**

The SDK skips messages from bots by default. The bot replies only when a person sends exactly `!ping`

Press Ctrl+C to stop the bot. The SDK then stops the message handler, closes the connection and finishes its cleanup before the program ends

## Keep going

Change `!ping` or `Pong!` to customize the command or reply. Then choose a task:

- [Build a small bot](/docs/{{version}}/small-bot/): Combine commands, arguments, an embed, a welcome message, a permission check and a cooldown in one file
- [Learn the core concepts](/docs/{{version}}/core-concepts/): Clients, events, Results, caches and the gateway in plain terms
- [Copy an example bot](/docs/{{version}}/examples/): Complete bots for moderation, reaction roles, welcomes and tickets
- [Send messages, embeds and files](/docs/{{version}}/messages/): Check reply results, edit messages and attach a file
- [Add prefix commands to a bot](/docs/{{version}}/commands/): Register actions with typed arguments and generated help
- [React to events and collect replies](/docs/{{version}}/events-and-collectors/): Distinguish joins from startup and build a bounded conversation
- [Operate a long-running bot](/docs/{{version}}/reliability/): Handle failures, cancellation and shutdown

The [client's message methods](/docs/{{version}}/api/interfaces/js-ts.Client/#messages) link to the full API reference for exact inputs and return values

<details>
<summary>If the bot does not reply</summary>

Check that `FLUXER_BOT_TOKEN` is set and that the bot can view the channel and send messages. Without a token, the bot stops at once with an error whose hint points to an unset environment variable. When Node.js prints `.env: not found`, the terminal is not in the bot's folder or the file is saved as `.env.txt`.
Keep the terminal running when trying `!ping`.
When a reply fails, the terminal shows a log line with the reason and a hint, such as a missing permission. Outside a terminal, such as in an editor's run panel, log lines are JSON. Add `FLUXERLY_LOG_FORMAT=pretty` to `.env` for readable lines there. A reply can fail after Fluxer has already posted it, for example when the response is lost, so do not send it again blindly

The [troubleshooting guide](/docs/{{version}}/troubleshooting/) helps tell command, connection and request failures apart. Never share a bot token or private message contents

</details>

<details>
<summary>What happens when something fails?</summary>

Requests such as `reply` do not throw. They return a Result, which is either a success or a failure. The handler returns the reply's Result, so the SDK logs a failed reply and the bot keeps running

A failure that stops the whole bot, such as a rejected token, is logged once, and the process ends with exit code 1 so a shell or process manager can tell it from a normal stop. A missing token is logged with a hint and also ends the process with exit code 1, before the bot connects. The [core concepts](/docs/{{version}}/core-concepts/) page explains Results in more detail

</details>

<details>
<summary>Which SDK version should be used?</summary>

The install command above uses the version chosen in the documentation's version selector.
Choose Stable once a stable release is available.
The selector also lists prerelease channels, which show upcoming versions before they become stable.
A preview marked Unreleased does not have an installable package version yet

</details>

<details>
<summary>Using TypeScript or Effect?</summary>

Choose TypeScript above to save this example as `bot.ts`. Node.js runs it directly, without a compilation step

To typecheck TypeScript with TypeScript 7, install the Node.js types that the SDK's types use:

```command
{"kind":"dev","package":"@types/node"}
```

Then add a `tsconfig.json` next to the bot:

```json
{
    "compilerOptions": {
        "target": "ES2024",
        "module": "NodeNext",
        "types": ["node"],
        "strict": true,
        "noEmit": true,
        "allowImportingTsExtensions": true,
        "verbatimModuleSyntax": true,
        "erasableSyntaxOnly": true
    }
}
```

The [TypeScript setup](/docs/{{version}}/create-a-bot/#typescript-setup) explains these settings and the pnpm command

JavaScript can also use editor inference and optional `// @ts-check` without changing file extensions or adding a build step. Neither a compiler nor checked JavaScript is required to run the bot

The default API works with JavaScript and TypeScript. Effect is optional: The [Effect learning path](/docs/{{version}}/effect-first-bot/) introduces the native API and shows which Effect version to install

</details>
