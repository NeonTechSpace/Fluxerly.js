---
title: Start your first bot
navTitle: Quick start
description: Type !ping and let your bot reply Pong!
---

The starter requires Node.js 24.11 or newer and a Fluxer bot added to a server

## 1. Install the SDK

Open a terminal in a folder for your bot.
Create a `package.json` file:

```json
{
    "type": "module"
}
```

This lets Node use `import` in your bot

{{installation}}

## 2. Create your bot

Copy `lifetime.js` from `node_modules/@neontechspace/fluxerly/examples/starter/` into the bot folder. The [starter lifetime guide](/docs/{{version}}/starter-lifetime/) also provides the complete file and explains its ownership

Save this as <code data-example-filename>bot.js</code> beside `lifetime.js`.
Set `FLUXER_BOT_TOKEN` in the process environment instead of putting the token in either file

```js
{{starter:bot.js}}
```

## 3. Start it

```command
{"kind":"run","command":"node bot.js"}
```

Type **!ping** in a channel your bot can read and reply to.
It should answer **Pong!**

The `!about` command provides a second example. Bot-authored messages, unknown commands and extra arguments are ignored by this starter

Press Ctrl+C in the terminal to request shutdown and wait for SDK-owned cleanup. The application-owned companion observes the command subscription as well as the connection, so a stopped critical worker cannot leave the bot silently connected

## Keep going

Change `!ping` or `Pong!` to give your bot a different command or reply. Then choose a task:

- [Send messages, embeds and files](/docs/{{version}}/messages/): Check reply results, edit messages and attach a file
- [Give your bot prefix commands](/docs/{{version}}/commands/): Register actions with typed arguments and generated help
- [React to events and collect replies](/docs/{{version}}/events-and-collectors/): Distinguish joins from startup and build a bounded conversation
- [Read history and use caches](/docs/{{version}}/history-and-cache/): Scan deliberately and separate local snapshots from remote reads
- [Operate a long-running bot](/docs/{{version}}/reliability/): Handle failures, cancellation and shutdown
- [Learn Effect with a bot](/docs/{{version}}/effect-first-bot/): Try the native API without changing SDK capabilities

The [client's message methods](/docs/{{version}}/api/interfaces/js-ts.Client/#messages) link to the full API reference when you need exact inputs and return values

<details>
<summary>If your bot doesn't reply</summary>

Check that `FLUXER_BOT_TOKEN` is set and that the bot can view the channel and send messages.
Keep the terminal running while you try `!ping`.
The starter checks the reply Result with `isErr()` and logs its safe failure kind. A lost response can leave a reply posted, so a failed Result is not a reason to send it again blindly

The [troubleshooting guide](/docs/{{version}}/troubleshooting/) separates command, worker, connection and request failures using safe diagnostics. Never share a bot token or private message contents

</details>

<details>
<summary>What do isErr() and value mean?</summary>

The SDK returns a result so you can handle a failed request without guessing whether it succeeded.
The `isErr()` method tells you that the operation failed, and `error` describes that failure.
Otherwise, `value` holds the successful result, such as your client

The startup and registration checks stop the script on a visible failure.
The reply handler reports the typed failure kind without exposing message contents or credentials.
The process-signal boundary asks handlers to stop, closes the connection and awaits SDK-owned cleanup. Ordinary handler Promises remain application-owned and are not automatically drained

</details>

<details>
<summary>Which SDK version should be used?</summary>

Choose Stable in the documentation version selector once a stable release is available.
The install command then includes that exact version.
Choose Canary to try upcoming changes, or RC to test a release candidate.
A preview marked Unreleased does not have an installable package version yet

</details>

<details>
<summary>Using TypeScript or Effect?</summary>

Choose TypeScript above to save this example as `bot.ts` and run it directly with Node.js, without a compilation step.
For TypeScript projects that compile or typecheck their code, use TypeScript 7

JavaScript can also use editor inference and optional `// @ts-check` without changing file extensions or adding a build step. A TypeScript 7 project check with `allowJs` and `checkJs` verifies JavaScript types when desired. Neither a compiler nor checked-JavaScript mode is required to run the bot

The default API works with JavaScript and TypeScript.
The optional [Effect learning path](/docs/{{version}}/effect-first-bot/) introduces the native API through progressively larger bot examples

Use the Effect version selected by your installed SDK, not Effect's latest release.
Open `node_modules/@neontechspace/fluxerly/package.json`.
Read `peerDependencies.effect` for the SDK's tested Effect version

Modern npm and pnpm install the npm package's required peer automatically.
If your application imports Effect directly, or automatic peer installation is disabled, install that exact version yourself.
For this documentation version, the command is:

```command
{"kind":"add","package":"effect","version":"{{effect-version}}"}
```

Inspect your project's installed Effect version with:

```command
{"kind":"list","package":"effect"}
```

Recheck the required version when upgrading the SDK

</details>
