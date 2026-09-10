import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { Effect, Exit } from "effect"
import { expect, onTestFinished, test, vi } from "vitest"
import { supervisor as defaultSupervisor } from "../src/index.js"
import { supervisor as nativeSupervisor } from "../src/effect.js"
import type { SupervisorOptions } from "../src/supervisor.js"

type Mode = "default" | "native"
type Proof = {
    readonly mode: Mode
    readonly reasons: readonly string[]
    readonly messageBefore: number
    readonly messageAfter: number
    readonly disconnectBefore: number
    readonly disconnectAfter: number
}

function safeCount(value: string | null): number | undefined {
    if (value === null) return undefined
    const count = Number(value)
    return Number.isSafeInteger(count) && count >= 0 && count <= 100 ? count : undefined
}

async function failureFixture() {
    let origin = ""
    let closed = false
    const proofs: Proof[] = []
    const server = createServer((request, response) => {
        const target = new URL(request.url ?? "/", origin)
        if (request.method !== "GET" || target.pathname !== "/supervisor-child-failure-proof") {
            response.statusCode = 404
            response.end()
            return
        }
        const mode = target.searchParams.get("mode")
        const reasons = target.searchParams.getAll("reason")
        const messageBefore = safeCount(target.searchParams.get("messageBefore"))
        const messageAfter = safeCount(target.searchParams.get("messageAfter"))
        const disconnectBefore = safeCount(target.searchParams.get("disconnectBefore"))
        const disconnectAfter = safeCount(target.searchParams.get("disconnectAfter"))
        if (
            (mode !== "default" && mode !== "native") ||
            reasons.some(
                (reason) =>
                    reason !== "Failure:ConnectionError" &&
                    reason !== "Defect" &&
                    reason !== "Interruption" &&
                    reason !== "Unexpected",
            ) ||
            messageBefore === undefined ||
            messageAfter === undefined ||
            disconnectBefore === undefined ||
            disconnectAfter === undefined
        ) {
            response.statusCode = 400
            response.end()
            return
        }
        proofs.push({ mode, reasons, messageBefore, messageAfter, disconnectBefore, disconnectAfter })
        response.statusCode = 204
        response.end()
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing supervisor child failure address")
    origin = `http://127.0.0.1:${address.port}`
    return {
        origin,
        proofs,
        async close() {
            if (closed) return
            closed = true
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

function options(mode: Mode, origin: string): SupervisorOptions {
    const worker = new URL("./supervisor-child-failure-worker.mjs", import.meta.url)
    return {
        entry: mode === "default" ? fileURLToPath(worker) : worker,
        totalShards: 1,
        assignments: [{ id: "failure", shardIds: [0] }],
        startupTimeoutMs: 5_000,
        shutdownTimeoutMs: 1_000,
        childEnvironment: {
            FLUXERLY_SUPERVISOR_FAILURE_ORIGIN: origin,
            FLUXERLY_SUPERVISOR_FAILURE_MODE: mode,
            FLUXERLY_SUPERVISOR_FAILURE_TOKEN: "supervisor-child-failure-token",
        },
    }
}

test.each(["default", "native"] as const)(
    "%s public child helper preserves discovery failure and cleanup defect through its parent lifecycle",
    async (mode) => {
        const fixture = await failureFixture()
        let cleaned = false
        let terminalObserved = false
        let shutdown: (() => Promise<void>) | undefined
        const cleanup = async () => {
            if (cleaned) return
            cleaned = true
            try {
                if (!terminalObserved) await shutdown?.()
            } finally {
                await fixture.close()
            }
        }
        onTestFinished(cleanup)
        try {
            if (mode === "default") {
                const created = defaultSupervisor.create(options(mode, fixture.origin))
                expect(created.isOk()).toBe(true)
                if (created.isErr()) throw created.error
                shutdown = async () => {
                    const result = await created.value.shutdown()
                    if (result.isErr()) throw result.error
                }
                const started = await created.value.start()
                expect(started.isOk()).toBe(true)
                if (started.isErr()) throw started.error
                await vi.waitFor(() => expect(fixture.proofs).toHaveLength(1), { timeout: 5_000 })
                const terminal = await created.value.waitForClose()
                expect(terminal.isErr()).toBe(true)
                if (terminal.isOk()) throw new Error("Expected default supervisor child failure")
                expect(terminal.error).toMatchObject({ _tag: "SupervisorError", childId: "failure", reason: "closed" })
                terminalObserved = true
                expect(created.value.status()).toMatchObject({
                    state: "failed",
                    children: [{ id: "failure", generation: 1, pid: null, restarts: 0, state: "failed" }],
                })
            } else {
                const owner = await Effect.runPromise(nativeSupervisor.create(options(mode, fixture.origin)))
                shutdown = () => Effect.runPromise(owner.shutdown())
                await Effect.runPromise(owner.start())
                await vi.waitFor(() => expect(fixture.proofs).toHaveLength(1), { timeout: 5_000 })
                const terminal = await Effect.runPromiseExit(owner.waitForClose())
                expect(Exit.isFailure(terminal)).toBe(true)
                if (Exit.isSuccess(terminal)) throw new Error("Expected native supervisor child failure")
                expect(terminal.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({
                            _tag: "SupervisorError",
                            childId: "failure",
                            reason: "closed",
                        }),
                    }),
                )
                terminalObserved = true
                expect(owner.status()).toMatchObject({
                    state: "failed",
                    children: [{ id: "failure", generation: 1, pid: null, restarts: 0, state: "failed" }],
                })
            }
            expect(fixture.proofs).toHaveLength(1)
            const proof = fixture.proofs[0]!
            expect(proof).toMatchObject({
                mode,
                messageBefore: expect.any(Number),
                messageAfter: expect.any(Number),
                disconnectBefore: expect.any(Number),
                disconnectAfter: expect.any(Number),
            })
            expect(proof.reasons).toEqual(expect.arrayContaining(["Failure:ConnectionError", "Defect"]))
            expect(proof.messageAfter).toBe(proof.messageBefore)
            expect(proof.disconnectAfter).toBe(proof.disconnectBefore)
        } finally {
            await cleanup()
        }
    },
    10_000,
)
