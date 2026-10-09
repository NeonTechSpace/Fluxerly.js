import { Effect } from "effect"
import { ChildBridge } from "../../../../dist/internal/supervisor.js"
import { runFixtureGateway } from "./supervisor-gateway.js"

const barrierUrl = process.env.FLUXERLY_SUPERVISOR_GRANT_BARRIER
if (barrierUrl) {
    const barrier = new URL(barrierUrl)
    if (barrier.protocol !== "http:" || barrier.hostname !== "127.0.0.1")
        throw new Error("Unexpected grant barrier origin")
    // Hold this child's first Identify grant until the test answers, as a child that is slow to send its Identify would
    const emit = process.emit
    process.emit = function (event, message, ...rest) {
        if (event !== "message" || typeof message !== "object" || message === null || message.type !== "grant")
            return emit.call(this, event, message, ...rest)
        process.emit = emit
        void fetch(barrier).then((response) => {
            if (!response.ok) throw new Error("Grant barrier failed")
            emit.call(process, event, message, ...rest)
        })
        return true
    }
}

const worker = Effect.scoped(
    Effect.gen(function* () {
        const bridge = yield* ChildBridge.open()
        yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()))
        const assignment = yield* bridge.waitForAssignment()
        if (assignment.shardIds[0] === undefined) throw new Error("Missing fixture shard assignment")
        bridge.ready()
        yield* Effect.promise(() => runFixtureGateway(bridge, assignment))
    }),
)

const exit = await Effect.runPromiseExit(worker)
if (exit._tag === "Failure") process.exitCode = 1
