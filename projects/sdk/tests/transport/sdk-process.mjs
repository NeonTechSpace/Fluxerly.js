import { registerHooks } from "node:module"
import { Effect, Exit, Cause } from "effect"

const [mode, url] = process.argv.slice(2)
// Redirect only the external ws constructor, leaving the built public SDK and real loopback I/O intact
registerHooks({
    resolve(specifier, context, next) {
        if (specifier === "ws" && context.parentURL?.endsWith("/dist/internal/gateway.js")) {
            const original = next(specifier, context).url
            const source = `import WebSocket from ${JSON.stringify(original)}; export default class extends WebSocket { constructor(_url, options) { super(${JSON.stringify(url)}, options) } }`
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
        }
        return next(specifier, context)
    },
})
globalThis.fetch = async () => new Response(JSON.stringify({ url: "wss://gateway.fluxer.app" }))
const controller = new AbortController()
const stop = Promise.withResolvers()
process.on("message", (message) => {
    if (message === "interrupt") controller.abort()
    if (message === "shutdown") stop.resolve()
})
const pending = mode.endsWith("pending")
if (mode.startsWith("default")) {
    const { createClient } = await import("../../dist/index.js")
    const client = createClient({ token: "fixture-only-not-a-credential" })._unsafeUnwrap()
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
    const { createClient } = await import("../../dist/effect.js")
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
