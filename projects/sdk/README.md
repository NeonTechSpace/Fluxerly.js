# Fluxerly.js

Fluxerly.js is a JavaScript and TypeScript SDK for building Fluxer bots on Node.js.
It handles HTTP requests and gateway connections for messages, events, server resources and commands

Use `@neontechspace/fluxerly` for the JavaScript and TypeScript API, whose results let you check success and failure explicitly.
Use `@neontechspace/fluxerly/effect` when your application already uses Effect.
Both entry points share the same implementation

This package is under development and has not reached its first stable release.
It targets Node.js 24.11.0 or newer and JavaScript or TypeScript 7.
JavaScript users do not need to install TypeScript

## Your first bot

This bot replies **Pong!** when you send **!ping**

After installing the SDK, add `"type": "module"` to your bot project's `package.json`

Save the following as `bot.js`, or `bot.ts` for TypeScript, and replace `YOUR_BOT_TOKEN`

Keep the file private while it contains your token

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

The same code works in JavaScript and TypeScript.
Run `node bot.js` or `node bot.ts`, then send **!ping** in a channel your bot can read and reply to

## Choose the Effect version

The recommended Effect version is the one selected by your installed SDK, not Effect's latest release.
Open `node_modules/@neontechspace/fluxerly/package.json` in your bot project.
Read `peerDependencies.effect`

Modern npm and pnpm install the required Effect peer automatically.
If automatic peer installation is disabled, install the declared version yourself.
An Effect-native application must use that same version.
For example, run `pnpm add effect@VERSION`, replacing `VERSION` with the exact value from the manifest

Run `pnpm list effect` or `npm ls effect` in your bot project to inspect the installed version.
Recheck the SDK manifest when upgrading the SDK

## For coding agents

Open `consumer/AGENTS.md` inside this installed package before implementing SDK usage.
It covers API selection, checked examples, lifecycle ownership and verification.
Agent tools do not necessarily discover instructions inside dependencies automatically

The installed `package.json` owns the supported runtime and public entry points.
The `types` paths selected by its `exports` contain the API reference and examples
