import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"

const kind = process.argv[2]
assert.ok(kind === "default" || kind === "effect")
const adjacentCases = new URL("./standalone-conformance-reference-cases.json", import.meta.url)
const cases = JSON.parse(
    readFileSync(
        existsSync(adjacentCases)
            ? adjacentCases
            : new URL("../standalone-conformance-reference-cases.json", import.meta.url),
        "utf8",
    ),
)

function discoveryResponse() {
    return Response.json({
        api_code_version: 1,
        endpoints: {
            api_public: cases.discovery.api,
            gateway: cases.discovery.gateway,
            media: cases.discovery.media,
            static_cdn: cases.discovery.staticCdn,
            webapp: cases.discovery.webapp,
            invite: cases.discovery.invite,
        },
        features: { presigned_attachment_uploads: true },
    })
}

function requestUrl(input) {
    return new URL(typeof input === "string" || input instanceof URL ? input : input.url)
}

async function defaultResult(value) {
    const result = await value
    if (result.isErr()) throw result.error
    return result.value
}

async function defaultFailure(value) {
    const result = await value
    if (result.isOk()) throw new Error("Expected the packed reference operation to fail")
    return result.error
}

let runtime
if (kind === "default") {
    const { createClient, createWebhookClient, oauth } = await import("@neontechspace/fluxerly")
    runtime = {
        oauth() {
            const client = oauth
                .create({ clientId: cases.oauth.clientId, clientSecret: cases.oauth.clientSecret })
                ._unsafeUnwrap()
            return {
                exchangeCode: () => defaultResult(client.exchangeCode(cases.oauth.exchange)),
                fetchIdentity: () => defaultResult(client.fetchIdentity(cases.oauth.accessToken)),
                rejectInvalidToken: () => defaultFailure(client.introspect(cases.oauth.invalidOpaqueToken)),
                close: () => defaultResult(client.shutdown()),
            }
        },
        webhook() {
            const client = createWebhookClient({ id: cases.webhook.id, token: cases.webhook.token })._unsafeUnwrap()
            return {
                send: () => defaultResult(client.send(cases.webhook.sendInput)),
                sendFailure: () => defaultFailure(client.send(cases.webhook.sendInput)),
                close: () => defaultResult(client.shutdown()),
            }
        },
        client() {
            const client = createClient({ token: cases.clientLifecycle.token })._unsafeUnwrap()
            return {
                fetchUserFailure: (id) => defaultFailure(client.users.fetch(id)),
                connectFailure: () => defaultFailure(client.connect()),
                shutdown: () => defaultResult(client.shutdown()),
                waitForClose: () => defaultResult(client.waitForClose()),
                state: () => client.state,
                dispose: () => defaultResult(client.shutdown()),
            }
        },
    }
} else {
    const { Effect, Exit, Scope } = await import("effect")
    const { createClient, createWebhookClient, oauth } = await import("@neontechspace/fluxerly/effect")
    runtime = {
        async oauth() {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(
                oauth
                    .create({ clientId: cases.oauth.clientId, clientSecret: cases.oauth.clientSecret })
                    .pipe(Scope.provide(scope)),
            )
            return {
                exchangeCode: () => Effect.runPromise(client.exchangeCode(cases.oauth.exchange)),
                fetchIdentity: () => Effect.runPromise(client.fetchIdentity(cases.oauth.accessToken)),
                rejectInvalidToken: () =>
                    Effect.runPromise(Effect.flip(client.introspect(cases.oauth.invalidOpaqueToken))),
                close: async () => {
                    await Effect.runPromise(client.shutdown())
                    await Effect.runPromise(Scope.close(scope, Exit.void))
                },
            }
        },
        async webhook() {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(
                createWebhookClient({ id: cases.webhook.id, token: cases.webhook.token }).pipe(Scope.provide(scope)),
            )
            return {
                send: () => Effect.runPromise(client.send(cases.webhook.sendInput)),
                sendFailure: () => Effect.runPromise(Effect.flip(client.send(cases.webhook.sendInput))),
                close: async () => {
                    await Effect.runPromise(client.shutdown())
                    await Effect.runPromise(Scope.close(scope, Exit.void))
                },
            }
        },
        async client() {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(
                createClient({ token: cases.clientLifecycle.token }).pipe(Scope.provide(scope)),
            )
            return {
                fetchUserFailure: (id) => Effect.runPromise(Effect.flip(client.users.fetch(id))),
                connectFailure: () => Effect.runPromise(Effect.flip(client.connect())),
                shutdown: () => Effect.runPromise(client.shutdown()),
                waitForClose: () => Effect.runPromise(client.waitForClose()),
                state: () => client.state,
                dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
            }
        },
    }
}

{
    const requests = []
    let fetchCalls = 0
    globalThis.fetch = async (input, init = {}) => {
        fetchCalls += 1
        const url = requestUrl(input)
        if (url.href === cases.discovery.url) return discoveryResponse()
        requests.push({ url, init })
        if (url.pathname === cases.oauth.tokenRequest.path) return Response.json(cases.oauth.tokenResponse)
        if (url.pathname === cases.oauth.identityRequest.path) return Response.json(cases.oauth.identityResponse)
        throw new Error(`Unexpected OAuth packed reference request: ${url.pathname}`)
    }
    const client = await runtime.oauth()
    assert.equal(fetchCalls, 0)
    assert.equal(requests.length, 0)
    try {
        const invalid = await client.rejectInvalidToken()
        assert.deepEqual(
            { tag: invalid._tag, reason: invalid.reason, outcome: invalid.outcome },
            { tag: "OAuthOperationError", reason: "input", outcome: "notDispatched" },
        )
        assert.equal(fetchCalls, 0)
        assert.equal(requests.length, 0)
        const tokens = await client.exchangeCode()
        assert.equal(tokens.accessToken, cases.oauth.tokenResponse.access_token)
        assert.equal(tokens.refreshToken, cases.oauth.tokenResponse.refresh_token)
        assert.deepEqual(tokens.scopes, ["identify"])
        const identity = await client.fetchIdentity()
        assert.deepEqual(
            { id: identity.id, globalName: identity.globalName, avatar: identity.avatar },
            { id: cases.oauth.identityResponse.id, globalName: null, avatar: null },
        )
    } finally {
        await client.close()
    }

    assert.equal(requests.length, 2)
    const tokenRequest = requests[0]
    const tokenHeaders = new Headers(tokenRequest.init.headers)
    assert.deepEqual(
        {
            method: tokenRequest.init.method,
            path: tokenRequest.url.pathname,
            contentType: tokenHeaders.get("content-type"),
            authorizationScheme: tokenHeaders.get("authorization")?.split(" ", 1)[0],
            body: Object.fromEntries(new URLSearchParams(String(tokenRequest.init.body))),
        },
        cases.oauth.tokenRequest,
    )
    assert.equal(
        tokenHeaders.get("authorization"),
        `Basic ${Buffer.from(`${cases.oauth.clientId}:${cases.oauth.clientSecret}`).toString("base64")}`,
    )
    const identityRequest = requests[1]
    assert.deepEqual(
        {
            method: identityRequest.init.method,
            path: identityRequest.url.pathname,
            authorization: new Headers(identityRequest.init.headers).get("authorization"),
        },
        cases.oauth.identityRequest,
    )
}

{
    const requests = []
    let fetchCalls = 0
    globalThis.fetch = async (input, init = {}) => {
        fetchCalls += 1
        const url = requestUrl(input)
        if (url.href === cases.discovery.url) return discoveryResponse()
        requests.push({ url, init })
        if (requests.length === 1) return Response.json(cases.webhook.messageResponse)
        return Response.json(
            { code: cases.webhook.rejection.providerCode, message: cases.webhook.rejection.privateMessage },
            { status: cases.webhook.rejection.status },
        )
    }
    const client = await runtime.webhook()
    assert.equal(fetchCalls, 0)
    assert.equal(requests.length, 0)
    try {
        const message = await client.send()
        assert.deepEqual(
            {
                id: message.id,
                content: message.content,
                embeds: message.embeds,
                attachments: message.attachments,
                stickers: message.stickers,
            },
            { id: cases.webhook.messageResponse.id, content: "", embeds: [], attachments: [], stickers: [] },
        )
        const rejected = await client.sendFailure()
        assert.deepEqual(
            {
                tag: rejected._tag,
                status: rejected.status,
                reason: rejected.reason,
                outcome: rejected.outcome,
                apiCode: rejected.apiError?.code,
            },
            {
                tag: "WebhookOperationError",
                status: cases.webhook.rejection.status,
                reason: cases.webhook.rejection.reason,
                outcome: cases.webhook.rejection.outcome,
                apiCode: cases.webhook.rejection.apiCode,
            },
        )
        assert.doesNotMatch(JSON.stringify(rejected), new RegExp(cases.webhook.rejection.privateMessage))
    } finally {
        await client.close()
    }

    assert.equal(requests.length, 2)
    for (const { url, init } of requests)
        assert.deepEqual(
            {
                method: init.method,
                path: url.pathname,
                query: url.search,
                authorization: new Headers(init.headers).get("authorization"),
                body: JSON.parse(String(init.body)),
            },
            cases.webhook.request,
        )
}

{
    let releaseCleanup
    const cleanup = new Promise((resolve) => (releaseCleanup = resolve))
    let markStarted
    const started = new Promise((resolve) => (markStarted = resolve))
    let markAborted
    const aborted = new Promise((resolve) => (markAborted = resolve))
    let fetchCalls = 0
    let operationDispatches = 0
    globalThis.fetch = async (input, init = {}) => {
        fetchCalls += 1
        const url = requestUrl(input)
        if (url.href === cases.discovery.url) return discoveryResponse()
        operationDispatches += 1
        markStarted()
        await new Promise((resolve) => {
            if (init.signal?.aborted) resolve()
            else init.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        markAborted()
        await cleanup
        throw init.signal?.reason ?? new Error("Packed reference request was aborted")
    }
    const client = await runtime.client()
    assert.equal(fetchCalls, 0)
    assert.equal(operationDispatches, 0)
    try {
        const active = client.fetchUserFailure(cases.clientLifecycle.activeUserId)
        await started
        let completedShutdowns = 0
        const shutdowns = [client.shutdown(), client.shutdown()].map((shutdown) =>
            shutdown.then(() => {
                completedShutdowns += 1
            }),
        )
        await aborted
        await Promise.resolve()
        assert.equal(completedShutdowns, 0)
        releaseCleanup()
        await Promise.all(shutdowns)
        assert.equal((await active)._tag, "ClientClosedError")
        assert.equal(client.state(), "Closed")
        await client.waitForClose()

        const fetchesBeforeClosedCalls = fetchCalls
        assert.equal((await client.fetchUserFailure(cases.clientLifecycle.closedUserId))._tag, "ClientClosedError")
        assert.equal((await client.connectFailure())._tag, "ClientClosedError")
        assert.equal(fetchCalls, fetchesBeforeClosedCalls)
    } finally {
        releaseCleanup()
        await client.dispose()
    }
}

console.log(`Packed ${kind} standalone conformance reference passed`)
