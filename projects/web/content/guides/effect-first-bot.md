---
title: Learn Effect with a bot
navTitle: First Effect bot
description: Understand the small set of Effect concepts needed to send a message and run a bot
---

Effect is optional. The [default JavaScript and TypeScript API](/docs/{{version}}/quick-start/) supports the same SDK capabilities with `async` functions and Results

Use the native Effect API when several bot operations must stop together, resources must close and failures need separate handling. Those operations can use the same services and cleanup scope as the rest of an Effect application

The examples introduce each Effect concept before combining them into a bot

## Install the matching version

First install the SDK using [the start guide](/docs/{{version}}/quick-start/). Use Node.js 24.11 or newer, an ESM project with `"type": "module"`, and TypeScript 7 for typechecking. Native examples use TypeScript

Because this application imports Effect directly, declare it as a direct dependency too:

```command
{"kind":"add","package":"effect","version":"{{effect-version}}"}
```

Fluxerly currently requires an exact Effect 4 RC peer. Check `peerDependencies.effect` in the installed SDK when upgrading, because other RCs and Effect 3 are incompatible. Use the matching [Effect v4 learning material](https://effect.website/docs/v4/getting-started/why-effect)

## Start with one request

An Effect describes work but does not run it yet. `Effect.runPromise` runs it from the application's top-level code

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

Call `sendHello` with a private bot token and a channel the bot can write to. It resolves to the sent message after the client has finished cleanup. Sending through REST does not need a gateway connection

Read the program in order:

1. `Effect.gen` writes sequential work using a generator function
2. The `yield*` expression runs an Effect and returns its successful value. An expected failure skips the remaining steps unless handled
3. `Effect.scoped` supplies a cleanup lifetime. When that lifetime ends, Fluxerly closes the client and waits for its owned cleanup
4. `Effect.runPromise` runs the program and returns a JavaScript Promise

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

`Effect.void` describes doing nothing successfully. Returning the reply Effect lets the SDK run and cancel it with the handler. Calling `Effect.runPromise` inside each callback would run that work separately from the handler

## Run the complete bot

Save this as `bot.ts`, set `FLUXER_BOT_TOKEN` in the process environment and run `node bot.ts`. The SDK provides the runner, with no companion file required

```ts
{{starter:bot-effect.ts}}
```

Send `!ping` and expect `Pong!`. Press Ctrl+C to request interruption and wait for SDK-owned cleanup. Keep the environment and any process-manager configuration containing the token private

The SDK runner installs the handler before gateway startup and observes both the connection and returned subscription. Failure or unexpected subscription closure stops the bot and awaits cleanup. Individual handler failures remain isolated and are not automatically retried

The bot's top-level code treats interruption alone as a normal stop. Any other failure, including a cleanup defect during interruption, sets a failing process exit code without printing a raw Cause, token or event data. Setting `process.exitCode` lets Node finish cleanup naturally

## Read the Effect types

`Effect.Effect<A, E, R>` describes the successful value `A`, expected failures `E`, and required services `R`. A client operation can use the same application services as other Effects without the SDK starting a separate runtime

Effect represents expected errors, defects and interruption. A defect is an unexpected fault, and interruption means cancellation. Effect's Cause can retain these together, including cleanup failures. Do not turn every Cause into a retry

Continue with [scoped workflows](/docs/{{version}}/effect-workflows/) to combine collectors, failure handling and concurrent reads
