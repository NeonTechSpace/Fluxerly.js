import { once } from "node:events"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Exit, Scope } from "effect"
import type { Result, ResultAsync } from "neverthrow"
import { expect, test } from "vitest"
import WebSocket, { WebSocketServer } from "ws"
import { createClient, createWebhookClient } from "../src/index.js"
import { createClient as createNativeClient, createWebhookClient as createNativeWebhookClient } from "../src/effect.js"

const modes = ["default", "native"] as const
const botToken = "loopback_bot_token"
const webhookToken = "loopback_webhook_token"

type Mode = (typeof modes)[number]
type ResolvedEndpointMap = {
    readonly endpoints: {
        readonly apiPublic: string
        readonly gateway: string
        readonly media: string
        readonly staticCdn: string
        readonly webapp: string
        readonly invite: string
    }
}
type ScopedUrls = {
    readonly defaultAvatar: string
    readonly emoji: string
    readonly channel: string
    readonly installation: string
}
type LoopbackClient = {
    readonly resolve: () => Promise<ResolvedEndpointMap>
    readonly fetchSelf: () => Promise<{ readonly id: string; readonly isBot: boolean }>
    readonly connect: () => Promise<void>
    readonly scopedUrls: () => Promise<ScopedUrls>
    readonly resolveWebhook: () => Promise<ResolvedEndpointMap>
    readonly deleteWebhookMessage: () => Promise<void>
    readonly close: () => Promise<void>
}

type RequestRecord = {
    readonly method: string
    readonly path: string
    readonly authorization: string | undefined
    readonly cookie: string | undefined
}

function instanceDocument(origin: string) {
    return {
        api_code_version: 7,
        endpoints: {
            // The literal /v1 suffix catches accidental host-only normalization before the SDK adds its API route prefix
            api_public: `${origin}/v1`,
            gateway: origin.replace("http:", "ws:") + "/gateway",
            media: `${origin}/media`,
            static_cdn: `${origin}/static`,
            webapp: `${origin}/web`,
            invite: `${origin}/invites`,
        },
        features: { presigned_attachment_uploads: false },
    }
}

function userResponse() {
    return {
        id: "10",
        username: "loopback",
        discriminator: "0001",
        global_name: null,
        avatar: null,
        avatar_color: null,
        flags: 0,
        bot: true,
    }
}

function json(response: ServerResponse, value: unknown): void {
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(value))
}

async function readBody(request: IncomingMessage): Promise<void> {
    for await (const _chunk of request) {
        // Consume every fixture request before the response ends so teardown can prove no reader remains
    }
}

async function waitFor(matches: () => boolean, deadlineMessage: string): Promise<void> {
    const deadline = performance.now() + 5_000
    while (!matches()) {
        if (performance.now() >= deadline) throw Error(deadlineMessage)
        await sleep(10)
    }
}

async function loopbackFixture() {
    const requests: RequestRecord[] = []
    const unexpectedRoutes: string[] = []
    const blockedFetches: string[] = []
    const gatewayRequests: string[] = []
    const gatewayCommands: unknown[] = []
    const gatewaySockets: WebSocket[] = []
    const activeResponses = new Set<ServerResponse>()
    const serverSockets = new Set<import("node:net").Socket>()
    const nativeFetch = globalThis.fetch
    let origin = ""
    let closed = false
    const server = createServer(async (request, response) => {
        activeResponses.add(response)
        response.once("finish", () => activeResponses.delete(response))
        const target = new URL(request.url ?? "/", origin)
        requests.push({
            method: request.method ?? "",
            path: `${target.pathname}${target.search}`,
            authorization: request.headers.authorization,
            cookie: request.headers.cookie,
        })
        await readBody(request)
        if (target.pathname === "/.well-known/fluxer") {
            expect(request.headers.authorization).toBeUndefined()
            expect(request.headers.cookie).toBeUndefined()
            json(response, instanceDocument(origin))
            return
        }
        if (target.pathname === "/v1/v1/users/@me" && request.method === "GET") {
            expect(request.headers.authorization).toBe(`Bot ${botToken}`)
            expect(request.headers.cookie).toBeUndefined()
            json(response, userResponse())
            return
        }
        if (
            target.pathname === "/v1/v1/webhooks/50/loopback_webhook_token/messages/20" &&
            request.method === "DELETE"
        ) {
            expect(request.headers.authorization).toBeUndefined()
            expect(request.headers.cookie).toBeUndefined()
            response.statusCode = 204
            response.end()
            return
        }
        unexpectedRoutes.push(`${request.method} ${target.pathname}${target.search}`)
        response.statusCode = 404
        response.end()
    })
    server.on("connection", (socket) => {
        serverSockets.add(socket)
        socket.once("close", () => serverSockets.delete(socket))
    })
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket, request) => {
        gatewaySockets.push(socket)
        gatewayRequests.push(request.url ?? "")
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const command = JSON.parse(data.toString())
            gatewayCommands.push(command)
            if (command.op === 2) {
                expect(command.d.token).toBe(botToken)
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "loopback" } }))
            }
            if (command.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Expected an owned loopback address")
    origin = `http://127.0.0.1:${address.port}`
    globalThis.fetch = ((input, init) => {
        const target = new URL(input instanceof Request ? input.url : input.toString())
        if (target.origin !== origin) {
            blockedFetches.push(target.href)
            throw Error("Unexpected non-loopback fixture fetch")
        }
        return nativeFetch(input, init)
    }) as typeof globalThis.fetch

    return {
        origin,
        requests,
        unexpectedRoutes,
        blockedFetches,
        gatewayRequests,
        gatewayCommands,
        async waitForGatewayClose() {
            await waitFor(
                () => gatewaySockets.every((socket) => socket.readyState === WebSocket.CLOSED),
                "Client-owned gateway socket was not closed",
            )
            await waitFor(() => activeResponses.size === 0, "Fixture response reader was not released")
        },
        async close() {
            if (closed) return
            closed = true
            globalThis.fetch = nativeFetch
            for (const socket of gatewaySockets) socket.terminate()
            await new Promise<void>((resolve) => gateway.close(() => resolve()))
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
            await waitFor(() => serverSockets.size === 0, "Fixture TCP socket was not closed")
        },
    }
}

async function operation<A>(value: ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) return Effect.runPromise(value)
    const result = await value
    if (result.isErr()) throw result.error
    return result.value
}

async function pure<A>(value: Result<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) return Effect.runPromise(value)
    if (value.isErr()) throw value.error
    return value.value
}

async function createLoopbackClient(mode: Mode, origin: string): Promise<LoopbackClient> {
    const instance = { url: origin, allowInsecure: true }
    if (mode === "default") {
        const client = createClient({ token: botToken, instance })._unsafeUnwrap()
        const webhook = createWebhookClient({ id: "50", token: webhookToken, instance })._unsafeUnwrap()
        let closed = false
        return {
            resolve: () => operation(client.instance.resolve()),
            fetchSelf: () => operation(client.users.fetchSelf()),
            connect: async () => {
                const result = await client.connect()
                if (result.isErr()) throw result.error
            },
            scopedUrls: async () => {
                const resolved = await operation(client.instance.resolve())
                return {
                    defaultAvatar: await pure(resolved.assets.defaultAvatar("0")),
                    emoji: await pure(resolved.assets.emoji({ id: "1", animated: false })),
                    channel: await pure(resolved.links.channel({ id: "20" })),
                    installation: await pure(resolved.links.installation("30")),
                }
            },
            resolveWebhook: () => operation(webhook.instance.resolve()),
            deleteWebhookMessage: () => operation(webhook.deleteMessage("20")),
            close: async () => {
                if (closed) return
                closed = true
                const clientResult = await client.shutdown()
                if (clientResult.isErr()) throw clientResult.error
                await webhook.shutdown()
            },
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createNativeClient({ token: botToken, instance }).pipe(Scope.provide(scope)))
    const webhook = await Effect.runPromise(
        createNativeWebhookClient({ id: "50", token: webhookToken, instance }).pipe(Scope.provide(scope)),
    )
    let closed = false
    return {
        resolve: () => Effect.runPromise(client.instance.resolve()),
        fetchSelf: () => Effect.runPromise(client.users.fetchSelf()),
        connect: () => Effect.runPromise(client.connect()),
        scopedUrls: async () => {
            const resolved = await Effect.runPromise(client.instance.resolve())
            return {
                defaultAvatar: await pure(resolved.assets.defaultAvatar("0")),
                emoji: await pure(resolved.assets.emoji({ id: "1", animated: false })),
                channel: await pure(resolved.links.channel({ id: "20" })),
                installation: await pure(resolved.links.installation("30")),
            }
        },
        resolveWebhook: () => Effect.runPromise(webhook.instance.resolve()),
        deleteWebhookMessage: () => Effect.runPromise(webhook.deleteMessage("20")),
        close: async () => {
            if (closed) return
            closed = true
            await Effect.runPromise(client.shutdown())
            await Effect.runPromise(webhook.shutdown())
            await Effect.runPromise(Scope.close(scope, Exit.void))
        },
    }
}

test.each(modes)("%s routes one selected instance through an owned HTTP and WebSocket loopback", async (mode) => {
    const fixture = await loopbackFixture()
    let client: LoopbackClient | undefined
    try {
        client = await createLoopbackClient(mode, fixture.origin)
        const resolved = await client.resolve()
        expect(resolved.endpoints).toMatchObject({
            apiPublic: `${fixture.origin}/v1`,
            gateway: fixture.origin.replace("http:", "ws:") + "/gateway",
            media: `${fixture.origin}/media`,
            staticCdn: `${fixture.origin}/static`,
            webapp: `${fixture.origin}/web`,
            invite: `${fixture.origin}/invites`,
        })
        expect(await client.scopedUrls()).toEqual({
            defaultAvatar: `${fixture.origin}/static/avatars/0.png`,
            emoji: `${fixture.origin}/media/emojis/1.webp`,
            channel: `${fixture.origin}/web/channels/@me/20`,
            installation: `${fixture.origin}/web/oauth2/authorize?client_id=30&scope=bot`,
        })
        expect(fixture.requests).toHaveLength(1)

        const self = await client.fetchSelf()
        expect(self).toMatchObject({ id: "10", isBot: true })
        await client.connect()
        await waitFor(
            () => fixture.gatewayCommands.some((command) => (command as { op?: number }).op === 2),
            "Identify deadline",
        )

        const webhook = await client.resolveWebhook()
        expect(webhook.endpoints.apiPublic).toBe(`${fixture.origin}/v1`)
        await client.deleteWebhookMessage()

        expect(fixture.blockedFetches).toEqual([])
        expect(fixture.unexpectedRoutes).toEqual([])
        expect(fixture.gatewayRequests).toEqual(["/gateway?v=1&encoding=json"])
        expect(fixture.requests).toEqual([
            { method: "GET", path: "/.well-known/fluxer", authorization: undefined, cookie: undefined },
            { method: "GET", path: "/v1/v1/users/@me", authorization: `Bot ${botToken}`, cookie: undefined },
            { method: "GET", path: "/.well-known/fluxer", authorization: undefined, cookie: undefined },
            {
                method: "DELETE",
                path: "/v1/v1/webhooks/50/loopback_webhook_token/messages/20",
                authorization: undefined,
                cookie: undefined,
            },
        ])

        await client.close()
        await fixture.waitForGatewayClose()
    } finally {
        try {
            await client?.close()
        } finally {
            await fixture.close()
        }
    }
})
