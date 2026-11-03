// The learned-bucket stage of the live SDK rate-limit check, kept apart so an offline test can drive it
import assert from "node:assert/strict"
import { controlledClock } from "./controlled-clock.js"
import { pacedDeadlineMs } from "./watchdogs.js"

/** One real read with its paced slot. The refused read keeps its 100 ms, because the SDK refuses it unsent */
const readTimeoutMs = pacedDeadlineMs(10_000, 1)

/**
 * Learn a shared bucket from three real reads with injected scheduling headers, require the next read to be refused
 * unsent while the bucket is empty, then require a read once it refills. `setStage` names the running stage for failure
 * reports
 */
export async function verifyBucketLearning({ client, guildId, userId, run, fail, setStage, report }) {
    setStage("bucket_learning_live_headers")
    const originalFetch = globalThis.fetch
    let requests = 0
    let headersObserved = 0
    let clock
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input))
        assert.equal(url.origin, "https://fluxer.com")
        assert.equal(init?.method, "GET")
        assert.ok(url.pathname === "/api/v1/users/@me" || url.pathname === `/api/v1/guilds/${guildId}`)
        requests++
        const response = await originalFetch(input, init)
        assert.ok(response.ok)
        if (/^[a-f0-9]{16}$/.test(response.headers.get("x-ratelimit-bucket") ?? "")) headersObserved++
        if (requests > 3) return response
        // The learned bucket runs on the controlled clock from the third response on, so a slow host cannot let its
        // refill come due before the rejected read. Earlier reads still wait on real time, so a wait the client learned
        // before this stage ends normally instead of stalling on a clock that only moves when advanced
        if (requests === 3) clock = controlledClock()
        const headers = new Headers(response.headers)
        // Override only scheduling metadata on real read responses. This opaque,
        // unrecognized template is intentionally treated as account-wide. The
        // three responses coherently consume a three-request leaky bucket whose
        // first refill remains beyond the following 100 ms admission deadline
        headers.set("x-ratelimit-bucket", "fixture-shared-read-bucket")
        headers.set("x-ratelimit-limit", "3")
        headers.set("x-ratelimit-remaining", String(3 - requests))
        headers.set("x-ratelimit-reset-after", ["0.333", "0.667", "1"][requests - 1])
        return new Response(response.body, { status: response.status, headers })
    }
    try {
        assert.equal((await run(client.users.fetchSelf({ timeoutMs: readTimeoutMs }))).id, userId)
        assert.equal((await run(client.guilds.fetch(guildId, { timeoutMs: readTimeoutMs }))).id, guildId)
        assert.equal((await run(client.users.fetchSelf({ timeoutMs: readTimeoutMs }))).id, userId)
        setStage("bucket_learning_shared_wait")
        // The refill is past the deadline, so the read fails at once with the remaining wait, unsent
        const rejected = await fail(client.guilds.fetch(guildId, { timeoutMs: 100 }))
        assert.equal(rejected.reason, "rateLimit")
        assert.equal(rejected.outcome, "notDispatched")
        assert.ok(rejected.retryAfterMs >= 100)
        assert.equal(requests, 3)
        assert.ok(clock)
        assert.equal(client.diagnostics().rest.queuedRequests, 0)
        report("bucket_learning_shared_wait", {
            passed: true,
            injectedHeaderSets: 3,
            realBucketHeadersObserved: headersObserved,
        })
        setStage("bucket_learning_live_recovery")
        // The injected bucket refills completely
        clock.advance(1_000)
        await clock.restore()
        assert.equal((await run(client.guilds.fetch(guildId, { timeoutMs: readTimeoutMs }))).id, guildId)
        assert.equal(requests, 4)
        assert.equal(client.diagnostics().rest.activeRequests, 0)
        report("bucket_learning_live_recovery", { passed: true, remoteReads: requests, remoteMutations: false })
    } finally {
        globalThis.fetch = originalFetch
        await clock?.restore()
    }
}
