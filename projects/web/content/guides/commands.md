---
title: Add prefix commands to a bot
navTitle: Commands
description: Register a command, convert arguments and generate help from the same definitions
---

A prefix command is a message such as `!ping` or `!greet Maya`. Fluxerly's optional command router reads the name after the configured prefix and calls the matching handler. It uses the existing client and does not connect another bot

These examples replace the plain message handler in [the starter bot](/docs/{{version}}/quick-start/). Call the command installer inside the `runBot` installation callback, check its Result and return its subscription in the array. Remove the original `!ping` handler to avoid duplicate replies

## Register and attach commands

Register related commands together. Each object key becomes a command name. If a definition is invalid or a name is already in use, registration fails and the existing router stays unchanged

```ts
import { commands, type Client } from "@neontechspace/fluxerly"

export function installCommands(client: Client) {
    const created = commands.create({ prefix: "!" })
    if (created.isErr()) return created

    const registered = created.value.registerMany({
        ping: {
            description: "Check that the bot can reply",
            arguments: {},
            execute: async ({ reply }) => {
                const sent = await reply({ content: "Pong!" })
                if (sent.isErr()) throw sent.error
            },
        },
        about: {
            description: "Describe this bot",
            arguments: {},
            execute: async ({ reply }) => {
                const sent = await reply({ content: "Built with Fluxerly" })
                if (sent.isErr()) throw sent.error
            },
        },
    })
    if (registered.isErr()) return registered
    return registered.value.attach(client)
}
```

Check the installer's Result. On success, it returns a subscription that the application can stop or wait for. An attachment failure happens during setup, while a command failure happens after a matching message arrives

The bound `reply` uses the incoming message as its reference and forwards the handler's cancellation signal. The handler still checks its Result and throws an expected failure for the router to report. Returning an Err by itself would not report a callback failure

Commands in a batch use the order of the object's own string keys. Inherited keys are ignored. Use `arguments: {}` when a command accepts no positional arguments. Use `arguments: undefined` to keep unrestricted raw `args`, as with an individually registered command that has no argument schema. Pass a group as the batch's second argument to apply it to every command

## Convert arguments before execution

The router converts message tokens into typed arguments before running a command. This command accepts `!greet "Ada Lovelace"`. The quoted parser treats the name as one text argument

```ts
import { commands, type Client } from "@neontechspace/fluxerly"

export function installGreeting(client: Client) {
    const created = commands.create({ prefix: "!", parse: commands.parseQuoted })
    if (created.isErr()) return created

    const registered = created.value.register({
        name: "greet",
        description: "Greet a name",
        arguments: { name: { type: "text" } },
        execute: async ({ values, reply }) => {
            const sent = await reply({
                content: `Hello, ${values.name}!`,
            })
            if (sent.isErr()) throw sent.error
        },
        onReject: async ({ reply }) => {
            const sent = await reply({
                content: 'Try !greet "Ada Lovelace"',
            })
            if (sent.isErr()) throw sent.error
        },
    })
    if (registered.isErr()) return registered
    return registered.value.attach(client)
}
```

In TypeScript, `values.name` is inferred as a string. Missing or extra arguments take the rejection path before `execute`. Other descriptors cover integers, choices, IDs and ID-or-mention inputs. Selecting an ID does not authorize an operation on that resource

## Use the Effect entry point

The Effect API provides the same keyed batch and bound reply. Each reply inherits command-handler interruption and keeps `SendError` in the Effect error channel. Services required by any command in the batch remain requirements of the returned router

```ts
import { Effect } from "effect"
import { commands, type Client } from "@neontechspace/fluxerly/effect"

export const installCommands = (client: Client) =>
    Effect.gen(function* () {
        const root = yield* commands.create({ prefix: "!" })
        const router = yield* root.registerMany({
            ping: {
                arguments: {},
                execute: ({ reply }) => reply({ content: "Pong!" }).pipe(Effect.asVoid),
            },
            about: {
                arguments: {},
                execute: ({ reply }) => reply({ content: "Built with Fluxerly" }).pipe(Effect.asVoid),
            },
        })
        return yield* router.attach(client)
    })
```

## Add help from the registered commands

The router can build help pages from command descriptions and argument schemas. It does not send them or decide who may see them

```ts
import type { Client, DefaultPrefixCommandRouter, Message } from "@neontechspace/fluxerly"

export async function replyWithHelp(
    client: Client,
    router: DefaultPrefixCommandRouter,
    message: Message,
) {
    const pages = router.help({ prefix: "!", maxLength: 1800 })
    if (pages.isErr()) throw pages.error

    for (const content of pages.value) {
        const sent = await client.messages.reply(message, { content })
        if (sent.isErr()) throw sent.error
    }
}
```

Pass the final registered router to this helper from a help handler. Sequential sends preserve page order. A failed page does not remove pages already posted

For a larger bot, separate command definitions by feature and attach one combined router. [Groups, guards and cooldowns](/docs/{{version}}/api/interfaces/js-ts.DefaultPrefixCommandRouter/) can add structure when needed. Hidden help entries do not restrict access. Apply the application's access policy in each command's guard
