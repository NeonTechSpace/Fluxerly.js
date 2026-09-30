import { Effect } from "effect"
import WebSocket from "ws"
import { ChildBridge } from "../../../../dist/internal/supervisor.js"
import { runFixtureGateway } from "./supervisor-gateway.js"

const mode = process.env.FLUXERLY_SUPERVISOR_MODE
const reports = []
const proofUrl = process.env.FLUXERLY_SUPERVISOR_SEND_PROOF
if (proofUrl) {
    const origin = new URL(proofUrl)
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1")
        throw new Error("Unexpected Identify send proof origin")
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function (data, ...arguments_) {
        const identify = typeof data === "string" && JSON.parse(data).op === 2
        // The host's monotonic counter is shared by these local child processes.
        const at = identify ? Number(process.hrtime.bigint() / 1_000_000n) : undefined
        const result = send.call(this, data, ...arguments_)
        if (at !== undefined)
            reports.push(
                fetch(`${origin.origin}/?at=${at}`).then((response) => {
                    if (!response.ok) throw new Error("Identify send proof failed")
                }),
            )
        return result
    }
}

const worker = Effect.scoped(
    Effect.gen(function* () {
        const bridge = yield* ChildBridge.open()
        yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()))
        const assignment = yield* bridge.waitForAssignment()
        const shardId = assignment.shardIds[0]
        if (shardId === undefined) throw new Error("Missing fixture shard assignment")
        if (mode === "delayed" && shardId === 0) {
            const block = new Int32Array(new SharedArrayBuffer(4))
            const delayGrant = (message) => {
                if (typeof message === "object" && message !== null && message.type === "grant") {
                    process.off("message", delayGrant)
                    Atomics.wait(block, 0, 0, 150)
                }
            }
            process.prependListener("message", delayGrant)
        }
        bridge.ready()
        yield* Effect.promise(() => runFixtureGateway(bridge, assignment, mode === "delayed" && shardId === 1 ? 50 : 0))
    }),
)

const exit = await Effect.runPromiseExit(worker)
await Promise.all(reports)
if (exit._tag === "Failure") process.exitCode = 1
