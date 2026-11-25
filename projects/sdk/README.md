# Fluxerly.js

Fluxerly.js (FluxerlyJS) is a Fluxer-native bot SDK for JavaScript, TypeScript and Effect on Node.js 26.13 or newer (ESM only, TypeScript 7 for type checking)

[Home](https://fluxerly.neontechspace.com/) ·
[Playground](https://fluxerly.neontechspace.com/playground/) ·
[Docs](https://fluxerly.neontechspace.com/docs/) ·
[Quick start](https://fluxerly.neontechspace.com/docs/quick-start/) ·
[API reference](https://fluxerly.neontechspace.com/docs/api/) ·
[Changelog](https://fluxerly.neontechspace.com/docs/changelog/) ·
[Examples](https://fluxerly.neontechspace.com/docs/examples/) ·
[FAQ](https://fluxerly.neontechspace.com/docs/faq/) ·
[Agent skill](https://fluxerly.neontechspace.com/SKILL.md) ·
[llms.txt](https://fluxerly.neontechspace.com/llms.txt) ·
[NeonFlux, a bot built with it](https://github.com/NeonTechSpace/NeonFlux)

Fluxerly.js handles HTTP requests and gateway connections for messages, events, community resources and commands. Both APIs use the same underlying code

| API                       | Import                                   | Application style                                            |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| JavaScript and TypeScript | `@neontechspace/fluxerly`                | Async/await with a Result that reports success or failure    |
| Effect                    | `@neontechspace/fluxerly/effect`         | Effect programs with typed failures, scopes and interruption |
| Testing                   | `@neontechspace/fluxerly/testing`        | Application tests with an in-memory gateway and HTTP server  |
| Effect testing            | `@neontechspace/fluxerly/effect/testing` | The same test client for Effect programs                     |

The default API does not require learning or setting up Effect. Applications that use Effect directly must install a version within the Effect range described below

## What Fluxerly includes

Fluxerly is built for developers at every skill level, from a first bot in one file to large production bots that need full control

- **One-file start and scaffolding:** The `fluxerly init` CLI creates a runnable JavaScript, TypeScript or Effect starter with a working test, and `runBot` connects, drains on Ctrl+C and explains failed startups with a fix
- **Structured, actionable errors:** Network calls return a Result instead of throwing silently, every error carries a stable code, an actionable hint, typo suggestions on unknown options and `describeError` output with `errors.apiCode`, `errors.outcome` and `errors.retryAfterMs`, while logs mask tokens and recognized credentials automatically
- **Built-in commands, builders and collectors:** Prefix commands with typed arguments, guards, cooldowns, middleware, command groups and generated help, alongside `EmbedBuilder`, `MessageBuilder` and message or reaction collectors
- **Complete Fluxer coverage:** Messages, embeds, attachments, voice notes, reactions, threads and forum posts, communities, roles and permissions, emoji and stickers, webhooks and OAuth2, with paginated history and opt-in bounded caches
- **Typed raw escape hatches:** The `client.rest.call` method reaches every bot route with Fluxer's own field names checked at compile time, `client.rest.request` reaches routes newer than the SDK, and raw gateway events carry their documented payload types
- **Zero-network testing:** The `/testing` and `/effect/testing` entry points ship `createTestBot` with an in-memory Fluxer gateway, HTTP server and virtual test clock so timed work runs without waiting
- **Zero-backend browser SDK sandbox:** Try real `@neontechspace/fluxerly` TypeScript, JavaScript and Effect bots live in an isolated browser iframe on `createTestBot` with 429/403 fault injection and wire inspection at [fluxerly.neontechspace.com/playground](https://fluxerly.neontechspace.com/playground/)
- **Two APIs, one engine:** Start with async/await and Results, or choose the native Effect 4 API with typed error channels, scopes and layers, backed by the same implementation
- **Production resilience:** Automatic sharding, session resume across restarts, a process supervisor, deadline-aware rate limiting that never blindly replays uncertain writes, and metrics and traces through `observe`
- **Built-in CLI, diagnostics and agent workflow:** Shipped TypeScript `src/` and source maps, `fluxerly doctor` for offline setup and `node_modules` drift checks, `fluxerly triage` for agent-powered root-cause debugging against shipped source with `createTestBot` reproductions, `fluxerly agents` for `AGENTS.md`, `SKILL.md`, Cursor, Claude and Gemini rules, `fluxerly invite` for offline install URLs, plus [SKILL.md](https://fluxerly.neontechspace.com/SKILL.md) and [llms.txt](https://fluxerly.neontechspace.com/llms.txt)
- **Tracked against Fluxer's server:** Automated drift checks across Fluxer's API documents and server source trees, verified by offline contract tests, live end-to-end Fluxer checks and multi-model security reviews

The result is less infrastructure to build, with testing, diagnostics and production structure already in place

## Voice

Fluxerly waits for Fluxer's new voice system and does not support voice over LiveKit. Fluxer is replacing LiveKit with its own voice system, which should arrive soon, and bot voice will come with it. Until then, voice states, member voice controls such as move, mute, deafen and disconnect, voice notes, and audio or video attachments work

## Install

Fluxer moves fast, and Fluxerly keeps pace. Two channels fit different bots:

- **Stable:** Releases that passed every check, for bots that value calm
- **Nightly:** The newest changes as they land, for bots that want them first

Fluxerly is tested against Node.js 26.13 or newer. JavaScript needs no compiler. Use TypeScript 7 to check types or compile TypeScript code, with `@types/node` as a development dependency

Install the Stable channel with npm, pnpm or Bun:

```sh
npm install @neontechspace/fluxerly
pnpm add @neontechspace/fluxerly
bun add @neontechspace/fluxerly
```

Nightly releases can include breaking changes, so pin the exact version. A fresh install without a lockfile then cannot pick up a newer nightly that breaks the API:

```sh
npm install --save-exact @neontechspace/fluxerly@nightly
pnpm add --save-exact @neontechspace/fluxerly@nightly
bun add --exact @neontechspace/fluxerly@nightly
```

Keep the package manager's lockfile for reproducible installs and review the changelog before upgrading. The installed package also contains the changelog as `CHANGELOG.md`

## Start a bot

This bot replies **Pong!** to **!ping**. A bot needs a Fluxer application, its bot token and an invite to a community. [Create a bot](https://fluxerly.neontechspace.com/docs/create-a-bot/) walks through these steps and the permissions the bot needs

Generate a project with a test in the bot's folder with `npx @neontechspace/fluxerly init`, `pnpm dlx @neontechspace/fluxerly init` or `bunx @neontechspace/fluxerly init`, choose JavaScript, TypeScript or Effect, and follow the steps it prints. Pass `--template js`, `--template ts` or `--template effect` to skip the question, `--dir <folder>` to write into a new directory, `--pm npm|pnpm|bun` to select the package manager or `--no-install` to skip installing. An existing `.env` is kept, and missing `node_modules` and `.env` lines are added to an existing `.gitignore`. The [quick start](https://fluxerly.neontechspace.com/docs/quick-start/) also sets up the same project by hand

This is the generated `bot.js`:

```js
import { defineBot, runBot } from "@neontechspace/fluxerly"

// The bot's options without its token, so its test can run them through createTestBot without a token or a network
export const bot = defineBot({
    commands: {
        prefix: "!",
        commands: {
            // Returning the reply reports a failed send to the log
            ping: { execute: ({ reply }) => reply("Pong!") },
        },
    },
})

// Running this file starts the bot, while importing it from a test does not.
// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
if (import.meta.main) await runBot({ token: process.env.FLUXER_BOT_TOKEN, ...bot })
```

The same code works in JavaScript and TypeScript. The file exports the bot's options as `bot`, so the generated test can import them and run the bot without a token or a network. The `defineBot` function returns them unchanged and keeps the types of command arguments. Set `FLUXER_BOT_TOKEN` in `.env`, check the bot with `npm test` and start it with `npm start`, then send **!ping** in a channel where the bot can read and reply. While changing the bot, `npm run dev` restarts it after each saved change

By default, messages from bots, including the bot's own replies, skip the commands. Press Ctrl+C to stop the bot and wait for SDK cleanup. A permanent connection failure stops the bot, prints what went wrong with a suggested fix and reports failure to the operating system. The bot must still stop or finish work it starts outside the SDK, such as database writes

While it runs, the bot prints startup, readiness, lost connections, long rate-limit waits, shutdown and any handler error in full. Set `FLUXERLY_DEBUG=1` to add Debug records, or pass `logging` settings to change levels or send records to another logger. Records never contain the token. The SDK is ESM-only, so `require()` fails with an explanation instead of loading it

The same configuration object accepts `events` for event handlers and `setup` for other startup work. For direct control over connection and shutdown, use `createClient`. Both are available in JavaScript and TypeScript without using Effect

## Start an Effect bot

The Effect API also provides the one-object `runBot` configuration. Its handlers return Effects instead of Promises and Results. The runner uses the application's Effect runtime and services, and waits for cleanup before finishing. The file `examples/starter/bot-effect.ts` shows the complete bot

Before running the Effect example, add Effect 4 to the bot project's dependencies with `npm install effect@4`, `pnpm add effect@4` or `bun add effect@4`. The SDK accepts the Effect range listed under `peerDependencies.effect` in `node_modules/@neontechspace/fluxerly/package.json`. Later Effect 4 releases are accepted. Effect 3 and Effect 4 prereleases are not

Run `npm ls effect`, `pnpm list effect` or `bun why effect` in the bot project to inspect the installed version. Recheck the SDK manifest when upgrading the SDK

## For coding agents

Agent tools do not read instructions inside dependencies on their own. Run `npx --no fluxerly agents`, `pnpm exec fluxerly agents` or `bunx --no-install fluxerly agents` in the bot project, after installing the SDK there, to copy the SDK's rules into its `AGENTS.md`, which many coding agent tools read automatically. Pass `--target skill`, `--target cursor`, `--target claude`, `--target gemini` or `--target all` for tool-specific rule files, `--check` to verify freshness in CI, or `--print` to read the rules without writing files. Run `fluxerly doctor` (or `fluxerly doctor --json`) for offline static checks covering Node.js, ESM, `tsconfig.json`, TypeScript 7, `@types/node`, Effect, installed `node_modules` drift, source imports, `AGENTS.md`, `.gitignore` and `.env` token prefix mistakes. Run `fluxerly triage` (`[problem]`, `--agent antigravity|claude|codex|opencode|t3code|other`, `--model <id>`, `--dir <folder>`, `--log <file>`, `--run <command>`, `--print`) to diagnose bot or SDK issues with Antigravity, Claude Code, Codex, OpenCode, T3 Code or any other coding agent against shipped `src/` and `createTestBot`, or `fluxerly invite <applicationId>` (`--permissions <value>`) to generate a bot installation URL offline. The complete guide is `agents/AGENTS.md` inside the installed package

Agents that read web pages can start from the compact [SKILL.md](https://fluxerly.neontechspace.com/SKILL.md) or the docs' [llms.txt](https://fluxerly.neontechspace.com/llms.txt), which links the newest version's Markdown guides, split task maps and condensed API reference

The installed `package.json` lists the supported Node.js version and import paths. The files listed in the `types` entries inside `exports` contain the API reference and examples

## Issues and security

Report bugs and request features in [GitHub issues](https://github.com/NeonTechSpace/Fluxerly.js/issues). Report vulnerabilities privately as the [security policy](https://github.com/NeonTechSpace/Fluxerly.js/security/policy) describes, never in a public issue
