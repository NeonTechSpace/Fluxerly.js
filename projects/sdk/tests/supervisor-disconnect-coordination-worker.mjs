const control = process.env.FLUXERLY_SUPERVISOR_DISCONNECT_CONTROL
const mode = process.env.FLUXERLY_SUPERVISOR_DISCONNECT_COORDINATION
const keepAlive = setInterval(() => {}, 1_000)

let generation

function disconnectAfterBarrier() {
    if (!control) return
    void fetch(control).then(
        (response) => {
            if (response.ok) process.disconnect?.()
            else process.exitCode = 1
        },
        () => {
            process.exitCode = 1
        },
    )
}

const onMessage = (message) => {
    if (typeof message !== "object" || message === null) return
    if (message.type === "assignment") {
        generation = message.generation
        process.off("message", onMessage)
        if (mode === "startup") {
            disconnectAfterBarrier()
            return
        }
        process.send?.({ type: "ready", generation })
        process.send?.({ type: "state", generation, state: "Connected" })
        process.send?.({ type: "identify", generation, requestId: 0, shardId: 0 })
        process.on("message", onGrant)
    }
}

const onGrant = (message) => {
    if (typeof message !== "object" || message === null || message.type !== "grant" || message.requestId !== 0) return
    if (mode === "outstanding") {
        disconnectAfterBarrier()
        return
    }
    if (mode === "queued") {
        process.send?.({ type: "sent", generation, requestId: 0 })
        process.send?.({ type: "identify", generation, requestId: 1, shardId: 0 })
        disconnectAfterBarrier()
    }
}

process.on("message", onMessage)
process.send?.({ type: "hello" })
process.once("exit", () => clearInterval(keepAlive))
