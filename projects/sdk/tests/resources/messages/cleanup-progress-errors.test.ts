import { Effect, Exit, Scope } from "effect"
import { err, errAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type FailureReport, type MessageCleanupProgress } from "../../../src/index.js"
import { createClient as createNative } from "../../../src/effect.js"
import { modes } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"

const configuration = { token: "fixture-only-not-a-credential" }
const wire = (id: string) => ({
    id,
    channel_id: "20",
    content: `private-${id}`,
    author: { id: "30", username: "fixture" },
})

afterEach(() => vi.unstubAllGlobals())

/** Preview and clean up two messages with the given progress callback, returning the client's failure reports */
async function cleanupWith(mode: (typeof modes)[number], onProgress: (event: MessageCleanupProgress) => unknown) {
    const reports: FailureReport[] = []
    const posts: string[] = []
    let reads = 0
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        if (init.method === "POST") {
            posts.push(String(init.body))
            return new Response(null, { status: 204 })
        }
        reads++
        return Response.json(reads === 1 ? [wire("30"), wire("29")] : [])
    })
    if (mode === "default") {
        const client = createClient({ ...configuration, onError: (report) => void reports.push(report) })
        onTestFinished(async () => {
            await client.shutdown()
        })
        const preview = await client.messages.previewCleanup("20", { authorId: "30", maxScanned: 10, maxSelected: 10 })
        if (preview.isErr()) throw preview.error
        const report = await client.messages.cleanup(preview.value, { onProgress })
        if (report.isErr()) throw report.error
    } else {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const client = await Effect.runPromise(
            createNative({
                ...configuration,
                onError: (report) => Effect.sync(() => void reports.push(report)),
            }).pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(
            Effect.gen(function* () {
                const plan = yield* client.messages.previewCleanup("20", {
                    authorId: "30",
                    maxScanned: 10,
                    maxSelected: 10,
                })
                yield* client.messages.cleanup(plan, { onProgress })
            }),
        )
    }
    // Cleanup continues past every progress failure
    expect(posts).toEqual(['{"message_ids":["30","29"]}'])
    return reports
}

test.each(modes)("%s cleanup reports an Err returned or resolved by onProgress like a throw", async (mode) => {
    const returned = new Error("returned progress failure")
    const resolved = new Error("resolved progress failure")
    const reports = await cleanupWith(mode, (event) =>
        event.state === "submitting" ? err(returned) : errAsync(resolved),
    )
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    expect(reports).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ kind: "progress", error: returned }),
            expect.objectContaining({ kind: "progress", error: resolved }),
        ]),
    )
})

test.each(modes)("%s cleanup reports an Effect returned by onProgress as misuse without running it", async (mode) => {
    let ran = 0
    const reports = await cleanupWith(mode, () => Effect.sync(() => void ran++))
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    expect(reports).toEqual([
        expect.objectContaining({ kind: "progress", error: expect.any(TypeError) }),
        expect.objectContaining({ kind: "progress", error: expect.any(TypeError) }),
    ])
    expect(ran).toBe(0)
})
