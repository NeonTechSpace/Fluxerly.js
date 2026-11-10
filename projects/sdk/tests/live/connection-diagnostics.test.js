import { EventEmitter } from "node:events"
import { afterEach, expect, test } from "vitest"
import { observeConnections } from "./support/connection-diagnostics.js"

const observers = []
afterEach(() => {
    for (const observer of observers.splice(0).reverse()) observer.restore()
})

function fixture(emitFailure = false) {
    class Socket extends EventEmitter {
        url = "wss://gateway.fluxer.com/?synthetic-secret"
        sent = []
        send(...args) {
            this.sent.push(args)
            if (args[0] instanceof Error) throw args[0]
            return "sent"
        }
    }
    let time = 0
    const records = []
    const observer = observeConnections(
        Socket,
        (record) => {
            if (emitFailure) throw Error("synthetic-secret")
            records.push(record)
        },
        () => time,
    )
    observers.push(observer)
    return {
        Socket,
        observer,
        records,
        advance: (milliseconds) => {
            time += milliseconds
        },
    }
}

test("diagnostics distinguish unopened sockets and a live socket awaiting READY using controlled time", () => {
    const { Socket, observer, records, advance } = fixture()
    const unopened = new Socket()
    unopened.emit("close", 1006, "synthetic-secret")
    const socket = new Socket()
    socket.emit("open")
    socket.emit("message", Buffer.from('{"op":10,"d":{"heartbeat_interval":40000}}'))
    const callback = () => {}
    const identify = '{"op":2,"d":{"token":"synthetic-secret"}}'
    expect(socket.send(identify, callback)).toBe("sent")
    expect(socket.sent).toEqual([[identify, callback]])
    advance(41000)
    socket.send('{"op":1,"d":42}')
    socket.emit("message", Buffer.from('{"op":11}'))
    const snapshot = observer.snapshot()
    expect(snapshot.connections).toMatchObject([
        { connection: 1, open: 0, hello: 0, identify: 0, close: 1, closeCode: 1006 },
        { connection: 2, open: 1, hello: 1, identify: 1, ready: 0, heartbeat: 1, heartbeatAck: 1, lastEventMs: 41000 },
    ])
    expect(records.map((record) => record.event)).toEqual(["close", "open", "hello", "identify"])
    expect(JSON.stringify([records, snapshot])).not.toContain("synthetic-secret")
})

test("diagnostics keep independent READY and RESUMED sessions and preserve event delivery", () => {
    const { Socket, observer } = fixture()
    const socket = new Socket()
    const received = []
    socket.on("message", (...args) => received.push(args))
    socket.emit("open")
    const ready = Buffer.from('{"op":0,"t":"READY","d":{"session_id":"synthetic-secret"}}')
    expect(socket.emit("message", ready, false)).toBe(true)
    expect(received).toEqual([[ready, false]])
    const resumed = new Socket()
    resumed.send('{"op":6,"d":{"session_id":"synthetic-secret"}}')
    resumed.emit("message", Buffer.from('{"op":0,"t":"RESUMED"}'))
    expect(observer.snapshot().connections).toMatchObject([
        { ready: 1, resumed: 0 },
        { ready: 0, resume: 1, resumed: 1 },
    ])
})

test("observation tolerates malformed frames and reporting failures without masking transport errors", () => {
    const { Socket, observer } = fixture(true)
    const socket = new Socket()
    const error = Error("synthetic-secret")
    expect(() => socket.emit("open")).not.toThrow()
    expect(() => socket.send("not json")).not.toThrow()
    expect(() => socket.send(error)).toThrow(error)
    expect(() => socket.emit("error", error)).toThrow(error)
    expect(observer.snapshot().connections).toMatchObject([{ open: 1, unreadable: 1, error: 1, identify: 0 }])
})

test("diagnostics ignore other hosts, bound storage and restore inherited and own methods", () => {
    const { Socket, observer, records } = fixture()
    const socket = new Socket()
    socket.url = "wss://unrelated.invalid/synthetic-secret"
    socket.emit("open")
    expect(observer.snapshot().connections).toEqual([])
    for (let index = 0; index < 20; index++) {
        const tracked = new Socket()
        for (let event = 0; event < 10; event++) tracked.emit("open")
    }
    expect(observer.snapshot()).toMatchObject({ overflow: true })
    expect(observer.snapshot().connections).toHaveLength(16)
    expect(records).toHaveLength(64)
    observer.restore()
    expect(Object.hasOwn(Socket.prototype, "emit")).toBe(false)
    expect(socket.send("original method")).toBe("sent")
    expect(socket.sent).toEqual([["original method"]])
})
