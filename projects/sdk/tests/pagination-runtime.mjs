import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Exit, Scope, Stream } from "effect"
import { createClient } from "@neontechspace/fluxerly"
import { createClient as createNative } from "@neontechspace/fluxerly/effect"

assert.equal(typeof globalThis.gc, "function")
const originalFetch = globalThis.fetch
const wire = (id) => ({ id, channel_id: "20", content: "fixture", author: { id: "40", username: "fixture" } })
globalThis.fetch = async () => Response.json([wire("30"), wire("29")])
const value = (result) => {
    assert.ok(result.isOk())
    return result.value
}
async function released(refs) {
    for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(20)
        globalThis.gc()
        if (refs.every((ref) => ref.deref() === undefined)) return
    }
    assert.fail("Buffered snapshots remained strongly retained")
}
try {
    for (const mode of ["default", "native"]) {
        for (const finish of ["return", "shutdown"]) {
            const scope = Scope.makeUnsafe()
            const snapshots = new Map()
            const options = {
                token: "fixture-only",
                cache: {
                    messages: {
                        maxAgeMs: (message) => {
                            snapshots.set(message.id, new WeakRef(message))
                            return 0
                        },
                    },
                },
            }
            const client =
                mode === "default"
                    ? value(createClient(options))
                    : await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
            const close = () =>
                mode === "default" ? client.shutdown().then(value) : Effect.runPromise(client.shutdown())
            const source = client.messages.iterateHistory("20", { maxItems: 10, pageSize: 2 })
            const iterator = (mode === "default" ? source : Stream.toAsyncIterable(source))[Symbol.asyncIterator]()
            try {
                await iterator.next()
                assert.equal(snapshots.size, 2)
                await sleep(20)
                globalThis.gc()
                assert.ok(snapshots.get("29").deref(), "The pending page must be retained before termination")
                if (finish === "return") await iterator.return()
                else await close()
                // Keep the iterator itself alive while proving its unseen buffered item is released
                await released([snapshots.get("29")])
                if (finish === "shutdown") await iterator.return()
                console.log(JSON.stringify({ mode, finish, check: "pagination_buffer_release", passed: true }))
            } finally {
                await iterator.return()
                await close()
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        }
    }
} finally {
    globalThis.fetch = originalFetch
}
