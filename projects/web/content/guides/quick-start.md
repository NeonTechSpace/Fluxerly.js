---
title: Start your first bot
description: Type !ping and let your bot reply Pong!
---

You'll need Node.js 24.11 or newer and a Fluxer bot added to your server

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

Save this as <code data-example-filename>bot.js</code>, replacing `YOUR_BOT_TOKEN` with your bot's token.
Keep this file private while it contains your token

```js
import { createClient } from "@neontechspace/fluxerly"

const created = createClient({ token: "YOUR_BOT_TOKEN" })
if (created.isErr()) throw created.error
const client = created.value

client.on("messageCreate", async (message) => {
    if (message.content === "!ping") {
        await client.messages.reply(message, { content: "Pong!" })
    }
})

const connected = await client.connect()
if (connected.isErr()) throw connected.error
```

## 3. Start it

```command
{"kind":"run","command":"node bot.js"}
```

Type **!ping** in a channel your bot can read and reply to.
It should answer **Pong!**

Press Ctrl+C in the terminal to stop it

## Keep going

Change `!ping` or `Pong!` to give your bot a different command or reply.
The [client's message methods](/docs/{{version}}/api/interfaces/js-ts.Client/#messages) cover replies, edits and more

<details>
<summary>If your bot doesn't reply</summary>

Check that you replaced `YOUR_BOT_TOKEN` and that the bot can view the channel and send messages.
Keep the terminal running while you try `!ping`.
To inspect a failed reply, save the result from `client.messages.reply` and check its `isErr()` method

Never share your bot token when asking for help

</details>

<details>
<summary>What do isErr() and value mean?</summary>

The SDK returns a result so you can handle a failed request without guessing whether it succeeded.
`isErr()` tells you that the operation failed, and `error` describes that failure.
Otherwise, `value` holds the successful result, such as your client

The startup checks above stop the script if the client cannot be created or connected.
As your bot grows, check message results too so it can respond to failed requests

Call `client.shutdown()` when you add graceful shutdown to your application

</details>

<details>
<summary>Which SDK version should I use?</summary>

Choose Stable in the documentation version selector once a stable release is available.
The install command then includes that exact version.
Choose Canary to try upcoming changes, or RC to test a release candidate.
A preview marked Unreleased does not have an installable package version yet

</details>

<details>
<summary>Using TypeScript or Effect?</summary>

Choose TypeScript above to save this example as `bot.ts` and run it directly with Node.js, without a compilation step.
For TypeScript projects that compile or typecheck their code, use TypeScript 7

The default API works with JavaScript and TypeScript.
The [Effect-native API](/docs/{{version}}/api/modules/Effect/) is for applications already using Effect

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
