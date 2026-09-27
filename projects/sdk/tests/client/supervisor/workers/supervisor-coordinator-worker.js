import { Effect } from "effect"
import { ChildBridge } from "../../../../dist/internal/supervisor.js"

// Expects the parent's identify coordinator to refuse the first permit and grant the second
const worker = Effect.scoped(
    Effect.gen(function* () {
        const bridge = yield* ChildBridge.open()
        yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()))
        const assignment = yield* bridge.waitForAssignment()
        const shardId = assignment.shardIds[0]
        if (shardId === undefined) throw new Error("Missing fixture shard assignment")
        bridge.ready()
        const refused = yield* Effect.exit(bridge.identifyGate.permit(shardId, () => {}))
        const failure =
            refused._tag === "Failure" ? refused.cause.reasons.find((reason) => reason._tag === "Fail") : undefined
        if (failure?.error?._tag !== "ConnectionError")
            return yield* Effect.die(new Error("The refusal did not arrive"))
        let sent = false
        yield* bridge.identifyGate.permit(shardId, () => {
            sent = true
        })
        if (!sent) return yield* Effect.die(new Error("The grant did not arrive"))
        bridge.state("Connected")
        yield* bridge.waitForStop()
    }),
)

const exit = await Effect.runPromiseExit(worker)
if (exit._tag === "Failure") process.exitCode = 1
