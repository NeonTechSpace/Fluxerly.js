process.on("SIGTERM", () => {})
process.on("message", (message) => {
    if (typeof message !== "object" || message === null) return
    if (message.type === "assignment" && process.env.FLUXERLY_SUPERVISOR_MODE !== "never-ready")
        process.send?.({ type: "ready", generation: message.generation })
})
process.send?.({ type: "hello" })
