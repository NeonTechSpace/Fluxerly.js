const keepAlive = setInterval(() => {}, 1_000)
const control = process.env.FLUXERLY_SUPERVISOR_DISCONNECT_CONTROL

const onMessage = (message) => {
    if (typeof message !== "object" || message === null || message.type !== "assignment") return
    process.off("message", onMessage)
    const shardId = message.assignment?.shardIds?.[0]
    process.send?.({ type: "ready", generation: message.generation })
    process.send?.({ type: "state", generation: message.generation, state: "Connected" })
    if (shardId !== 0 || !control) return
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

process.on("message", onMessage)
process.send?.({ type: "hello" })

process.once("exit", () => clearInterval(keepAlive))
