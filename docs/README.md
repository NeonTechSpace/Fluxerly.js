<h1 align="center"><a href="https://fluxerly.neontechspace.com">Fluxerly.js</a></h1>

<p align="center">
  <strong>A JavaScript and TypeScript SDK for Fluxer bots</strong>
</p>

Fluxerly.js is taking shape as a Fluxer-native JavaScript SDK, with APIs, types, and guides designed together so beginners have a clear way in and experienced developers can get straight to building

<p align="center">
  <a href="https://github.com/NeonTechSpace/Fluxerly.js/issues"><img src="https://img.shields.io/github/issues/NeonTechSpace/Fluxerly.js?style=for-the-badge&amp;label=Issues&amp;color=471838&amp;logo=github&amp;logoColor=white&amp;labelColor=0B1221" alt="Open GitHub issues"></a>&nbsp;&nbsp;
  <a href="https://github.com/NeonTechSpace/Fluxerly.js/pulls"><img src="https://img.shields.io/github/issues-pr/NeonTechSpace/Fluxerly.js?style=for-the-badge&amp;label=PRs&amp;color=1E40AF&amp;logo=github&amp;logoColor=white&amp;labelColor=0B1221" alt="Open GitHub pull requests"></a>&nbsp;&nbsp;
  <a href="https://github.com/NeonTechSpace/Fluxerly.js/forks"><img src="https://img.shields.io/github/forks/NeonTechSpace/Fluxerly.js?style=for-the-badge&amp;label=Forks&amp;color=3D66B8&amp;logo=github&amp;logoColor=white&amp;labelColor=0B1221" alt="GitHub forks"></a>&nbsp;&nbsp;
  <a href="https://github.com/NeonTechSpace/Fluxerly.js"><img src="https://img.shields.io/github/stars/NeonTechSpace/Fluxerly.js?style=for-the-badge&amp;label=Stars&amp;color=CA8A04&amp;logo=github&amp;logoColor=white&amp;labelColor=0B1221" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@neontechspace/fluxerly"><img src="https://img.shields.io/npm/v/@neontechspace/fluxerly?style=for-the-badge&amp;color=1E40AF&amp;logo=npm&amp;logoColor=white&amp;labelColor=0B1221" alt="Latest npm version"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Fluxer-Coming%20soon-0E7490?style=for-the-badge&amp;logo=fluxer&amp;logoColor=white&amp;labelColor=0B1221" alt="Fluxer: Public community invite coming soon">&nbsp;&nbsp;
  <a href="https://ossinsight.io/analyze/NeonTechSpace/Fluxerly.js#overview"><img src="https://img.shields.io/badge/OSS%20Insight-Analytics-0E7490?style=for-the-badge&amp;logo=github&amp;logoColor=white&amp;labelColor=0B1221" alt="OSS Insight: Repository analytics"></a>
</p>

## Using the SDK

> [!NOTE]
> Fluxerly.js is in its prerelease phase. Read the [canary documentation](https://preview.fluxerly.neontechspace.com/docs/1000.0.0-canary.0/)

Use Node.js 24.11.0 or newer with JavaScript or TypeScript 7.
TypeScript 6 and earlier are not supported.
JavaScript consumers do not need a TypeScript installation

The default JavaScript and TypeScript API returns results you check for success or failure.
The separate `@neontechspace/fluxerly/effect` entry point is for applications already using Effect.
Both APIs share the same SDK implementation

### Your first bot

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

### Choosing the matching Effect version

Use the Effect version selected by your SDK version, not whichever Effect version is newest.
For this checkout, read `peerDependencies.effect` in the [SDK manifest](/projects/sdk/package.json).
For an installed package, open `node_modules/@neontechspace/fluxerly/package.json` in your bot project.
Read `peerDependencies.effect`

Modern npm and pnpm normally install the required peer automatically.
If your application imports Effect directly, or automatic peer installation is disabled, install that exact version yourself

## Why Fluxerly.js?

Before Fluxerly.js, there was [NeonFlux](https://github.com/NeonTechSpace/NeonFlux): A Fluxer bot in development, built with [FluxerJS/core](https://github.com/fluxerjs/core).
Building it, contributing fixes, and working through everyday SDK friction turned years of self-taught experience into a clearer idea of what a bot library should feel like to use

Fluxerly.js is the next step: An independent SDK with the freedom to turn those lessons into design decisions and carry them through the API, documentation, and long-term maintenance

## Documentation

- [Technology choices](/docs/TECHNOLOGY.md): SDK and website technologies, tooling and support policy
- [Versioning and release stages](/docs/TECHNOLOGY.md#versioning-and-release-stages): Epoch numbering and Canary, RC and Stable releases
- [SDK contracts](/docs/SDK-CONTRACTS.md): Cross-cutting implementation constraints for contributors
- [Repository guide](/docs/REPOSITORY.md): Project layout and file locations
- [Releasing](/docs/RELEASING.md): Registry verification, manual release workflow and registry setup
- [Documentation maintenance](/docs/DOCUMENTATION.md): Local documentation, exact-version archives and Preview delivery

## Community

The NeonSpace Fluxer server already exists.
Joining is on hold until the bot is ready

## Activity

[View repository activity over the last 28 days](https://next.ossinsight.io/widgets/official/compose-last-28-days-stats?repo_id=1370449818)

<p align="center">
  <a href="https://next.ossinsight.io/widgets/official/analyze-repo-stars-history?repo_id=1370449818">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://next.ossinsight.io/widgets/official/analyze-repo-stars-history/thumbnail.png?repo_id=1370449818&amp;image_size=auto&amp;color_scheme=dark">
      <img src="https://next.ossinsight.io/widgets/official/analyze-repo-stars-history/thumbnail.png?repo_id=1370449818&amp;image_size=auto&amp;color_scheme=light" alt="Fluxerly.js star history, provided by OSS Insight">
    </picture>
  </a>
</p>

## License

Licensed under [Apache-2.0](/LICENSE)
