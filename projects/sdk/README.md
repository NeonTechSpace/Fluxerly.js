# Fluxerly.js

A Fluxer bot SDK for JavaScript, TypeScript and Effect

Fluxerly.js handles HTTP requests and gateway connections for messages, events, server resources and commands.
Both APIs use the same underlying code

| API                       | Import                           | Application style                                            |
| ------------------------- | -------------------------------- | ------------------------------------------------------------ |
| JavaScript and TypeScript | `@neontechspace/fluxerly`        | Async/await with a Result that reports success or failure    |
| Effect-native             | `@neontechspace/fluxerly/effect` | Effect programs with typed failures, scopes and interruption |

The default API does not require learning or setting up Effect.
Applications that use Effect directly must install the matching version described below

## Requirements

This package is under development and has not reached its first stable release.
Use Node.js 24.11.0 or newer.
JavaScript needs no compiler. Use TypeScript 7 to check types or compile TypeScript code

Keep the package manager's lockfile for reproducible installs and review prerelease changes before upgrading

## Start a bot

This bot replies **Pong!** to **!ping**

After installing the SDK:

1. Add `"type": "module"` to the bot project's `package.json`
2. Save the following as `bot.js`, or `bot.ts` for TypeScript
3. Set the `FLUXER_BOT_TOKEN` environment variable. Keep the token and any files containing it private

The `runBot` function starts the client and watches the connection and returned subscriptions. It closes the client before finishing. No extra helper files are needed

```js
import { runBot } from "@neontechspace/fluxerly"

const token = process.env.FLUXER_BOT_TOKEN
if (!token) throw new Error("FLUXER_BOT_TOKEN is required")

try {
    const result = await runBot(
        { token },
        (client) => {
            const subscription = client.on("messageCreate", async (message, signal) => {
                if (message.author.isBot || message.content !== "!ping") return
                const sent = await client.messages.reply(message, { content: "Pong!" }, { signal })
                if (sent.isErr()) console.warn("Reply failed", { kind: sent.error._tag })
            })
            if (subscription.isErr()) throw subscription.error
            return [subscription.value]
        },
        { processSignals: true },
    )
    if (result.isErr()) throw result.error
} catch {
    console.error("Bot stopped because an operation or cleanup failed")
    process.exitCode = 1
}
```

The same code works in JavaScript and TypeScript.
Run `node bot.js` or `node bot.ts`, then send **!ping** in a channel where the bot can read and reply

Press Ctrl+C to stop the bot and wait for SDK cleanup.
An unexpected failure in the connection or a required subscription stops the bot and reports failure to the operating system.
The bot must still stop or finish work it starts outside the SDK, such as database writes

## Start an Effect-native bot

The Effect API also provides `runBot`. Its setup function returns an Effect containing the subscriptions that must stay running. The runner uses the application's Effect runtime and services, and waits for cleanup before finishing. The file `examples/starter/bot-effect.ts` shows the complete bot

Before running the Effect example, add Effect to the bot project's dependencies. Use the exact version listed under `peerDependencies.effect` in `node_modules/@neontechspace/fluxerly/package.json`.
For example, run `pnpm add effect@VERSION` or `npm install effect@VERSION`, replacing `VERSION` with that value

Modern npm and pnpm normally install the SDK's Effect dependency automatically, even when the bot uses only the default API.
If automatic peer installation is disabled, install that exact version separately.
Do not substitute Effect's latest release for the SDK's declared version

Run `pnpm list effect` or `npm ls effect` in the bot project to inspect the installed version.
Recheck the SDK manifest when upgrading the SDK

## For coding agents

Open `consumer/AGENTS.md` inside the installed package before implementing SDK usage.
It explains which API to use, how to start and stop the client, and how to check the result.
Agent tools do not necessarily discover instructions inside dependencies automatically

The installed `package.json` lists the supported Node.js version and import paths.
The files listed in the `types` entries inside `exports` contain the API reference and examples
