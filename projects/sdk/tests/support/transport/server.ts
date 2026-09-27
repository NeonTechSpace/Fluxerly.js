import { createHash } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import type { Duplex } from "node:stream"

/** A constrained local fixture for unfragmented text and close frames, not a WebSocket server implementation */
function frame(opcode: number, payload: Buffer): Buffer {
    if (payload.length > 125) throw new Error("Transport fixture only supports short frames")
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])
}

export async function startServer(options: { holdHandshake?: boolean; holdClose?: boolean } = {}) {
    const sockets = new Set<Socket>()
    const upgraded = Promise.withResolvers<Duplex>()
    const receivedClose = Promise.withResolvers<void>()
    const peerClosed = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<IncomingMessage>()
    const requestClosed = Promise.withResolvers<void>()
    const server = createServer((request, response) => {
        requested.resolve(request)
        request.socket.once("close", () => requestClosed.resolve())
        if (request.url === "/pending") return
        response.writeHead(200, { "content-type": "text/plain" })
        if (request.url === "/body") response.write("partial")
        else response.end("fixture response")
    })
    server.on("connection", (socket) => {
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))
    })
    server.on("upgrade", (request, socket) => {
        // Upgraded HTTP sockets are half-open; acknowledge peer FIN for realistic cleanup
        socket.on("end", () => socket.end())
        socket.once("close", () => peerClosed.resolve())
        socket.resume()
        upgraded.resolve(socket)
        if (options.holdHandshake) return
        const accept = createHash("sha1")
            .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64")
        socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        )
        let pending: Buffer = Buffer.alloc(0)
        socket.on("data", (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk])
            while (pending.length >= 2) {
                const opcode = pending[0]! & 0x0f
                const marker = pending[1]! & 0x7f
                if (marker === 127) throw new Error("Transport fixture does not support 64-bit frame lengths")
                if (marker === 126 && pending.length < 4) return
                const length = marker === 126 ? pending.readUInt16BE(2) : marker
                const masked = (pending[1]! & 0x80) !== 0
                const maskOffset = marker === 126 ? 4 : 2
                const headerLength = maskOffset + (masked ? 4 : 0)
                if (pending.length < headerLength + length) return
                const payload = Buffer.from(pending.subarray(headerLength, headerLength + length))
                if (masked) {
                    for (let index = 0; index < payload.length; index++) {
                        payload[index] = payload[index]! ^ pending[maskOffset + (index % 4)]!
                    }
                }
                pending = pending.subarray(headerLength + length)
                if (opcode === 8) {
                    receivedClose.resolve()
                    if (!options.holdClose) socket.end(frame(8, payload))
                }
            }
        })
    })
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject)
            resolve()
        })
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected a local TCP address")
    let cleanup: Promise<void> | undefined
    return {
        httpUrl: `http://127.0.0.1:${address.port}`,
        socketUrl: `ws://127.0.0.1:${address.port}`,
        upgraded: upgraded.promise,
        receivedClose: receivedClose.promise,
        peerClosed: peerClosed.promise,
        requested: requested.promise,
        requestClosed: requestClosed.promise,
        send: async (...messages: string[]) => {
            const socket = await upgraded.promise
            socket.write(Buffer.concat(messages.map((message) => frame(1, Buffer.from(message)))))
        },
        releaseClose: async () => {
            const socket = await upgraded.promise
            socket.end(frame(8, Buffer.from([0x03, 0xe8])))
        },
        close: () => {
            if (cleanup) return cleanup
            for (const socket of sockets) socket.destroy()
            cleanup = new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()))
            })
            return cleanup
        },
    }
}
