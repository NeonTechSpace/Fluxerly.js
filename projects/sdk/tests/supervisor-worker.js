import { Effect } from "effect"
import { ChildBridge } from "../dist/internal/supervisor.js"
import { runFixtureGateway } from "./supervisor-gateway.js"

const mode = process.env.FLUXERLY_SUPERVISOR_MODE

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
if (exit._tag === "Failure") process.exitCode = 1
