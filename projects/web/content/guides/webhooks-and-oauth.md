---
title: Send webhook messages and authorize users
navTitle: Webhooks & OAuth
description: Send through configured webhooks and use a confidential OAuth code grant with PKCE
---

Use a bot token for guild resources and gateway events. Use a webhook's token to send and manage messages for that webhook. Use OAuth when an application needs a user's consent to access their account data

## Send through a configured webhook

Store the webhook ID and token in application configuration. Pass both to the helper, and keep the client open only while it sends through that webhook

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

Creating the client checks and copies the credentials locally. A successful `send` returns the message Fluxer created. If a `WebhookOperationError` has `outcome: "unknown"`, Fluxer may already have posted the message. Check for it before sending again

The helper closes its client in `finally`. For repeated sends, create one client for each webhook credential, reuse it and await `shutdown()` when sending stops. Shutdown releases the SDK's copy of the credentials and its active requests. The application must still protect its stored credentials. Shutdown does not delete the remote webhook

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

OAuth needs an application secret stored on the server, the exact registered redirect URI, an unpredictable state value and a fresh PKCE verifier and challenge. Store the state and verifier together in a one-use server record before sending the user to the consent URL. Do not put the verifier or application secret in the URL, browser code or logs

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

The default API returns expected webhook and OAuth failures in `Result` values. Handle an `Err` where the helper is called, record only safe error metadata, and use the [reliability guide](/docs/{{version}}/reliability/) for cancellation and uncertain-write handling. Operation details are available in the [webhook client reference](/docs/{{version}}/api/interfaces/js-ts.WebhookClient/) and [OAuth client reference](/docs/{{version}}/api/interfaces/js-ts.OAuthClient/)
