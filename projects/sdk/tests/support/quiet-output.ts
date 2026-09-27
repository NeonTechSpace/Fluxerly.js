/**
 * Vitest setup that keeps SDK log output out of passing test reports without hiding it from failures.
 *
 * Clients print their default log records to the console, supervised children forward labelled lines to standard
 * output, and fallback diagnostics go to standard error. This file captures those lines per test and prints them
 * after a failed test, so a failure still shows what the SDK logged. Other output passes through unchanged, and
 * spies installed by a test observe every call before capture
 */
import { format } from "node:util"
import { afterEach, beforeEach } from "vitest"

const maxCapturedLines = 2_000

const recordPatterns = [
    // JSON records, optionally forwarded by a supervisor with a child label
    /^(?:\[(?:shard \d+|child [^\]\n]+)\] )?\{"time":"[^"]+","level":"[a-z]+","category":"[a-z]+","code":"/,
    // Pretty records with their indented fields and stacks
    /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] [A-Z]+ \(#\d+\):[\s\S]*fluxerly\.code/,
    // Built-in pretty console lines, used when a stream is a terminal or the format is pretty
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} (?:TRACE|DEBUG|INFO |WARN |ERROR|FATAL) (?:lifecycle|gateway|rest|ratelimit|cache|events|commands|collectors|supervisor|sdk) /,
    // Every line a supervisor forwards from a child process
    /^\[(?:shard \d+|child [^\]\n]+)\] /,
    // Fallback diagnostics written when a log sink or timer callback fails
    /^Fluxerly [^\n]* failed: /,
]

// oxlint-disable-next-line no-control-regex -- matches ANSI color escapes, which begin with the escape control character
const ansiEscape = /\u001b\[[0-9;]*m/g

let captured: string[] = []
let omitted = 0

function isSdkOutput(text: string) {
    return recordPatterns.some((pattern) => pattern.test(text))
}

function capture(text: string) {
    if (captured.length >= maxCapturedLines) {
        omitted++
        return
    }
    captured.push(text.endsWith("\n") ? text : `${text}\n`)
}

function wrapStream(stream: NodeJS.WriteStream) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        const text =
            typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : ""
        if (text !== "" && text.split("\n").every((line) => line === "" || isSdkOutput(line))) {
            capture(text)
            const callback = rest.find((value) => typeof value === "function") as (() => void) | undefined
            callback?.()
            return true
        }
        return write(chunk, ...rest)
    }) as typeof stream.write
    return write
}

function wrapConsole(method: "log" | "info" | "warn" | "error" | "debug") {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
        // Effect's logger passes a native client's record as several arguments, possibly colored
        const text = format(...args).replace(ansiEscape, "")
        if (isSdkOutput(text)) capture(text)
        else original(...args)
    }
}

const writeError = wrapStream(process.stderr)
wrapStream(process.stdout)
for (const method of ["log", "info", "warn", "error", "debug"] as const) wrapConsole(method)

beforeEach((context) => {
    captured = []
    omitted = 0
    context.onTestFailed(() => {
        if (captured.length === 0) return
        const lines = captured
        const skipped = omitted
        captured = []
        omitted = 0
        writeError(
            `\n--- SDK output captured during "${context.task.name}" ---\n${lines.join("")}${
                skipped > 0 ? `... ${skipped} later lines omitted\n` : ""
            }--- end of captured SDK output ---\n`,
        )
    })
})

// runBot marks a failed run by setting process.exitCode, which must not leak from a test into the test process
let exitCode: typeof process.exitCode
beforeEach(() => {
    exitCode = process.exitCode
})
afterEach(() => {
    process.exitCode = exitCode
})
