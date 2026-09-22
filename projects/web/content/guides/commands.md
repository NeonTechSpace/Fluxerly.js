---
title: Give your bot prefix commands
navTitle: Commands
description: Register a command, convert arguments and generate help from the same definitions
---

A prefix command is a message such as `!ping` or `!greet Maya`. Fluxerly's optional command router matches the prefix, finds a registered command and calls your handler. It uses your existing client and does not connect another bot

These examples extend [the starter bot](/docs/{{version}}/quick-start/). Add commands to its existing batch or replace that batch with an installer. Call installers inside the `runBot` installation callback and return their subscriptions so the starter supervises each critical worker. Attaching a second router with another `ping` command can make both handlers reply

## Register and attach commands

Register related commands in one immutable batch. The object keys become command names, and a failed definition or name collision rejects the whole batch without changing the earlier router

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

Check the installer's Result. Its successful value is a subscription, which lets your application stop this router and observe its closure. Attachment errors are different from a later command execution failure

The bound `reply` uses the incoming message as its reference and forwards the handler's cancellation signal. The handler still checks its Result and throws an expected failure into the router's handler-error boundary. Returning an Err by itself would not report a callback failure

Batch entries follow JavaScript own enumerable string-key order and ignore inherited keys. Use `arguments: {}` when a command accepts no positional arguments. Use `arguments: undefined` when it should keep unrestricted raw `args`, matching an individually registered command with no argument schema. A group can be selected once with the batch's second argument

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

Pass your final registered router to this helper from a help handler. Sequential sends preserve page order. A failed page does not remove pages already posted

For a larger bot, separate command definitions by feature and attach one composed router. [Groups, guards and cooldowns](/docs/{{version}}/api/interfaces/js-ts.DefaultPrefixCommandRouter/) can add structure when needed. Hidden help entries are presentation, not authorization. Apply your application's access policy in each command's guard
