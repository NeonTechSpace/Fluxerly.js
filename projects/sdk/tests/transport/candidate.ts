import { Effect, Queue } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"

/** Test-only candidate, not an SDK export or a selected production transport */
export const fetchText = (url: string) =>
    Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.get(url)
        return yield* response.text
    }).pipe(Effect.provide(FetchHttpClient.layer))

const closeAndWait = (socket: WebSocket) =>
    Effect.callback<void>((resume) => {
        if (socket.readyState === WebSocket.CLOSED) {
            resume(Effect.void)
            return
        }
        const onClose = () => {
            socket.removeEventListener("close", onClose)
            resume(Effect.void)
        }
        socket.addEventListener("close", onClose, { once: true })
        socket.close(1000)
        return Effect.sync(() => socket.removeEventListener("close", onClose))
    })

/** Serial processing and close-event waiting around the existing Effect adapter */
export const runSocket = <E, R>(url: string, consume: (text: string) => Effect.Effect<void, E, R>) =>
    Effect.scoped(
        Effect.gen(function* () {
            const makeWebSocket = yield* Socket.WebSocketConstructor
            const socket = yield* Socket.fromWebSocket(
                Effect.acquireRelease(
                    Effect.sync(() => makeWebSocket(url)),
                    closeAndWait,
                ),
            )
            // This fixture-sized queue is not a proposed SDK event-buffer policy
            const messages = yield* Queue.make<string>({ capacity: 16 })
            yield* Effect.addFinalizer(() => Queue.shutdown(messages))
            return yield* Effect.raceFirst(
                socket.runRaw((data) => {
                    if (typeof data !== "string" || !Queue.offerUnsafe(messages, data)) {
                        return Effect.die(new Error("Transport fixture received unsupported input"))
                    }
                }),
                Effect.forever(Effect.flatMap(Queue.take(messages), consume)),
            )
        }),
    )
