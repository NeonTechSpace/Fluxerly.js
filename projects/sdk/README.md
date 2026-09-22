# Fluxerly.js

A Fluxer-native bot SDK spanning from JavaScript to TypeScript all the way to Effect

Fluxerly.js handles HTTP requests and gateway connections for messages, events, server resources and commands.
Both public entry points share the same SDK implementation

| API                       | Import                           | Application style                                            |
| ------------------------- | -------------------------------- | ------------------------------------------------------------ |
| JavaScript and TypeScript | `@neontechspace/fluxerly`        | Async/await with explicit success and failure Results        |
| Effect-native             | `@neontechspace/fluxerly/effect` | Effect programs with typed failures, scopes and interruption |

The default API needs no Effect-specific application setup.
Native applications import Effect directly and must use the matching version described below

## Requirements

This package is under development and has not reached its first stable release.
Use Node.js 24.11.0 or newer.
JavaScript needs no compiler. TypeScript 7 is required when typechecking or compiling TypeScript

Keep the package manager's lockfile for reproducible installs and review prerelease changes before upgrading

## Start a bot

The included starter replies **Pong!** to **!ping** and provides a second **!about** command

After installing the SDK:

1. Add `"type": "module"` to the bot project's `package.json`
2. Copy `lifetime.js` from `node_modules/@neontechspace/fluxerly/examples/starter/` into the bot folder
3. Save the following as `bot.js`, or `bot.ts` for TypeScript
4. Set `FLUXER_BOT_TOKEN` in the process environment. Keep the token and any configuration containing it private

The lifetime companion is editable application code, not a public SDK export.
It supervises the connection and returned critical command workers, then awaits SDK-owned cleanup

```js
import { commands } from "@neontechspace/fluxerly"
import { runBot } from "./lifetime.js"

const token = process.env.FLUXER_BOT_TOKEN
if (!token) throw new Error("FLUXER_BOT_TOKEN is required")

try {
    await runBot({ token }, (client) => {
        const router = commands.create({ prefix: "!" })
        if (router.isErr()) throw router.error

        const registered = router.value.registerMany({
            ping: {
                arguments: {},
                execute: async ({ reply }) => {
                    const sent = await reply({ content: "Pong!" })
                    if (sent.isErr()) console.warn("Reply failed", { kind: sent.error._tag })
                },
            },
            about: {
                arguments: {},
                execute: async ({ reply }) => {
                    const sent = await reply({ content: "A Fluxer bot built with Fluxerly" })
                    if (sent.isErr()) console.warn("Reply failed", { kind: sent.error._tag })
                },
            },
        })
        if (registered.isErr()) throw registered.error

        const attached = registered.value.attach(client)
        if (attached.isErr()) throw attached.error
        return [attached.value]
    })
} catch {
    console.error("Bot stopped because an operation or cleanup failed")
    process.exitCode = 1
}
```

The same code works in JavaScript and TypeScript.
Run `node bot.js` or `node bot.ts`, then send **!ping** in a channel where the bot can read and reply

Press Ctrl+C to stop the bot and await SDK cleanup.
An unexpected connection or critical-worker failure stops the starter with a failing exit status instead of leaving a partially working bot.
Application-owned work, such as database writes started by event handlers, still needs its own cancellation and cleanup

## Start an Effect-native bot

The same installed `examples/starter/` folder includes `bot-effect.ts` and `lifetime-effect.ts`.
Copy both into the bot folder, retain `"type": "module"`, set `FLUXER_BOT_TOKEN` and run `node bot-effect.ts`.
The native lifetime companion composes with application-provided Effect services and scoped cleanup, without creating a separate hidden runtime

Before running the native starter, declare Effect as a direct dependency using the exact `peerDependencies.effect` value in `node_modules/@neontechspace/fluxerly/package.json`.
For example, run `pnpm add effect@VERSION` or `npm install effect@VERSION`, replacing `VERSION` with that value

Modern npm and pnpm normally install the required Effect peer automatically, including for default-API applications.
If automatic peer installation is disabled, install the declared version explicitly.
Do not substitute Effect's latest release for the SDK's declared version

Run `pnpm list effect` or `npm ls effect` in the bot project to inspect the installed version.
Recheck the SDK manifest when upgrading the SDK

## For coding agents

Open `consumer/AGENTS.md` inside the installed package before implementing SDK usage.
It covers API selection, checked examples, lifecycle ownership and verification.
Agent tools do not necessarily discover instructions inside dependencies automatically

The installed `package.json` owns the supported runtime and public entry points.
The `types` paths selected by its `exports` contain the API reference and examples
