---
title: Raw requests and raw events
navTitle: Raw requests and events
description: Call a Fluxer route that has no method, and read a gateway event that has no typed event
---

Most bots never need this page. When a Fluxer route has no Fluxerly method, or a gateway event has no typed event, the SDK still gives a way in. The [endpoint map](/docs/api/endpoints/) lists the routes that Fluxerly methods call, the other routes that accept the bot's token, and a few noted exceptions, with why the routes without a method rarely matter. It leaves out routes that need no token, such as sign-in, but `client.rest.request` can still send them

## Call a route without a method

A Fluxer route that has no Fluxerly method can still be called. The `client.rest.call` method sends it with the bot's token, and the compiler checks it against Fluxer's API description, with Fluxer's own field names. This one reads a channel's latest messages:

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function latestContents(client: Client, channelId: string) {
    const result = await client.rest.call("GET /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        query: { limit: 10 },
    })
    return result.map((response) => response.body.map((message) => message.content))
}
```

The route is written as Fluxer's documentation writes it. The `params` field fills its path template, `query` holds the query and `body` the JSON body, and the response body has the route's type, so a misspelled field, a missing required field or an unlisted route fails to compile. An array sends a repeated parameter, so `query: { tag: ["101", "102"] }` sends `tag=101&tag=102`, and the message routes also take `files`

The types come from Fluxer's OpenAPI document at the commit this release pins, with a few reviewed corrections that cite Fluxer's source. [`RestRoutes`](/docs/api/js-ts/rest-routes/) links each route to its section of Fluxer's documentation. Nothing checks Fluxer's answer at runtime, so check a response field before relying on it

### Routes newer than the SDK

The `client.rest.request` method takes any path and body, for a route or field newer than the pinned description, or a route that needs no token. This one reads another application's public name, from a route that needs no token:

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function applicationName(client: Client, applicationId: string) {
    const result = await client.rest.request<{ name?: unknown }>({
        method: "GET",
        path: `/oauth2/applications/${applicationId}/public`,
    })
    return result.map((response) => (typeof response.body.name === "string" ? response.body.name : undefined))
}
```

The path is the part after `/v1`, with the query in `query`. The type argument only names the expected body, so check each field before relying on it

### What both methods share

Both use the queue, rate limits, deadline and logging of the named methods. Logs name only the route, never the query, body or answer, unless `logging.unsafe` prints masked bodies for the `rest` category while debugging. A non-2xx answer fails the Result with `RestRequestError`, whose `status` and `apiError` say what Fluxer answered, and invalid input, such as a missing path parameter, fails with reason `input` before anything is sent. Neither method reads nor updates the caches

## Read an event without a type

Every gateway event also arrives as the `raw` event, in the form Fluxer sent it. Types listed in `gateway.ignoredEvents` do not arrive, apart from the mention and reaction batch exceptions that `gateway.ignoredEvents` describes. When `documented` is true, Fluxer's documentation describes the event's type, and comparing `t` with that type gives `d` its documented fields under Fluxer's own names, so a misspelled field fails to compile. This one notices when the bot's own membership of a thread changes:

```ts
import type { Client } from "@neontechspace/fluxerly"

export function watchOwnThreadMembership(client: Client) {
    return client.on("raw", (dispatch) => {
        if (!dispatch.documented || dispatch.t !== "THREAD_MEMBER_UPDATE") return
        console.log(`The bot's membership of thread ${dispatch.d.id} in guild ${dispatch.d.guild_id} changed`)
    })
}
```

The types come from Fluxer's gateway and HTTP API documentation at the Fluxer commit the SDK was reviewed against. They check nothing at runtime: `d` is still the body Fluxer sent, which can lack a documented field or carry a newer one, so check a field before relying on it. A type that documentation does not describe, such as one Fluxer added later, still arrives, with `documented: false` and an unknown `d` to validate. `GatewayDispatchPayloads` names the payload of each documented type, and `GatewayPayloadObjects` the objects inside them, keyed by the address of their documentation, such as `GatewayPayloadObjects["/http-api/messages/#message-object"]`

A `raw` handler turns off [`ignoredEvents: "auto"`](/docs/configuration/#events-and-the-gateway), so the bot also receives the event types that setting would skip. With `ignoredEvents: "auto"`, register the `raw` handler before `client.connect`. Automatic filtering is decided when Identify starts a new session. Adding a `raw` handler later does not change that session's filtering, and Resume keeps the existing list

## Read a refused voice join

The `raw` event receives only opcode 0 dispatches. Fluxer sends an opcode 12 Gateway Error frame when it refuses a voice join the session asked for, and that frame arrives as the `gatewayError` event, with Fluxer's `code` and `message` in `d`:

```ts
import type { Client } from "@neontechspace/fluxerly"

export function reportRefusedVoiceJoins(client: Client) {
    return client.on("gatewayError", (frame) => {
        console.log(`Shard ${frame.shardId} could not join voice: ${frame.d.code}`)
    })
}
```

At the reviewed Fluxer commit the codes are `VOICE_P2P_CONSENT_REQUIRED`, `VOICE_P2P_UNAVAILABLE` and `VOICE_CHANNEL_FULL`, and other refused joins send no frame. The connection stays open. The frame has no sequence number, so Resume does not replay it and a frame sent while the shard is disconnected is lost. `gateway.ignoredEvents` never suppresses it. Without a `gatewayError` subscription, the SDK logs each frame at Warn with the code `gateway.gatewayError`. In a test, `test.emitGatewayError({ code, message })` delivers one to the bot

## Send a gateway command without a method

The `client.gateway.send` method sends an outgoing gateway command that has no method. [Core concepts](/docs/core-concepts/#gateway-and-rest) explains how it shares pacing with the SDK's own commands. When Fluxer refuses a Voice State Update sent this way, the answer is a [Gateway Error frame](/docs/raw-requests-and-events/#read-a-refused-voice-join)

The Effect API has the same `client.rest.call` and `client.rest.request` methods and `raw` and `gatewayError` events
