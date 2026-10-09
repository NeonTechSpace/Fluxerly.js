import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Client } from "../../../src/index.js"
import type { Client as NativeClient } from "../../../src/effect.js"
import { TestHarness } from "../../../src/internal/testing/harness.js"
import type { MemberRequestSlot } from "../../../src/internal/member-chunks.js"
import { Opcode } from "../../../src/internal/protocol/gateway.js"
import { SupervisorChildError } from "../../../src/supervisor.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { outcome, sdkClock } from "../../support/client-clock.js"

afterEach(() => {
    vi.doUnmock("#sdk/internal/supervisor")
    vi.restoreAllMocks()
    vi.resetModules()
})

/**
 * The parent side of a supervised child at its IPC boundary: It answers member requests from a script and records
 * what the child reports and shares
 */
function controlledParent(answer: () => MemberRequestSlot) {
    const stop = Deferred.makeUnsafe<void, SupervisorChildError>()
    const connected = Promise.withResolvers<void>()
    const shared: number[] = []
    const reports: string[] = []
    let relay: ((waitMs: number) => void) | undefined
    const bridge = {
        drainMs: 0,
        identifyGate: { permit: (_shard: number, send: () => void) => Effect.sync(send) },
        accountLimits: {
            shareGlobalPause: (waitMs: number) => void shared.push(waitMs),
            onGlobalPause: (listener: (waitMs: number) => void) => {
                relay = listener
            },
            members: { request: () => Effect.sync(answer), sent: () => void reports.push("sent without grant") },
        },
        signal: new AbortController().signal,
        waitForAssignment: () => Effect.succeed({ totalShards: 1, shardIds: [0] }),
        waitForStop: () => Deferred.await(stop),
        ready: () => undefined,
        state: (state: string) => {
            if (state === "Connected") connected.resolve()
        },
        failed: () => undefined,
        close: () => undefined,
        reportDiagnostics: () => undefined,
    }
    return {
        bridge,
        connected: connected.promise,
        shared,
        reports,
        relay: (waitMs: number) => relay!(waitMs),
        stop: () => Deferred.doneUnsafe(stop, Effect.void),
    }
}

type Parent = ReturnType<typeof controlledParent>

/** Run supervisor.child.run of one public API against the parent and a test transport until the client is connected */
async function supervisedChild(mode: Mode, parent: Parent) {
    vi.resetModules()
    vi.doMock("#sdk/internal/supervisor", async (original) => ({
        ...(await original<object>()),
        ChildBridge: { open: () => Effect.succeed(parent.bridge) },
    }))
    const harness = new TestHarness({})
    const { token, ...clientOptions } = harness.clientOptions({})
    const configured = Promise.withResolvers<Client | NativeClient>()
    let running: Promise<unknown>
    if (mode === "default") {
        const { supervisor } = await import("../../../src/index.js")
        running = Promise.resolve(
            supervisor.child.run({ token, clientOptions, configure: ({ client }) => configured.resolve(client) }),
        )
    } else {
        const { supervisor } = await import("../../../src/effect.js")
        running = Effect.runPromiseExit(
            supervisor.child.run({
                token,
                clientOptions,
                configure: ({ client }) => Effect.sync(() => configured.resolve(client)),
            }),
        )
    }
    const client = await configured.promise
    await parent.connected
    onTestFinished(async () => {
        parent.stop()
        await running
        harness.close()
    })
    const memberRequests = () =>
        harness.gateway.commands().filter((command) => command.op === Opcode.requestGuildMembers)
    return {
        harness,
        memberRequests,
        /** The first batch of a member stream for community 40, or the stream's failure */
        firstBatch: async (): Promise<{ value?: unknown; error?: unknown }> => {
            if (mode === "native")
                return outcome(
                    Stream.runHead((client as NativeClient).members.iterateChunks("40", { userIds: ["50"] })).pipe(
                        Effect.map(Option.getOrUndefined),
                    ),
                )
            const iterator = (client as Client).members.iterateChunks("40", { userIds: ["50"] })[Symbol.asyncIterator]()
            try {
                const first = await iterator.next()
                if (first.done) return { value: undefined }
                return first.value.isErr() ? { error: first.value.error } : { value: first.value.value }
            } finally {
                await iterator.return?.()
            }
        },
        rawMemberRequest: (nonce: string) =>
            outcome(
                mode === "default"
                    ? (client as Client).gateway.send(0, Opcode.requestGuildMembers, {
                          guild_id: "40",
                          query: "",
                          limit: 0,
                          nonce,
                      })
                    : (client as NativeClient).gateway.send(0, Opcode.requestGuildMembers, {
                          guild_id: "40",
                          query: "",
                          limit: 0,
                          nonce,
                      }),
            ),
        fetchUser: () =>
            outcome(
                mode === "default"
                    ? (client as Client).users.fetch("60", { timeoutMs: 1_000 })
                    : (client as NativeClient).users.fetch("60", { timeoutMs: 1_000 }),
            ),
    }
}

test.each(modes)("%s supervised child asks its parent before sending a member request", async (mode) => {
    // Catches: A supervised child decided by its own window alone, so its member requests went out even when the
    // other children had used the account's 12 in 10 seconds, and Fluxer dropped them without an answer
    sdkClock()
    const granted: string[] = []
    const answers: MemberRequestSlot[] = [
        { kind: "refused", retryAfterMs: 4_321 },
        { kind: "granted", sent: () => void granted.push("sent"), withdraw: () => void granted.push("withdrawn") },
    ]
    const parent = controlledParent(() => answers.shift()!)
    const child = await supervisedChild(mode, parent)
    expect(await child.firstBatch()).toMatchObject({
        error: { _tag: "MemberChunkError", reason: "rateLimit", retryAfterMs: 4_321 },
    })
    expect(child.memberRequests()).toEqual([])
    const batch = child.firstBatch()
    await vi.waitFor(() => expect(child.memberRequests()).toHaveLength(1))
    expect(granted).toEqual(["sent"])
    const nonce = (child.memberRequests()[0]!.d as { nonce: string }).nonce
    const member = { user: { id: "50", username: "fixture" }, roles: [], joined_at: "2026-10-01T00:00:00.000Z" }
    child.harness.gateway.emit(
        "GUILD_MEMBERS_CHUNK",
        { guild_id: "40", members: [member], chunk_index: 0, chunk_count: 1, nonce },
        undefined,
    )
    expect(await batch).toMatchObject({ value: { guildId: "40", members: [{ userId: "50" }] } })
    // A raw member request is never refused, but the parent counts it
    expect(await child.rawMemberRequest("raw")).toEqual({ value: undefined })
    expect(parent.reports).toEqual(["sent without grant"])
    expect(child.memberRequests()).toHaveLength(2)
})

test.each(modes)(
    "%s supervised child shares a global pause it learned and applies one another child learned",
    async (mode) => {
        // Catches: A child paused only itself after a global 429 and ignored pauses the other children learned, so every
        // child kept sending into Fluxer's account-wide pause. Also catches a child's first request waiting out such a
        // pause in instance discovery, past its own deadline
        const clock = sdkClock()
        const parent = controlledParent(() => ({ kind: "unreachable" }))
        const child = await supervisedChild(mode, parent)
        let fetches = 0
        child.harness.http.respond("GET /users/:id", () => {
            fetches += 1
            return {
                status: 429,
                headers: { "retry-after": "5", "x-ratelimit-global": "true" },
                body: { code: "RATE_LIMITED", message: "You are being rate limited", retry_after: 5, global: true },
            }
        })
        // Another child's pause holds this child's requests without sending them, and is not shared back
        parent.relay(7_000)
        expect(await child.fetchUser()).toMatchObject({ error: { reason: "rateLimit", retryAfterMs: 7_000 } })
        expect(fetches).toBe(0)
        await clock.advance(7_000)
        expect(await child.fetchUser()).toMatchObject({ error: { reason: "rateLimit", retryAfterMs: 5_000 } })
        expect(fetches).toBe(1)
        expect(parent.shared).toEqual([5_000])
    },
)

test.each(modes)(
    "%s supervised child counts only its own member requests when the parent does not answer, and logs that once",
    async (mode) => {
        // Catches: A child whose parent did not answer either waited for the answer or sent the request unchecked, and
        // nothing showed that the account-wide count was missing
        sdkClock()
        const parent = controlledParent(() => ({ kind: "unreachable" }))
        const child = await supervisedChild(mode, parent)
        for (let index = 0; index < 12; index++)
            expect(await child.rawMemberRequest(`raw${index}`)).toEqual({ value: undefined })
        for (let attempt = 0; attempt < 2; attempt++)
            expect(await child.firstBatch()).toMatchObject({ error: { reason: "rateLimit", retryAfterMs: 11_000 } })
        expect(child.memberRequests()).toHaveLength(12)
        expect(child.harness.logs().filter((record) => record.code === "supervisor.memberRequestsLocal")).toEqual([
            expect.objectContaining({ level: "warn", category: "supervisor" }),
        ])
    },
)
