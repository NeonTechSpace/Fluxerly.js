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
Applications that use Effect directly must install a version within the Effect range described below

## What Fluxerly includes

Fluxerly is built for developers at every skill level, from a first bot in one file to large bots that need full control

- **One-file start:** `runBot` connects, stops cleanly on Ctrl+C and explains a failed startup with a suggested fix
- **Visible errors:** Network calls return a Result instead of throwing, and logs show every failure in full without the token. `FLUXERLY_DEBUG=1` or the `logging` option changes what the logs show
- **Built-in commands:** Prefix commands with typed arguments, guards, cooldowns, command groups and generated help
- **Tests without a token:** The `/testing` and `/effect/testing` entry points run a bot against an in-memory gateway and HTTP server
- **Two APIs, one implementation:** Start with async/await, or choose the native Effect API, with the same features and behavior in both
- **Ready to grow:** Automatic sharding, session resume across restarts, a process supervisor, rate limiting that never blindly repeats an uncertain write, and metrics and traces through the `observe` option
- **Agent-ready:** `fluxerly agents` adds the SDK's rules to a project's `AGENTS.md`, and the docs publish `llms.txt`

The result is less infrastructure to build, with testing and application structure already in place

## Requirements

This package is under development and has not reached its first stable release.
Fluxerly is tested against Node.js 24.15 or newer.
JavaScript needs no compiler. Use TypeScript 7 to check types or compile TypeScript code, with `@types/node` as a development dependency

Keep the package manager's lockfile for reproducible installs and review the changelog before upgrading.
Canary and RC releases can include breaking changes. Install them with `--save-exact`, or `--exact` with Bun, so a fresh install without a lockfile cannot pick up a newer Canary or RC that breaks the API.
The installed package also contains the changelog as `CHANGELOG.md`

## Start a bot

This bot replies **Pong!** to **!ping**

A bot needs a Fluxer application, its bot token and an invite to a community. [Create a bot](https://preview.fluxerly.neontechspace.com/docs/latest/create-a-bot/) walks through these steps and the permissions the bot needs. Then:

1. Add `"type": "module"` to the bot project's `package.json`
2. Install the SDK with `npm install @neontechspace/fluxerly`, `pnpm add @neontechspace/fluxerly` or `bun add @neontechspace/fluxerly`
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

Before running the Effect example, add Effect 4 to the bot project's dependencies with `npm install effect@4`, `pnpm add effect@4` or `bun add effect@4`.
The SDK accepts the Effect range listed under `peerDependencies.effect` in `node_modules/@neontechspace/fluxerly/package.json`. The lowest version in that range is the one the SDK is tested against, and later Effect 4 releases are accepted. Effect 3 and Effect 4 prereleases are not

Run `npm ls effect`, `pnpm list effect` or `bun why effect` in the bot project to inspect the installed version.
Recheck the SDK manifest when upgrading the SDK

## For coding agents

Agent tools do not read instructions inside dependencies on their own. Run `npx fluxerly agents`, `pnpm exec fluxerly agents` or `bunx fluxerly agents` in the bot project to copy the SDK's rules into its `AGENTS.md`, which many coding agent tools read automatically. Run it again after an SDK update to refresh them.
The complete guide is `agents/AGENTS.md` inside the installed package. It explains which API to use, how to start and stop the client, and how to check the result

Agents that read web pages can start from the docs' [llms.txt](https://preview.fluxerly.neontechspace.com/llms.txt), which links each documentation version's Markdown guides and condensed API reference

The installed `package.json` lists the supported Node.js version and import paths.
The files listed in the `types` entries inside `exports` contain the API reference and examples
