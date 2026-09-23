<h1 align="center">
  <a href="https://fluxerly.neontechspace.com">Fluxerly.js</a>
  <br>
  <br>
  <img src="/docs/assets/mascot.png" width="220" alt="Fluxerly mascot">
</h1>

<h3 align="center">Build bots for Fluxer</h3>

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
<a href="https://www.npmjs.com/package/@neontechspace/fluxerly"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/npm/v/@neontechspace/fluxerly/canary.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Canary&amp;labelColor=111827&amp;color=5c1028&amp;labelTextColor=ffffff&amp;valueColor=ffffff&amp;logo=npm&amp;mode=dark"><img src="https://shieldcn.dev/npm/v/@neontechspace/fluxerly/canary.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Canary&amp;labelColor=111827&amp;color=5c1028&amp;labelTextColor=ffffff&amp;valueColor=ffffff&amp;logo=npm&amp;mode=light" alt="npm Canary version"></picture></a>
  <a href="https://ossinsight.io/analyze/NeonTechSpace/Fluxerly.js#overview"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/OSS%20Insight-Analytics-0891b2.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=OSS%20Insight&amp;labelColor=111827&amp;color=0891b2&amp;logo=github&amp;mode=dark"><img src="https://shieldcn.dev/badge/OSS%20Insight-Analytics-0891b2.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=OSS%20Insight&amp;labelColor=111827&amp;color=0891b2&amp;logo=github&amp;mode=light" alt="OSS Insight: Repository analytics"></picture></a>
  <picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/Fluxer-Coming%20soon-0891b2.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Fluxer&amp;labelColor=111827&amp;color=0891b2&amp;logo=fluxer&amp;mode=dark"><img src="https://shieldcn.dev/badge/Fluxer-Coming%20soon-0891b2.svg?variant=branded&amp;split=true&amp;size=sm&amp;label=Fluxer&amp;labelColor=111827&amp;color=0891b2&amp;logo=fluxer&amp;mode=light" alt="Fluxer: Public community invite coming soon"></picture>
</p>

> [!NOTE]
> Fluxerly is a prerelease SDK. Start with the [temporary docs](https://preview.fluxerly.neontechspace.com/). Install the explicit `@canary` channel and review changes when upgrading
>
> Pull requests and issues open with the first stable release, alongside contribution guides and templates

## Install

Use Node.js 24.11 or newer. JavaScript needs no compiler. If you typecheck or compile TypeScript, use TypeScript 7

> [!NOTE]
> Older Node.js versions may work, but they are not tested or officially supported

**npm**

```sh
npm install @neontechspace/fluxerly@canary
```

**pnpm**

```sh
pnpm add @neontechspace/fluxerly@canary
```

Keep your package manager's lockfile for reproducible installs. The SDK does not require the `--save-exact` option. Modern npm and pnpm normally install the required Effect peer automatically, even when you only use the default API

## Choose your API

### JavaScript & TypeScript

Import `@neontechspace/fluxerly` and use `async` / `await`. Check Results for expected failures, and control shutdown with explicit methods and cancellation signals. The default API works with new bots and existing Promise-based applications. JavaScript users do not need TypeScript or Effect setup

### Effect-native

Import `@neontechspace/fluxerly/effect` and compose work with `Effect.gen` and `yield*`. Expected failures stay in the typed error channel. Scopes and interruption control cleanup. Choose this API for an Effect application, or to learn structured concurrency with a real bot

Both entry points provide typed events, prefix commands, embeds, attachments, reactions and collectors. Optional bounded caches keep local lookup separate from remote reads

### Why learn Effect?

Bots often grow from one handler into several jobs, listeners and requests that must stop together. Effect lets you describe that work as one program, share its dependencies and wait for scoped cleanup when it succeeds, fails or is interrupted

For example, a scoped conversation can register a collector, send a question and wait for an answer. If sending fails, the scope releases the collector. Concurrent reads can cancel their unfinished siblings on failure without leaving cleanup to scattered callbacks

Learn the core concepts in the [Effect v4 introduction](https://effect.website/docs/v4/getting-started/why-effect)

<details>
<summary>Installing Effect for a native application</summary>

If your code imports Effect directly, declare it as a direct dependency using the exact version in your installed SDK's `peerDependencies.effect`. Read `node_modules/@neontechspace/fluxerly/package.json`, or the [SDK manifest](/projects/sdk/package.json) for this checkout

Fluxerly currently uses the Effect 4 RC line. Do not install an arbitrary newer RC or stable Effect 3. The versioned documentation gives the matching install command

</details>

## Bot voice and media are not supported yet

Bot voice connections and audio/media transport are deferred until after Fluxer's voice update, with SDK implementation and verification still required. Fluxerly does not currently join voice channels or send and receive audio or video

Guild voice-state observations and member move, disconnect, server-mute and server-deafen controls are supported for existing participants

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
