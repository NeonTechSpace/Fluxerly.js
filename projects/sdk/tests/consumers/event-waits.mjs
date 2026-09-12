import assert from "node:assert/strict"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
const originalFetch = globalThis.fetch
let requests = 0
globalThis.fetch = () => {
    requests += 1
    throw new Error("Event waits must not issue requests")
}
let client
let scope
let runtime
try {
    if (mode === "default") client = sdk.createClient({ token: "fixture-only-not-a-credential" })._unsafeUnwrap()
    else {
        runtime = await import("effect")
        scope = runtime.Scope.makeUnsafe()
        client = await runtime.Effect.runPromise(
            sdk.createClient({ token: "fixture-only-not-a-credential" }).pipe(runtime.Scope.provide(scope)),
        )
    }
    const waiting = client.waitFor("typingStart", { timeoutMs: 5 })
    const result = mode === "default" ? await waiting : await runtime.Effect.runPromise(runtime.Effect.result(waiting))
    const error = mode === "default" ? result._unsafeUnwrapErr() : result.failure
    assert.ok(error instanceof sdk.EventWaitError)
    assert.equal(error.reason, "timeout")
    if (mode === "default") (await client.shutdown())._unsafeUnwrap()
    else await runtime.Effect.runPromise(client.shutdown())
    const closed = client.waitFor("messageCreate", { timeoutMs: 5 })
    const ended = mode === "default" ? await closed : await runtime.Effect.runPromise(runtime.Effect.result(closed))
    assert.equal((mode === "default" ? ended._unsafeUnwrapErr() : ended.failure)._tag, "ClientClosedError")
    assert.equal(requests, 0)
    console.log(`Packed ${mode} event waits passed`)
} finally {
    try {
        if (client) {
            if (mode === "default") (await client.shutdown())._unsafeUnwrap()
            else await runtime.Effect.runPromise(client.shutdown())
        }
    } finally {
        if (scope) await runtime.Effect.runPromise(runtime.Scope.close(scope, runtime.Exit.void))
        globalThis.fetch = originalFetch
    }
}
