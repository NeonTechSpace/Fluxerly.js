import { fileURLToPath } from "node:url"
import { expect, test, vi } from "vitest"
import { supervisor } from "../../../src/index.js"
import { maximumForwardedLineLength } from "../../../src/internal/supervisor.js"
import { captureLogs } from "../../support/log-capture.js"
import { requireBuiltSdk } from "../../support/built-sdk.js"

// These tests run the built SDK, so a stale or missing dist fails them before they start
requireBuiltSdk()

const entry = fileURLToPath(new URL("./workers/supervisor-output-worker.js", import.meta.url))
const sdkEntry = fileURLToPath(new URL("./workers/supervisor-output-sdk-worker.js", import.meta.url))
const formatEntry = fileURLToPath(new URL("./workers/supervisor-output-format-worker.js", import.meta.url))
const errorEntry = fileURLToPath(new URL("./workers/supervisor-output-error-worker.js", import.meta.url))

/** Start a worker under a prefix supervisor and return once its crash has been handled */
async function runFormatWorker(format: "pretty" | "json", workerEntry = formatEntry) {
    const logs = captureLogs()
    const created = supervisor.create({
        entry: workerEntry,
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

test("pretty prefix output labels readable child records and keeps a crash trace written just before exit", async () => {
    vi.stubEnv("FLUXERLY_LOG_FORMAT", undefined)
    vi.stubEnv("FLUXERLY_LOG_COLOR", undefined)
    const streams = capture()
    try {
        await runFormatWorker("pretty")
        // Checked as soon as start settles: exit handling waited for both pipes to drain
        const out = streams.stdout.join("")
        // Children always log JSON without color, and the parent prints an SDK record as a readable line
        expect(out).toContain("[shard 0] format=json color=0\n")
        expect(out).toMatch(
            /^\[shard 0\] \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} INFO {2}lifecycle {2}\[lifecycle\.fixture\] child record shards=1$/m,
        )
        expect(out).toContain('[shard 0] {"application":"own json"}\n')
        expect(out).not.toContain('"code":"lifecycle.fixture"')
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

test("pretty prefix output hides stack frames of expected SDK errors but keeps those of application errors", async () => {
    const streams = capture()
    try {
        await runFormatWorker("pretty", errorEntry)
        const out = streams.stdout.join("")
        // The SDK error and its SDK cause print as a single process would print them, without frames
        expect(out).toContain("[shard 0]     GuildOperationError [guild.rejected]: Guild rejected")
        expect(out).toContain("[shard 0]     Caused by: RestError [rest.rejected]: Rejected")
        expect(out).toContain("[shard 0]     TypeError: bad input")
        expect(out.match(/at handler \(\/app\/fixture\.js/g)).toHaveLength(1)
        expect(out).toContain("[shard 0]       at handler (/app/fixture.js:10:5)")
    } finally {
        streams.restore()
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

test("a child SDK record reaches a JSON stderr intact while stdout is a terminal and shows readable text there", async () => {
    vi.stubEnv("FLUXERLY_LOG_FORMAT", undefined)
    vi.stubEnv("FLUXERLY_LOG_COLOR", undefined)
    // The parent chooses pretty for a terminal stdout and json for a redirected stderr, as in node bot.js 2> errors.log
    const stdoutTerminal = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
    const stderrTerminal = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true })
    const streams = capture()
    try {
        const logs = captureLogs()
        const created = supervisor.create({
            entry: sdkEntry,
            totalShards: 1,
            assignments: [{ id: "only", shardIds: [0] }],
            restart: false,
            execArgv: [],
            childEnvironment: { FLUXERLY_DEBUG: "unknown-category" },
            logging: logs.logging,
        })
        const started = await created.start()
        expect(started.isErr() && started.error).toMatchObject({ _tag: "SupervisorError", reason: "closed" })
        await created.shutdown()
        const records = streams.stderr
            .join("")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        expect(records).toContainEqual(
            expect.objectContaining({
                level: "warn",
                category: "sdk",
                code: "sdk.unknownDebugCategory",
                fields: expect.objectContaining({ child: "only" }),
            }),
        )
        expect(records.some((record) => record.code === "supervisor.childOutput")).toBe(false)
        // Standard output is a terminal, so the child's Info record is a labeled readable line and not JSON
        const lines = streams.stdout
            .join("")
            .split("\n")
            .filter((line) => line.startsWith("[shard 0] "))
        expect(lines.length).toBeGreaterThan(0)
        // The terminal stream keeps its color, so the level is wrapped in escape codes
        expect(lines.some((line) => /INFO.*lifecycle .*\[lifecycle\.starting\]/.test(line))).toBe(true)
        expect(lines.some((line) => line.startsWith("[shard 0] {"))).toBe(false)
    } finally {
        streams.restore()
        for (const [stream, descriptor] of [
            [process.stdout, stdoutTerminal],
            [process.stderr, stderrTerminal],
        ] as const)
            if (descriptor) Object.defineProperty(stream, "isTTY", descriptor)
            else delete (stream as { isTTY?: boolean }).isTTY
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
    // A paused forwarder waits for the parent stream with one drain listener. A forwarder that resumed without a drain
    // would add another at each later pause
    const listeners = process.stdout.listenerCount("drain")
    const paused = () => expect(process.stdout.listenerCount("drain")).toBe(listeners + 1)
    const long = () => stdout.some((line) => line.startsWith("[shard 0] long:"))
    try {
        const running = runFormatWorker("pretty")
        await vi.waitFor(paused)
        // The first chunk can hold several lines, and they are written together before the stream pauses
        const before = stdout.length
        expect(before).toBeGreaterThan(0)
        expect(long()).toBe(false)
        // Each drain resumes the child stream until the next refused write pauses it again
        do {
            process.stdout.emit("drain")
            await vi.waitFor(paused)
        } while (!long())
        expect(stdout.length).toBeGreaterThan(before)
        await running
    } finally {
        out.mockRestore()
        err.mockRestore()
    }
})
