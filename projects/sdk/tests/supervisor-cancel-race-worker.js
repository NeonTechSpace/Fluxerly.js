import { Effect, Fiber } from "effect"
import { ChildBridge } from "../dist/internal/supervisor.js"
import { runFixtureGateway } from "./supervisor-gateway.js"

const worker = Effect.scoped(
    Effect.gen(function* () {
        const bridge = yield* ChildBridge.open()
        yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()))
        const assignment = yield* bridge.waitForAssignment()
        const shardId = assignment.shardIds[0]
        if (shardId === undefined) throw new Error("Missing fixture shard assignment")
        if (shardId === 0) {
            let permit
            const cancelGrantedPermit = (message) => {
                if (typeof message !== "object" || message === null || message.type !== "grant") return
                process.off("message", cancelGrantedPermit)
                void Effect.runPromise(Fiber.interrupt(permit))
            }
            process.prependListener("message", cancelGrantedPermit)
            bridge.ready()
            permit = Effect.runFork(bridge.identifyGate.permit(shardId, () => {}))
            yield* bridge.waitForStop()
            return
        }
        bridge.ready()
        yield* Effect.promise(() => runFixtureGateway(bridge, assignment))
    }),
)

const exit = await Effect.runPromiseExit(worker)
if (exit._tag === "Failure") process.exitCode = 1
