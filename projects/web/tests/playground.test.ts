import assert from "node:assert/strict"
import { test } from "node:test"
import vm from "node:vm"
import { bundlePlaygroundRuntime } from "../scripts/playground-runtime.mjs"
import { playgroundPresets } from "../src/islands/playground-presets.ts"

// Executes the real esbuild browser bundle inside a Node VM with browser-only globals (no Node process/Buffer/setImmediate)
async function startSandboxVm() {
    const bundle = await bundlePlaygroundRuntime({ minify: false })
    const listeners: ((event: { data: unknown }) => void)[] = []
    const messages: Record<string, unknown>[] = []
    let wake: (() => void) | undefined

    const nextMessage = (type: string, timeoutMs = 8000): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timed out waiting for "${type}" (seen: ${messages.map((m) => String(m.type)).join(", ")})`)),
                timeoutMs,
            )
            const poll = () => {
                const index = messages.findIndex((item) => item.type === type)
                if (index >= 0) {
                    clearTimeout(timer)
                    resolve(messages.splice(index, 1)[0]!)
                    return true
                }
                return false
            }
            if (!poll()) wake = () => void poll()
        })

    const channels: MessageChannel[] = []
    class TrackedMessageChannel extends MessageChannel {
        constructor() {
            super()
            channels.push(this)
        }
    }

    const context = vm.createContext({
        console,
        performance,
        crypto,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        Response,
        Request,
        Headers,
        FormData,
        Blob,
        File,
        AbortController,
        AbortSignal,
        MessageChannel: TrackedMessageChannel,
        queueMicrotask,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        btoa,
        atob,
        structuredClone,
        addEventListener: (event: string, listener: (event: { data: unknown }) => void) => {
            if (event === "message") listeners.push(listener)
        },
        parent: {
            postMessage: (message: Record<string, unknown>) => {
                messages.push(message)
                wake?.()
            },
        },
    })
    context.globalThis = context
    context.window = context
    context.self = context

    vm.runInContext(bundle, context)
    const booted = await nextMessage("booted")
    const send = (message: Record<string, unknown>) => {
        for (const listener of listeners) listener({ data: message })
    }
    const close = async () => {
        send({ type: "dispose" })
        await new Promise((resolve) => setTimeout(resolve, 40))
        for (const ch of channels) {
            ch.port1.close()
            ch.port2.close()
        }
    }
    return { booted, send, nextMessage, messages, close }
}

test("real browser Fluxerly SDK runtime boots and executes every playground preset", async () => {
    const sandbox = await startSandboxVm()
    try {
        assert.equal(sandbox.booted.type, "booted")
        assert.equal(typeof sandbox.booted.sdkVersion, "string")

        let runSeq = 1
        let reqSeq = 1
        for (const preset of playgroundPresets) {
            sandbox.send({ type: "run", runId: runSeq++, mode: preset.mode, code: preset.code })
            const runResult = await sandbox.nextMessage("runResult")
            assert.equal(runResult.ok, true, `Preset "${preset.id}" failed to run: ${JSON.stringify(runResult.error)}`)
            assert.equal(runResult.interactive, true, `Preset "${preset.id}" must connect an interactive createTestBot`)

            const firstMessage = preset.quickMessages[0]!
            sandbox.send({ type: "say", requestId: reqSeq++, content: firstMessage })
            const sayResult = await sandbox.nextMessage("sayResult")
            assert.equal(sayResult.ok, true, `Preset "${preset.id}" say("${firstMessage}") failed`)
            const replies = sayResult.replies as { content: string; embeds: unknown[] }[]
            assert.ok(replies.length >= 1, `Preset "${preset.id}" should reply to "${firstMessage}"`)
        }

        // Verify real fault injection (429 automatic retry, 403 Result error and gateway disconnect resume)
        const resilience = playgroundPresets.find((preset) => preset.id === "resilience")!
        sandbox.send({ type: "run", runId: runSeq++, mode: resilience.mode, code: resilience.code })
        assert.equal((await sandbox.nextMessage("runResult")).ok, true)

        sandbox.send({ type: "fault", requestId: reqSeq++, fault: "429" })
        assert.equal((await sandbox.nextMessage("faultResult")).ok, true)
        sandbox.send({ type: "say", requestId: reqSeq++, content: "!ping" })
        const after429 = await sandbox.nextMessage("sayResult")
        assert.equal(after429.ok, true)
        assert.equal((after429.replies as unknown[]).length, 1)
        assert.equal(((after429.telemetry as { counters: { rateLimitWaits: number } }).counters).rateLimitWaits, 1)

        sandbox.send({ type: "fault", requestId: reqSeq++, fault: "403" })
        assert.equal((await sandbox.nextMessage("faultResult")).ok, true)
        sandbox.send({ type: "say", requestId: reqSeq++, content: "!ping" })
        const after403 = await sandbox.nextMessage("sayResult")
        assert.equal(after403.ok, true)
        assert.equal((after403.replies as unknown[]).length, 0)

        sandbox.send({ type: "fault", requestId: reqSeq++, fault: "disconnect" })
        const afterDisconnect = await sandbox.nextMessage("faultResult")
        assert.equal(afterDisconnect.ok, true)
        assert.equal(((afterDisconnect.telemetry as { counters: { resumes: number } }).counters).resumes, 1)
    } finally {
        await sandbox.close()
    }
})
