import assert from "node:assert/strict"
import { test } from "node:test"
import vm from "node:vm"
import { brotliCompressSync, gzipSync } from "node:zlib"
import { buildPlaygroundTsAssets } from "../scripts/playground-ts-assets.mjs"
import { playgroundPresets } from "../src/islands/playground-presets.ts"
import type { MainToTsWorkerMessage, TsCompletionDetails, TsCompletionItem, TsDiagnostic, TsQuickInfo } from "../src/playground-ts/protocol.ts"

interface WorkerHarness {
    readonly assets: Awaited<ReturnType<typeof buildPlaygroundTsAssets>>
    readonly ready: {
        readonly bootMs: number
        readonly fileCount: number
        readonly hasEffect: boolean
        readonly fileName: string
        readonly version: number
        readonly diagnostics: readonly TsDiagnostic[]
    }
    send(message: MainToTsWorkerMessage): void
    next<T extends Record<string, unknown>>(predicate: (msg: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<T>
    readonly fetchedUrls: string[]
}

async function startTsWorkerVm(initialFile: string, initialCode: string): Promise<WorkerHarness> {
    const assets = await buildPlaygroundTsAssets({ minify: true })
    const fetchedUrls: string[] = []
    const listeners: ((event: { data: unknown }) => void)[] = []
    const messages: Record<string, unknown>[] = []
    let wake: (() => void) | undefined

    const next = <T extends Record<string, unknown>>(
        predicate: (msg: Record<string, unknown>) => boolean,
        timeoutMs = 15_000,
    ): Promise<T> =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                wake = undefined
                reject(
                    new Error(
                        `Timed out waiting for TS worker message (seen: ${messages.map((m) => String(m.type)).join(", ")})`,
                    ),
                )
            }, timeoutMs)
            const poll = () => {
                const index = messages.findIndex(predicate)
                if (index >= 0) {
                    clearTimeout(timer)
                    wake = undefined
                    resolve(messages.splice(index, 1)[0] as T)
                    return true
                }
                return false
            }
            if (!poll()) wake = () => void poll()
        })

    const mockFetch = async (url: string) => {
        fetchedUrls.push(url)
        if (url === assets.manifest.coreTypesUrl) {
            return { ok: true, status: 200, json: async () => JSON.parse(assets.coreJson) }
        }
        if (url === assets.manifest.effectTypesUrl) {
            return { ok: true, status: 200, json: async () => JSON.parse(assets.effectJson) }
        }
        return { ok: false, status: 404, json: async () => ({}) }
    }

    const context = vm.createContext({
        console,
        performance,
        TextDecoder,
        TextEncoder,
        fetch: mockFetch,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        addEventListener: (event: string, listener: (event: { data: unknown }) => void) => {
            if (event === "message") listeners.push(listener)
        },
        postMessage: (message: Record<string, unknown>) => {
            messages.push(structuredClone(message))
            wake?.()
        },
    })
    context.globalThis = context
    context.self = context

    vm.runInContext(assets.workerCode, context)

    const send = (message: MainToTsWorkerMessage) => {
        for (const listener of listeners) listener({ data: message })
    }

    const coreBytes = new TextEncoder().encode(assets.coreJson)
    send({
        type: "init",
        coreTypesUrl: assets.manifest.coreTypesUrl,
        effectTypesUrl: assets.manifest.effectTypesUrl,
        coreBuffer: coreBytes.buffer.slice(coreBytes.byteOffset, coreBytes.byteOffset + coreBytes.byteLength),
        fileName: initialFile,
        code: initialCode,
    })

    const ready = await next<{
        type: "ready"
        bootMs: number
        fileCount: number
        hasEffect: boolean
        fileName: string
        version: number
        diagnostics: TsDiagnostic[]
    }>((msg) => msg.type === "ready" || msg.type === "error")
    assert.equal(ready.type, "ready", `TS worker failed to boot: ${JSON.stringify(ready)}`)
    return { assets, ready, send, next, fetchedUrls }
}

test("static TypeScript 6.0 Web Worker provides zero-error presets, member autocomplete, hover docs, squiggles and lazy Effect loading", async () => {
    const first = playgroundPresets[0]!
    const harness = await startTsWorkerVm(first.filename, first.code)

    // Verify wire budgets stay lean, boot returns initial diagnostics and Tier 1 loads zero Effect files on boot
    assert.equal(harness.ready.hasEffect, false, "Non-Effect preset must not eagerly load Effect types")
    assert.deepEqual(harness.ready.diagnostics, [], "Initial preset should return clean diagnostics in ready payload")
    assert.equal(harness.fetchedUrls.length, 0, "Transferred coreBuffer avoids an extra fetch round-trip")
    const workerBrKb = Math.round(brotliCompressSync(Buffer.from(harness.assets.workerCode)).length / 1024)
    const coreBrKb = Math.round(brotliCompressSync(Buffer.from(harness.assets.coreJson)).length / 1024)
    const effectBrKb = Math.round(brotliCompressSync(Buffer.from(harness.assets.effectJson)).length / 1024)
    const coreGzKb = Math.round(gzipSync(Buffer.from(harness.assets.coreJson)).length / 1024)
    assert.ok(workerBrKb < 950, `Expected TS worker brotli < 950 KB, got ${workerBrKb} KB`)
    assert.ok(coreBrKb < 400, `Expected core types brotli < 400 KB, got ${coreBrKb} KB (gzip ${coreGzKb} KB)`)
    assert.ok(effectBrKb < 650, `Expected compacted Effect types brotli < 650 KB, got ${effectBrKb} KB`)

    let seq = 1
    let version = 2

    // 1. Every non-Effect preset typechecks cleanly with 0 diagnostics without loading Effect
    for (const preset of playgroundPresets.filter((p) => p.mode !== "effect")) {
        harness.send({ type: "update", fileName: preset.filename, code: preset.code, version: version++ })
        const diagId = seq++
        harness.send({ type: "diagnostics", id: diagId, fileName: preset.filename, version: version - 1 })
        const res = await harness.next<{ type: "diagnosticsResult"; id: number; diagnostics: TsDiagnostic[] }>(
            (msg) => msg.type === "diagnosticsResult" && msg.id === diagId,
        )
        assert.deepEqual(
            res.diagnostics,
            [],
            `Preset "${preset.id}" had TypeScript diagnostics: ${JSON.stringify(res.diagnostics)}`,
        )
    }
    assert.equal(harness.fetchedUrls.length, 0, "Effect types should still not be fetched for default presets")

    // 2. Real type-aware member completions: builders.embed(). -> title, description, color, field, build
    const embedCode = `import { builders, defineBot } from "@neontechspace/fluxerly"
export default defineBot({
    commands: {
        prefix: "!",
        commands: {
            ping: {
                execute: ({ client, reply }) => {
                    builders.embed().
                    return reply("ok")
                }
            }
        }
    }
})`
    harness.send({ type: "update", fileName: "bot.ts", code: embedCode, version: version++ })
    const embedDotOffset = embedCode.indexOf("builders.embed().") + "builders.embed().".length
    const embedCompleteId = seq++
    const tCompleteStart = performance.now()
    harness.send({
        type: "complete",
        id: embedCompleteId,
        fileName: "bot.ts",
        offset: embedDotOffset,
        triggerCharacter: ".",
        explicit: false,
    })
    const embedRes = await harness.next<{ type: "completeResult"; id: number; items: TsCompletionItem[] }>(
        (msg) => msg.type === "completeResult" && msg.id === embedCompleteId,
    )
    const hotCompleteMs = Math.round(performance.now() - tCompleteStart)
    const embedLabels = new Set(embedRes.items.map((item) => item.label))
    for (const expected of ["title", "description", "color", "field", "footer", "build"]) {
        assert.ok(embedLabels.has(expected), `Expected builders.embed(). to suggest "${expected}"`)
    }
    assert.ok(hotCompleteMs < 500, `Expected hot member completion < 500ms, got ${hotCompleteMs}ms`)

    // 3. Real type-aware client.* member completions and lazy JSDoc completion details
    const clientCode = embedCode.replace("builders.embed().", "client.")
    harness.send({ type: "update", fileName: "bot.ts", code: clientCode, version: version++ })
    const clientDotOffset = clientCode.indexOf("client.") + "client.".length
    const clientCompleteId = seq++
    harness.send({
        type: "complete",
        id: clientCompleteId,
        fileName: "bot.ts",
        offset: clientDotOffset,
        triggerCharacter: ".",
        explicit: false,
    })
    const clientRes = await harness.next<{ type: "completeResult"; id: number; items: TsCompletionItem[] }>(
        (msg) => msg.type === "completeResult" && msg.id === clientCompleteId,
    )
    const clientLabels = new Set(clientRes.items.map((item) => item.label))
    for (const expected of ["messages", "channels", "guilds", "diagnostics", "rest"]) {
        assert.ok(clientLabels.has(expected), `Expected client. to suggest "${expected}"`)
    }

    const detailsId = seq++
    harness.send({
        type: "completionDetails",
        id: detailsId,
        fileName: "bot.ts",
        offset: clientDotOffset,
        name: "diagnostics",
    })
    const detailsRes = await harness.next<{ type: "completionDetailsResult"; id: number; details: TsCompletionDetails | null }>(
        (msg) => msg.type === "completionDetailsResult" && msg.id === detailsId,
    )
    assert.ok(detailsRes.details && detailsRes.details.display.includes("diagnostics"), "Expected completionDetails signature")

    // 4. Real hover quickInfo returns Fluxerly signature and JSDoc
    const hoverOffset = first.code.indexOf("defineBot(") + 2
    harness.send({ type: "update", fileName: first.filename, code: first.code, version: version++ })
    const hoverId = seq++
    harness.send({ type: "hover", id: hoverId, fileName: first.filename, offset: hoverOffset })
    const hoverRes = await harness.next<{ type: "hoverResult"; id: number; info: TsQuickInfo | null }>(
        (msg) => msg.type === "hoverResult" && msg.id === hoverId,
    )
    assert.ok(hoverRes.info && hoverRes.info.display.includes("defineBot"), "Expected hover quickInfo for defineBot")

    // 5. Real import specifier completions list only sandbox-supported modules
    const importCode = `import { } from "@neontechspace/fluxerly"`
    harness.send({ type: "update", fileName: "bot.ts", code: importCode, version: version++ })
    const importId = seq++
    harness.send({
        type: "complete",
        id: importId,
        fileName: "bot.ts",
        offset: importCode.indexOf('"') + 1,
        triggerCharacter: '"',
        explicit: false,
    })
    const importRes = await harness.next<{ type: "completeResult"; id: number; items: TsCompletionItem[] }>(
        (msg) => msg.type === "completeResult" && msg.id === importId,
    )
    assert.ok(importRes.items.some((item) => item.label === "@neontechspace/fluxerly"))
    assert.ok(importRes.items.some((item) => item.label === "@neontechspace/fluxerly/effect"))
    assert.ok(importRes.items.some((item) => item.label === "effect"))

    // 6. Real red squiggles catch type errors on invalid SDK calls and EOF syntax errors, and non-Effect strings like "effective" stay Tier 1
    const badCode = `import { builders, colors, defineBot } from "@neontechspace/fluxerly"
const note = 'from "effective"'
const badColor = colors.parse({ invalid: true })
const badCard = builders.embed().notARealMethod()
export default defineBot({ commands: { prefix: "!", commands: {} } })
export { note, badColor, badCard }
`
    harness.send({ type: "update", fileName: "bot.ts", code: badCode, version: version++ })
    const badDiagId = seq++
    harness.send({ type: "diagnostics", id: badDiagId, fileName: "bot.ts", version: version - 1 })
    const badRes = await harness.next<{ type: "diagnosticsResult"; id: number; diagnostics: TsDiagnostic[] }>(
        (msg) => msg.type === "diagnosticsResult" && msg.id === badDiagId,
    )
    assert.ok(badRes.diagnostics.length >= 2, `Expected >=2 type errors, got: ${JSON.stringify(badRes.diagnostics)}`)
    assert.ok(badRes.diagnostics.some((d) => d.message.includes("notARealMethod")))
    assert.equal(harness.fetchedUrls.length, 0, 'String containing "effective" must not fetch Effect types')

    // Optional-chain completions preserve TypeScript's replacementSpan so accepting ?.hello replaces the preceding dot
    const optCode = `declare const maybe: { hello(): string } | undefined\nmaybe.`
    harness.send({ type: "update", fileName: "bot.ts", code: optCode, version: version++ })
    const optCompleteId = seq++
    harness.send({
        type: "complete",
        id: optCompleteId,
        fileName: "bot.ts",
        offset: optCode.length,
        triggerCharacter: ".",
        explicit: false,
    })
    const optRes = await harness.next<{ type: "completeResult"; id: number; items: TsCompletionItem[] }>(
        (msg) => msg.type === "completeResult" && msg.id === optCompleteId,
    )
    const helloOpt = optRes.items.find((item) => item.label === "hello")
    assert.ok(helloOpt, "Expected optional-chain completion for hello")
    assert.equal(helloOpt.insertText, "?.hello")
    assert.equal(helloOpt.replaceFrom, optCode.length - 1)
    assert.equal(helloOpt.replaceTo, optCode.length)

    // EOF syntax error produces a valid clamped diagnostic without throwing
    const eofCode = `const x =`
    harness.send({ type: "update", fileName: "bot.ts", code: eofCode, version: version++ })
    const eofDiagId = seq++
    harness.send({ type: "diagnostics", id: eofDiagId, fileName: "bot.ts", version: version - 1 })
    const eofRes = await harness.next<{ type: "diagnosticsResult"; id: number; diagnostics: TsDiagnostic[] }>(
        (msg) => msg.type === "diagnosticsResult" && msg.id === eofDiagId,
    )
    assert.ok(eofRes.diagnostics.length >= 1, "Expected EOF syntax diagnostic for `const x =`")

    // 7. On-demand Tier 2 Effect loading: commented import triggers Tier 2 and Effect 4 preset typechecks cleanly
    const commentedEffect = `import { Effect } from /* comment */ "effect"\nexport const prog = Effect.succeed(1)`
    harness.send({ type: "update", fileName: "bot-effect.ts", code: commentedEffect, version: version++ })
    const effectLoaded = await harness.next<{ type: "effectLoaded"; loadMs: number; fileCount: number }>(
        (msg) => msg.type === "effectLoaded",
    )
    assert.ok(effectLoaded.fileCount > 0)
    assert.deepEqual(harness.fetchedUrls, [harness.assets.manifest.effectTypesUrl])
    const commentedDiagId = seq++
    harness.send({ type: "diagnostics", id: commentedDiagId, fileName: "bot-effect.ts", version: version - 1 })
    const commentedDiagRes = await harness.next<{ type: "diagnosticsResult"; id: number; diagnostics: TsDiagnostic[] }>(
        (msg) => msg.type === "diagnosticsResult" && msg.id === commentedDiagId,
    )
    assert.deepEqual(commentedDiagRes.diagnostics, [])

    const effectPreset = playgroundPresets.find((p) => p.mode === "effect")!
    harness.send({ type: "update", fileName: effectPreset.filename, code: effectPreset.code, version: version++ })

    const effectDiagId = seq++
    harness.send({ type: "diagnostics", id: effectDiagId, fileName: effectPreset.filename, version: version - 1 })
    const effectDiagRes = await harness.next<{ type: "diagnosticsResult"; id: number; diagnostics: TsDiagnostic[] }>(
        (msg) => msg.type === "diagnosticsResult" && msg.id === effectDiagId,
    )
    assert.deepEqual(
        effectDiagRes.diagnostics,
        [],
        `Effect preset had TypeScript diagnostics: ${JSON.stringify(effectDiagRes.diagnostics)}`,
    )

    // Unsupported Effect module (Schema) produces a clear TS error because sandbox only exposes 8 Effect modules
    const unsupportedEffect = `import { Schema } from "effect"\nexport { Schema }`
    harness.send({ type: "update", fileName: "bot-effect.ts", code: unsupportedEffect, version: version++ })
    const unsupportedId = seq++
    harness.send({ type: "diagnostics", id: unsupportedId, fileName: "bot-effect.ts", version: version - 1 })
    const unsupportedRes = await harness.next<{ type: "diagnosticsResult"; id: number; diagnostics: TsDiagnostic[] }>(
        (msg) => msg.type === "diagnosticsResult" && msg.id === unsupportedId,
    )
    assert.ok(unsupportedRes.diagnostics.some((d) => d.message.includes("Schema")))
})
