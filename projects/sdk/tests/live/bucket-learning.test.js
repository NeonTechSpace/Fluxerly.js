import { setTimeout as sleep } from "node:timers/promises"
import { afterEach, expect, test, vi } from "vitest"
import { createClient } from "../../src/index.js"
import { hostedDiscoveryDocument, hostedDiscoveryUrl } from "../../src/internal/testing/discovery.js"
import { fixtures } from "../../src/internal/testing/fixtures.js"
import { verifyBucketLearning } from "./support/bucket-learning.js"

afterEach(() => {
    vi.unstubAllGlobals()
})

// The live stage runs against hosted Fluxer, so the fixture serves its API origin
const discovery = {
    ...hostedDiscoveryDocument,
    endpoints: { ...hostedDiscoveryDocument.endpoints, api_public: "https://fluxer.com/api" },
}

/**
 * Run the learned-bucket stage against fixture reads. `seedHeaders`, when given, adds rate-limit headers to one read
 * made before the stage, and `afterRead` runs after each read the stage makes. Returns the stages the stage set and,
 * for each read that reached transport, the stage that was running
 */
async function runStage({ seedHeaders, afterRead = () => {} }) {
    let stage = "before"
    const sent = []
    vi.stubGlobal("fetch", async (input) => {
        const url = String(input)
        if (url === hostedDiscoveryUrl) return Response.json(discovery)
        sent.push(stage)
        const user = new URL(url).pathname.endsWith("/users/@me")
        return Response.json(user ? fixtures.user({ id: "300", bot: true }) : fixtures.guild({ id: "100" }), {
            headers: stage === "before" ? seedHeaders : undefined,
        })
    })
    const client = createClient({ token: "200.fixture-only-not-a-credential", logging: { level: "silent" } })
    try {
        expect((await client.instance.resolve()).isOk()).toBe(true)
        if (seedHeaders !== undefined) expect((await client.users.fetchSelf()).isOk()).toBe(true)
        let reads = 0
        const stages = []
        await verifyBucketLearning({
            client,
            guildId: "100",
            userId: "300",
            async run(operation) {
                const result = await operation
                expect(result.isOk()).toBe(true)
                await afterRead(++reads)
                return result.value
            },
            async fail(operation) {
                const result = await operation
                expect(result.isErr()).toBe(true)
                return result.error
            },
            setStage(next) {
                stage = next
                stages.push(next)
            },
            report: () => {},
        })
        return { stages, sent }
    } finally {
        await client.shutdown()
    }
}

test("the learned-bucket stage refuses the fourth read even when the host stalls after the third", async () => {
    const { stages, sent } = await runStage({
        // A loaded host pauses longer than the injected bucket takes to refill in real time
        afterRead: (read) => (read === 3 ? sleep(1_100) : undefined),
    })
    expect(stages.at(-1)).toBe("bucket_learning_live_recovery")
    // The refused read never reached transport
    expect(sent).toEqual([
        "bucket_learning_live_headers",
        "bucket_learning_live_headers",
        "bucket_learning_live_headers",
        "bucket_learning_live_recovery",
    ])
})

test("the learned-bucket stage lets a wait learned before it end, then refuses the fourth read", async () => {
    const { stages, sent } = await runStage({
        // The read before the stage leaves a valid bucket with no room for 200 ms
        seedHeaders: {
            "x-ratelimit-bucket": "fixture-prior-bucket",
            "x-ratelimit-limit": "1",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset-after": "0.2",
        },
    })
    expect(stages.at(-1)).toBe("bucket_learning_live_recovery")
    expect(sent).toEqual([
        "before",
        "bucket_learning_live_headers",
        "bucket_learning_live_headers",
        "bucket_learning_live_headers",
        "bucket_learning_live_recovery",
    ])
})
