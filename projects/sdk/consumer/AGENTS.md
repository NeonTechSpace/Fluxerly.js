# Using Fluxerly in an application

Use this guide when writing an application with `@neontechspace/fluxerly`, not when changing the SDK itself

Follow the application's instructions and the user's scope first.
This guide does not authorize access to accounts, credentials or live channels

Paths below are relative to the installed package, not your application's root

## Start with the installed version

1. Read `package.json` for the installed SDK version, required Node.js version and supported import paths under `exports`
2. Unless the application already uses Effect or explicitly requests it, use `@neontechspace/fluxerly`.
   Use its default Result-based API without adding an Effect runtime

3. In `package.json` exports, select `.` for default usage or `./effect` for native Effect usage.
   Follow its `types` path and search that file for the requested member.
   Read its JSDoc and follow referenced declarations for the options and error types you need, rather than reading the entire entry file.
   These comments document the installed SDK version

4. Import through `@neontechspace/fluxerly` or `@neontechspace/fluxerly/effect`.
   Files under `src` and `dist` can be read to understand the SDK, but applications must not import them directly.
   The SDK's `#sdk/*` aliases are for its own code, not application imports

Do not infer Fluxerly methods from Discord.js or another chat SDK.
If a method is absent from the installed public declarations, report the gap instead of inventing it

Keep the application's existing module and TypeScript settings when they work with the SDK. Report any incompatibility before proposing changes

## Default API

Follow each method's declared return type

For `Result`, check `isErr()` to see whether the operation failed before reading its successful `.value`.
For `ResultAsync`, work starts when the method is called. Use `await` to get its `Result`

Methods returning `AsyncIterable`, such as `messages.iterateHistory`, start work when iteration begins. Use `for await` and check each returned `Result`.
Some local members return plain values or `void`, such as `cache.clear()`, and need no Result handling

Expected failures return `Err`. Unexpected SDK failures can throw or reject a Promise, so put cleanup in `finally`

Sending a single message over HTTP does not need a gateway connection.
The caller supplies an authorized token, channel ID and message, and decides how to report the thrown error

```ts
import { createClient } from "@neontechspace/fluxerly"

export async function sendOnce(token: string, channelId: string, content: string) {
    const created = createClient({ token })
    if (created.isErr()) throw created.error
    const client = created.value
    try {
        const sent = await client.messages.send(channelId, { content })
        if (sent.isErr()) throw sent.error
        return sent.value.id
    } finally {
        await client.shutdown()
    }
}
```

For a long-running bot, reuse one client rather than creating one per message.
Register handlers before starting the gateway

Read the lifecycle method documentation before choosing `connect`, `run` or `waitForClose`.
The `run` method waits until the client stops, not just until it connects. The `shutdown` method closes the client permanently

Keep shutdown in one place in the application. That code must also close the listeners, collectors and iterators it creates

## Only for native Effect applications

Use the exact Effect version listed under `peerDependencies.effect` in the installed SDK's `package.json`.
A newer Effect release candidate is not a supported substitute

Effect operations describe work but do not start it until executed.
Compose them with `yield*` inside `Effect.gen`, keep the scope open while its resources are needed, and execute the program from the application's entry point.
Do not return a usable client or collector from a scope that has already closed

```ts
import { Effect } from "effect"
import { createClient } from "@neontechspace/fluxerly/effect"

export function sendOnce(token: string, channelId: string, content: string) {
    const program = Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({ token })
            const sent = yield* client.messages.send(channelId, { content })
            return sent.id
        }),
    )
    return Effect.runPromise(program)
}
```

Re-running an Effect can repeat a remote write.
Handle typed failures separately from unexpected defects and interruption.
Check each member's declaration rather than assuming every native member is an Effect

## Before sending requests

- Keep IDs as decimal strings, not JavaScript numbers, and check documented units on timeout options
- Check whether the chosen method reads cached observations or fetches remote state.
  An object missing from the cache may still exist on Fluxer

- Look for existing SDK helpers, command routing and paginated iterators before writing equivalent code
- Keep tokens out of logs, examples, fixtures and error reports
- Check the documented cancellation and retry behavior before adding retries.
  Cancellation does not undo a write that was already sent.
  When a write's outcome is unknown, check Fluxer's current state if authorized rather than sending the same write again

## Finish with evidence

Check the types of the application's actual imports and changed code against the installed package.
Test success, expected failure and cleanup through the public API, using controlled fixtures where possible

Run live checks only against explicitly authorized targets and clean up test-owned resources

A successful send response does not prove that the recipient received the message or that the full task succeeded.
Check the result requested by the user. Report anything that could not be tested or accessed instead of claiming it is complete
