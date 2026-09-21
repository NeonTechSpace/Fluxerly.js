import { Effect } from "effect"
import { acquireWs, awaitWsOpen } from "./ws-candidate.ts"

const [, url] = process.argv.slice(2)
const controller = new AbortController()
process.on("message", (message) => {
    if (message === "interrupt") controller.abort()
})

await Effect.runPromiseExit(
    Effect.scoped(
        Effect.gen(function* () {
            const socket = yield* acquireWs(url)
            yield* awaitWsOpen(socket)
            process.send?.({ event: "open" })
            socket.close(1000)
            yield* Effect.never
        }),
    ),
    { signal: controller.signal },
)
process.send?.({ event: "completed" })
process.disconnect()
// Do not force process exit: Remaining referenced work must be observable by the parent
