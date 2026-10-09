---
title: Send webhook messages and authorize users
navTitle: Webhooks & OAuth
description: Send messages through a webhook, including into threads and forum channels, and use the OAuth code grant with PKCE to get a user's consent
---

Fluxerly works with three kinds of credentials. A bot token runs the bot: It reads community resources and receives gateway events. A [webhook](/docs/{{version}}/glossary/#webhook) token lets an application post and manage that webhook's messages in its channel, without a bot. [OAuth](/docs/{{version}}/glossary/#oauth) lets an application ask a user for consent to access their account data

## Send through a configured webhook

A token-authenticated webhook is an incoming webhook, identified by `WebhookType.Incoming`

Store the incoming webhook ID and token in application configuration, like the bot token. Pass both to the helper, which creates a webhook client, sends one message and closes the client again

```ts
import { createWebhookClient, type WebhookClientOptions } from "@neontechspace/fluxerly"

export async function sendWebhookMessage(
    credentials: WebhookClientOptions,
    content: string,
) {
    await using webhook = createWebhookClient(credentials)
    return await webhook.send(content)
}
```

The `send` method takes a plain string for a text-only message, or an object with other fields such as `embeds`, and `editMessage` accepts the same forms to change a sent message. The send returns a [Result](/docs/{{version}}/glossary/#result) that holds the message Fluxer created on success. Mentions in webhook messages do not notify anyone unless `allowedMentions` allows them. The `await using` declaration shuts the client down when the helper returns or throws. For repeated sends, create one client per webhook, reuse it and shut it down when sending stops, as the [last section](/docs/{{version}}/webhooks-and-oauth/#wire-it-up) shows

<details>
<summary>Follower webhooks and unknown kinds</summary>

A follower webhook has `WebhookType.ChannelFollower` and delivers [published announcements](/docs/{{version}}/announcement-channels/). It has no token, so `createWebhookClient` cannot use it. Bot clients can rename, move or delete it but cannot change its avatar. Handle `type: "unknown"` when reading a webhook kind this SDK version does not know

</details>

<details>
<summary>Failures, retries and credentials</summary>

Creating the client checks and copies the credentials locally without a request, and throws `ConfigurationError` if they are malformed. If a send fails with a `WebhookOperationError` whose `outcome` is `"unknown"`, Fluxer may already have posted the message, so check for it before sending again. The [reliability guide](/docs/{{version}}/reliability/) explains these uncertain writes.
A send, reply or forward can supply `nonce` for best-effort duplicate suppression through the same webhook for five minutes. Use an application operation ID, not a new value for each attempt. Nonces do not guarantee exactly-once delivery, and omission sends no nonce. A forward can instead supply its nonce in `messageReference.source`, but supplying both locations fails before any request.
Webhook messages do not accept `tts`, and a send with it fails with reason `input` before any request.
A rejected webhook token also logs one `rest.rejected` Warn record, even when the application handles the Result. The client prints Info and above to the console, and its `logging` option takes the same settings as a bot client's [logging](/docs/{{version}}/logging/)

Shutdown releases the SDK's copy of the credentials and ends its active requests. It does not delete the webhook on Fluxer, and the application must still protect its stored credentials

</details>

In an [Effect](/docs/{{version}}/glossary/#effect) application, a scope gives the webhook client the same lifetime. `Effect.scoped` shuts it down after success, failure or interruption

```ts
import { Effect } from "effect"
import { createWebhookClient } from "@neontechspace/fluxerly/effect"

export function sendWebhookMessageWithEffect(id: string, token: string, content: string) {
    return Effect.scoped(
        Effect.gen(function* () {
            const webhook = yield* createWebhookClient({ id, token })
            return yield* webhook.send(content)
        }),
    )
}
```

Keep this helper inside the application runtime shown in [the Effect bot guide](/docs/{{version}}/effect-first-bot/). The scope owns only this webhook client and leaves any bot client with its existing owner

## Post into threads and forum channels

A webhook posts into its own channel by default. To reach a [thread](/docs/{{version}}/threads/) of that channel, including a forum post, set `threadId` on the message. To start a new post in a forum or media channel instead, set `threadName`, and optionally `appliedTagIds`

```ts
import type { WebhookClient } from "@neontechspace/fluxerly"

export async function announceRelease(webhook: WebhookClient, version: string, tagIds: string[]) {
    // The result is the first message of the new post, and its channelId is the post's ID
    const first = await webhook.send({
        content: `Release ${version} is out`,
        threadName: `Release ${version}`,
        appliedTagIds: tagIds,
    })
    if (first.isErr()) return first
    return await webhook.send({ content: "Notes follow in this thread", threadId: first.value.channelId })
}
```

A webhook that belongs to a forum or media channel must use exactly one of `threadName` and `threadId` on every message, and Fluxer rejects a message with neither. A webhook in a text channel needs neither, and Fluxer rejects `threadName` there. The SDK checks the combinations that it can see before any request: `threadName` and `threadId` cannot be combined, `appliedTagIds` needs `threadName`, and a reply or forward cannot start a post, because the new post holds no earlier message. A post takes at most five tags. Fluxer rejects an unknown tag, a `moderated` tag (a webhook cannot manage threads) and a post without a tag in a channel that requires one

The `fetchMessage`, `editMessage` and `deleteMessage` methods look in the webhook's channel unless their options carry the `threadId` of the thread that holds the message

```ts
import type { WebhookClient } from "@neontechspace/fluxerly"

export async function reviseThreadNote(webhook: WebhookClient, messageId: string, threadId: string) {
    return await webhook.editMessage(messageId, "Notes moved to the wiki", { threadId })
}
```

Fluxer rejects a thread that belongs to another channel. Where threads are not active for the community, Fluxer can ignore `threadId` and post into the channel itself, which `threadsActive` on `guilds.fetchPage` reveals beforehand. The bot client's `rest.request` method refuses webhook token routes, so these options are the only way to reach a thread through a webhook

## Create a user-consent URL

OAuth sends a user to Fluxer to approve access, then back to the application's registered redirect URI with a one-use code. The application needs its client secret stored on the server, the exact registered redirect URI, an unpredictable `state` value that ties the callback to this request, and a fresh PKCE verifier and challenge, which prove that the same server finishes the exchange. Store the state and verifier together in a one-use server record before sending the user to the consent URL

```ts
import { oauth, OAuthScopes, type OAuthConfig } from "@neontechspace/fluxerly"

export async function prepareOAuthAuthorization(
    config: OAuthConfig,
    redirectUri: string,
    state: string,
) {
    await using client = oauth.create(config)
    const pkce = oauth.createPkce()
    const authorization = await client.authorizationUrl({
        redirectUri,
        scopes: [OAuthScopes.Identify],
        state,
        codeChallenge: pkce.challenge,
    })

    return authorization.map((url) => ({ url, codeVerifier: pkce.verifier }))
}
```

The web server redirects the user's browser to the returned URL and keeps the returned verifier with the matching state. Never put the verifier or client secret in the URL, browser code or logs. Request scopes with the `OAuthScopes` constants

<details>
<summary>Asking to add the bot through OAuth</summary>

Adding `OAuthScopes.Bot` to the scopes asks the user to add the bot through the consent flow. Fluxer's consent flow decides where the bot is added, and community, channel and permission values in the URL are only suggestions

</details>

## Validate the callback before exchanging its code

When Fluxer redirects the user back, the callback handler compares the returned state with the unused record from the previous step. Only on a match, consume that record and exchange the callback's code, using the original verifier and the exact redirect URI from the record

```ts
import { oauth, type OAuthConfig } from "@neontechspace/fluxerly"

export async function exchangeValidatedOAuthCode(
    config: OAuthConfig,
    redirectUri: string,
    code: string,
    codeVerifier: string,
) {
    await using client = oauth.create(config)
    return await client.exchangeCode({
        code,
        redirectUri,
        codeVerifier,
    })
}
```

A successful exchange returns a token pair. Store it in the application's protected token store. The granted scopes can differ from the requested ones

<details>
<summary>Refreshes and failed exchanges</summary>

Coordinate refreshes and replace the stored token pair as a whole, because a successful refresh can also replace the refresh token.
An exchange code works once. A timeout, cancellation or lost response after the request was sent can leave the outcome unknown, because Fluxer may have used the code. Start a new consent flow instead of repeating that exchange

</details>

A rejected client ID or secret also logs one `rest.rejected` Warn record, while a rejected user access token is only returned, because it concerns one user. The OAuth client accepts the same `logging` option as a bot client

The `fetchIdentity`, `fetchGuilds`, `fetchConnections` and `introspect` methods are reads. Their failures set `details.read`, so `errors.isRetryable` can identify a transient failure without implying that tokens changed. OAuth requests are never retried automatically. Exchange, refresh and revoke requests with an unknown outcome remain unsafe to repeat. Discovery and OAuth transport failures retain only sanitized causes, including a safe transport code such as `ECONNRESET` when available, not the original error text

The default API returns expected webhook and OAuth failures as `Result` values. Handle an `Err` where the helper is called, for example by logging `describeError(result.error)`, and never log the webhook token, client secret or verifier. Operation details are in the [webhook client reference](/docs/{{version}}/api/interfaces/js-ts.WebhookClient/) and the [OAuth client reference](/docs/{{version}}/api/interfaces/js-ts.OAuthClient/)

## Wire it up

A webhook client lives beside `runBot`, not inside it. Create it once before starting the bot, use it from commands or handlers, and let `await using` shut it down after the bot stops. This bot posts `!announce <text>` through the webhook for members who can manage webhooks

```ts
import { createWebhookClient, guards, runBot } from "@neontechspace/fluxerly"

const id = process.env.FLUXER_WEBHOOK_ID
const token = process.env.FLUXER_WEBHOOK_TOKEN
if (!id || !token) throw new Error("Set FLUXER_WEBHOOK_ID and FLUXER_WEBHOOK_TOKEN")
await using webhook = createWebhookClient({ id, token })

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    commands: {
        prefix: "!",
        commands: {
            announce: {
                description: "Post an announcement through the webhook",
                guard: guards.requirePermissions(["ManageWebhooks"]),
                arguments: { text: { type: "text", rest: true } },
                execute: async ({ values, reply, signal }) => {
                    const posted = await webhook.send(values.text, { signal })
                    return posted.isErr() ? posted : reply("Announcement posted")
                },
            },
        },
    },
})
```

OAuth does not belong in the bot runner. The consent redirect and the callback are web requests, so the OAuth helpers run in the application's web server, which can be a separate process from the bot. Create the OAuth client there, and pass anything the bot needs to know through the application's own storage
