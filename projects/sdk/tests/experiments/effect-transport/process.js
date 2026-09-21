import { Effect } from "effect"
import { Socket } from "effect/unstable/socket"
import { fetchText, runSocket } from "./candidate.ts"

const [mode, url] = process.argv.slice(2)
const controller = new AbortController()
let socket
process.on("message", (message) => {
    if (message === "interrupt") controller.abort()
    if (message === "inspect") process.send?.({ event: "state", readyState: socket?.readyState })
})

if (mode === "http") {
    await Effect.runPromise(fetchText(url), { signal: controller.signal })
} else {
    await Effect.runPromiseExit(
        runSocket(url, () => Effect.void).pipe(
            Effect.provideService(Socket.WebSocketConstructor, (address) => {
                socket = new WebSocket(address)
                socket.addEventListener("open", () => process.send?.({ event: "open" }), { once: true })
                return socket
            }),
        ),
        { signal: controller.signal },
    )
}
process.send?.({ event: "completed" })
process.disconnect()
// Do not force process exit: Remaining referenced work must be observable by the parent
