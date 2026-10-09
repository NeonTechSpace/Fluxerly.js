import { EventEmitter } from "node:events"
import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"

const fork = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>()
    return { ...actual, fork }
})

import { supervisor } from "../../../src/index.js"
import { supervisor as nativeSupervisor } from "../../../src/effect.js"
import type { SupervisorOptions } from "../../../src/supervisor.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { hostTurnsUntil } from "../../support/client-clock.js"

afterEach(() => {
    vi.useRealTimers()
    fork.mockReset()
})

type Message = { readonly type: string; readonly [key: string]: unknown }

/**
 * A scripted child process: It says hello, finishes configuration when assigned and records every parent message.
 * With holdShutdown it keeps running after a stop request, as a child that drains its work does
 */
function scriptedChild(pid: number, holdShutdown: boolean) {
    const received: Message[] = []
    const child = Object.assign(new EventEmitter(), {
        pid,
        connected: true,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        received,
        send(message: Message) {
            received.push(message)
            if (message.type === "assignment")
                queueMicrotask(() => child.emit("message", { type: "ready", generation: message.generation }))
            if (message.type === "shutdown" && !holdShutdown) child.exit(0)
            return true
        },
        kill() {
            child.exit(0)
            return true
        },
        exit(code: number) {
            if (!child.connected) return
            child.connected = false
            child.exitCode = code
            queueMicrotask(() => {
                child.emit("disconnect")
                child.emit("exit", code, null)
            })
        },
        /** Send a message to the parent. The parent answers synchronously, so the answer is the last one received */
        tell(message: Message) {
            child.emit("message", message)
            return received.at(-1)
        },
    })
    queueMicrotask(() => child.emit("message", { type: "hello" }))
    return child
}

type Child = ReturnType<typeof scriptedChild>

function forkScripted(holdShutdown = false) {
    const children: Child[] = []
    fork.mockImplementation(() => {
        const child = scriptedChild(300 + children.length, holdShutdown)
        children.push(child)
        return child
    })
    return children
}

async function managed(mode: Mode, options: SupervisorOptions) {
    if (mode === "default") {
        const created = supervisor.create(options)
        return {
            start: async () => expect((await created.start()).isOk()).toBe(true),
            shutdown: () => created.shutdown().then(() => undefined),
        }
    }
    const created = await Effect.runPromise(nativeSupervisor.create(options))
    return {
        start: () => Effect.runPromise(created.start()),
        shutdown: () => Effect.runPromise(created.shutdown()),
    }
}

/** Two or more children with fake host time, which the parent measures pauses and windows with */
async function started(mode: Mode, processes: number, holdShutdown = false) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] })
    const children = forkScripted(holdShutdown)
    const workers = await managed(mode, {
        entry: process.execPath,
        totalShards: processes,
        processes,
        childOutput: "ignore",
        logging: { level: "silent" },
    })
    await workers.start()
    return { children, workers }
}

const globalPauses = (child: Child) => child.received.filter((message) => message.type === "globalPause")

test.each(modes)(
    "%s supervisor relays a global rate-limit pause one child learned to the other children",
    async (mode) => {
        // Catches: A child paused only its own requests after a global 429, so the other children kept sending into
        // Fluxer's account-wide pause and collected more 429s
        const { children, workers } = await started(mode, 3)
        children[0]!.tell({ type: "globalPause", generation: 1, waitMs: 5_000 })
        expect(globalPauses(children[0]!)).toEqual([])
        for (const child of children.slice(1))
            expect(globalPauses(child)).toEqual([{ type: "globalPause", generation: 1, waitMs: 5_000 }])
        // A pause that ends before the account's running pause is not relayed again
        await vi.advanceTimersByTimeAsync(1_000)
        children[1]!.tell({ type: "globalPause", generation: 1, waitMs: 2_000 })
        expect(globalPauses(children[0]!)).toEqual([])
        expect(globalPauses(children[2]!)).toHaveLength(1)
        // A replacement child starts with what remains of the pause, after the one-second restart delay
        children[2]!.exit(1)
        await hostTurnsUntil(() => children[2]!.listenerCount("exit") === 0)
        await vi.advanceTimersByTimeAsync(1_000)
        await hostTurnsUntil(() => children.length === 4 && globalPauses(children[3]!).length > 0)
        expect(globalPauses(children[3]!)).toEqual([{ type: "globalPause", generation: 2, waitMs: 3_000 }])
        await workers.shutdown()
    },
)

test.each(modes)("%s supervisor keeps one member request window for all its children", async (mode) => {
    // Catches: Each child counted only its own member requests, so the children together sent more than Fluxer's 12
    // per account in 10 seconds, and Fluxer dropped the rest without an answer, leaving them to time out
    const { children, workers } = await started(mode, 2)
    const [first, second] = children as [Child, Child]
    let next = 0
    const ask = (child: Child) => child.tell({ type: "memberRequest", generation: 1, requestId: next++ })
    const sent = (child: Child, requestId: number) => child.tell({ type: "memberSent", generation: 1, requestId })
    for (let index = 0; index < 5; index++) {
        const requestId = next
        expect(ask(first)).toEqual({ type: "memberGrant", generation: 1, requestId })
        sent(first, requestId)
    }
    // A withdrawn grant never reached Fluxer, so it frees its slot
    const withdrawn = next
    expect(ask(first)).toEqual({ type: "memberGrant", generation: 1, requestId: withdrawn })
    first.tell({ type: "memberWithdrawn", generation: 1, requestId: withdrawn })
    await vi.advanceTimersByTimeAsync(1_000)
    for (let index = 0; index < 7; index++) expect(ask(second)).toMatchObject({ type: "memberGrant" })
    // The 13th waits for the oldest counted request to leave the 11-second window
    const refused = next
    expect(ask(first)).toEqual({ type: "memberDenied", generation: 1, requestId: refused, retryAfterMs: 10_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ask(second)).toMatchObject({ type: "memberGrant" })
    // A raw member request from gateway.send has no grant but still counts
    for (let index = 0; index < 4; index++) first.tell({ type: "memberSent", generation: 1 })
    expect(ask(second)).toMatchObject({ type: "memberDenied", retryAfterMs: 1_000 })
    await workers.shutdown()
})

test.each(modes)(
    "%s supervisor counts a granted member request from when it reached the socket, or from its holder's exit",
    async (mode) => {
        // Catches: A grant counted only from when it was given, so a request that waited for the socket or a child that
        // exited without reporting its request could leave Fluxer counting a request the window had already dropped
        const { children, workers } = await started(mode, 2)
        const [first, second] = children as [Child, Child]
        let next = 0
        const ask = (child: Child) => child.tell({ type: "memberRequest", generation: 1, requestId: next++ })
        const delayed = next
        ask(first)
        // The child never reports this grant
        ask(first)
        await vi.advanceTimersByTimeAsync(5_000)
        // Reaching the socket moves a grant's count to now rather than adding a second one
        first.tell({ type: "memberSent", generation: 1, requestId: delayed })
        for (let index = 0; index < 10; index++) expect(ask(second)).toMatchObject({ type: "memberGrant" })
        // The child exits holding its other grant, which then counts from the exit
        await vi.advanceTimersByTimeAsync(5_000)
        first.exit(1)
        await hostTurnsUntil(() => first.listenerCount("exit") === 0)
        // Every request counted 5 seconds in has left the window, and so would the grant counted from the start
        await vi.advanceTimersByTimeAsync(6_000)
        for (let index = 0; index < 11; index++) expect(ask(second)).toMatchObject({ type: "memberGrant" })
        expect(ask(second)).toMatchObject({ type: "memberDenied", retryAfterMs: 5_000 })
        await workers.shutdown()
    },
)

test.each(modes)(
    "%s supervisor still answers member requests from children that drain during shutdown",
    async (mode) => {
        // Catches: The parent ignored every child message once shutdown began, so a member request from a draining child
        // got no answer and that child fell back to counting only its own requests
        const { children, workers } = await started(mode, 1, true)
        const stopping = workers.shutdown()
        await hostTurnsUntil(() => children[0]!.received.some((message) => message.type === "shutdown"))
        expect(children[0]!.tell({ type: "memberRequest", generation: 1, requestId: 0 })).toEqual({
            type: "memberGrant",
            generation: 1,
            requestId: 0,
        })
        children[0]!.exit(0)
        await stopping
    },
)
