---
title: Learn Effect with a bot
navTitle: First Effect bot
description: Understand the small set of Effect concepts needed to send a message and run a bot
---

You do not need Effect to use Fluxerly. The [default JavaScript and TypeScript API](/docs/{{version}}/quick-start/) supports the same SDK capabilities with `async` functions and Results

Effect is worth learning when your bot has work that must stop together, resources that must close, and failures that need deliberate handling. Its native SDK entry point lets those operations share the same lifetime and services as the rest of an Effect application

Start here even if Effect is new to you. The examples introduce one idea at a time, then combine them into a bot

## Install the matching version

First install the SDK using [the start guide](/docs/{{version}}/quick-start/). Use Node.js 24.11 or newer, an ESM project with `"type": "module"`, and TypeScript 7 for typechecking. Native examples use TypeScript

Because this application imports Effect directly, declare it as a direct dependency too:

```command
{"kind":"add","package":"effect","version":"{{effect-version}}"}
```

Fluxerly currently requires an exact Effect 4 RC peer. Check `peerDependencies.effect` in your installed SDK when upgrading, because other RCs and Effect 3 are incompatible. Use the matching [Effect v4 learning material](https://effect.website/docs/v4/getting-started/why-effect)

## Start with one request

An Effect describes work. Creating that description does not send a request. `Effect.runPromise` executes it at your application's outer boundary

```ts
import { Effect } from "effect"
import { createClient } from "@neontechspace/fluxerly/effect"

export function sendHello(token: string, channelId: string) {
    const program = Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({ token })
            return yield* client.messages.send(channelId, { content: "Hello from Effect" })
        }),
    )
    return Effect.runPromise(program)
}
```

Call `sendHello` with your private bot token and a channel the bot can write to. It resolves to the sent message after the client has finished cleanup. Sending through REST does not need a gateway connection

Read the program in order:

1. `Effect.gen` lets you write sequential work using a generator function
2. The `yield*` expression runs an Effect and gives you its successful value. An expected failure skips the remaining steps unless you handle it
3. `Effect.scoped` supplies a cleanup lifetime. When that lifetime ends, Fluxerly closes the client and waits for its owned cleanup
4. `Effect.runPromise` crosses back into ordinary JavaScript at the boundary

Each `yield*` provides the successful value directly, while failures remain part of the Effect's type. Running the same description twice repeats its requests, including writes

## Add a message handler

Native handlers must return an Effect. This installer returns a scoped subscription for an existing native client

```ts
import { Effect } from "effect"
import type { Client } from "@neontechspace/fluxerly/effect"

export function installPing(client: Client) {
    return client.on("messageCreate", message => {
        if (message.author.isBot || message.content !== "!ping") return Effect.void
        return client.messages.reply(message, { content: "Pong!" })
    })
}
```

`Effect.void` describes doing nothing successfully. Returning the reply Effect lets the SDK run and cancel it with the handler. Calling `Effect.runPromise` inside each callback would split that work away from its intended owner

## Run the complete bot

Save this as `bot.ts`, set `FLUXER_BOT_TOKEN` in the process environment and run `node bot.ts`. The subscription is registered before `client.run()` starts the gateway

```ts
import { Cause, Effect, Exit } from "effect"
import { createClient } from "@neontechspace/fluxerly/effect"

const token = process.env.FLUXER_BOT_TOKEN
if (!token) throw new Error("FLUXER_BOT_TOKEN is required")

const program = Effect.scoped(
    Effect.gen(function* () {
        const client = yield* createClient({ token })
        const subscription = yield* client.on("messageCreate", message => {
            if (message.author.isBot || message.content !== "!ping") return Effect.void
            return client.messages.reply(message, { content: "Pong!" })
        })

        yield* Effect.all([client.run(), subscription.waitForClose()], { concurrency: 2 })
    }),
)

const controller = new AbortController()
const stop = () => controller.abort()
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
try {
    const exit = await Effect.runPromiseExit(program, { signal: controller.signal })
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        console.error("Bot stopped because an operation or cleanup failed")
        process.exitCode = 1
    }
} finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
}
```

Send `!ping` and expect `Pong!`. Press Ctrl+C to request interruption and wait for SDK-owned cleanup. Keep the environment and any process-manager configuration containing the token private

`Effect.all` observes both the client lifetime and the subscription. If either fails, it interrupts the sibling work. This prevents a stopped subscription from leaving an apparently connected but silent bot. Individual handler failures are isolated by the subscription and are not automatically retried

The outer boundary treats interruption alone as a normal stop. Any other failure, including a cleanup defect during interruption, sets a failing process exit code without printing a raw Cause, token or event data. Setting `process.exitCode` lets Node finish cleanup naturally

## What the types give you

`Effect.Effect<A, E, R>` describes the successful value `A`, expected failures `E`, and required services `R`. A client operation can ask for the same application services as your other Effects without the SDK starting a separate runtime

Effect represents expected errors, defects and interruption. A defect is an unexpected fault, and interruption means cancellation. Effect's Cause can retain these together, including cleanup failures. Do not turn every Cause into a retry

Continue with [scoped workflows](/docs/{{version}}/effect-workflows/) to combine collectors, failure handling and concurrent reads
