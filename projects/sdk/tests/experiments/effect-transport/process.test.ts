import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, test } from "vitest"
import { startServer } from "../../transport/server.js"

function runChild(mode: string, url: string) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./process.js", import.meta.url)), mode, url], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
    })
    const open = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    const state = Promise.withResolvers<number>()
    let didComplete = false
    let stderr = ""
    child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString()
    })
    child.on("message", (message: { event: string; readyState?: number }) => {
        if (message.event === "open") open.resolve()
        if (message.event === "completed") {
            didComplete = true
            completed.resolve()
        }
        if (message.event === "state") state.resolve(message.readyState ?? -1)
    })
    const exited = once(child, "exit")
    return {
        child,
        open: open.promise,
        completed: completed.promise,
        state: state.promise,
        didComplete: () => didComplete,
        stderr: () => stderr,
        exited,
        stop: async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill()
            await exited
        },
    }
}

test.each(["http", "socket", "pending"])("%s transport releases the child process after completion", async (mode) => {
    const pending = mode === "pending"
    const server = await startServer({ holdHandshake: pending })
    const run = runChild(mode, mode === "http" ? server.httpUrl : server.socketUrl)
    onTestFinished(async () => {
        await run.stop()
        await server.close()
    })
    try {
        if (mode !== "http") {
            if (pending) await server.upgraded
            else await run.open
            run.child.send!("interrupt")
        }
        await run.completed
        const [code, signal] = await run.exited
        expect({ code, signal }).toEqual({ code: 0, signal: null })
        expect(run.stderr()).toBe("")
    } finally {
        await run.stop()
        await server.close()
    }
})

test("an uncooperative peer leaves native WebSocket shutdown pending until the peer closes", async () => {
    const server = await startServer({ holdClose: true })
    const run = runChild("socket", server.socketUrl)
    onTestFinished(async () => {
        await run.stop()
        await server.close()
    })
    try {
        await run.open
        run.child.send!("interrupt")
        await server.receivedClose
        run.child.send!("inspect")
        expect(await run.state).toBe(WebSocket.CLOSING)
        expect(run.didComplete()).toBe(false)
        // No undocumented handle access or fake successful timeout can force native closure
        await server.releaseClose()
        await run.completed
        const [code, signal] = await run.exited
        expect({ code, signal }).toEqual({ code: 0, signal: null })
        expect(run.stderr()).toBe("")
    } finally {
        await run.stop()
        await server.close()
    }
})
