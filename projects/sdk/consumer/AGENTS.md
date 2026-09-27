# Using Fluxerly in an application

Use this guide when writing an application with `@neontechspace/fluxerly`, not when changing the SDK itself

Follow the application's instructions and the user's scope first.
This guide does not authorize access to accounts, credentials or live channels

Paths below are relative to the installed package, not the application's root

## Start with the installed version

1. Read `package.json` for the installed SDK version, required Node.js version and supported import paths under `exports`
2. Unless the application already uses Effect or explicitly requests it, use `@neontechspace/fluxerly`.
   Use its default Result-based API without adding an Effect runtime

3. In `package.json` exports, select `.` for default usage, `./effect` for native Effect usage, or `./testing` and `./effect/testing` for application tests.
   Follow its `types` path, such as `dist/index.d.ts`, and search that file for the requested member.
   Read its JSDoc and follow referenced declarations for the needed options and error types, rather than reading the entire entry file.
   These comments document the installed SDK version

4. Import only through `@neontechspace/fluxerly`, `@neontechspace/fluxerly/effect`, `@neontechspace/fluxerly/testing` or `@neontechspace/fluxerly/effect/testing`.
   Files under `src` and `dist` can be read to understand the SDK, but applications must not import them directly.
   The SDK's `#sdk/*` aliases are for its own code, not application imports

The complete starter bots are in `examples/starter/`: `bot.js`, `bot.ts` and the native `bot-effect.ts`.
Guides, examples and the API reference for the newest release are at https://preview.fluxerly.neontechspace.com/docs/latest/. Prefer the installed declarations when they differ

Do not infer Fluxerly methods from other libraries or platforms.
If a method is absent from the installed public declarations, report the gap instead of inventing it

## Project requirements

- Node.js 24.11 or newer, as `engines` states
- The SDK is ESM-only. Use `import` in a project whose `package.json` sets `"type": "module"`, or in `.mjs` files. A `require()` call fails with an error that explains this
- TypeScript checks need TypeScript 7 and `@types/node`, for example with `"types": ["node"]`, because handler signals are `AbortSignal` values and clients support `await using`. Running `node bot.ts` directly needs no compiler
- Read the token from the environment, such as `FLUXER_BOT_TOKEN`. A missing or blank token throws `ConfigurationError` with a hint that the variable is probably unset

Keep the application's existing module and TypeScript settings when they work with the SDK. Report any incompatibility before proposing changes

## Choose the entry

- Use `runBot` for a bot. One options object holds the client settings, `events` handlers, prefix `commands`, a `setup(client)` callback for other startup work, `onError` and `processSignals: true` to stop cleanly on SIGINT and SIGTERM.
  It checks every option before creating a client, then connects and resolves only after the bot stopped and SDK cleanup finished. A failure that stops the bot is logged once and sets `process.exitCode` to 1, so `await runBot({...})` needs no try/catch. Pass `reportFailure: false` only when the application handles the returned failure itself. Match `examples/starter/bot.js`
- Use `createClient` only when the application needs manual control of connection and shutdown.
  Register handlers with `client.on` or `client.subscribe` before `connect` or `run`.
  The `run` method waits until the client stops, not just until it connects. The `shutdown` method closes the client permanently
- For prefix commands, pass `commands: { prefix, commands: { name: { arguments, guard, cooldown, hidden, execute } } }` to `runBot`, or build a router with `commands.create` and `attach` it to a client.
  Guards come from `guards`: `guildOnly()`, `dmOnly()`, `ownerOnly(ids)` and `requirePermissions(names)`. A cooldown is `{ durationMs, per: "user" | "channel" | "guild" }`.
  Router options add `use` middleware, `onReject: "reply"` feedback, `mentionPrefix` and `cooldowns: { maxEntries }`, and `router.help` or the command context's `help()` builds help pages.
  A `hidden: true` command is left out of help and suggestions but still runs, so guard commands that need protection
- Use `client.use(middleware)` for event middleware around every later `on` handler
- For Fluxer API routes without an SDK method, use `client.rest.request({ method, path })`, which shares the client's queue, rate limits and logging. For gateway commands without an SDK method, use `client.gateway.send(shardId, op, d)`. Check the installed declarations for an SDK method first

## Default API

Follow each method's declared return type

Network and other I/O operations return `ResultAsync`, whose work starts when the method is called. Use `await` to get its `Result`.
Check `isErr()` to see whether the operation failed before reading its successful `.value`, or call `orThrow` to get the value and throw the error instead

Methods returning `AsyncIterable`, such as `messages.iterateHistory`, start work when iteration begins. Use `for await` and check each returned `Result`.
Local work returns plain values and needs no Result handling: Creating clients and command routers, registering handlers with `on` or `subscribe`, cache `get` lookups and helpers such as `format` and `colors`.
Misuse of local work, such as invalid options or a missing token, throws `ConfigurationError` or the helper's own error at once

Expected runtime failures return `Err`. Unexpected SDK failures can throw or reject a Promise, so release clients with `await using` or in `finally`.
Every SDK error extends `FluxerlyError` with a stable `code`, an optional `hint` and a `cause`. Use `describeError(error)` to print one, `errors.apiCode(error)` to branch on a Fluxer rejection such as `"missingPermissions"`, and `errors.isRetryable(error)` before repeating a call

Failures without a returned result, such as a handler that throws or returns an `Err`, go to the client's `onError` option or are logged at Error with the full error.
Do not wrap every handler in a catch that only logs. Let the SDK report it, or pass `onError` to route reports to the application's own error tracking

Sending a single message over HTTP does not need a gateway connection.
The caller supplies an authorized token, channel ID and message, and decides how to report the thrown error

```ts
import { createClient, orThrow } from "@neontechspace/fluxerly"

export async function sendOnce(token: string, channelId: string, content: string) {
    await using client = createClient({ token })
    const sent = orThrow(await client.messages.send(channelId, content))
    return sent.id
}
```

For a long-running bot, reuse one client rather than creating one per message.
Keep shutdown in one place in the application. That code must also close the subscriptions, collectors and iterators it creates, with `close()` or `await using`.
A subscription registered after shutdown began is returned already closed with a Warn record, and a collector registered then reports `ClientClosedError` from its `result()`

## Logging

The client logs startup, readiness, lost connections, long rate-limit waits, event drops, shutdown and every application failure by default. Records never contain the token or other credentials.
Adjust output with the `logging` option rather than filtering console output: `level`, per-category `categories`, `debug`, `format` (`"pretty"` or `"json"`), `sink` to forward records to another logger, and `dedupe`.
Set `FLUXERLY_DEBUG=1`, or a list of categories, for Debug records. Leave `unsafe` payload logging off unless explicitly authorized for local debugging.
Each record has a stable `code`, such as `rest.rejected`. The documentation website lists every error and log code.
Read `client.diagnostics().counters` for failure, drop, retry and reconnect totals

## Tests

Test a `runBot` bot by passing its own options object to `createTestBot` from `@neontechspace/fluxerly/testing`. It runs the bot's events, commands and `setup` against an in-memory Fluxer, with no token or network. Use `createTestClient` for code written against a client.
Both return a real client with the controls `ready()`, `emit(type, payload)` for wire dispatches such as `MESSAGE_CREATE`, `rest.respond(matcher, response)`, `requests()`, `commands()`, `logs()`, `counters()` and `disconnect()`. The shared `fixtures` build wire payloads.
Wait for a request with `next()` on the route that `rest.respond` returns, and for a quiet bot with `idle()`, instead of sleeping.
A handler or command failure without `onError` makes shutdown fail with `UnhandledTestFailuresError`, unless the test reads it from `failures()`.
Release the default test client with `await using` or `shutdown()`. The native versions from `@neontechspace/fluxerly/effect/testing` are scoped

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
            const sent = yield* client.messages.send(channelId, content)
            return sent.id
        }),
    )
    return Effect.runPromise(program)
}
```

The native `runBot` takes the same options object with handlers that return Effects. Match `examples/starter/bot-effect.ts`.
For Layer-based programs, provide `FluxerClient.layer(options)` or `FluxerClient.layerConfig({ token: Config.Redacted("FLUXER_BOT_TOKEN") })` and read the client with `yield* FluxerClient`. Building the layer does not connect.
Native logging goes through the program's Effect logger

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
Test success, expected failure and cleanup through the public API, preferably with the testing entry points

Run live checks only against explicitly authorized targets and clean up test-owned resources

A successful send response does not prove that the recipient received the message or that the full task succeeded.
Check the result requested by the user. Report anything that could not be tested or accessed instead of claiming it is complete
