import { fileURLToPath } from "node:url"
import { expect, test, vi } from "vitest"
import { supervisor } from "../../../src/index.js"
import { maximumForwardedLineLength } from "../../../src/internal/supervisor.js"
import { captureLogs } from "../../support/log-capture.js"
import { requireBuiltSdk } from "../../support/built-sdk.js"

// These tests run the built SDK, so a stale or missing dist fails them before they start
requireBuiltSdk()

const entry = fileURLToPath(new URL("./workers/supervisor-output-worker.js", import.meta.url))
const formatEntry = fileURLToPath(new URL("./workers/supervisor-output-format-worker.js", import.meta.url))

/** Start the format worker under a prefix supervisor and return once its crash has been handled */
async function runFormatWorker(format: "pretty" | "json") {
    const logs = captureLogs()
    const created = supervisor.create({
        entry: formatEntry,
        totalShards: 1,
        assignments: [{ id: "only", shardIds: [0] }],
        restart: false,
        execArgv: [],
        logging: { ...logs.logging, format },
    })
    const started = await created.start()
    expect(started.isErr() && started.error).toMatchObject({ _tag: "SupervisorError", reason: "closed" })
    await created.shutdown()
    return logs
}

function capture() {
    const stdout: string[] = []
    const stderr: string[] = []
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        stdout.push(String(chunk))
        return true
    })
    const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk))
        return true
    })
    return {
        stdout,
        stderr,
        restore: () => {
            out.mockRestore()
            err.mockRestore()
        },
    }
}

test.each([
    ["prefix", ["[shard 0] child stdout line\n"], ["[shard 0] child stderr line\n"]],
    ["ignore", [], []],
] as const)("childOutput %s forwards child lines and records spawn, exit and crash", async (childOutput, out, err) => {
    const logs = captureLogs()
    const streams = capture()
    try {
        const created = supervisor.create({
            entry,
            totalShards: 1,
            assignments: [{ id: "only", shardIds: [0] }],
            restart: false,
            childOutput,
            execArgv: [],
            // Pretty output labels each line. The json format has its own test below
            logging: { ...logs.logging, format: "pretty" },
        })
        const started = await created.start()
        expect(started.isErr() && started.error).toMatchObject({ _tag: "SupervisorError", reason: "closed" })
        await created.shutdown()
        // Exit handling waits for the forwarded output to drain, so every line is present once start settles
        expect(streams.stdout.filter((line) => line.includes("child stdout line"))).toEqual([...out])
        expect(streams.stderr.filter((line) => line.includes("child stderr line"))).toEqual([...err])
    } finally {
        streams.restore()
    }
    expect(logs.codes()).toEqual(["supervisor.spawn", "supervisor.exit", "supervisor.crash"])
    expect(logs.records[1]).toMatchObject({ level: "warn", fields: { child: "only", exitCode: 3, signal: null } })
    expect(logs.records[2]).toMatchObject({ level: "error", category: "supervisor" })
})

test("restarts are recorded with their delay and attempt", async () => {
    const logs = captureLogs()
    const created = supervisor.create({
        entry,
        totalShards: 2,
        assignments: [{ id: "pair", shardIds: [0, 1] }],
        childOutput: "ignore",
        execArgv: [],
        restart: { maxAttempts: 1, minDelayMs: 1, maxDelayMs: 1 },
        // Identical exit records would otherwise collapse into one repeated-record summary
        logging: { ...logs.logging, dedupe: false },
    })
    const started = await created.start()
    expect(started.isErr() && started.error).toMatchObject({ reason: "restartLimit" })
    await created.shutdown()
    expect(logs.codes()).toEqual([
        "supervisor.spawn",
        "supervisor.exit",
        "supervisor.restart",
        "supervisor.spawn",
        "supervisor.exit",
        "supervisor.crash",
    ])
    expect(logs.records[2]).toMatchObject({
        level: "warn",
        fields: { child: "pair", shards: "0,1", restarts: 1, delayMs: 1 },
    })
})

test("pretty prefix output passes the parent format to children and keeps a crash trace written just before exit", async () => {
    vi.stubEnv("FLUXERLY_LOG_FORMAT", undefined)
    vi.stubEnv("FLUXERLY_LOG_COLOR", undefined)
    const streams = capture()
    try {
        await runFormatWorker("pretty")
        // Checked as soon as start settles: exit handling waited for both pipes to drain
        const out = streams.stdout.join("")
        expect(out).toContain("[shard 0] format=pretty color=0\n")
        const long = streams.stdout.find((line) => line.startsWith("[shard 0] long:"))!
        expect(long.length).toBeLessThan(maximumForwardedLineLength + 100)
        expect(long).toContain("[line truncated by the supervisor]")
        const err = streams.stderr.join("")
        expect(err).toContain("[shard 0] Error: final crash\n")
        expect(err).toContain("[shard 0]     at frame3999 (fixture.js:3999:1)\n")
        expect(err).toContain("[shard 0] last stack line\n")
    } finally {
        streams.restore()
        vi.unstubAllEnvs()
    }
})

test("json prefix output stays valid JSON Lines with the child ID in each record", async () => {
    vi.stubEnv("FLUXERLY_LOG_FORMAT", undefined)
    vi.stubEnv("FLUXERLY_LOG_COLOR", undefined)
    const streams = capture()
    try {
        await runFormatWorker("json")
        const lines = (chunks: string[]) =>
            chunks
                .join("")
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => JSON.parse(line) as Record<string, unknown>)
        const out = lines(streams.stdout)
        expect(out).toContainEqual(
            expect.objectContaining({
                code: "supervisor.childOutput",
                message: "format=json color=0",
                fields: { child: "only", shards: "0", stream: "stdout" },
            }),
        )
        // An SDK record keeps its shape and gains the child ID, and other JSON passes through unchanged
        expect(out).toContainEqual(
            expect.objectContaining({ code: "lifecycle.fixture", fields: { shards: 1, child: "only" } }),
        )
        expect(out).toContainEqual({ application: "own json" })
        const long = out.find((record) => String(record.message).startsWith("long:"))!
        expect(String(long.message)).toMatch(/\[line truncated by the supervisor\]$/)
        const err = lines(streams.stderr)
        expect(err).toHaveLength(4_002)
        expect(err.every((record) => record.level === "warn" && record.code === "supervisor.childOutput")).toBe(true)
        expect(err.at(-1)).toMatchObject({ message: "last stack line", fields: { stream: "stderr" } })
    } finally {
        streams.restore()
        vi.unstubAllEnvs()
    }
})

test("prefix output pauses a child stream while the parent stream applies backpressure", async () => {
    const stdout: string[] = []
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        stdout.push(String(chunk))
        return false
    })
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
        const running = runFormatWorker("pretty")
        await vi.waitFor(() => expect(stdout.length).toBeGreaterThan(0))
        // Without a drain event the forwarder writes nothing further, even though the child has more lines
        await new Promise((resolve) => setTimeout(resolve, 100))
        const before = stdout.length
        expect(before).toBe(1)
        while (!stdout.some((line) => line.startsWith("[shard 0] long:"))) {
            process.stdout.emit("drain")
            await new Promise((resolve) => setTimeout(resolve, 5))
        }
        expect(stdout.length).toBeGreaterThan(before)
        await running
    } finally {
        out.mockRestore()
        err.mockRestore()
    }
})
