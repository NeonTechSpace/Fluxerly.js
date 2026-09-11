import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, test } from "vitest"
import { startServer } from "./transport/server.js"

function runChild(mode: string, url: string, entry = "./transport/sdk-process.mjs") {
    const child = spawn(process.execPath, [fileURLToPath(new URL(entry, import.meta.url)), mode, url], {
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

test.each(["ws", "ws-pending"])("selected %s transport releases the child process after completion", async (mode) => {
    const pending = mode === "ws-pending"
    const server = await startServer({ holdHandshake: pending, holdClose: mode === "ws" })
    const run = runChild(mode, server.socketUrl, "./transport/ws-process.mjs")
    onTestFinished(async () => {
        await run.stop()
        await server.close()
    })
    try {
        if (pending) await server.upgraded
        else await run.open
        if (mode === "ws") await server.receivedClose
        run.child.send!("interrupt")
        await run.completed
        const [code, signal] = await run.exited
        expect({ code, signal }).toEqual({ code: 0, signal: null })
        expect(run.stderr()).toBe("")
    } finally {
        await run.stop()
        await server.close()
    }
})

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
