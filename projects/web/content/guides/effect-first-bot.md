---
title: Learn Effect with a bot
navTitle: First Effect bot
description: Understand the small set of Effect concepts needed to send a message and run a bot
---

Effect is optional. The [default JavaScript and TypeScript API](/docs/{{version}}/quick-start/) supports the same SDK capabilities with `async` functions and Results

Use the native Effect API when several bot operations must stop together, resources must close and failures need separate handling. Those operations can use the same services and cleanup scope as the rest of an Effect application

The examples introduce each Effect concept before combining them into a bot

## Install the matching version

First install the SDK with [the quick start](/docs/{{version}}/quick-start/). Fluxerly is tested against Node.js 24.15 or newer. Use such a version, an ESM project with `"type": "module"`, and TypeScript 7 for typechecking with the Node.js types from the [TypeScript setup](/docs/{{version}}/create-a-bot/#typescript-setup). Native examples use TypeScript

Fluxerly is tested against Effect {{effect-version}} and accepts later Effect 4 releases. The installed SDK lists its accepted range under `peerDependencies.effect` in `node_modules/@neontechspace/fluxerly/package.json`. Effect 3 and Effect 4 prereleases are incompatible

These examples import Effect directly, so declare it as a direct dependency. For this documentation version, the command is:

```command
{"kind":"add","package":"effect","version":"{{effect-version}}"}
```

Check which Effect version the application has installed:

```command
{"kind":"list","package":"effect"}
```

Recheck the required version when upgrading the SDK. The [Effect v4 learning material](https://effect.website/docs/v4/getting-started/why-effect) matches this major version

## Start with one request

An Effect describes work but does not run it yet. `Effect.runPromise` runs it from the application's top-level code

```ts
import { Effect } from "effect"
import { createClient } from "@neontechspace/fluxerly/effect"

export function sendHello(token: string, channelId: string) {
    const program = Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({ token })
            return yield* client.messages.send(channelId, "Hello from Effect")
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

Native handlers must return an Effect. For an existing native client, `client.on` provides a subscription

```ts
import { Effect } from "effect"
import type { Client } from "@neontechspace/fluxerly/effect"

export function installPing(client: Client) {
    return client.on("messageCreate", message => {
        if (message.author.isBot || message.content !== "!ping") return Effect.void
        return client.messages.reply(message, "Pong!")
    })
}
```

`Effect.void` describes doing nothing successfully. Returning the reply Effect lets the SDK run and cancel it with the handler. Calling `Effect.runPromise` inside each callback would run that work separately from the handler

## Run the complete bot

Save this as `bot.ts` and start it with `node --env-file=.env bot.ts`, using the `.env` file from [Create a bot](/docs/{{version}}/create-a-bot/). The runner registers the handlers in the `events` object before it connects

```ts
{{starter:bot-effect.ts}}
```

Send `!ping` and expect `Pong!`. Press Ctrl+C to stop the bot. The SDK interrupts it and waits for its cleanup

The last line runs the program with `Effect.runPromiseExit`, which resolves with the program's outcome, called an Exit, instead of rejecting. The `runBot` program reports its own failure: A failure that stops the bot, such as a rejected token, is logged once and sets `process.exitCode` to 1, so the Exit needs no further handling. Setting the exit code instead of calling `process.exit()` lets Node.js finish cleanup before the process ends

<details>
<summary>What the runner watches while the bot runs</summary>

The runner registers the handler before the gateway connects and then watches both the connection and the handler's subscription. A connection failure, or a subscription that closes unexpectedly, stops the bot and waits for cleanup.
A failed handler is reported and not retried, and the bot keeps running. Returning the `reply` Effect lets the SDK interrupt it when the handler stops.
Keep the token private, including in the environment and in process-manager settings

</details>

The [small bot](/docs/{{version}}/small-bot/) guide shows a larger native bot with commands, a permission guard, a cooldown and a welcome message

## Report failures outside runBot

Application code outside `runBot`, such as a one-off job, reports its own failure. A failed Exit holds a Cause, Effect's full record of why the program failed. Pass `exit.cause` to `describeError`, which prints each error's code, hint and details with credentials masked

```ts
import { Effect, Exit } from "effect"
import { createClient, describeError } from "@neontechspace/fluxerly/effect"

export async function announce(token: string, channelId: string) {
    const exit = await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createClient({ token })
                yield* client.messages.send(channelId, "Maintenance starts in ten minutes")
            }),
        ),
    )
    if (Exit.isFailure(exit)) {
        console.error(describeError(exit.cause))
        process.exitCode = 1
    }
}
```

## Read the Effect types

`Effect.Effect<A, E, R>` describes the successful value `A`, expected failures `E`, and required services `R`. A client operation can use the same application services as other Effects without the SDK starting a separate runtime

Effect represents expected errors, defects and interruption. A defect is an unexpected fault, and interruption means cancellation. Effect's Cause can retain these together, including cleanup failures. Do not turn every Cause into a retry

Continue with [scoped workflows](/docs/{{version}}/effect-workflows/) to combine collectors, failure handling and concurrent reads
