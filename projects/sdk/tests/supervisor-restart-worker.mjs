const onMessage = (message) => {
    if (typeof message !== "object" || message === null || message.type !== "assignment") return
    process.off("message", onMessage)
    if (process.env.FLUXERLY_SUPERVISOR_MODE === "exit-then-never-ready" && message.generation > 1) {
        process.on("message", () => {})
        return
    }
    process.send?.({ type: "ready", generation: message.generation })
    if (process.env.FLUXERLY_SUPERVISOR_MODE === "exit-then-never-ready") setTimeout(() => process.exit(0), 250)
}
process.on("message", onMessage)
process.send?.({ type: "hello" })
