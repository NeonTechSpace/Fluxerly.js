const onMessage = (message) => {
    if (typeof message !== "object" || message === null || message.type !== "assignment") return
    process.off("message", onMessage)
    process.send?.({ type: "state", generation: message.generation, state: "Connected" })
    process.send?.({ type: "ready", generation: message.generation })
    process.send?.({ type: "state", generation: message.generation - 1, state: "Connected" })
    setTimeout(() => {
        process.send?.({ type: "state", generation: message.generation, state: "Connected" })
        if (process.env.FLUXERLY_SUPERVISOR_DISCONNECT_AFTER_READY !== "1") return
        setTimeout(() => {
            process.disconnect?.()
            setTimeout(() => process.exit(0), 500)
        }, 25)
    }, 100)
}
process.on("message", onMessage)
process.send?.({ type: "hello" })
