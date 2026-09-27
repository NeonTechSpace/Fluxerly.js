import { err, errAsync, ok } from "neverthrow"
import { afterEach, expect, test, vi } from "vitest"
import { modes } from "../../support/both-apis.js"
import { monotonicClock } from "../../support/clock.js"
import { act, attach, commandFixture, connect, createRouter } from "./command-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test("default command callbacks that return or resolve an Err result are reported like thrown errors", async () => {
    const remote = await commandFixture()
    const connected = await connect("default")
    const failures = {
        execute: new Error("execute result"),
        asyncExecute: new Error("async execute result"),
        onReject: new Error("rejection feedback result"),
        onUnmatched: new Error("unmatched feedback result"),
        store: new Error("cooldown store result"),
    }
    const executed: string[] = []
    const router = createRouter("default", {
        prefix: "!",
        onUnmatched: () => errAsync(failures.onUnmatched),
    }).registerMany({
        sync: { execute: () => err(failures.execute) },
        async: { execute: async () => err(failures.asyncExecute) },
        denied: { guard: () => false, onReject: () => err(failures.onReject), execute: () => undefined },
        stored: {
            cooldown: { durationMs: 1_000, store: { claim: () => err(failures.store) as never } },
            execute: () => void executed.push("stored"),
        },
        fine: { execute: () => ok("ignored success value") },
    })
    const reports = await attach(connected, router, { concurrency: 1 })

    for (const content of ["!sync", "!async", "!denied", "!stored", "!missing", "!fine"]) remote.deliver(content)
    await vi.waitFor(() => expect(connected.logs.withCode("commands.executed")).toHaveLength(1))
    await vi.waitFor(() => expect(reports).toHaveLength(5))

    expect(reports.map((report) => [report.command, report.error])).toEqual([
        ["sync", failures.execute],
        ["async", failures.asyncExecute],
        ["denied", failures.onReject],
        ["stored", failures.store],
        [undefined, failures.onUnmatched],
    ])
    expect(executed).toEqual([])
    expect(connected.logs.withCode("commands.executed")[0]).toMatchObject({ command: "fine" })
})

test.each(modes)("%s commands.executed measures durationMs on the Effect Clock", async (mode) => {
    const remote = await commandFixture()
    const connected = await connect(mode)
    const clock = monotonicClock()
    // The command takes five seconds of the Effect Clock's monotonic time and no wall-clock time
    const router = createRouter(mode, { prefix: "!" }).registerMany({
        slow: { execute: () => act(mode, () => clock.advance(5_000)) },
    })
    await attach(connected, router)
    remote.deliver("!slow")
    await vi.waitFor(() => expect(connected.logs.withCode("commands.executed")).toHaveLength(1))
    expect(connected.logs.withCode("commands.executed")[0]!.durationMs).toBeGreaterThanOrEqual(5_000)
})
