---
title: Give your bot prefix commands
navTitle: Commands
description: Register a command, convert arguments and generate help from the same definitions
---

A prefix command is a message such as `!ping` or `!greet Maya`. Fluxerly's optional command router matches the prefix, finds a registered command and calls your handler. It uses your existing client and does not connect another bot

These examples are helpers for [an existing bot](/docs/{{version}}/quick-start/). Call an installer once before `client.connect()`. Do not keep the starter's manual `!ping` handler if you register another `ping` command, or both handlers can reply

## Register and attach one command

Each registration returns a new router. Keep the returned value and attach that final router to your client

```ts
import { commands, type Client } from "@neontechspace/fluxerly"

export function installPing(client: Client) {
    const created = commands.create({ prefix: "!" })
    if (created.isErr()) return created

    const registered = created.value.register({
        name: "ping",
        description: "Check that the bot can reply",
        execute: async ({ client, message, signal }) => {
            const reply = await client.messages.reply(message, { content: "Pong!" }, { signal })
            if (reply.isErr()) throw reply.error
        },
    })
    if (registered.isErr()) return registered
    return registered.value.attach(client)
}
```

Check the installer's Result. Its successful value is a subscription, which lets your application stop this router and observe its closure. Attachment errors are different from a later command execution failure

The handler awaits its reply and throws an expected failure into the router's handler-error boundary. Returning an Err by itself would not report a callback failure. Pass the provided `signal` so an unsubscribed router can cancel its pending requests

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
        execute: async ({ client, message, values, signal }) => {
            const reply = await client.messages.reply(message, {
                content: `Hello, ${values.name}!`,
            }, { signal })
            if (reply.isErr()) throw reply.error
        },
        onReject: async ({ client, message, signal }) => {
            const reply = await client.messages.reply(message, {
                content: 'Try !greet "Ada Lovelace"',
            }, { signal })
            if (reply.isErr()) throw reply.error
        },
    })
    if (registered.isErr()) return registered
    return registered.value.attach(client)
}
```

In TypeScript, `values.name` is inferred as a string. Missing or extra arguments take the rejection path before `execute`. Other descriptors cover integers, choices, IDs and ID-or-mention inputs. Selecting an ID does not authorize an operation on that resource

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
