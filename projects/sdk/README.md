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

Save the following as `bot.js`, or `bot.ts` for TypeScript, and set `FLUXER_BOT_TOKEN` in the process environment

Keep that environment and any process-manager configuration containing the token private

```js
import { createClient } from "@neontechspace/fluxerly"

const token = process.env.FLUXER_BOT_TOKEN
if (!token) throw new Error("FLUXER_BOT_TOKEN is required")

const created = createClient({
    token,
})
if (created.isErr()) throw created.error
const client = created.value

const stop = new AbortController()
const requestStop = () => stop.abort()
process.once("SIGINT", requestStop)
process.once("SIGTERM", requestStop)

try {
    const registered = client.on("messageCreate", async (message, signal) => {
        if (message.author.isBot || message.content !== "!ping") return

        const replied = await client.messages.reply(message, { content: "Pong!" }, { signal })
        if (replied.isErr()) console.warn("Reply failed", { kind: replied.error._tag })
    })
    if (registered.isErr()) throw registered.error

    const connection = client.run({ signal: stop.signal })
    const worker = registered.value.waitForClose({ signal: stop.signal })
    let firstSource = "pending"
    let firstWorkerSucceeded = false
    await new Promise((resolve, reject) => {
        connection.then((result) => {
            if (firstSource !== "pending") return
            firstSource = "connection"
            resolve(undefined)
        }, reject)
        worker.then((result) => {
            if (firstSource !== "pending") return
            firstSource = "worker"
            firstWorkerSucceeded = result.isOk()
            resolve(undefined)
        }, reject)
    })
    const unexpectedWorkerStop =
        firstSource === "worker" &&
        firstWorkerSucceeded &&
        !stop.signal.aborted &&
        client.state !== "Closing" &&
        client.state !== "Closed"
    stop.abort()
    const [finished, closed] = await Promise.all([connection, worker])
    if (finished.isErr() && finished.error._tag !== "CancelledError") throw finished.error
    if (closed.isErr() && closed.error._tag !== "CancelledError") throw closed.error
    if (unexpectedWorkerStop) throw new Error("Critical messageCreate worker stopped")
} finally {
    stop.abort()
    process.off("SIGINT", requestStop)
    process.off("SIGTERM", requestStop)
    await client.shutdown()
}
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
