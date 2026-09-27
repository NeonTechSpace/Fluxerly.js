import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, test } from "vitest"
import { startServer } from "../support/transport/server.js"
import { requireBuiltSdk } from "../support/built-sdk.js"

// These tests run the built SDK, so a stale or missing dist fails them before they start
requireBuiltSdk()

function runChild(mode: string, url: string) {
    const entry = fileURLToPath(new URL("../support/transport/sdk-process.js", import.meta.url))
    const child = spawn(process.execPath, [entry, mode, url], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
    })
    const open = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    let stderr = ""
    child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString()
    })
    child.on("message", (message: { event: string }) => {
        if (message.event === "open") open.resolve()
        if (message.event === "completed") completed.resolve()
    })
    const exited = once(child, "exit")
    return {
        child,
        open: open.promise,
        completed: completed.promise,
        stderr: () => stderr,
        exited,
        stop: async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill()
            await exited
        },
    }
}

test.each(["default", "native", "default-pending", "native-pending", "default-forced"])(
    "built %s SDK releases its child process before the fixture closes",
    async (mode) => {
        const pending = mode.endsWith("pending")
        const server = await startServer({ holdHandshake: pending, holdClose: mode.endsWith("forced") })
        const run = runChild(mode, server.socketUrl)
        onTestFinished(async () => {
            await run.stop()
            await server.close()
        })
        try {
            await server.upgraded
            if (pending) run.child.send!("interrupt")
            else {
                await server.send(
                    JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }),
                    JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture-session" } }),
                )
                await run.open
                run.child.send!("shutdown")
            }
            await run.completed
            const [code, signal] = await run.exited
            expect({ code, signal }).toEqual({ code: 0, signal: null })
            expect(run.stderr()).toBe("")
        } finally {
            await run.stop()
            await server.close()
        }
    },
    12_000,
)
