import { Effect } from "effect"
import { ChildBridge } from "../../../../dist/internal/supervisor.js"

// The child for shard 0 takes all 12 member request slots of the account, reports them sent and then shares a global
// pause. The child for shard 1 waits for that pause through the parent and is then refused a 13th slot. Each reports
// Connected only when everything arrived as expected
const worker = Effect.scoped(
    Effect.gen(function* () {
        const bridge = yield* ChildBridge.open()
        yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()))
        const assignment = yield* bridge.waitForAssignment()
        bridge.ready()
        const limits = bridge.accountLimits
        if (assignment.shardIds[0] === 0) {
            for (let index = 0; index < 12; index++) {
                const slot = yield* limits.members.request()
                if (slot.kind !== "granted") return yield* Effect.die(new Error(`Slot ${index} was ${slot.kind}`))
                slot.sent()
            }
            limits.shareGlobalPause(60_000)
        } else {
            const waitMs = yield* Effect.callback((resume) => {
                limits.onGlobalPause((waitMs) => resume(Effect.succeed(waitMs)))
            })
            if (!(waitMs > 0 && waitMs <= 60_000)) return yield* Effect.die(new Error(`Pause of ${waitMs} ms`))
            const slot = yield* limits.members.request()
            if (slot.kind !== "refused" || !(slot.retryAfterMs > 0 && slot.retryAfterMs <= 11_000))
                return yield* Effect.die(new Error(`The 13th slot was ${slot.kind}`))
        }
        bridge.state("Connected")
        yield* bridge.waitForStop()
    }),
)

const exit = await Effect.runPromiseExit(worker)
if (exit._tag === "Failure") process.exitCode = 1
