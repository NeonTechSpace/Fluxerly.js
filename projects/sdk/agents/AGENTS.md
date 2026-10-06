# Using Fluxerly in an application

Use this guide when writing an application with `@neontechspace/fluxerly`, not when changing the SDK itself.
Follow the application's instructions and the user's scope first. This guide does not authorize access to accounts, credentials or live channels

Paths starting with `node_modules/@neontechspace/fluxerly/` point into the installed package

## Rules

<!-- fluxerly-rules:start -->

1. Import only from `@neontechspace/fluxerly`, `@neontechspace/fluxerly/effect`, `@neontechspace/fluxerly/testing` or `@neontechspace/fluxerly/effect/testing`, never from its `dist` or `src` files
2. Use `runBot` for a bot, as in the starter bot. Use `createClient` only when the application needs manual control of connection and shutdown
3. Network calls return a Result instead of throwing. Check `result.isErr()` before reading `result.value`, or return the call from a handler so the SDK logs a failure
4. Read the bot token from the environment, such as `FLUXER_BOT_TOKEN`, and keep it out of code, logs and commits
5. The SDK is ESM-only and needs Node.js 24.15 or newer. Use `import` in a project whose `package.json` sets `"type": "module"`
6. Use only methods declared in the installed type files, even when a familiar method name seems likely, and report a missing method instead of inventing one
7. Test a bot with `createTestBot` from `@neontechspace/fluxerly/testing`, which needs no token or network

<!-- fluxerly-rules:end -->

## Start from the starter bot

This is `node_modules/@neontechspace/fluxerly/examples/starter/bot.js`. The same folder has `bot.ts` and the native Effect `bot-effect.ts`

```js
import { runBot } from "@neontechspace/fluxerly"

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.author.isBot || message.content !== "!ping") return
            // Returning the reply reports a failed send to the log
            return reply("Pong!")
        },
    },
})
```

Run it with `node --env-file=.env bot.js`, where `.env` holds `FLUXER_BOT_TOKEN=...`

## Patterns that do not exist in Fluxerly

- No `new Client()` and `client.login(token)`. Use `runBot({ token, ... })`, or `createClient({ token })` and then `client.run()`
- No intents. Nothing needs to be enabled to receive events
- No slash commands or interactions. Commands are prefix commands such as `!ping`, through the `commands` option of `runBot`
- Messages are read-only data without methods, so `message.reply()`, `message.delete()` and `channel.send()` do not exist. Use the `reply` passed to a handler, or `client.messages.send(channelId, content)`
- A `runBot` event handler receives a context object such as `({ message, reply })`, not the message itself
- A bot author is detected with `message.author.isBot`. There is no `message.author.bot`
- Fluxer calls servers communities, and the SDK names them guilds, as in `guildId`

## Check a Result

Network and other I/O operations return `ResultAsync`, whose work starts when the method is called. Use `await` to get its `Result`, then check `isErr()` before reading `.value`.
The `orThrow` helper returns the value and throws the error instead

```ts
import { createClient } from "@neontechspace/fluxerly"

export async function sendOnce(token: string, channelId: string, content: string) {
    await using client = createClient({ token })
    const sent = await client.messages.send(channelId, content)
    // The caller decides how to report a failed send
    if (sent.isErr()) throw sent.error
    return sent.value.id
}
```

Sending a single message over HTTP needs no gateway connection. For a long-running bot, reuse one client rather than creating one per message

## Find the right API

1. Read `node_modules/@neontechspace/fluxerly/package.json` for the installed SDK version, required Node.js version and supported import paths under `exports`
2. Unless the application already uses Effect or explicitly requests it, use `@neontechspace/fluxerly` and its Result-based API without adding an Effect runtime
3. Follow the `types` path of the chosen entry, such as `dist/index.d.ts`, and search that file for the requested member.
   Read its JSDoc and follow referenced declarations for the needed options and error types, rather than reading the entire file.
   These comments document the installed SDK version
4. Look for existing SDK helpers, command routing and paginated iterators before writing equivalent code

When the declarations do not answer a question, the documentation website has files for AI tools.
The index at https://preview.fluxerly.neontechspace.com/docs/latest/llms.txt links every guide as a small Markdown file, `llms-full.txt` holds every guide and `llms-reference.txt` holds a condensed API reference.
Prefer the installed declarations when they differ from the website

## Project requirements

- A `require()` call fails with an error that explains the SDK is ESM-only
- TypeScript checks need TypeScript 7 and `@types/node`, for example with `"types": ["node"]`, because handler signals are `AbortSignal` values and clients support `await using`. Running `node bot.ts` directly needs no compiler
- A missing or blank token throws `ConfigurationError` with a hint that the variable is probably unset

Keep the application's existing module and TypeScript settings when they work with the SDK. Report any incompatibility before proposing changes

## Build the bot

- `runBot` takes one options object with the client settings, `events` handlers, prefix `commands`, a `setup(client)` callback for other startup work, `onError` and `processSignals: true` to stop cleanly on SIGINT and SIGTERM.
  It checks every option before creating a client, then connects and resolves only after the bot stopped and SDK cleanup finished. A failure that stops the bot is logged once and sets `process.exitCode` to 1, so `await runBot({...})` needs no try/catch. Pass `reportFailure: false` only when the application handles the returned failure itself
- For prefix commands, pass `commands: { prefix, commands: { name: { arguments, guard, cooldown, hidden, execute } } }` to `runBot`.
  Guards come from `guards`: `guildOnly()`, `dmOnly()`, `ownerOnly(ids)` and `requirePermissions(names)`. A cooldown is `{ durationMs, per: "user" | "channel" | "guild" }`.
  A `hidden: true` command is left out of help and suggestions but still runs, so guard commands that need protection
- With `createClient`, register handlers with `client.on` or `client.subscribe` before `connect` or `run`.
  The `run` method waits until the client stops, not just until it connects. The `shutdown` method closes the client permanently

Local work returns plain values and needs no Result handling: Creating clients and command routers, registering handlers, cache `get` lookups and helpers such as `format` and `colors`.
Misuse of local work, such as invalid options or a missing token, throws `ConfigurationError` or the helper's own error at once

Methods returning `AsyncIterable`, such as `messages.iterateHistory`, start work when iteration begins. Use `for await` and check each returned `Result`

## Errors and cleanup

Expected runtime failures return `Err`. Unexpected SDK failures can throw or reject a Promise, so release clients with `await using` or in `finally`.
Every SDK error extends `FluxerlyError` with a stable `code`, an optional `hint` and a `cause`. Use `describeError(error)` to print one, `errors.apiCode(error)` to branch on a Fluxer rejection such as `"missingPermissions"`, and `errors.isRetryable(error)` before repeating a call

Failures without a returned result, such as a handler that throws or returns an `Err`, go to the client's `onError` option or are logged at Error with the full error.
Do not wrap every handler in a catch that only logs. Let the SDK report it, or pass `onError` to route reports to the application's own error tracking

Keep shutdown in one place in the application. That code must also close the subscriptions, collectors and iterators it creates, with `close()` or `await using`.
A subscription registered after shutdown began is returned already closed with a Warn record, and a collector registered then reports `ClientClosedError` from its `result()`

## Tests

Test a `runBot` bot by passing its own options object to `createTestBot` from `@neontechspace/fluxerly/testing`. It runs the bot's events, commands and `setup` against an in-memory Fluxer, with no token or network. Use `createTestClient` for code written against a client.
Both return a real client with the controls `ready()`, `emit(type, payload)` for Fluxer events such as `MESSAGE_CREATE`, `rest.respond(matcher, response)`, `requests()`, `commands()`, `logs()`, `counters()` and `disconnect()`. The shared `fixtures` build event payloads.
Wait for a request with `next()` on the route that `rest.respond` returns, and for a quiet bot with `idle()`, instead of sleeping.
A handler or command failure without `onError` makes shutdown fail with `UnhandledTestFailuresError`, unless the test reads it from `failures()`.
Release the default test client with `await using` or `shutdown()`

## Before sending requests

- Keep IDs as decimal strings, not JavaScript numbers, and check documented units on timeout options
- Check whether the chosen method reads cached data or fetches it from Fluxer. An object missing from the cache may still exist on Fluxer
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

## Only for native Effect applications

Use an Effect version within the `peerDependencies.effect` range in the installed SDK's `package.json`.
The lowest version in that range is the one the SDK is tested against. Later Effect 4 releases are accepted, but Effect 3 and Effect 4 prereleases are not

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
Native logging goes through the program's Effect logger. The native test helpers from `@neontechspace/fluxerly/effect/testing` are scoped

Re-running an Effect can repeat a remote write.
Handle typed failures separately from unexpected defects and interruption.
Check each member's declaration rather than assuming every native member is an Effect

## Advanced

- Build a command router with `commands.create` and `attach` it to a client. Router options add `use` middleware, `onReject: "reply"` feedback, `mentionPrefix` and `cooldowns: { maxEntries }`, and `router.help` or the command context's `help()` builds help pages
- Use `client.use(middleware)` for event middleware around every later `on` handler
- For Fluxer API routes without an SDK method, use `client.rest.request({ method, path })`, which shares the client's queue, rate limits and logging. For gateway commands without an SDK method, use `client.gateway.send(shardId, op, d)`. Check the installed declarations for an SDK method first
- The client logs startup, readiness, lost connections, long rate-limit waits, event drops, shutdown and every application failure by default. Records never contain the token or other credentials.
  Adjust output with the `logging` option rather than filtering console output: `level`, per-category `categories`, `debug`, `format` (`"pretty"` or `"json"`), `sink` to forward records to another logger, and `dedupe`.
  Set `FLUXERLY_DEBUG=1`, or a list of categories, for Debug records. Leave `unsafe` payload logging off unless explicitly authorized for local debugging.
  Each record has a stable `code`, such as `rest.rejected`. The documentation website lists every error and log code
- Read `client.diagnostics().counters` for failure, drop, retry and reconnect totals

## Keep this guide in the project

Run `npx --no fluxerly agents`, `pnpm exec fluxerly agents` or `bunx --no-install fluxerly agents` in the application's folder to copy the rules above into its AGENTS.md, which many coding agent tools read automatically.
Running it again after an SDK update refreshes only that section
