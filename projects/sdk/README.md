# Fluxerly.js

A Fluxer bot SDK for JavaScript, TypeScript and Effect

[Docs](https://preview.fluxerly.neontechspace.com/) ·
[Quick start](https://preview.fluxerly.neontechspace.com/docs/latest/quick-start/) ·
[API reference](https://preview.fluxerly.neontechspace.com/docs/latest/api/) ·
[Changelog](https://preview.fluxerly.neontechspace.com/docs/latest/changelog/) ·
[Examples](https://preview.fluxerly.neontechspace.com/docs/latest/examples/)

Fluxerly.js handles HTTP requests and gateway connections for messages, events, community resources and commands.
Both APIs use the same underlying code

| API                       | Import                                   | Application style                                            |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| JavaScript and TypeScript | `@neontechspace/fluxerly`                | Async/await with a Result that reports success or failure    |
| Effect                    | `@neontechspace/fluxerly/effect`         | Effect programs with typed failures, scopes and interruption |
| Testing                   | `@neontechspace/fluxerly/testing`        | Application tests with an in-memory gateway and HTTP server  |
| Effect testing            | `@neontechspace/fluxerly/effect/testing` | The same test client for Effect programs                     |

The default API does not require learning or setting up Effect.
Applications that use Effect directly must install the matching version described below

## Requirements

This package is under development and has not reached its first stable release.
Fluxerly is tested against Node.js 24.11 or newer.
JavaScript needs no compiler. Use TypeScript 7 to check types or compile TypeScript code, with `@types/node` as a development dependency

Keep the package manager's lockfile for reproducible installs and review prerelease changes before upgrading.
The installed package also contains the changelog as `CHANGELOG.md`

## Start a bot

This bot replies **Pong!** to **!ping**

A bot needs a Fluxer application, its bot token and an invite to a community. [Create a bot](https://preview.fluxerly.neontechspace.com/docs/latest/create-a-bot/) walks through these steps and the permissions the bot needs. Then:

1. Add `"type": "module"` to the bot project's `package.json`
2. Install the SDK with `npm install @neontechspace/fluxerly` or `pnpm add @neontechspace/fluxerly`
3. Save the token in a file named `.env` as `FLUXER_BOT_TOKEN=paste-the-token-here`, and add `.env` to `.gitignore`. Anyone holding the token can act as the bot
4. Save the following as `bot.js`, or `bot.ts` for TypeScript

The `runBot` function installs the event handler, connects the client and waits for SDK cleanup before finishing. No extra helper files are needed

```js
import { runBot } from "@neontechspace/fluxerly"

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.author.isBot || message.content !== "!ping") return
            // Returning the reply reports a failed send to the log
            return reply("Pong!")
        },
    },
})
```

The same code works in JavaScript and TypeScript.
Run `node --env-file=.env bot.js`, or `node --env-file=.env bot.ts`, then send **!ping** in a channel where the bot can read and reply

To typecheck TypeScript, add `@types/node` and TypeScript 7 as development dependencies and save this `tsconfig.json` next to the bot. Node.js still runs `bot.ts` directly, and TypeScript only checks it:

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

Press Ctrl+C to stop the bot and wait for SDK cleanup.
A permanent connection failure stops the bot, prints what went wrong with a suggested fix and reports failure to the operating system.
The bot must still stop or finish work it starts outside the SDK, such as database writes

While it runs, the bot prints startup, readiness, lost connections, long rate-limit waits, shutdown and any handler error in full.
Set `FLUXERLY_DEBUG=1` to add Debug records, or pass `logging` settings to change levels or send records to another logger.
Records never contain the token. The SDK is ESM-only, so `require()` fails with an explanation instead of loading it

The same configuration object accepts `commands` for prefix commands and `setup` for other startup work.
For direct control over connection and shutdown, use `createClient`. Both are available in JavaScript and TypeScript without using Effect

## Start an Effect bot

The Effect API also provides the one-object `runBot` configuration. Its handlers return Effects instead of Promises and Results. The runner uses the application's Effect runtime and services, and waits for cleanup before finishing. The file `examples/starter/bot-effect.ts` shows the complete bot

Before running the Effect example, add Effect to the bot project's dependencies. Use the exact version listed under `peerDependencies.effect` in `node_modules/@neontechspace/fluxerly/package.json`.
For example, run `pnpm add effect@VERSION` or `npm install effect@VERSION`, replacing `VERSION` with that value

Do not substitute Effect's latest release for the SDK's declared version

Run `pnpm list effect` or `npm ls effect` in the bot project to inspect the installed version.
Recheck the SDK manifest when upgrading the SDK

## For coding agents

Open `consumer/AGENTS.md` inside the installed package before implementing SDK usage.
It explains which API to use, how to start and stop the client, and how to check the result.
Agent tools do not necessarily discover instructions inside dependencies automatically

The installed `package.json` lists the supported Node.js version and import paths.
The files listed in the `types` entries inside `exports` contain the API reference and examples
