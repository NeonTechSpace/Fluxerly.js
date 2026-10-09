import { Effect } from "effect"
import { ChildBridge } from "../../../../dist/internal/supervisor.js"

// The child loses the parent's answer to its first member request, so that request falls back to the child's own
// window when the answer wait ends. Falling back withdraws the request, so the parent then grants all 12 slots of the
// account. The child reports Connected only when both happened
const worker = Effect.scoped(
    Effect.gen(function* () {
        const bridge = yield* ChildBridge.open()
        yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()))
        yield* bridge.waitForAssignment()
        bridge.ready()
        process.off("message", bridge.onMessage)
        const missed = yield* bridge.accountLimits.members.request()
        process.on("message", bridge.onMessage)
        if (missed.kind !== "unreachable") return yield* Effect.die(new Error(`The lost answer was ${missed.kind}`))
        for (let index = 0; index < 12; index++) {
            const slot = yield* bridge.accountLimits.members.request()
            if (slot.kind !== "granted") return yield* Effect.die(new Error(`Slot ${index} was ${slot.kind}`))
        }
        bridge.state("Connected")
        yield* bridge.waitForStop()
    }),
)

const exit = await Effect.runPromiseExit(worker)
if (exit._tag === "Failure") process.exitCode = 1
