---
title: Compose and test an Effect application
navTitle: Effect application testing
description: Put the scoped client behind application services and replace those services in tests
---

An Effect application can provide the SDK client as a service, beside its own services. Handlers then use both without starting another runtime, and tests replace the application services without a Fluxer connection

## Define application services and handlers

Keep the handler separate from the services it calls. In the running bot, the reply service uses the SDK client. In tests, replace that service without changing `handlePing`

```ts
// bot.ts
import { Config, Context, Effect, Layer } from "effect";
import { FluxerClient, type Message } from "@neontechspace/fluxerly/effect";

export class GreetingStore extends Context.Service<
    GreetingStore,
    { readonly greetingFor: (userId: string) => Effect.Effect<string> }
>()("example/GreetingStore") {}

export class BotReplies extends Context.Service<
    BotReplies,
    {
        readonly reply: (
            message: Message,
            content: string,
        ) => Effect.Effect<void, unknown>;
    }
>()("example/BotReplies") {}

export const handlePing = (message: Message) =>
    Effect.gen(function* () {
        if (message.author.isBot || message.content !== "!ping") return;
        const store = yield* GreetingStore;
        const replies = yield* BotReplies;
        yield* Effect.sleep("100 millis");
        yield* replies.reply(
            message,
            yield* store.greetingFor(message.author.id),
        );
    });

export const clientLayer = FluxerClient.layerConfig({
    token: Config.Redacted("FLUXER_BOT_TOKEN"),
});

export const repliesLayer = Layer.effect(
    BotReplies,
    FluxerClient.use((client) =>
        Effect.succeed({
            reply: (message: Message, content: string) =>
                client.messages.reply(message, content).pipe(Effect.asVoid),
        }),
    ),
).pipe(Layer.provideMerge(clientLayer));
```

The `FluxerClient` service holds one native client. `FluxerClient.layerConfig` reads the token from the `FLUXER_BOT_TOKEN` environment variable through Effect `Config`, keeps it redacted and creates the client inside the Layer's scope, without connecting. Closing the application scope shuts the client down once. `BotReplies` lets the handler send replies without depending directly on SDK methods

<details>
<summary>Layer failures and other ways to build the client service</summary>

A missing `FLUXER_BOT_TOKEN` fails the Layer with `ConfigError` before any client exists. A blank token or another invalid setting is misuse, so the Layer dies with `ConfigurationError`. `FluxerClient.layer(options)` takes the same settings as `createClient` without reading `Config`. Each build of a Layer creates its own client, so provide one Layer value to share it. For a `messageFields` selection, call `createClient` directly instead. The next example shows that form

</details>

## Assemble the live program

A bot that needs no custom Layer assembly can use `runBot` from the Effect entry point. Its handlers can require application services, and it watches its subscriptions and connection itself. See [first Effect bot](/docs/effect-first-bot/)

For full control, a worker service registers the handlers and runs the client. The worker Layer needs a client, which must stay available until the worker stops. `Layer.provideMerge` keeps both services available, and Layer memoization makes them share one client. This version creates its client service with `createClient` from a token argument

```ts
import { Context, Effect, Layer } from "effect";
import { createClient, type Client } from "@neontechspace/fluxerly/effect";

class AppConfig extends Context.Service<
    AppConfig,
    { readonly token: string }
>()("example-live/AppConfig") {}
class BotClient extends Context.Service<BotClient, Client>()(
    "example-live/BotClient",
) {}
class GreetingStore extends Context.Service<
    GreetingStore,
    { readonly greetingFor: (userId: string) => Effect.Effect<string> }
>()("example-live/GreetingStore") {}
class BotWorker extends Context.Service<
    BotWorker,
    { readonly run: Effect.Effect<void, unknown, GreetingStore> }
>()("example-live/BotWorker") {}

export const liveApplication = (token: string) => {
    const config = Layer.succeed(AppConfig, { token });
    const clients = Layer.effect(
        BotClient,
        AppConfig.use((appConfig) => createClient({ token: appConfig.token })),
    ).pipe(Layer.provide(config));
    const workers = Layer.effect(
        BotWorker,
        BotClient.use((client) =>
            Effect.succeed({
                run: Effect.scoped(
                    Effect.gen(function* () {
                        const subscription = yield* client.on(
                            "messageCreate",
                            (message) => {
                                if (
                                    message.author.isBot ||
                                    message.content !== "!ping"
                                )
                                    return Effect.void;
                                return GreetingStore.use((greetings) =>
                                    greetings
                                        .greetingFor(message.author.id)
                                        .pipe(
                                            Effect.flatMap((content) =>
                                                client.messages
                                                    .reply(message, content)
                                                    .pipe(Effect.asVoid),
                                            ),
                                        ),
                                );
                            },
                        );
                        const criticalWorker = subscription.waitForClose().pipe(
                            Effect.flatMap(() =>
                                Effect.fail({
                                    _tag: "CriticalWorkerStopped" as const,
                                }),
                            ),
                        );
                        yield* Effect.raceFirst(client.run(), criticalWorker);
                    }),
                ),
            }),
        ),
    ).pipe(Layer.provideMerge(clients));
    const store = Layer.succeed(GreetingStore, {
        greetingFor: (userId) => Effect.succeed(`Pong for ${userId}`),
    });

    const program = BotWorker.use((worker) => worker.run);

    return Effect.scoped(
        program.pipe(Effect.provide(Layer.mergeAll(config, workers, store))),
    );
};
```

This example includes its own handler and client service so it can be copied alone. An application can import `handlePing` from the previous section instead, and use `FluxerClient` with `clientLayer` in place of `BotClient`

Run `subscription.waitForClose()` and `client.run()` together for every subscription the bot needs, stopping when either finishes. `Effect.raceFirst` stops the other operation and the surrounding scope runs cleanup

<details>
<summary>When a subscription stops</summary>

If a subscription closes unexpectedly without an error, report `CriticalWorkerStopped`. A typed subscription error remains the application failure. A failed subscription must either stop the bot or trigger a restart with a limit on attempts. Effect does not replay failed event handlers

</details>

## Replace application services in a deterministic test

This test supplies fake database and reply services to the unchanged handler. `TestClock` advances only the application-owned `Effect.sleep` in `handlePing`

```ts
// bot.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { Message } from "@neontechspace/fluxerly/effect";
import { BotReplies, GreetingStore, handlePing } from "./bot.ts";

export function testPing(message: Message, replies: Array<string>) {
    const fakes = Layer.mergeAll(
        Layer.succeed(GreetingStore, {
            greetingFor: (userId) => Effect.succeed(`Hello ${userId}`),
        }),
        Layer.succeed(BotReplies, {
            reply: (_message, content) =>
                Effect.sync(() => replies.push(content)),
        }),
    );

    return Effect.gen(function* () {
        const fiber = yield* handlePing(message).pipe(
            Effect.provide(fakes),
            Effect.forkChild,
        );
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()));
}

test("!ping replies with the stored greeting", async () => {
    const replies: Array<string> = [];
    const message = {
        content: "!ping",
        author: { id: "42", isBot: false },
    } as unknown as Message;

    await Effect.runPromise(testPing(message, replies));
    assert.deepEqual(replies, ["Hello 42"]);
});
```

Save it as `bot.test.ts` beside `bot.ts` and run `node --test --test-timeout=10000 --test-force-exit`. The test runs the Effect and checks the result, so a missing reply fails

The test does not open a gateway or replace SDK internals. It replaces the application services used by the handler

## Test a runBot bot against an in-memory Fluxer

To check the requests a bot really sends, pass its native `runBot` options to `createTestBot` from `@neontechspace/fluxerly/effect/testing`. It creates a real native client connected to an in-memory Fluxer, owned by the test's Scope, and registers the bot's events, commands and setup as `runBot` would. The unset token falls back to a test token. For a bot file that exports its options with `defineBot`, such as the one `fluxerly init --template effect` writes, pass the imported `bot`

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { createTestBot } from "@neontechspace/fluxerly/effect/testing"

export const pingTest = Effect.scoped(
    Effect.gen(function* () {
        const bot = yield* createTestBot({
            token: process.env.FLUXER_BOT_TOKEN,
            events: {
                messageCreate: ({ message, reply }) =>
                    message.content !== "!ping" ? Effect.void : reply("Pong!"),
            },
        })
        yield* bot.ready()

        const replies = yield* bot.say("!ping")
        const ignored = yield* bot.say("hello")
        return { replies: replies.map((message) => message.content), ignored: ignored.length }
    }),
)

test("!ping replies Pong! and other messages get no reply", async () => {
    assert.deepEqual(await Effect.runPromise(pingTest), { replies: ["Pong!"], ignored: 0 })
})
```

The `say` Effect delivers a message from a fake user as Fluxer would send it, waits until the bot has stopped working and returns the messages the bot sent meanwhile. The fake Fluxer API answers each message the bot sends with that message, so no response needs registering. The list shows what the bot tried to send, even when `rest.respond` rejected the request, and a failure that an `onError` hook handled does not appear in `failures()`

For other events, `emit` delivers a gateway event, `idle()` waits until the bot has stopped working, and `rest.respond` controls how the fake Fluxer API answers a request. These waits have no deadline unless `timeoutMs` is passed, so run tests with `node --test --test-timeout=10000 --test-force-exit` to fail a bot that never settles

The test gateway enforces the Identify session's `gateway.ignoredEvents`: The `emit` Effect dies with `ConfigurationError` when Fluxer would suppress that dispatch, without consuming a sequence number. With automatic filtering, register handlers before running `ready()` so Identify sees them. Resume keeps the list, while a new Identify recomputes it. Suppressed message mentions and generated reaction batches follow Fluxer's exceptions, described in [Match gateway event filtering](/docs/testing/#match-gateway-event-filtering)

The `failures()` method returns handler and command failures that no `onError` hook received, including a failed SDK call such as a rejected reply, whatever the logging level

Closing the Scope dies with `UnhandledTestFailuresError` when such a failure happened and the test did not read it from `failures()`, so a broken handler fails the test. For code that registers handlers with `client.on`, `createTestClient` creates the same test client without bot options. See [Test a bot without Fluxer](/docs/testing/) and the [Effect testing reference](/docs/api/effect-testing/)

<details>
<summary>Control SDK time with TestClock</summary>

A native client captures the provided Effect `Clock` when `createClient` runs. Create the client inside the same provided Clock and Scope context when a test needs logical SDK time. `TestClock` can then advance event waits, message and reaction collectors, member-chunk timeouts, native command cooldowns, queued REST admission and deadlines, cache expiry, and presence or member-subscription pacing without real waiting

`TestClock` does not control protocol timestamps such as an HTTP-date `Retry-After`, external I/O including WebSockets, or process shutdown watchdogs. Those cases still need controlled transport responses or tests using real time

Fake timers from a test runner, such as Vitest's `vi.useFakeTimers()`, work differently from `TestClock`. A `timeoutMs` on `next()`, `idle()` or `say` uses real timers, so faking the global timers does not change it. The SDK runs its work on `setImmediate`, so fake timers must leave `setImmediate` real, as in `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })`. When `setImmediate` is faked, no handler can run, and `idle()` dies with `ConfigurationError` instead of settling

</details>

## Test a conversation that waits for a reply

A command that asks a question and waits for the answer, such as the collector in [Collect replies and clean up](/docs/effect-workflows/#collect-replies-and-clean-up), keeps `say` waiting, because `say` waits for the command to finish and the command waits for the answer. Register a route for the question, deliver the first message with `emit`, and wait for the question with the route's `next()`. Then `say` can send the answer

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { createTestBot } from "@neontechspace/fluxerly/effect/testing"

export const conversationTest = Effect.scoped(
    Effect.gen(function* () {
        const bot = yield* createTestBot({
            token: process.env.FLUXER_BOT_TOKEN,
            commands: {
                prefix: "!",
                commands: {
                    name: {
                        execute: ({ client, message, reply }) =>
                            Effect.scoped(
                                Effect.gen(function* () {
                                    const collector = yield* client.messages.collect(message.channelId, {
                                        filter: (answer) => answer.author.id === message.author.id,
                                        maxMessages: 1,
                                        timeoutMs: 30_000,
                                    })
                                    yield* reply("What name should the bot use?")
                                    const answer = (yield* collector.result()).messages[0]
                                    return yield* reply(answer ? `Hello, ${answer.content}!` : "No answer in time")
                                }),
                            ),
                    },
                },
            },
        })
        const questions = bot.rest.respond("POST /channels/:id/messages", (request) => ({
            body: bot.fixtures.message({
                author: bot.fixtures.botUser(),
                content: String((request.body as { content?: unknown }).content),
            }),
        }))
        yield* bot.ready()

        yield* bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content: "!name" }))
        const question = yield* questions.next()
        const replies = yield* bot.say("Ada")
        return {
            question: (question.body as { content?: unknown }).content,
            replies: replies.map((message) => message.content),
        }
    }),
)

test("!name asks for a name and greets the answer", async () => {
    assert.deepEqual(await Effect.runPromise(conversationTest), {
        question: "What name should the bot use?",
        replies: ["Hello, Ada!"],
    })
})
```

To test the timeout instead, create the bot under `TestClock`, as described in Control SDK time with TestClock above, advance it past `timeoutMs` after the question arrives, and call `idle()`. The default API's `say` returns early while a command waits on its manual clock, but a native client under `TestClock` has no such shortcut

## Provide the test client as the FluxerClient service

Code that reads its client from the `FluxerClient` service, like `repliesLayer` in the first section, runs against the in-memory Fluxer unchanged. `FluxerTestClient.layer()` from `@neontechspace/fluxerly/effect/testing` creates a test client and provides its client as `FluxerClient`. The same Layer provides the whole test client as `FluxerTestClient`, whose controls drive the test

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { FluxerClient } from "@neontechspace/fluxerly/effect"
import { FluxerTestClient } from "@neontechspace/fluxerly/effect/testing"

const registerPing = Effect.gen(function* () {
    const client = yield* FluxerClient
    yield* client.on("messageCreate", (message) =>
        message.content === "!ping" ? client.messages.reply(message, "Pong!") : Effect.void,
    )
})

export const serviceTest = Effect.gen(function* () {
    yield* registerPing
    const testClient = yield* FluxerTestClient
    const replies = testClient.rest.respond("POST /channels/:id/messages", {
        body: testClient.fixtures.message({ content: "Pong!" }),
    })
    yield* testClient.ready()
    yield* testClient.emit("MESSAGE_CREATE", testClient.fixtures.message({ content: "!ping" }))
    return yield* replies.next()
}).pipe(Effect.scoped, Effect.provide(FluxerTestClient.layer()))

test("registerPing sends the reply", async () => {
    const request = await Effect.runPromise(serviceTest)
    assert.equal((request.body as { content?: unknown }).content, "Pong!")
})
```

The `FluxerTestClient.layer(options)` method accepts the options of `createTestClient` except `messageFields`, because `FluxerClient` holds full messages. Closing the Layer's scope shuts the client down, as the live Layer does, and dies with `UnhandledTestFailuresError` for a handler failure the test did not read from `failures()`
