<h1 align="center">
  <a href="https://fluxerly.neontechspace.com">Fluxerly.js</a>
  <br>
  <br>
  <img src="/docs/assets/mascot.png" width="220" alt="Fluxerly mascot">
</h1>

<h3 align="center">From your first reply to the bot of your dreams</h3>

<p align="center">
  A Fluxer-native bot SDK for JavaScript, TypeScript and Effect
</p>

<p align="center">
  <a href="https://github.com/NeonTechSpace/Fluxerly.js/issues"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/issues/NeonTechSpace/Fluxerly.js.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Issues&amp;labelColor=111827&amp;color=9333ea&amp;logo=github&amp;mode=dark"><img src="https://shieldcn.dev/github/issues/NeonTechSpace/Fluxerly.js.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Issues&amp;labelColor=111827&amp;color=9333ea&amp;logo=github&amp;mode=light" alt="Open GitHub issues"></picture></a>
  <a href="https://github.com/NeonTechSpace/Fluxerly.js/pulls"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/prs/NeonTechSpace/Fluxerly.js.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=PRs&amp;labelColor=111827&amp;color=6366f1&amp;logo=github&amp;mode=dark"><img src="https://shieldcn.dev/github/prs/NeonTechSpace/Fluxerly.js.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=PRs&amp;labelColor=111827&amp;color=6366f1&amp;logo=github&amp;mode=light" alt="Open GitHub pull requests"></picture></a>
  <a href="https://github.com/NeonTechSpace/Fluxerly.js/forks"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/forks/NeonTechSpace/Fluxerly.js.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Forks&amp;labelColor=111827&amp;color=2563eb&amp;logo=github&amp;mode=dark"><img src="https://shieldcn.dev/github/forks/NeonTechSpace/Fluxerly.js.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Forks&amp;labelColor=111827&amp;color=2563eb&amp;logo=github&amp;mode=light" alt="GitHub forks"></picture></a>
<a href="https://github.com/NeonTechSpace/Fluxerly.js/stargazers"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/stars/NeonTechSpace/Fluxerly.js.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Stars&amp;labelColor=111827&amp;color=9a6700&amp;labelTextColor=ffffff&amp;valueColor=ffffff&amp;logo=github&amp;mode=dark"><img src="https://shieldcn.dev/github/stars/NeonTechSpace/Fluxerly.js.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Stars&amp;labelColor=111827&amp;color=9a6700&amp;labelTextColor=ffffff&amp;valueColor=ffffff&amp;logo=github&amp;mode=light" alt="GitHub stars"></picture></a>
</p>

<p align="center">
<a href="https://www.npmjs.com/package/@neontechspace/fluxerly"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/npm/v/@neontechspace/fluxerly/latest.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=npm&amp;labelColor=111827&amp;color=5c1028&amp;labelTextColor=ffffff&amp;valueColor=ffffff&amp;logo=npm&amp;mode=dark"><img src="https://shieldcn.dev/npm/v/@neontechspace/fluxerly/latest.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=npm&amp;labelColor=111827&amp;color=5c1028&amp;labelTextColor=ffffff&amp;valueColor=ffffff&amp;logo=npm&amp;mode=light" alt="npm version"></picture></a>
  <a href="https://ossinsight.io/analyze/NeonTechSpace/Fluxerly.js#overview"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/OSS%20Insight-Analytics-0891b2.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=OSS%20Insight&amp;labelColor=111827&amp;color=0891b2&amp;logo=github&amp;mode=dark"><img src="https://shieldcn.dev/badge/OSS%20Insight-Analytics-0891b2.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=OSS%20Insight&amp;labelColor=111827&amp;color=0891b2&amp;logo=github&amp;mode=light" alt="OSS Insight: Repository analytics"></picture></a>
  <picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/Fluxer-Coming%20soon-0891b2.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Fluxer&amp;labelColor=111827&amp;color=0891b2&amp;logo=fluxer&amp;mode=dark"><img src="https://shieldcn.dev/badge/Fluxer-Coming%20soon-0891b2.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Fluxer&amp;labelColor=111827&amp;color=0891b2&amp;logo=fluxer&amp;mode=light" alt="Fluxer: Public community invite coming soon"></picture>
</p>

> [!NOTE]
> Fluxerly is a prerelease SDK. Start with the [temporary docs](https://preview.fluxerly.neontechspace.com/) and review the changelog before upgrading
>
> Issues and pull requests are maintainer-only until the first Stable release. The [contribution guide](/docs/CONTRIBUTING.md) and submission templates are prepared for that release, without opening public access now

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

## Install

Fluxerly is tested against Node.js 24.15 or newer. JavaScript needs no compiler, and TypeScript typechecking or compilation requires TypeScript 7 and `@types/node` as a development dependency

**npm**

```sh
npm install @neontechspace/fluxerly
```

**pnpm**

```sh
pnpm add @neontechspace/fluxerly
```

**Bun**

```sh
bun add @neontechspace/fluxerly
```

> A committed lockfile records the exact installed version and keeps installs reproducible. Canary and RC releases can include breaking changes. Install them with `--save-exact`, or `--exact` with Bun, so a fresh install without a lockfile cannot pick up a newer Canary or RC that breaks the API

## Getting started

A bot needs a Fluxer application, its bot token and an invite to a community

To start from a generated project with a test, run `npx @neontechspace/fluxerly init`, `pnpm dlx @neontechspace/fluxerly init` or `bunx @neontechspace/fluxerly init` in the bot's folder, choose JavaScript, TypeScript or Effect, and follow the steps it prints. Adding `--template js`, `--template ts` or `--template effect` skips the question. An existing `.env` is kept, and missing `node_modules` and `.env` lines are added to an existing `.gitignore`. To set up the bot by hand instead:

1. Create a folder for the bot containing a `package.json` file with `{ "type": "module" }`, then install the SDK in that folder as shown above
2. Save the token in a file named `.env` as `FLUXER_BOT_TOKEN=paste-the-token-here`, and add `.env` to `.gitignore`
3. Save this bot as `bot.js`. It replies **Pong!** to **!ping**

```js
import { runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return
            return reply("Pong!")
        },
    },
})
```

4. Run `node --env-file=.env bot.js` and send **!ping** in a channel the bot can read

## Choosing an API

### JavaScript & TypeScript

Import `@neontechspace/fluxerly` and use `async` / `await`. Check Results for expected failures, and control shutdown with explicit methods and cancellation signals. The default API works with new bots and existing Promise-based applications. JavaScript users do not need TypeScript or Effect setup

### Effect

Import `@neontechspace/fluxerly/effect` and compose work with `Effect.gen` and `yield*`. Expected failures stay in the typed error channel. Scopes and interruption control cleanup. Choose this API for an Effect application, or to learn structured concurrency with a real bot

Both entry points provide typed events, prefix commands, embeds, attachments, reactions and collectors. Optional bounded caches keep local lookup separate from remote reads

### Why learn Effect?

Bots often grow from one handler into several jobs, listeners and requests that must stop together. Effect describes that work as one program, shares its dependencies and waits for scoped cleanup when it succeeds, fails or is interrupted

For example, a scoped conversation can register a collector, send a question and wait for an answer. If sending fails, the scope releases the collector. Concurrent reads can cancel their unfinished siblings on failure without leaving cleanup to scattered callbacks

Learn the core concepts in the [Effect v4 introduction](https://effect.website/docs/v4/getting-started/why-effect)

<details>
<summary>Installing Effect for a native application</summary>

Applications that import Effect directly must declare it as a direct dependency, using a version within the installed SDK's `peerDependencies.effect` range. Read `node_modules/@neontechspace/fluxerly/package.json`, or the [SDK manifest](/projects/sdk/package.json) for this checkout

The lowest version in that range is the one Fluxerly is tested against. Later Effect 4 releases are accepted. Do not install Effect 3 or an Effect 4 prerelease. The versioned documentation gives the matching install command

</details>

## Bot voice and media are not supported yet

Bot voice connections and audio/media transport are deferred until after Fluxer's voice update, with SDK implementation and verification still required. Fluxerly does not currently join voice channels or send and receive audio or video

Voice-state observations in communities and member move, disconnect, community mute and community deafen controls are supported for existing participants

## Repository activity

![Repobeats analytics](https://repobeats.axiom.co/api/embed/bee17a118a5b819df2216921a10032f2a01dcab9.svg "Repobeats analytics image")

<p align="center">
  <a href="https://github.com/NeonTechSpace/Fluxerly.js/stargazers">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/chart/github/stars/NeonTechSpace/Fluxerly.js.svg?theme=violet&amp;mode=dark&amp;width=800&amp;height=240&amp;title=Star%20history&amp;bg=0d1117&amp;yTicks=3&amp;xTicks=3&amp;logo=false">
      <img src="https://shieldcn.dev/chart/github/stars/NeonTechSpace/Fluxerly.js.svg?theme=violet&amp;mode=light&amp;width=800&amp;height=240&amp;title=Star%20history&amp;bg=ffffff&amp;yTicks=3&amp;xTicks=3&amp;logo=false" alt="Fluxerly.js star history" width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@neontechspace/fluxerly">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/chart/npm/@neontechspace/fluxerly.svg?theme=cyan&amp;mode=dark&amp;days=365&amp;width=800&amp;height=240&amp;title=Fluxerly.js%20downloads&amp;bg=0d1117&amp;yTicks=3&amp;xTicks=3&amp;logo=false">
      <img src="https://shieldcn.dev/chart/npm/@neontechspace/fluxerly.svg?theme=cyan&amp;mode=light&amp;days=365&amp;width=800&amp;height=240&amp;title=Fluxerly.js%20downloads&amp;bg=ffffff&amp;yTicks=3&amp;xTicks=3&amp;logo=false" alt="Fluxerly.js downloads over the last 365 days, grouped by week" width="800">
    </picture>
  </a>
</p>

Licensed under [Apache-2.0](/LICENSE)
