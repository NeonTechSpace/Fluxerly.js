---
title: Start a bot
navTitle: Quick start
description: Send !ping and receive Pong! from a bot
---

Before starting, [create a Fluxer bot](/docs/{{version}}/create-a-bot/), copy its token when Fluxer shows it and add the bot to a community. Fluxer shows a token only once, and the project below has a file for it. Fluxerly is tested against Node.js 24.15 or newer

## Generate the project

{{init}}

Adding `--template js`, `--template ts` or `--template effect` skips the question. The command writes the bot shown below with a test, an empty `.env` file for the token and an `AGENTS.md` file for coding agents. It then installs the SDK and prints the remaining steps

The folder may already hold the `.env` and `.gitignore` that the [manual setup](/docs/{{version}}/quick-start/#2-save-the-token) describes. The command keeps the `.env` and its token, adds `node_modules` and `.env` to the `.gitignore` when they are missing and leaves the rest of that file as it is. When any other file that the command writes already exists, such as `package.json` or `bot.js`, it stops without writing anything

Then set `FLUXER_BOT_TOKEN` in `.env` to the token. Check the bot with `npm test`, `pnpm test` or `bun run test`, which runs it against an in-memory Fluxer without the token or a network. Start it with `npm start`, `pnpm start` or `bun run start` and continue with [Try it](/docs/{{version}}/quick-start/#try-it)

## Set up the project by hand

These steps create the same bot without the generator

### 1. Install the SDK

Open a terminal in the bot's folder.
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

### 2. Save the token

Save the token in a file named `.env` in the bot's folder:

```text
FLUXER_BOT_TOKEN=paste-the-token-here
```

Check that the file is named exactly `.env`. Some editors, such as Notepad, add `.txt` when saving, and Node.js cannot find `.env.txt`

Keep that file out of version control by adding this line to `.gitignore`:

```text
.env
```

### 3. Create the bot

Save this as <code data-example-filename>bot.js</code>.
The bot reads its token from `FLUXER_BOT_TOKEN` in the process environment, so the token never appears in the file

```js
{{starter:bot.js}}
```

The file exports the bot's options as `bot`. The `defineBot` function returns them unchanged and keeps the types of command arguments for TypeScript and editors. Running the file starts the bot with these options and the token, while a test can import `bot` without starting it. [Testing a bot](/docs/{{version}}/testing/) shows the test that the generator writes

### 4. Start it

Start the bot with the token's `.env` file:

```command
{"kind":"run","command":"node --env-file=.env bot.js"}
```

When `FLUXER_BOT_TOKEN` is already set in the terminal, run the file without `--env-file=.env`

<details>
<summary>Set the variable in the terminal instead</summary>

In bash or zsh, run `export FLUXER_BOT_TOKEN="paste-the-token-here"`, then start the bot with `node bot.js` in the same terminal.
In PowerShell, run `$env:FLUXER_BOT_TOKEN = "paste-the-token-here"`, then `node bot.js`

The variable lasts until the terminal closes. The typed command can stay in the shell's history, so prefer `.env` on shared machines

</details>

## Try it

Once the bot is online, the terminal shows a line such as `Connected to Fluxer as MyBot in 1 community`. If it says instead that the bot is not in any community yet, open the link in that line to invite it

Type **!ping** in a channel the bot can read and reply to.
It should answer **Pong!**

The SDK skips messages from bots by default. The `commands` option routes a message that starts with the `!` prefix and a command name, such as `!ping`, to that command, and the bot ignores every other message

Press Ctrl+C to stop the bot. The SDK then stops the commands, closes the connection and finishes its cleanup before the program ends

## Keep going

Change `ping` or `Pong!` to customize the command or reply. Then choose a task:

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

Requests such as `reply` do not throw. They return a Result, which is either a success or a failure. The command returns the reply's Result, so the SDK logs a failed reply and the bot keeps running

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

Choose TypeScript above to save this example as `bot.ts`. The code is the same, and Node.js runs it directly, without a compilation step, and removes the types without checking them

A generated TypeScript or Effect project needs no further setup to typecheck. It installs TypeScript 7 and the Node.js types, writes the `tsconfig.json` below and adds a `check` script that runs the compiler, as `npm run check`, `pnpm run check` or `bun run check`.
To typecheck a project set up by hand, install the Node.js types, which the SDK's types use for values such as the `AbortSignal` passed to handlers:

```command
{"kind":"dev","package":"@types/node"}
```

Install `typescript@7` the same way, as another development dependency. Then add a `tsconfig.json` next to the bot:

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

TypeScript only checks the code and writes no output, because Node.js removes the types itself. The last three settings keep the code in a form Node.js can run directly: Imports of other files may use their `.ts` extension, type-only imports need `import type`, and TypeScript features that generate code, such as `enum`, are reported. Run the check with `npm exec tsc`, `pnpm exec tsc` or `bun run tsc`

JavaScript can also use editor inference and optional `// @ts-check` without changing file extensions or adding a build step. Neither a compiler nor checked JavaScript is required to run the bot

The default API works with JavaScript and TypeScript. Effect is optional: The [Effect learning path](/docs/{{version}}/effect-first-bot/) introduces the native API and shows which Effect version to install

</details>
