// Passive protocol diagnostics for live harnesses. Only fixed event names, counters, elapsed times and numeric close
// codes leave the observer. Socket URLs, frames, credentials, session IDs, errors and close reasons are never retained

export function observeConnections(WebSocket, emit, now = () => performance.now()) {
    const prototype = WebSocket.prototype
    const descriptors = Object.fromEntries(
        ["emit", "send"].map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)]),
    )
    const originalEmit = prototype.emit
    const originalSend = prototype.send
    const began = now()
    const sockets = new Map()
    let events = 0
    let overflow = false

    const recordFor = (socket) => {
        const url = new URL(socket.url)
        if (url.protocol !== "wss:" || url.host !== "gateway.fluxer.com") return
        if (!sockets.has(socket)) {
            if (sockets.size >= 16) {
                overflow = true
                return
            }
            sockets.set(socket, {
                connection: sockets.size + 1,
                open: 0,
                hello: 0,
                identify: 0,
                ready: 0,
                resume: 0,
                resumed: 0,
                heartbeat: 0,
                heartbeatAck: 0,
                error: 0,
                close: 0,
                unreadable: 0,
            })
        }
        return sockets.get(socket)
    }
    const observe = (socket, event, value) => {
        const record = recordFor(socket)
        if (!record) return
        record[event]++
        const elapsedMs = Math.max(0, Math.round(now() - began))
        record.lastEventMs = elapsedMs
        if (event === "close" && Number.isInteger(value) && value >= 1000 && value <= 4999) record.closeCode = value
        // Heartbeats are summarized, keeping output useful even during a long observation window
        if (event === "heartbeat" || event === "heartbeatAck") return
        if (events++ >= 64) {
            overflow = true
            return
        }
        emit({
            connection: record.connection,
            event,
            elapsedMs,
            ...(event === "close" && record.closeCode !== undefined ? { closeCode: record.closeCode } : {}),
        })
    }
    const frameEvent = (data, outgoing) => {
        const frame = JSON.parse(data.toString())
        if (outgoing) {
            if (frame?.op === 1) return "heartbeat"
            if (frame?.op === 2) return "identify"
            if (frame?.op === 6) return "resume"
            return
        }
        if (frame?.op === 10) return "hello"
        if (frame?.op === 11) return "heartbeatAck"
        if (frame?.op === 0 && frame.t === "READY") return "ready"
        if (frame?.op === 0 && frame.t === "RESUMED") return "resumed"
    }
    const observeFrame = (socket, data, outgoing) => {
        // Parse failures remain observable without changing delivery or retaining any frame bytes
        let event
        try {
            event = frameEvent(data, outgoing)
        } catch {
            event = "unreadable"
        }
        if (event) observe(socket, event)
    }
    prototype.emit = function (event, ...args) {
        try {
            if (["open", "error", "close"].includes(event)) observe(this, event, args[0])
            else if (event === "message") observeFrame(this, args[0], false)
        } catch {
            // allow-silent: Diagnostic collection must never change transport delivery or failure
        }
        return Reflect.apply(originalEmit, this, [event, ...args])
    }
    prototype.send = function (data, ...args) {
        // A failed send must not be counted as an Identify delivered to the transport
        const result = Reflect.apply(originalSend, this, [data, ...args])
        try {
            observeFrame(this, data, true)
        } catch {
            // allow-silent: Diagnostic collection must never change transport delivery or failure
        }
        return result
    }
    return {
        snapshot() {
            return {
                elapsedMs: Math.max(0, Math.round(now() - began)),
                overflow,
                connections: [...sockets.values()].map((record) => ({ ...record })),
            }
        },
        restore() {
            for (const [key, descriptor] of Object.entries(descriptors)) {
                if (descriptor) Object.defineProperty(prototype, key, descriptor)
                else delete prototype[key]
            }
            sockets.clear()
        },
    }
}
