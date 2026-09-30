import { registerHooks } from "node:module"
import { Effect, Exit, Cause } from "effect"
import { withHostedDiscovery } from "../hosted-discovery.mjs"

const [mode, url] = process.argv.slice(2)
const forced = mode.endsWith("forced")
let shuttingDown = false
let expireClose
// Control only the graceful-close deadline. Startup, real sockets and natural process exit stay real.
if (forced) {
    const set = globalThis.setTimeout
    const clear = globalThis.clearTimeout
    const heldTimer = {}
    globalThis.setTimeout = (callback, delay, ...arguments_) => {
        if (shuttingDown && delay === 5_000) {
            if (expireClose) throw new Error("Duplicate graceful-close deadline")
            expireClose = () => callback(...arguments_)
            process.send?.({ event: "close-deadline", durationMs: delay })
            return heldTimer
        }
        return set(callback, delay, ...arguments_)
    }
    globalThis.clearTimeout = (timer) => {
        if (timer === heldTimer) expireClose = undefined
        else clear(timer)
    }
}
// Redirect only the external ws constructor, leaving the built public SDK and real loopback I/O intact
registerHooks({
    resolve(specifier, context, next) {
        if (specifier === "ws" && context.parentURL?.endsWith("/dist/internal/transport/socket.js")) {
            const original = next(specifier, context).url
            const source = `import WebSocket from ${JSON.stringify(original)}; export default class extends WebSocket {
                constructor(_url, options) { super(${JSON.stringify(url)}, options) }
                terminate() {
                    if (${forced}) process.send?.({ event: "forced-close" })
                    return super.terminate()
                }
            }`
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
        }
        return next(specifier, context)
    },
})
globalThis.fetch = withHostedDiscovery(async (url) => {
    throw new Error(`Unexpected operation request ${url}`)
})
const controller = new AbortController()
const stop = Promise.withResolvers()
process.on("message", (message) => {
    if (message === "interrupt") controller.abort()
    if (message === "shutdown") {
        shuttingDown = true
        stop.resolve()
    }
    if (message === "expire-close") {
        if (!expireClose) throw new Error("No graceful-close deadline to expire")
        const expire = expireClose
        expireClose = undefined
        expire()
    }
})
const pending = mode.endsWith("pending")
if (mode.startsWith("default")) {
    const { createClient } = await import("../../../dist/index.js")
    const client = createClient({ token: "fixture-only-not-a-credential" })
    const connected = await client.connect({ signal: controller.signal })
    if (pending) {
        if (connected._unsafeUnwrapErr()._tag !== "CancelledError") throw new Error("Expected cancellation")
    } else {
        connected._unsafeUnwrap()
        process.send?.({ event: "open" })
        await stop.promise
    }
    ;(await client.shutdown())._unsafeUnwrap()
} else {
    const { createClient } = await import("../../../dist/effect.js")
    const exit = await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createClient({ token: "fixture-only-not-a-credential" })
                yield* client.connect()
                process.send?.({ event: "open" })
                yield* Effect.promise(() => stop.promise)
                yield* client.shutdown()
            }),
        ),
        { signal: controller.signal },
    )
    if (pending ? !(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) : Exit.isFailure(exit)) {
        throw new Error("Unexpected native lifecycle outcome")
    }
}
process.send?.({ event: "completed" })
process.disconnect()
// No process.exit: The parent must observe natural exit before closing its server
