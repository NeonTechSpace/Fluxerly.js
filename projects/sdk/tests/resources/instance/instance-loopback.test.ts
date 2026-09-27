import { once } from "node:events"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { Effect, Exit, Scope } from "effect"
import { expect, test } from "vitest"
import WebSocket from "ws"
import { createClient, createWebhookClient } from "../../../src/index.js"
import {
    createClient as createNativeClient,
    createWebhookClient as createNativeWebhookClient,
} from "../../../src/effect.js"
import { Opcode as GatewayOpcode } from "../../../src/internal/protocol/gateway.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { waitUntil } from "../../support/clock.js"
import { startGatewayServer } from "../../support/gateway-server.js"
import { settle } from "../../support/settle.js"

const botToken = "loopback_bot_token"
const webhookToken = "loopback_webhook_token"

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
type LoopbackClient = {
    readonly resolve: () => Promise<ResolvedEndpointMap>
    readonly fetchSelf: () => Promise<{ readonly id: string; readonly isBot: boolean }>
    readonly connect: () => Promise<void>
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

async function loopbackFixture() {
    const requests: RequestRecord[] = []
    const unexpectedRoutes: string[] = []
    const blockedFetches: string[] = []
    const gatewayRequests: string[] = []
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
            json(response, instanceDocument(origin))
            return
        }
        if (target.pathname === "/v1/v1/users/@me" && request.method === "GET") {
            json(response, userResponse())
            return
        }
        if (
            target.pathname === "/v1/v1/webhooks/50/loopback_webhook_token/messages/20" &&
            request.method === "DELETE"
        ) {
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
    server.on("upgrade", (request: IncomingMessage) => gatewayRequests.push(request.url ?? ""))
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const gateway = await startGatewayServer({ server, redirect: false })
    const gatewaySockets = gateway.sockets
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
        identifies: () => gateway.commandsWithOp(GatewayOpcode.identify),
        async waitForGatewayClose() {
            await waitUntil(() => gatewaySockets.every((socket) => socket.readyState === WebSocket.CLOSED), {
                message: "Client-owned gateway socket was not closed",
            })
            await waitUntil(() => activeResponses.size === 0, { message: "Fixture response reader was not released" })
        },
        async close() {
            if (closed) return
            closed = true
            globalThis.fetch = nativeFetch
            for (const socket of gatewaySockets) socket.terminate()
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
            await waitUntil(() => serverSockets.size === 0, { message: "Fixture TCP socket was not closed" })
        },
    }
}

async function createLoopbackClient(mode: Mode, origin: string): Promise<LoopbackClient> {
    const instance = { url: origin, allowInsecure: true }
    if (mode === "default") {
        const client = createClient({ token: botToken, instance })
        const webhook = createWebhookClient({ id: "50", token: webhookToken, instance })
        let closed = false
        return {
            resolve: () => settle(client.instance.resolve()),
            fetchSelf: () => settle(client.users.fetchSelf()),
            connect: async () => {
                const result = await client.connect()
                if (result.isErr()) throw result.error
            },
            resolveWebhook: () => settle(webhook.instance.resolve()),
            deleteWebhookMessage: () => settle(webhook.deleteMessage("20")),
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
        expect(fixture.requests).toHaveLength(1)

        const self = await client.fetchSelf()
        expect(self).toMatchObject({ id: "10", isBot: true })
        await client.connect()
        await waitUntil(() => fixture.identifies().length > 0, { message: "Identify deadline" })
        expect(fixture.identifies()[0]).toMatchObject({ d: { token: botToken } })

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
