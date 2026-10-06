// The parent releases each later transition through loopback barriers, so its assertions never race a child timer
const stateControl = process.env.FLUXERLY_SUPERVISOR_STATE_CONTROL
const exitControl = process.env.FLUXERLY_SUPERVISOR_EXIT_CONTROL
const keepAlive = setInterval(() => {}, 1_000)

// Any value is accepted, so null fields only mark a point in the IPC message order
const marker = Object.fromEntries(
    ["state", "gatewayLatencyMs", "shards", "rest", "uploads", "gatewayRequests", "events", "caches", "counters"].map(
        (key) => [key, null],
    ),
)

const fail = () => process.exit(1)

process.on("message", (message) => {
    if (typeof message !== "object" || message === null) return
    if (message.type === "shutdown") process.exit(0)
    if (message.type !== "assignment") return
    const { generation } = message
    process.send?.({ type: "state", generation, state: "Connected" })
    process.send?.({ type: "ready", generation })
    process.send?.({ type: "state", generation: generation - 1, state: "Connected" })
    // IPC keeps message order, so a parent that observes these diagnostics has already handled the stale state
    process.send?.({ type: "diagnostics", generation, diagnostics: marker })
    void fetch(stateControl).then((response) => {
        if (!response.ok) return fail()
        // The disconnect waits until the current state is written, so the parent receives it first
        process.send?.({ type: "state", generation, state: "Connected" }, () => {
            if (!exitControl) return
            process.disconnect?.()
            // The process stays alive without IPC until the parent answers or closes the barrier
            const exit = () => process.exit(0)
            void fetch(exitControl).then(exit, exit)
        })
    }, fail)
})
process.send?.({ type: "hello" })

process.once("exit", () => clearInterval(keepAlive))
