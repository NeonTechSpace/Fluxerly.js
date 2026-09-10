const originValue = process.env.FLUXERLY_SUPERVISOR_LOOPBACK
const mode = process.env.FLUXERLY_SUPERVISOR_MODE
const token = process.env.FLUXERLY_SUPERVISOR_TEST_TOKEN

if (typeof originValue !== "string" || typeof mode !== "string" || token !== "supervisor-loopback-token")
    throw new Error("Missing loopback supervisor child settings")

const origin = new URL(originValue)
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1")
    throw new Error("Unexpected loopback supervisor origin")

const nativeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : String(input))
    if (target.origin !== origin.origin) throw new Error("Supervisor child denied non-loopback fetch")
    return nativeFetch(input, init)
}

const { default: WebSocket } = await import("ws")
const reports = []
const originalWebSocketSend = WebSocket.prototype.send
WebSocket.prototype.send = function (data, ...arguments_) {
    if (typeof data === "string") {
        try {
            const packet = JSON.parse(data)
            if (packet?.op === 2 || packet?.op === 6) {
                const operation = packet.op
                reports.push(
                    fetch(
                        `${origin.origin}/supervisor-send-proof?mode=${encodeURIComponent(mode)}&operation=${operation}&at=${Date.now()}`,
                        { method: "GET", redirect: "error" },
                    ).then((response) => {
                        if (!response.ok) throw new Error("Supervisor child send proof failed")
                    }),
                )
            }
        } catch (error) {
            throw error
        }
    }
    return originalWebSocketSend.call(this, data, ...arguments_)
}

const dropSentForShard = Number(process.env.FLUXERLY_SUPERVISOR_DROP_SENT_FOR_SHARD)
const holdConfigureForShard = Number(process.env.FLUXERLY_SUPERVISOR_HOLD_CONFIGURE_FOR_SHARD)
let assignedShard
let droppedSent = false
const originalProcessSend = process.send?.bind(process)
if (originalProcessSend) {
    process.send = (message, ...arguments_) => {
        if (
            assignedShard === dropSentForShard &&
            !droppedSent &&
            typeof message === "object" &&
            message !== null &&
            message.type === "sent"
        ) {
            droppedSent = true
            return true
        }
        return originalProcessSend(message, ...arguments_)
    }
}

let client
async function configure({ client: configured, assignment }) {
    assignedShard = assignment.shardIds[0]
    client = configured
    if (assignedShard !== holdConfigureForShard) return
    const barrier = await fetch(`${origin.origin}/supervisor-configure-barrier?shard=${assignedShard}`, {
        method: "GET",
        redirect: "error",
    })
    if (!barrier.ok) throw new Error("Supervisor child configuration barrier failed")
}

if (mode === "default") {
    const { supervisor } = await import("@neontechspace/fluxerly")
    const result = await supervisor.child.run({
        token,
        clientOptions: {
            instance: { url: origin.href, allowInsecure: true },
            connection: { startupTimeoutMs: 8_000, maxStartupAttempts: 1 },
        },
        configure,
    })
    if (result.isErr()) throw new Error("Default supervisor child failed")
} else if (mode === "native") {
    const { Effect } = await import("effect")
    const { supervisor } = await import("@neontechspace/fluxerly/effect")
    const exit = await Effect.runPromiseExit(
        supervisor.child.run({
            token,
            clientOptions: {
                instance: { url: origin.href, allowInsecure: true },
                connection: { startupTimeoutMs: 8_000, maxStartupAttempts: 1 },
            },
            configure: (context) => Effect.promise(() => configure(context)),
        }),
    )
    if (exit._tag === "Failure") throw new Error("Native supervisor child failed")
} else throw new Error("Unsupported supervisor child mode")

if (!client) throw new Error("Supervisor child never received a client")
await Promise.all(reports)
const proof = await fetch(
    `${origin.origin}/supervisor-proof?mode=${mode}&state=${encodeURIComponent(client.state)}&at=${Date.now()}`,
    {
        method: "GET",
        redirect: "error",
    },
)
if (!proof.ok) throw new Error("Supervisor child loopback proof failed")
if (droppedSent) {
    // Keep this test-owned process alive after helper closure so a Closed report cannot substitute for actual exit
    const exitAfter = performance.now() + 250
    while (performance.now() < exitAfter)
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, exitAfter - performance.now())))
}
