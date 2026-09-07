import { Effect } from "effect"
import WebSocket from "ws"

const terminateAndWait = (socket: WebSocket) =>
    Effect.callback<void>((resume) => {
        if (socket.readyState === WebSocket.CLOSED) {
            resume(Effect.void)
            return
        }
        // Terminating a pending handshake emits an error before close; cleanup owns that abort
        const onError = () => socket.terminate()
        const onClose = () => {
            socket.off("error", onError)
            resume(Effect.void)
        }
        socket.on("error", onError)
        socket.once("close", onClose)
        socket.terminate()
        return Effect.sync(() => {
            socket.off("error", onError)
            socket.off("close", onClose)
        })
    })

/** Test-only forced cleanup, not the SDK's graceful-close policy */
export const acquireWs = (url: string) =>
    Effect.acquireRelease(
        Effect.sync(() => new WebSocket(url, { perMessageDeflate: false })),
        terminateAndWait,
    )

export const awaitWsOpen = (socket: WebSocket) =>
    Effect.callback<void, Error>((resume) => {
        if (socket.readyState === WebSocket.OPEN) {
            resume(Effect.void)
            return
        }
        const cleanup = () => {
            socket.off("open", onOpen)
            socket.off("error", onError)
            socket.off("close", onClose)
        }
        const onOpen = () => {
            cleanup()
            resume(Effect.void)
        }
        const onError = (error: Error) => {
            cleanup()
            resume(Effect.fail(error))
        }
        const onClose = () => {
            cleanup()
            resume(Effect.fail(new Error("Transport fixture closed before opening")))
        }
        socket.once("open", onOpen)
        socket.once("error", onError)
        socket.once("close", onClose)
        return Effect.sync(cleanup)
    })
