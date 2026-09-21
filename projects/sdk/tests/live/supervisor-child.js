import assert from "node:assert/strict"

const mode = process.env.FLUXERLY_SUPERVISOR_LIVE_MODE
const proofUrl = process.env.FLUXERLY_SUPERVISOR_LIVE_PROOF_URL
const proofSecret = process.env.FLUXERLY_SUPERVISOR_LIVE_PROOF_SECRET
const token = process.env.FLUXER_TEST_BOT_TOKEN

assert.ok(mode === "default" || mode === "effect")
assert.ok(token && token === token.trim())
assert.equal(typeof proofUrl, "string")
assert.equal(typeof proofSecret, "string")

const proofEndpoint = new URL(proofUrl)
assert.equal(proofEndpoint.protocol, "http:")
assert.equal(proofEndpoint.hostname, "127.0.0.1")
assert.equal(proofEndpoint.pathname, "/proof")
assert.equal(proofEndpoint.username, "")
assert.equal(proofEndpoint.password, "")
assert.equal(proofEndpoint.search, "")
assert.equal(proofEndpoint.hash, "")

async function postProof(proof) {
    const response = await fetch(proofEndpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...proof, mode, secret: proofSecret }),
    })
    if (response.status !== 204) {
        await response.body?.cancel()
        throw new Error("Local proof rejected")
    }
    await response.body?.cancel()
}

async function postSafely(proof) {
    try {
        await postProof(proof)
        return true
    } catch {
        return false
    }
}

class ChildSettings {
    get connection() {
        return { startupTimeoutMs: 35_000, maxStartupAttempts: 1 }
    }
    get instance() {
        return { url: "https://fluxer.app" }
    }
}

const clientOptions = Object.defineProperty(new ChildSettings(), "cache", { value: { users: true } })

async function runDefault() {
    const { supervisor } = await import("@neontechspace/fluxerly")
    let client
    let assignment
    let unsubscribe
    let connectionProofStarted = false

    const sendConnectionProof = async () => {
        try {
            const self = await client.users.fetchSelf()
            if (self.isErr()) await postSafely({ kind: "failed", shardId: assignment.shardIds[0] })
            else {
                const cached = client.users.get(self.value.id)
                assert.ok(cached.isOk())
                assert.equal(cached.value?.id, self.value.id)
                await postSafely({
                    kind: "connected",
                    shardId: assignment.shardIds[0],
                    state: client.state,
                    userId: self.value.id,
                })
            }
        } catch {
            await postSafely({ kind: "failed", shardId: assignment.shardIds[0] })
        } finally {
            unsubscribe?.()
        }
    }

    const result = await supervisor.child.run({
        token,
        clientOptions,
        configure: (configured) => {
            client = configured.client
            assignment = configured.assignment
            unsubscribe = client.observeState((state) => {
                if (state !== "Connected" || connectionProofStarted) return
                connectionProofStarted = true
                return sendConnectionProof()
            })
            return postProof({ kind: "configured", shardId: assignment.shardIds[0] })
        },
    })
    unsubscribe?.()
    if (result.isErr()) throw new Error("Child supervisor operation failed")
    assert.ok(client)
    assert.ok(assignment)
    await postProof({ kind: "closed", shardId: assignment.shardIds[0], state: client.state })
}

async function runEffect() {
    const [{ supervisor }, { Effect, Stream }] = await Promise.all([
        import("@neontechspace/fluxerly/effect"),
        import("effect"),
    ])
    let client
    let assignment

    await Effect.runPromise(
        supervisor.child.run({
            token,
            clientOptions,
            configure: (configured) => {
                client = configured.client
                assignment = configured.assignment
                return Effect.gen(function* () {
                    yield* Effect.promise(() => postProof({ kind: "configured", shardId: assignment.shardIds[0] }))
                    yield* client.observeState().pipe(
                        Stream.filter((state) => state === "Connected"),
                        Stream.take(1),
                        Stream.runForEach(() =>
                            client.users.fetchSelf().pipe(
                                Effect.flatMap((self) =>
                                    Effect.gen(function* () {
                                        const cached = yield* client.users.get(self.id)
                                        assert.equal(cached?.id, self.id)
                                        return yield* Effect.promise(() =>
                                            postSafely({
                                                kind: "connected",
                                                shardId: assignment.shardIds[0],
                                                state: client.state,
                                                userId: self.id,
                                            }),
                                        )
                                    }),
                                ),
                                Effect.catch(() =>
                                    Effect.promise(() =>
                                        postSafely({ kind: "failed", shardId: assignment.shardIds[0] }),
                                    ),
                                ),
                            ),
                        ),
                        Effect.forkScoped,
                        Effect.asVoid,
                    )
                })
            },
        }),
    )
    assert.ok(client)
    assert.ok(assignment)
    await postProof({ kind: "closed", shardId: assignment.shardIds[0], state: client.state })
}

try {
    if (mode === "default") await runDefault()
    else await runEffect()
} catch {
    process.exitCode = 1
}
