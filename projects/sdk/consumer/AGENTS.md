# Using Fluxerly in an application

Use this guide when writing code that consumes `@neontechspace/fluxerly`, not when maintaining the SDK itself

Follow the application's instructions and the user's scope first.
This guide does not authorize access to accounts, credentials or live channels

Paths below are relative to the installed package, not your application's root

## Start with the installed version

1. Read `package.json` for the installed version, Node requirement and public `exports`
2. Unless the application already uses Effect or explicitly requests it, use `@neontechspace/fluxerly`.
   Keep its default Result-based API rather than adding an Effect runtime to application code

3. In `package.json` exports, select `.` for default usage or `./effect` for native Effect usage.
   Follow its `types` path and search that file for the requested member.
   Read its JSDoc and follow referenced declarations for the options and error types you need, rather than reading the entire entry file.
   Their JSDoc is the version-matched API reference

4. Import through `@neontechspace/fluxerly` or `@neontechspace/fluxerly/effect`.
   Files under `src` and `dist` may help inspection but are not additional public import paths.
   The SDK's `#sdk/*` aliases belong to its implementation, not the consuming application

Do not infer Fluxerly methods from Discord.js or another chat SDK.
If a method is absent from the installed public declarations, report the gap instead of inventing it

Use the application's existing ESM and TypeScript setup where compatible, and report incompatibilities before proposing a migration

## Default API

Follow each method's declared return type

For `Result`, check `isErr()` before reading `.value`.
For `ResultAsync`, work starts when called, and awaiting it gives a `Result`

Methods returning `AsyncIterable`, such as `messages.iterateHistory`, start work on the first pull, so use `for await` and check each yielded `Result`.
Some local members return plain values or `void`, such as `cache.clear()`, and need no Result handling

Expected failures use `Err`, but unexpected defects can throw or reject, so cleanup belongs in `finally`

This one-shot HTTP send does not need a gateway connection.
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
In particular, `run` represents the accepted lifetime, not just readiness, and `shutdown` is final

Give one application-level owner responsibility for shutdown and for disposing listeners, collectors and iterators it creates

## Only for native Effect applications

Satisfy `peerDependencies.effect` in the installed package's manifest, not examples for a different Effect version.
The RC dependency is exact, so an arbitrary newer RC is not a supported substitute

Native operations describe work until executed.
Compose them with `yield*` inside `Effect.gen`, retain the owning scope for as long as its resources are needed, and run at the application boundary.
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
Handle typed failures without treating defects or interruption as default API errors.
Check each member's declaration rather than assuming every native member is an Effect

## Before sending requests

- Keep IDs as decimal strings, not JavaScript numbers, and check documented units on timeout options
- Check whether the chosen method reads cached observations or fetches remote state.
  A cache miss does not prove a remote object is absent

- Look for existing SDK helpers, command routing and paginated iterators before building equivalent machinery
- Keep tokens out of logs, examples, fixtures and error reports
- Check the documented cancellation and retry behavior before adding retries.
  Cancellation does not undo a dispatched write.
  When a write's outcome is unknown, reconcile remote state if authorized rather than blindly sending it again

## Finish with evidence

Typecheck the application's actual imports and changed usage against the installed package.
Test success, expected failure and cleanup through the public API, using controlled fixtures where possible

Run live checks only against explicitly authorized targets and clean up test-owned resources

A successful send response is not proof of downstream delivery or the user's complete workflow.
Check the requested observable result, and report any untested integration or unavailable access instead of claiming completion
