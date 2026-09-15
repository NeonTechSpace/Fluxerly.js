---
title: Send webhook messages and authorize users
navTitle: Webhooks & OAuth
description: Send through configured webhooks and use a confidential OAuth code grant with PKCE
---

Use a bot token for guild resources and gateway events. Use a webhook's token to send and manage messages for that webhook. Use OAuth when an application needs a user's consent to access their account data

## Send through a configured webhook

Store the webhook ID and token in application configuration. Pass them to a helper as explicit credentials, then keep the client only for the work it owns

```ts
import { createWebhookClient, type WebhookClientOptions } from "@neontechspace/fluxerly"

export async function sendWebhookMessage(
    credentials: WebhookClientOptions,
    content: string,
) {
    const created = createWebhookClient(credentials)
    if (created.isErr()) return created

    const webhook = created.value
    try {
        return await webhook.send({ content })
    } finally {
        await webhook.shutdown()
    }
}
```

Client creation validates and copies the credentials locally. A successful `send` returns the created message after Fluxer's HTTP response. An `Err` with a `WebhookOperationError` whose `outcome` is `unknown` can follow dispatch, so the application must reconcile the intended message before making another send attempt

The helper closes a short-lived client in `finally`. For recurring delivery, create one client per credential in the component that owns that work, reuse it for its sends, and await `shutdown()` when the component stops. Shutdown releases the SDK's credential reference and active request resources. The configured credential and remote webhook remain under application and Fluxer ownership

Use a scope for the same lifecycle in an Effect application. `Effect.scoped` runs the client's finalizer after success, failure, or interruption

```ts
import { Effect } from "effect"
import { createWebhookClient } from "@neontechspace/fluxerly/effect"

export function sendWebhookMessageWithEffect(id: string, token: string, content: string) {
    return Effect.scoped(
        Effect.gen(function* () {
            const webhook = yield* createWebhookClient({ id, token })
            return yield* webhook.send({ content })
        }),
    )
}
```

Keep this helper inside the application runtime shown in [the Effect bot guide](/docs/{{version}}/effect-first-bot/). The scope owns this token-only client and leaves any separately scoped bot client with its existing owner

## Create a user-consent URL

OAuth uses a server-held application secret, an exact registered redirect URI, an unpredictable application-generated state value, and a fresh PKCE pair. Before sending the user to the returned URL, retain the state and the PKCE verifier in a server-owned, one-use callback record. Keep the verifier and application secret out of the URL, browser code, and logs

```ts
import { oauth, OAuthScopes, type OAuthConfig } from "@neontechspace/fluxerly"

export async function prepareOAuthAuthorization(
    config: OAuthConfig,
    redirectUri: string,
    state: string,
) {
    const created = oauth.create(config)
    if (created.isErr()) return created

    const client = created.value
    try {
        const pkce = oauth.createPkce()
        const authorization = await client.authorizationUrl({
            redirectUri,
            scopes: [OAuthScopes.Identify],
            state,
            codeChallenge: pkce.challenge,
        })

        return authorization.map(url => ({ url, codeVerifier: pkce.verifier }))
    } finally {
        await client.shutdown()
    }
}
```

The caller sends the returned URL to the selected browser and retains the returned verifier with the matching state. Use the public `OAuthScopes` constants for the consent request. Adding `OAuthScopes.Bot` asks for bot installation through the consent flow. Provider consent and target selection remain external to URL construction, and guild, channel, and permission values are only installation hints

## Validate the callback before exchanging its code

The callback handler must compare the returned state with the unused callback record before calling the exchange helper. On a match, consume the state record, pass the callback code, and use the original verifier and exact redirect URI from that record

```ts
import { oauth, type OAuthConfig } from "@neontechspace/fluxerly"

export async function exchangeValidatedOAuthCode(
    config: OAuthConfig,
    redirectUri: string,
    code: string,
    codeVerifier: string,
) {
    const created = oauth.create(config)
    if (created.isErr()) return created

    const client = created.value
    try {
        return await client.exchangeCode({
            code,
            redirectUri,
            codeVerifier,
        })
    } finally {
        await client.shutdown()
    }
}
```

Store a successful token pair in the application's protected token store. The granted scopes can differ from the requested scopes. Coordinate refreshes and replace the stored token pair together because a successful refresh can rotate the refresh token

An exchange code is one use. A timeout, cancellation, or lost response after dispatch can leave an unknown outcome because Fluxer may have consumed the code. Begin a new consent flow instead of replaying that exchange

The default API returns expected webhook and OAuth failures in `Result` values. Keep the `Err` result at the caller's error boundary, record only safe error metadata, and use the [reliability guide](/docs/{{version}}/reliability/) for cancellation and uncertain-write handling. Operation details are available in the [webhook client reference](/docs/{{version}}/api/interfaces/js-ts.WebhookClient/) and [OAuth client reference](/docs/{{version}}/api/interfaces/js-ts.OAuthClient/)
