---
title: Compose and test an Effect application
navTitle: Effect application testing
description: Put the scoped client behind application services and replace those services in tests
---

The native SDK client already belongs to the caller's Effect scope. An application Layer can expose that client alongside application-owned services without adding an SDK-specific Layer constructor or hidden runtime

## Define application services and handlers

Keep handler logic behind small application services. The live reply service delegates to the scoped SDK client, while tests can replace it without editing `handlePing`

```ts
import { Context, Effect, Layer } from "effect";
import {
    createClient,
    type Client,
    type Message,
} from "@neontechspace/fluxerly/effect";

export class AppConfig extends Context.Service<
    AppConfig,
    { readonly token: string }
>()("example/AppConfig") {}

export class BotClient extends Context.Service<BotClient, Client>()(
    "example/BotClient",
) {}

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

export const clientLayer = Layer.effect(
    BotClient,
    AppConfig.use((config) => createClient({ token: config.token })),
);

export const repliesLayer = Layer.effect(
    BotReplies,
    BotClient.use((client) =>
        Effect.succeed({
            reply: (message: Message, content: string) =>
                client.messages.reply(message, { content }).pipe(Effect.asVoid),
        }),
    ),
);
```

`Layer.effect` uses the Layer's scope for `createClient`. Closing the application scope runs the client's registered finalizer once. `BotReplies` keeps SDK operations out of the database-facing handler contract, but does not hide another runtime or connection

## Assemble the live program

The worker Layer needs the client Layer, while the assembled graph also retains that client for its scoped lifetime. `Layer.provideMerge` retains both services, and Layer memoization shares one client within this graph

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
                                                    .reply(message, { content })
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

This block inlines the small handler so it can be copied independently. A real application can import the `handlePing` function from the previous section instead

Race `subscription.waitForClose()` with `client.run()` for every critical worker. Unexpected normal worker closure becomes `CriticalWorkerStopped`, while a typed subscription failure remains the application failure. `Effect.raceFirst` interrupts the other lifetime and the surrounding scope runs finalizers. A failed subscription must either fail the application or enter an explicit bounded restart policy. Effect does not replay failed event handlers

## Replace application services in a deterministic test

This test supplies fake database and reply services to the unchanged handler. `TestClock` advances only the application-owned `Effect.sleep` in `handlePing`

```ts
import { Context, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { Message } from "@neontechspace/fluxerly/effect";

class GreetingStore extends Context.Service<
    GreetingStore,
    { readonly greetingFor: (userId: string) => Effect.Effect<string> }
>()("example-test/GreetingStore") {}
class BotReplies extends Context.Service<
    BotReplies,
    {
        readonly reply: (
            message: Message,
            content: string,
        ) => Effect.Effect<void>;
    }
>()("example-test/BotReplies") {}

const handlePing = (message: Message) =>
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
```

The test does not open a gateway or replace SDK internals. It replaces the application boundary consumed by the handler. Provider protocol scenarios still need the repository's controlled gateway fixtures or a separately designed public transport seam

A native client captures the provided Effect `Clock` when `createClient` runs. Create the client inside the same provided Clock and Scope context when a test needs logical SDK time. `TestClock` can then advance event waits, message and reaction collectors, member-chunk timeouts, native command cooldowns, queued REST admission and deadlines, cache expiry, and presence or member-subscription pacing without real waiting

`TestClock` does not control protocol absolute wall timestamps such as an HTTP-date `Retry-After`, bounded external I/O, WebSocket behavior or process shutdown watchdogs. Those boundaries still need controlled transport fixtures or their existing host-time tests
