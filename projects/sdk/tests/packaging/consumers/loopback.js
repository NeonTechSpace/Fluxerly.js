import { once } from "node:events"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

// The fixture gateway uses the ws package that the installed SDK resolves, so the consumer adds no dependency
const sdkRequire = createRequire(import.meta.resolve("@neontechspace/fluxerly"))
export const sdkWebSocketUrl = pathToFileURL(sdkRequire.resolve("ws")).href
const { WebSocketServer } = sdkRequire("ws")

/** Records values and lets a consumer await a count instead of polling with a real-time deadline */
export class Recorder {
    items = []
    #waiters = []

    record(item) {
        this.items.push(item)
        this.#waiters = this.#waiters.filter(({ count, resolve }) => {
            if (this.items.length < count) return true
            resolve(this.items)
            return false
        })
        return item
    }

    reach(count) {
        if (this.items.length >= count) return Promise.resolve(this.items)
        return new Promise((resolve) => this.#waiters.push({ count, resolve }))
    }
}

/**
 * Start an owned loopback Fluxer instance on 127.0.0.1.
 * It serves discovery, passes other HTTP requests to `route` and runs a gateway that sends Hello, acknowledges
 * heartbeats and passes every other command to `command`. A route that returns false produces 404
 */
export async function startLoopback({ route = () => false, command = () => {} } = {}) {
    let origin = ""
    let sequence = 0
    const connections = new Set()
    let closeWaiters = []
    const server = createServer(async (request, response) => {
        const target = new URL(request.url ?? "/", origin)
        if (target.pathname === "/.well-known/fluxer") {
            response.setHeader("content-type", "application/json")
            response.end(
                JSON.stringify({
                    api_code_version: 1,
                    endpoints: {
                        api_public: `${origin}/api`,
                        gateway: origin.replace("http:", "ws:") + "/gateway",
                        media: `${origin}/media`,
                        static_cdn: `${origin}/static`,
                        webapp: `${origin}/web`,
                        invite: `${origin}/invite`,
                    },
                    features: { presigned_attachment_uploads: false },
                }),
            )
            return
        }
        if ((await route(request, response, target)) !== false) return
        response.statusCode = 404
        response.end()
    })
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket, request) => {
        const connection = { socket, url: request.url }
        connections.add(connection)
        socket.once("close", () => {
            connections.delete(connection)
            if (connections.size > 0) return
            for (const resolve of closeWaiters) resolve()
            closeWaiters = []
        })
        socket.on("message", (payload) => {
            const parsed = JSON.parse(payload.toString())
            if (parsed.op === 1) socket.send(JSON.stringify({ op: 11 }))
            else command(parsed, connection)
        })
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const { port } = server.address()
    origin = `http://127.0.0.1:${port}`
    const dispatch = (connection, event, data) =>
        connection.socket.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: data }))
    return {
        origin,
        gatewayUrl: `ws://127.0.0.1:${port}`,
        connections,
        dispatch,
        broadcast(event, data) {
            for (const connection of connections) dispatch(connection, event, data)
            return data
        },
        /** Resolve once every gateway socket has closed */
        closed() {
            if (connections.size === 0) return Promise.resolve()
            return new Promise((resolve) => closeWaiters.push(resolve))
        },
        async close() {
            for (const { socket } of connections) socket.terminate()
            await new Promise((resolve) => gateway.close(resolve))
            await new Promise((resolve) => server.close(resolve))
        },
    }
}

export const wireMessage = (id, content, author = { id: "30", username: "fixture" }) => ({
    id,
    channel_id: "20",
    content,
    author,
})

export async function readJson(request) {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    return JSON.parse(Buffer.concat(chunks).toString())
}

export function sendJson(response, value) {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(value))
}
