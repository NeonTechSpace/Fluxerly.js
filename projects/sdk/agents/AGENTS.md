# Using Fluxerly in an application

Use this guide when writing an application with `@neontechspace/fluxerly`, not when changing the SDK itself.
Follow the application's instructions and the user's scope first. This guide does not authorize access to accounts, credentials or live channels

Paths starting with `node_modules/@neontechspace/fluxerly/` point into the installed package

## Rules

<!-- fluxerly-rules:start -->

1. Import only from `@neontechspace/fluxerly`, `@neontechspace/fluxerly/effect`, `@neontechspace/fluxerly/testing` or `@neontechspace/fluxerly/effect/testing`, never from its `dist` or `src` files
2. Use `runBot` for a bot, as in the starter bot. Use `createClient` only when the application needs manual control of connection and shutdown
3. In the default API, network calls return a Result for expected failures. Check `result.isErr()` before reading `result.value`, or return the call from a handler so the SDK reports the failure. In the Effect API, execute the Effect and handle its error channel
4. Read the bot token from the environment, such as `FLUXER_BOT_TOKEN`, and keep it out of code, logs and commits
5. The SDK is ESM-only and needs Node.js 24.15 or newer. Use `import` in a project whose `package.json` sets `"type": "module"`
6. Use only methods declared in the installed type files, even when a familiar method name seems likely, and report a missing method instead of inventing one
7. Test a default API bot with `createTestBot` from `@neontechspace/fluxerly/testing`, or a native Effect bot with `createTestBot` from `@neontechspace/fluxerly/effect/testing`. Neither needs a token or network

<!-- fluxerly-rules:end -->

## Start from the starter bot

This is `node_modules/@neontechspace/fluxerly/examples/starter/bot.js`, the bot that `fluxerly init` writes. The same folder has `bot.ts`, with the same code, and the native Effect `bot-effect.ts`

```js
import { defineBot, runBot } from "@neontechspace/fluxerly"

// The bot's options without its token, so its test can run them through createTestBot without a token or a network
export const bot = defineBot({
    commands: {
        prefix: "!",
        commands: {
            // Returning the reply reports a failed send to the log
            ping: { execute: ({ reply }) => reply("Pong!") },
        },
    },
})

// Running this file starts the bot, while importing it from a test does not.
// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
if (import.meta.main) await runBot({ token: process.env.FLUXER_BOT_TOKEN, ...bot })
```

Run it with `node --env-file=.env bot.js`, where `.env` holds `FLUXER_BOT_TOKEN=...`.
Keep the options in the exported `defineBot` call and the `import.meta.main` start line, so a test can import `bot` and pass it to `createTestBot` from `@neontechspace/fluxerly/testing` without a token or a network.
A project from `fluxerly init` has such a test in `bot.test.js` or `bot.test.ts`, run by `npm test`, `pnpm test` or `bun run test`

## Patterns that do not exist in Fluxerly

- No `new Client()` and `client.login(token)`. Use `runBot({ token, ... })`, or `createClient({ token })` and then `client.run()`
- No intents. Fluxer sends events by permissions, visibility and subscriptions. Member presence updates also need `client.presence.setMembers` with the member IDs
- No slash commands or interactions. Commands are prefix commands such as `!ping`, through the `commands` option of `runBot`
- Messages are read-only data without methods, so `message.reply()`, `message.delete()` and `channel.send()` do not exist. Use the `reply` passed to a handler, or `client.messages.send(channelId, content)`
- A `runBot` event handler receives a context object such as `({ message, reply })`, not the message itself
- A bot author is detected with `message.author.isBot`. There is no `message.author.bot`, and `runBot` already skips bot-authored messages unless `ignoreBots` is false
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
3. Find the task in the map below and open the declaration file it names.
   Read the member's JSDoc and follow referenced declarations for its options and error types, rather than reading whole files.
   These comments document the installed SDK version
4. Look for existing SDK helpers, command routing and paginated iterators before writing equivalent code

Paths in the map are relative to `node_modules/@neontechspace/fluxerly/`. The Effect API uses the same names under `dist/api/effect/`, imported from `@neontechspace/fluxerly/effect`

- Run a bot with event handlers and commands: `dist/api/default/bot.d.ts`, starting with `defineBot`, `runBot` and their options
- Prefix commands, arguments and help pages: `dist/api/default/commands.d.ts`, `dist/command-arguments.d.ts`, starting with the `commands` option of `runBot`
- Send, reply, edit, delete, react, pin and read history: `dist/api/default/messages.d.ts`, starting with `client.messages`
- Embeds and message content: `dist/builders.d.ts`, `dist/messages.d.ts`, starting with `EmbedBuilder`, `MessageBuilder`
- Wait for replies or reactions: `dist/api/default/messages.d.ts`, `dist/collectors.d.ts`, starting with `client.messages.collect`, `client.messages.collectReactions`
- Ban, kick, time out, rename and change member roles: `dist/api/default/members.d.ts`, starting with `client.members`
- Roles and the role hierarchy: `dist/api/default/roles.d.ts`, `dist/role-hierarchy.d.ts`, starting with `client.roles`, `hierarchy`
- Check permissions: `dist/api/default/permissions.d.ts`, `dist/api/default/helpers.d.ts`, starting with `client.permissions`, `permissionBits`
- Channels, threads and forums: `dist/api/default/channels.d.ts`, `dist/api/default/threads.d.ts`, starting with `client.channels`, `client.threads`
- Community data and settings: `dist/api/default/guilds.d.ts`, starting with `client.guilds`
- Event names, payloads and handler context: `dist/events.d.ts`, starting with `EventMap`, `EventContext`
- Errors and Results: `dist/errors.d.ts`, `dist/error-tools.d.ts`, starting with `errors`, `describeError`
- Upload, refresh, download or stream attachments: `dist/api/default/attachments.d.ts`, `dist/attachments.d.ts`, starting with `client.attachments`
- Webhooks: `dist/api/default/webhooks.d.ts` for `client.webhooks`, and `dist/api/default/webhook-client.d.ts` for `createWebhookClient`, which sends through a webhook without a bot token
- Community emoji and stickers: `dist/api/default/emojis.d.ts`, `dist/api/default/stickers.d.ts`, starting with `client.emojis`, `client.stickers`
- Logging: `dist/logging.d.ts`, starting with the `logging` option of `runBot` and `createClient`
- Mentions, links, text and colors: `dist/api/default/helpers.d.ts`, starting with `format`, `links`, `text`, `colors`
- Tests without a token or network: `dist/testing.d.ts`, starting with `createTestBot`

When the declarations do not answer a question, the documentation website has Markdown files for AI tools.
Start with the task index at https://fluxerly.neontechspace.com/docs/where-do-i.md, which links the guide section for each common task, or the list of every client method by task at https://fluxerly.neontechspace.com/docs/api/tasks.md.
The index of all guides is https://fluxerly.neontechspace.com/docs/llms.txt, and its first lines name the SDK version it documents. These files follow the newest release, so when that version differs from the installed one, trust the installed declarations

## Project requirements

- A `require()` call fails with an error that explains the SDK is ESM-only
- TypeScript checks need TypeScript 7 and `@types/node`, for example with `"types": ["node"]`, because handler signals are `AbortSignal` values and clients support `await using`. Running `node bot.ts` directly needs no compiler
- A missing or blank token is logged with a hint, sets exit code 1 and returns `ConfigurationError` from `runBot` instead of throwing

Keep the application's existing module and TypeScript settings when they work with the SDK. Report any incompatibility before proposing changes

## Build the bot

- `runBot` takes one options object with the client settings, `events` handlers, prefix `commands`, a `setup` callback for other startup work and `onError`. The default API calls `setup(client, { signal })`. By default it skips messages written by bots, and the default API's `runBot` also stops cleanly on SIGINT and SIGTERM. Set `ignoreBots: false` or `processSignals: false` to turn either off. The native Effect `runBot` from `@neontechspace/fluxerly/effect` handles those signals only with `processSignals: true`, because an Effect launcher such as `NodeRuntime.runMain` may already handle them.
  It checks every option before creating a client, then connects and resolves only after the bot stopped and SDK cleanup finished. By default, an expected runtime failure that stops the bot is logged once and sets `process.exitCode` to 1. In the default API, invalid options can throw synchronously and unexpected defects can throw or reject, so applications that need to recover from or report them must handle those errors. Pass `reportFailure: false` only when the application handles the returned failure itself
- For prefix commands, pass `commands: { prefix, commands: { name: { arguments, guard, cooldown, hidden, execute } } }` to `runBot`.
  Guards come from `guards`: `guildOnly()`, `dmOnly()`, `ownerOnly()` for the application's owner, `ownerOnly(ids)` and `requirePermissions(names)`. A cooldown is `{ durationMs, per: "user" | "channel" | "guild" }`.
  A `hidden: true` command is left out of help and suggestions but still runs, so guard commands that need protection
- With `createClient`, register handlers with `client.on` or `client.subscribe` before `connect` or `run`.
  The `run` method waits until the client stops, not just until it connects. The `shutdown` method closes the client permanently
- Startup allows 30 seconds, and the first Identify adds 135 seconds once, because Fluxer can hold a session start that long while its Identify queue is busy. A reconnection attempt allows 30 seconds, plus 135 when it sends Identify instead of resuming. Size health checks and process manager start timeouts for up to about 165 seconds. Setting `connection.startupTimeoutMs` or `connection.recovery.attemptTimeoutMs` makes that value one fixed deadline that Identify does not extend

In the default API, local work returns plain values and needs no Result handling: Creating clients and command routers, registering handlers, cache `get` lookups and helpers such as `format` and `colors`.
In the default API, misuse of local work, such as invalid options or a missing token, throws `ConfigurationError` or the helper's own error at once. The native Effect API returns Effects for some of this work, as described under "Only for native Effect applications"

Methods returning `AsyncIterable`, such as `messages.iterateHistory`, start work when iteration begins. Use `for await` and check each returned `Result`

## Errors and cleanup

Expected runtime failures return `Err`. Unexpected SDK failures can throw or reject a Promise, so release clients with `await using` or in `finally`.
Every SDK error extends `FluxerlyError` with a stable `code`, an optional `hint` and a `cause`. Use `describeError(error)` to print one, `errors.apiCode(error)` to branch on a Fluxer rejection such as `"missingPermissions"` or `"fileSizeTooLarge"`, and `errors.isRetryable(error)` before repeating a call.
A retryable failure can still require a wait, as a rate limit or Fluxer's busy upload slots answer does, so first wait `errors.retryAfterMs(error)` milliseconds when it returns a number. An upload that read a `ReadableStream`, marked by `details.streamUsed`, is not retryable and needs a new stream

Failures without a returned result, such as a handler that throws or returns an `Err`, go to the client's `onError` option or are logged at Error with the full error.
Do not wrap every handler in a catch that only logs. Let the SDK report it, or pass `onError` to route reports to the application's own error tracking

Keep shutdown in one place in the application. That code must also close the subscriptions and collectors it creates, with `close()` or `await using`. Paginated reads have neither: Consume them with `for await`, whose end or early exit releases them, and cancel pending work with the request's `signal`.
A subscription registered after shutdown began is returned already closed with a Warn record, and a collector registered then reports `ClientClosedError` from its `result()`

## Tests

Test a `runBot` bot by passing its own options object to `createTestBot` from `@neontechspace/fluxerly/testing`. It runs the bot's events, commands and `setup` against an in-memory Fluxer, with no token or network. Use `createTestClient` for code written against a client.
Both return a test harness with the real client at `test.client` and the controls `ready()`, `emit(type, payload)` for Fluxer events such as `MESSAGE_CREATE`, `rest.respond(matcher, response)`, `requests()`, `commands()`, `logs()`, `counters()` and `disconnect()`. The shared `fixtures` build event payloads.
Send a user message with `say(content)` on a test bot, which resolves with the messages the bot sent, including sends that a test's `rest.respond` fixture rejected. Message sends and edits without a `rest.respond` fixture receive an echoed message.
Wait for a request with `next()` on the route that `rest.respond` returns, and for a quiet bot with `idle()`, instead of sleeping. Waits have no deadline unless `timeoutMs` is passed. Pass it to a wait that might never settle, or run tests with `node --test --test-timeout=10000 --test-force-exit`.
A handler or command failure without `onError` makes shutdown fail with `UnhandledTestFailuresError`, unless the test reads it from `failures()`.
Release the default test client with `await using` or `shutdown()`

## Before sending requests

- Keep IDs as decimal strings, not JavaScript numbers, and check documented units on timeout options. SDK methods and helpers trim surrounding whitespace from an ID and require a decimal without leading zeros, at most 9223372036854775807, and gateway IDs must also be nonzero. `client.rest.call` and `client.rest.request` send params and bodies as given
- Null `content` clears a message's text. An edit without `flags` needs visible content, an embed or an attachment in the edit itself. To clear the text alone, include the message's current `flags` in the same edit, except on a voice note, where supplying flags clears the voice-note flag
- Embed URLs, link channel URLs and webhook avatar URLs must start with lowercase `http://` or `https://`, carry no credentials and name an IP address or a domain. On hosted Fluxer the domain needs a top-level domain, while a custom instance decides that itself. These rules do not apply to URLs the bot receives
- Download `maxBytes` is required and has no SDK ceiling. `client.attachments.download` holds the whole file in memory, so use `client.attachments.stream` for large files
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
The SDK is tested against the lowest version in that range, and a daily check runs its tests against the newest Effect 4 release in the range. Later Effect 4 releases are accepted, but Effect 3 and Effect 4 prereleases are not

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

The native `runBot` takes the same options object with handlers that return Effects. Native `setup(client)` gets only the client and returns an Effect that runs in the bot's Scope, so use scoped resources for cleanup instead of a signal. Match `examples/starter/bot-effect.ts`.
For Layer-based programs, provide `FluxerClient.layer(options)` or `FluxerClient.layerConfig({ token: Config.Redacted("FLUXER_BOT_TOKEN") })` and read the client with `yield* FluxerClient`. Building the layer does not connect.
Native logging goes through the program's Effect logger. The native test helpers from `@neontechspace/fluxerly/effect/testing` are scoped

Re-running an Effect can repeat a remote write.
Handle typed failures separately from unexpected defects and interruption.
Check each member's declaration rather than assuming every native member is an Effect

## Advanced

- Build a command router with `commands.create` and `attach` it to a client. Router options add `use` middleware, `onReject: "reply"` feedback, `mentionPrefix` and `cooldowns: { maxEntries }`, and `router.help` or the command context's `help()` builds help pages. The context's `sendHelp()` sends them, and its `paginate(pages)` shows pages that the command's author flips with reactions
- Use `client.use(middleware)` for event middleware around every later `on` handler
- Check the installed declarations for an SDK method before using the raw tools below. Their types check nothing at runtime, so check a value before relying on it
- For Fluxer API routes without an SDK method, use `client.rest.call("METHOD /path/{param}", { params, query, body })`, whose route, fields and response are typed from Fluxer's API description, with reviewed corrections from Fluxer's server code, and Fluxer's field names. Use `client.rest.request({ method, path })` for a route or field newer than the SDK, or a route `call` does not list, such as Fluxer's report flows. Both share the client's queue, rate limits and logging
- For gateway commands without an SDK method, use `client.gateway.send(shardId, op, d)`, and read a voice join that Fluxer refuses from the `gatewayError` event
- For dispatches without a typed event, such as `THREAD_MEMBER_UPDATE`, use `client.on("raw", handler)`: Check `documented`, then compare `t`, and `d` gets the payload type the SDK describes from Fluxer's documentation and reviewed server code, with Fluxer's field names. `documented` is true exactly for the types the SDK describes, including `GUILD_HEALTH_UPDATE`, which only Fluxer's server code defines
- The client logs startup, readiness, lost connections, long rate-limit waits, event drops, shutdown and every application failure by default. Records mask the token, Fluxer's credential forms and common credential names, such as Authorization headers, passwords and cookies, but not an unlabelled secret or another service's secret under a name the SDK does not know, so keep such secrets out of error messages.
  Adjust output with the `logging` option rather than filtering console output. Choose `format` (`"pretty"` or `"json"`), `sink` to forward records to another logger and `dedupe` when creating the client. Change `level`, per-category `categories` and `debug` while running with `client.logging.configure`.
  Set `FLUXERLY_DEBUG=1`, or a list of categories, for Debug records. Leave `unsafe` payload logging off unless explicitly authorized for local debugging.
  Each record has a stable `code`, such as `rest.rejected`. The documentation website lists every error and log code
- Read `client.diagnostics().counters` for failure, drop, retry and reconnect totals

## Keep this guide in the project

Run `npx --no fluxerly agents`, `pnpm exec fluxerly agents` or `bunx --no-install fluxerly agents` in the application's folder to copy the rules above into its AGENTS.md, which many coding agent tools read automatically.
Running it again after an SDK update refreshes only that section
