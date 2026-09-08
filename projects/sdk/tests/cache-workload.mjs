import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const mode = process.argv[2]
const child = process.argv.includes("--child")
const samples = 5
const channelId = "1000000000000000000"
const maxEntries = 1_000
const maxBytes = 8 * 1024 * 1024
const pages = 10
const pageSize = 100
const rounds = 100

assert.ok(mode === "default" || mode === "effect")

if (!child) {
    for (let sample = 1; sample <= samples; sample++) {
        const result = spawnSync(
            process.execPath,
            [...process.execArgv, process.argv[1], mode, "--child", `--sample=${sample}`],
            { encoding: "utf8", timeout: 120_000 },
        )
        assert.equal(result.error, undefined)
        assert.equal(result.status, 0, result.stderr)
        process.stdout.write(result.stdout)
    }
} else {
    const sample = Number(process.argv.find((argument) => argument.startsWith("--sample="))?.slice("--sample=".length))
    assert.ok(Number.isSafeInteger(sample) && sample >= 1 && sample <= samples)
    const rawFetch = globalThis.fetch
    let offset = 0
    let requests = 0
    globalThis.fetch = async (input, init) => {
        const url = new URL(input)
        assert.equal(url.origin, "https://api.fluxer.app")
        assert.equal(url.pathname, `/v1/channels/${channelId}/messages`)
        assert.equal(url.searchParams.get("limit"), String(pageSize))
        assert.equal(init?.method, "GET")
        requests++
        const rows = Array.from({ length: pageSize }, (_, index) => {
            const ordinal = maxEntries - offset - index - 1
            return {
                id: (2_000_000_000_000_000_000n + BigInt(ordinal)).toString(),
                channel_id: channelId,
                content: `${String(ordinal).padStart(8, "0")}${"a".repeat(192)}`,
                author: {
                    id: (3_000_000_000_000_000_000n + BigInt(ordinal % 100)).toString(),
                    username: "SyntheticUser00000000000000000000",
                    bot: false,
                },
            }
        })
        offset += pageSize
        return Response.json(rows)
    }

    try {
        const configuration = {
            token: "synthetic-not-a-credential",
            cache: { messages: { maxEntries, maxBytes } },
        }
        if (mode === "default") {
            const { createClient } = await import("@neontechspace/fluxerly")
            const created = createClient(configuration)
            assert.ok(created.isOk())
            const client = created.value
            const references = []
            for (let page = 0; page < pages; page++) {
                const result = await client.messages.fetchHistory(channelId, { limit: pageSize })
                assert.ok(result.isOk())
                for (const message of result.value) {
                    assert.ok(Object.isFrozen(message) && Object.isFrozen(message.author))
                    references.push({ id: message.id, channelId })
                }
            }
            assert.equal(references.length, maxEntries)
            assert.equal(requests, pages)
            const beforeLookups = requests
            const started = performance.now()
            let observed = 0
            for (let round = 0; round < rounds; round++) {
                for (const reference of references) {
                    const cached = client.messages.get(reference)
                    assert.ok(cached.isOk())
                    observed += cached.value.content.length
                }
            }
            const elapsedMs = performance.now() - started
            assert.equal(requests, beforeLookups)
            assert.equal(observed, rounds * maxEntries * 200)
            assert.ok((await client.shutdown()).isOk())
            assert.equal(client.state, "Closed")
            console.log(
                JSON.stringify({
                    sample,
                    mode,
                    check: "repeated_lookup_and_bulk_history",
                    pages,
                    pageSize,
                    lookupOperations: rounds * maxEntries,
                    elapsedMs,
                    operationsPerSecond: (rounds * maxEntries * 1_000) / elapsedMs,
                    requests,
                }),
            )
        } else {
            const { Effect, Exit } = await import("effect")
            const { createClient } = await import("@neontechspace/fluxerly/effect")
            let client
            const exit = await Effect.runPromiseExit(
                Effect.scoped(
                    Effect.gen(function* () {
                        client = yield* createClient(configuration)
                        const references = []
                        for (let page = 0; page < pages; page++) {
                            const result = yield* client.messages.fetchHistory(channelId, { limit: pageSize })
                            for (const message of result) {
                                assert.ok(Object.isFrozen(message) && Object.isFrozen(message.author))
                                references.push({ id: message.id, channelId })
                            }
                        }
                        assert.equal(references.length, maxEntries)
                        assert.equal(requests, pages)
                        const beforeLookups = requests
                        const started = performance.now()
                        let observed = 0
                        for (let round = 0; round < rounds; round++) {
                            for (const reference of references) {
                                const cached = yield* client.messages.get(reference)
                                observed += cached.content.length
                            }
                        }
                        const elapsedMs = performance.now() - started
                        assert.equal(requests, beforeLookups)
                        assert.equal(observed, rounds * maxEntries * 200)
                        return { elapsedMs }
                    }),
                ),
            )
            assert.ok(Exit.isSuccess(exit))
            assert.equal(client.state, "Closed")
            console.log(
                JSON.stringify({
                    sample,
                    mode,
                    check: "repeated_lookup_and_bulk_history",
                    pages,
                    pageSize,
                    lookupOperations: rounds * maxEntries,
                    elapsedMs: exit.value.elapsedMs,
                    operationsPerSecond: (rounds * maxEntries * 1_000) / exit.value.elapsedMs,
                    requests,
                }),
            )
        }
    } finally {
        globalThis.fetch = rawFetch
    }
}
