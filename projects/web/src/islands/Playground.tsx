// Zero-backend, isolated browser SDK sandbox running the real @neontechspace/fluxerly SDK + createTestBot
// inside a sandbox="allow-scripts" iframe (opaque origin, connect-src 'none') communicating strictly via postMessage
import { useCallback, useEffect, useId, useRef, useState } from "react"
import {
    ArrowClockwiseIcon,
    CheckIcon,
    LightningIcon,
    PaperPlaneTiltIcon,
    PlayIcon,
    PlugsIcon,
    ShareNetworkIcon,
    TerminalWindowIcon,
    WarningCircleIcon,
} from "@phosphor-icons/react"
import { getExperience, subscribeExperience } from "../lib/experience"
import type {
    ParentToSandboxMessage,
    SandboxBotReply,
    SandboxConsoleEntry,
    SandboxEmbed,
    SandboxErrorPayload,
    SandboxFaultKind,
    SandboxMode,
    SandboxTelemetry,
    SandboxToParentMessage,
} from "../playground-runtime/protocol"
import CodeEditor from "./CodeEditor"
import { getPreset, playgroundPresets, type PlaygroundPreset } from "./playground-presets"
import "./playground.css"

type InspectorTab = "logs" | "rest" | "gateway"

interface ChatItem {
    readonly id: number
    readonly kind: "user" | "bot" | "system" | "error"
    readonly author?: string
    readonly text: string
    readonly embeds?: readonly SandboxEmbed[]
    readonly badge?: string
}

const emptyTelemetry: SandboxTelemetry = {
    logs: [],
    requests: [],
    gateway: [],
    counters: {
        restRetries: 0,
        rateLimitWaits: 0,
        reconnects: 0,
        resumes: 0,
        commandRejections: 0,
        handlerFailures: 0,
    },
    failures: 0,
}

let runtimeScriptPromise: Promise<string> | undefined
const maxShareTokenChars = 65_536
const maxSharePayloadBytes = 65_536
const maxChatItems = 120
const runTimeoutMs = 8_000

function loadRuntimeScript(): Promise<string> {
    if (!runtimeScriptPromise) {
        runtimeScriptPromise = fetch("/playground/runtime.js")
            .then(async (response) => {
                if (!response.ok) throw new Error(`Could not load playground runtime (HTTP ${response.status})`)
                return response.text()
            })
            .catch((error: unknown) => {
                runtimeScriptPromise = undefined
                throw error
            })
    }
    return runtimeScriptPromise
}

function buildSandboxSrcDoc(runtimeScript: string): string {
    // Run the bundled SDK runtime inside a dedicated blob Web Worker owned by the opaque-origin srcdoc iframe.
    // The Worker inherits the opaque null origin and connect-src 'none' CSP while keeping synchronous infinite loops
    // off the main UI thread so the timeout watchdog and Reset button remain responsive and can terminate execution
    const encodedRuntime = JSON.stringify(runtimeScript).replace(/</g, "\\u003c")
    const bootstrap = [
        `(function(){`,
        `var runtimeCode=${encodedRuntime};`,
        `var workerUrl=URL.createObjectURL(new Blob([runtimeCode],{type:"text/javascript"}));`,
        `var worker=null;`,
        `var activeRunId=0;`,
        `var emptyTelemetry={logs:[],requests:[],gateway:[],counters:{restRetries:0,rateLimitWaits:0,reconnects:0,resumes:0,commandRejections:0,handlerFailures:0},failures:0};`,
        `function spawnWorker(){`,
        `if(worker){worker.terminate();worker=null;}`,
        `worker=new Worker(workerUrl);`,
        `worker.onmessage=function(event){window.parent.postMessage(event.data,"*");};`,
        `worker.onerror=function(event){`,
        `window.parent.postMessage({type:"runResult",runId:activeRunId,ok:false,compileMs:0,runMs:0,interactive:false,botName:"fluxerly-bot",telemetry:emptyTelemetry,error:{name:"WorkerError",message:(event&&event.message)||"Sandbox worker stopped unexpectedly"}},"*");`,
        `};`,
        `}`,
        `spawnWorker();`,
        `window.addEventListener("message",function(event){`,
        `if(event.source!==window.parent)return;`,
        `var data=event.data;`,
        `if(!data||typeof data!=="object")return;`,
        `if(data.type==="terminate"){if(worker){worker.terminate();worker=null;}return;}`,
        `if(data.type==="restart"){spawnWorker();return;}`,
        `if(data.type==="run"&&typeof data.runId==="number"){activeRunId=data.runId;}`,
        `if(!worker)spawnWorker();`,
        `worker.postMessage(data);`,
        `});`,
        `})();`,
    ].join("")
    return [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\' blob:; worker-src blob:; connect-src \'none\'; img-src \'none\'; style-src \'none\'; form-action \'none\';">',
        "</head><body>",
        `<script>${bootstrap}</script>`,
        "</body></html>",
    ].join("")
}

function toBase64Url(bytes: Uint8Array): string {
    let binary = ""
    for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]!)
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): Uint8Array {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
}

async function encodeShareState(payload: { preset: string; mode: SandboxMode; code: string }): Promise<string | null> {
    const raw = new TextEncoder().encode(JSON.stringify(payload))
    if (raw.byteLength > maxSharePayloadBytes) return null
    let token: string
    if (typeof CompressionStream === "function") {
        const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))
        const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
        token = `z.${toBase64Url(compressed)}`
    } else {
        token = `r.${toBase64Url(raw)}`
    }
    if (token.length > maxShareTokenChars) return null
    return token
}

async function readStreamWithByteCap(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            total += value.byteLength
            if (total > maxBytes) {
                await reader.cancel().catch(() => {})
                return null
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
    }
    return merged
}

function parseSharePayload(value: unknown): { preset?: string; mode?: SandboxMode; code: string } | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (typeof record.code !== "string") return null
    const preset = typeof record.preset === "string" ? record.preset : undefined
    const mode = record.mode === "default" || record.mode === "effect" ? record.mode : undefined
    return { code: record.code, ...(preset ? { preset } : {}), ...(mode ? { mode } : {}) }
}

async function decodeShareState(token: string): Promise<{ preset?: string; mode?: SandboxMode; code: string } | null> {
    if (token.length > maxShareTokenChars) return null
    try {
        if (token.startsWith("z.") && typeof DecompressionStream === "function") {
            const bytes = new Uint8Array(fromBase64Url(token.slice(2)))
            if (bytes.byteLength > maxSharePayloadBytes) return null
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
            const raw = await readStreamWithByteCap(stream, maxSharePayloadBytes)
            if (!raw) return null
            return parseSharePayload(JSON.parse(new TextDecoder().decode(raw)))
        }
        if (token.startsWith("r.")) {
            const bytes = fromBase64Url(token.slice(2))
            if (bytes.byteLength > maxSharePayloadBytes) return null
            return parseSharePayload(JSON.parse(new TextDecoder().decode(bytes)))
        }
    } catch {
        return null
    }
    return null
}

async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {
        // Fall through to legacy textarea copy when served over non-localhost HTTP
    }
    try {
        const area = document.createElement("textarea")
        area.value = text
        area.setAttribute("readonly", "")
        area.style.position = "fixed"
        area.style.opacity = "0"
        document.body.append(area)
        area.select()
        const ok = document.execCommand("copy")
        area.remove()
        return ok
    } catch {
        return false
    }
}

function colorHex(color: number | undefined): string {
    if (typeof color !== "number" || !Number.isFinite(color)) return "#46e3ef"
    return `#${Math.max(0, Math.min(0xffffff, Math.round(color))).toString(16).padStart(6, "0")}`
}

function EmbedPreview({ embed }: { readonly embed: SandboxEmbed }) {
    return (
        <div className="pg-embed-card" style={{ borderLeftColor: colorHex(embed.color) }}>
            {embed.authorName && <div className="pg-embed-author">{embed.authorName}</div>}
            {embed.title && <div className="pg-embed-title">{embed.title}</div>}
            {embed.description && <div className="pg-embed-desc">{embed.description}</div>}
            {embed.fields.length > 0 && (
                <div className="pg-embed-fields">
                    {embed.fields.map((field, index) => (
                        <div key={index} className="pg-embed-field" data-inline={field.inline || undefined}>
                            <span className="pg-embed-fname">{field.name}</span>
                            <span className="pg-embed-fval">{field.value}</span>
                        </div>
                    ))}
                </div>
            )}
            {embed.footerText && <div className="pg-embed-footer">{embed.footerText}</div>}
        </div>
    )
}

export default function Playground() {
    const baseId = useId()
    const [still, setStill] = useState(false)
    const [presetId, setPresetId] = useState<string>(playgroundPresets[0]!.id)
    const [mode, setMode] = useState<SandboxMode>(playgroundPresets[0]!.mode)
    const [code, setCode] = useState<string>(playgroundPresets[0]!.code)
    const [autoRun, setAutoRun] = useState(true)
    const [advanced, setAdvanced] = useState(false)

    const [iframeSrcDoc, setIframeSrcDoc] = useState<string | null>(null)
    const [iframeKey, setIframeKey] = useState(0)
    const [bootState, setBootState] = useState<"loading" | "ready" | "error">("loading")
    const [bootError, setBootError] = useState<string | null>(null)
    const [bootMs, setBootMs] = useState<number | null>(null)
    const [sdkVersion, setSdkVersion] = useState<string>("")

    const [running, setRunning] = useState(false)
    const [interactive, setInteractive] = useState(false)
    const [sharedPendingRun, setSharedPendingRun] = useState(false)
    const [hashSettled, setHashSettled] = useState(false)
    const [sandboxTimedOut, setSandboxTimedOut] = useState(false)
    const [compileMs, setCompileMs] = useState<number | null>(null)
    const [runMs, setRunMs] = useState<number | null>(null)
    const [runError, setRunError] = useState<SandboxErrorPayload | null>(null)

    const [chat, setChat] = useState<ChatItem[]>([])
    const [draft, setDraft] = useState(playgroundPresets[0]!.quickMessages[0] ?? "!ping")
    const [sending, setSending] = useState(false)
    const [armedFault, setArmedFault] = useState<Exclude<SandboxFaultKind, "disconnect"> | null>(null)

    const [inspectorTab, setInspectorTab] = useState<InspectorTab>("logs")
    const [consoleEntries, setConsoleEntries] = useState<SandboxConsoleEntry[]>([])
    const [telemetry, setTelemetry] = useState<SandboxTelemetry>(emptyTelemetry)
    const [shareStatus, setShareStatus] = useState<"idle" | "copied" | "ready" | "too-large">("idle")
    const shareTimerRef = useRef<number | undefined>(undefined)

    const iframeRef = useRef<HTMLIFrameElement>(null)
    const runSeqRef = useRef(0)
    const reqSeqRef = useRef(0)
    const activeSayIdRef = useRef(0)
    const activeFaultIdRef = useRef(0)
    const runTimeoutRef = useRef<number | undefined>(undefined)
    const pendingRestartRunRef = useRef<{ readonly code: string; readonly mode: SandboxMode } | null>(null)
    const lastRanRef = useRef<{ readonly code: string; readonly mode: SandboxMode } | null>(null)
    const chatSeqRef = useRef(1)
    const chatLogRef = useRef<HTMLDivElement>(null)
    const latestCodeRef = useRef(code)
    const latestModeRef = useRef(mode)
    const sharedPendingRunRef = useRef(sharedPendingRun)
    const hashSettledRef = useRef(hashSettled)
    const pendingSayRef = useRef<{ readonly beforeWaits: number; readonly faultWas: string | null }>({
        beforeWaits: 0,
        faultWas: null,
    })

    latestCodeRef.current = code
    latestModeRef.current = mode
    sharedPendingRunRef.current = sharedPendingRun
    hashSettledRef.current = hashSettled

    const clearRunWatchdog = useCallback(() => {
        if (runTimeoutRef.current !== undefined) {
            window.clearTimeout(runTimeoutRef.current)
            runTimeoutRef.current = undefined
        }
    }, [])

    const appendChat = useCallback((items: readonly ChatItem[]) => {
        setChat((previous) => [...previous, ...items].slice(-maxChatItems))
    }, [])

    const activePreset: PlaygroundPreset = getPreset(presetId)

    useEffect(() => {
        const update = () => setStill(getExperience() === "still")
        update()
        return subscribeExperience(update)
    }, [])

    useEffect(() => {
        try {
            if (window.localStorage.getItem("fluxerly.playground.advanced") === "1") setAdvanced(true)
        } catch {
            // Storage may be unavailable in strict privacy modes
        }
    }, [])

    const toggleAdvanced = () => {
        setAdvanced((previous) => {
            const next = !previous
            try {
                window.localStorage.setItem("fluxerly.playground.advanced", next ? "1" : "0")
            } catch {
                // Ignore storage write errors
            }
            return next
        })
    }

    // Restore shared code from URL hash (#s=...) or preset hash (#results, #effect, etc.) on mount.
    // Shared snippets (#s=...) never execute automatically on arrival; the visitor reviews and clicks Run explicitly
    useEffect(() => {
        let active = true
        const hash = window.location.hash
        if (hash.startsWith("#s=")) {
            void decodeShareState(hash.slice(3)).then((decoded) => {
                if (!active) return
                if (decoded !== null) {
                    const matchedPreset = decoded.preset ? getPreset(decoded.preset) : undefined
                    if (matchedPreset) {
                        setPresetId(matchedPreset.id)
                        setDraft(matchedPreset.quickMessages[0] ?? "!ping")
                    }
                    if (decoded.mode === "default" || decoded.mode === "effect") {
                        setMode(decoded.mode)
                        latestModeRef.current = decoded.mode
                    }
                    setCode(decoded.code)
                    latestCodeRef.current = decoded.code
                    setAutoRun(false)
                    setSharedPendingRun(true)
                    sharedPendingRunRef.current = true
                    setInteractive(false)
                    setChat([
                        {
                            id: chatSeqRef.current++,
                            kind: "system",
                            text: "Shared snippet loaded from link. Review the code and click Run to execute it",
                        },
                    ])
                }
                hashSettledRef.current = true
                setHashSettled(true)
            })
        } else {
            if (hash.length > 1) {
                const matched = playgroundPresets.find((item) => item.id === hash.slice(1))
                if (matched) {
                    setPresetId(matched.id)
                    setMode(matched.mode)
                    setCode(matched.code)
                    latestModeRef.current = matched.mode
                    latestCodeRef.current = matched.code
                    setDraft(matched.quickMessages[0] ?? "!ping")
                }
            }
            hashSettledRef.current = true
            setHashSettled(true)
        }
        return () => {
            active = false
        }
    }, [])

    // Lazily fetch the pre-bundled browser SDK runtime once and build the sandbox srcDoc
    const ensureRuntimeLoaded = useCallback(() => {
        let cancelled = false
        loadRuntimeScript()
            .then((script) => {
                if (!cancelled) setIframeSrcDoc(buildSandboxSrcDoc(script))
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setBootState("error")
                    setBootError(error instanceof Error ? error.message : String(error))
                }
            })
        return () => {
            cancelled = true
        }
    }, [])

    useEffect(() => ensureRuntimeLoaded(), [ensureRuntimeLoaded])

    useEffect(
        () => () => {
            clearRunWatchdog()
            if (shareTimerRef.current !== undefined) window.clearTimeout(shareTimerRef.current)
        },
        [clearRunWatchdog],
    )

    const postToSandbox = useCallback((message: ParentToSandboxMessage) => {
        iframeRef.current?.contentWindow?.postMessage(message, "*")
    }, [])

    const startRun = useCallback(
        (targetCode: string, targetMode: SandboxMode) => {
            clearRunWatchdog()
            const runId = ++runSeqRef.current
            activeSayIdRef.current = 0
            activeFaultIdRef.current = 0
            lastRanRef.current = { code: targetCode, mode: targetMode }
            setSharedPendingRun(false)
            sharedPendingRunRef.current = false
            setSandboxTimedOut(false)
            setSending(false)
            setRunning(true)
            setRunError(null)
            setArmedFault(null)
            setConsoleEntries([])
            setChat([])
            postToSandbox({ type: "run", runId, code: targetCode, mode: targetMode })
            runTimeoutRef.current = window.setTimeout(() => {
                if (runSeqRef.current !== runId) return
                runSeqRef.current += 1
                postToSandbox({ type: "terminate" })
                setRunning(false)
                setInteractive(false)
                setSending(false)
                setSandboxTimedOut(true)
                setRunError({
                    name: "TimeoutError",
                    message: `Run timed out after ${runTimeoutMs / 1000} s. Click Reset or Run to restart the isolated sandbox`,
                })
            }, runTimeoutMs)
        },
        [clearRunWatchdog, postToSandbox],
    )

    const triggerRun = useCallback(
        (nextCode?: string, nextMode?: SandboxMode) => {
            const targetCode = nextCode ?? latestCodeRef.current
            const targetMode = nextMode ?? latestModeRef.current
            if (sandboxTimedOut || running) {
                clearRunWatchdog()
                runSeqRef.current += 1
                pendingRestartRunRef.current = { code: targetCode, mode: targetMode }
                setSandboxTimedOut(false)
                setRunning(false)
                setInteractive(false)
                setBootState("loading")
                setRunError(null)
                setSending(false)
                postToSandbox({ type: "restart" })
                return
            }
            if (bootState !== "ready") {
                if (pendingRestartRunRef.current !== null) {
                    pendingRestartRunRef.current = { code: targetCode, mode: targetMode }
                }
                return
            }
            startRun(targetCode, targetMode)
        },
        [bootState, clearRunWatchdog, postToSandbox, running, sandboxTimedOut, startRun],
    )

    // Listen to postMessage events coming exclusively from our own sandbox iframe window
    useEffect(() => {
        const onMessage = (event: MessageEvent<SandboxToParentMessage>) => {
            if (event.source !== iframeRef.current?.contentWindow) return
            const data = event.data
            if (!data || typeof data !== "object") return

            if (data.type === "booted") {
                clearRunWatchdog()
                setBootState("ready")
                setBootError(null)
                setBootMs(data.bootMs)
                setSdkVersion(data.sdkVersion)
                setSending(false)
                activeSayIdRef.current = 0
                activeFaultIdRef.current = 0
                const pendingRestart = pendingRestartRunRef.current
                pendingRestartRunRef.current = null
                if (pendingRestart) {
                    startRun(pendingRestart.code, pendingRestart.mode)
                    return
                }
                if (hashSettledRef.current && !sharedPendingRunRef.current) {
                    startRun(latestCodeRef.current, latestModeRef.current)
                }
                return
            }

            if (data.type === "console") {
                if (data.runId !== undefined && data.runId !== runSeqRef.current) return
                setConsoleEntries((previous) => [...previous.slice(-119), data.entry])
                appendChat([
                    {
                        id: chatSeqRef.current++,
                        kind: data.entry.level === "error" ? "error" : "system",
                        text: `console.${data.entry.level}: ${data.entry.text}`,
                    },
                ])
                return
            }

            if (data.type === "runResult") {
                if (data.runId !== runSeqRef.current) return
                clearRunWatchdog()
                setRunning(false)
                setSandboxTimedOut(false)
                setCompileMs(data.compileMs)
                setRunMs(data.runMs)
                setInteractive(data.interactive)
                setTelemetry(data.telemetry)
                setRunError(data.error ?? null)
                if (data.ok) {
                    appendChat([
                        {
                            id: chatSeqRef.current++,
                            kind: "system",
                            text: data.interactive
                                ? `Connected ${data.botName} on in-memory Fluxer gateway (${data.compileMs} ms compile, ${data.runMs} ms boot)`
                                : `Script finished (${data.compileMs} ms compile, ${data.runMs} ms run)`,
                        },
                    ])
                }
                return
            }

            if (data.type === "sayResult") {
                if (data.requestId !== activeSayIdRef.current) return
                setSending(false)
                setTelemetry(data.telemetry)
                const pending = pendingSayRef.current
                const retried = data.telemetry.counters.rateLimitWaits > pending.beforeWaits
                setArmedFault(null)

                const additions: ChatItem[] = []
                if (!data.ok && data.error) {
                    additions.push({
                        id: chatSeqRef.current++,
                        kind: "error",
                        text: data.error.message,
                    })
                } else if (data.replies.length > 0) {
                    for (const reply of data.replies as readonly SandboxBotReply[]) {
                        additions.push({
                            id: chatSeqRef.current++,
                            kind: "bot",
                            author: reply.author,
                            text: reply.content,
                            embeds: reply.embeds,
                            badge: retried ? `Retried after 429 (${data.durationMs} ms)` : `${data.durationMs} ms`,
                        })
                    }
                } else if (pending.faultWas === "403" || pending.faultWas === "404") {
                    additions.push({
                        id: chatSeqRef.current++,
                        kind: "error",
                        text: `Delivery rejected with HTTP ${pending.faultWas}. Switch to Advanced to inspect Logs and REST details`,
                    })
                } else {
                    additions.push({
                        id: chatSeqRef.current++,
                        kind: "system",
                        text: `No reply sent (${data.durationMs} ms)`,
                    })
                }
                appendChat(additions)
                return
            }

            if (data.type === "faultResult") {
                if (data.requestId !== activeFaultIdRef.current) return
                setTelemetry(data.telemetry)
                if (data.ok && data.fault !== "disconnect") {
                    setArmedFault(data.fault)
                }
                appendChat([
                    {
                        id: chatSeqRef.current++,
                        kind: data.ok ? "system" : "error",
                        text: data.note,
                    },
                ])
            }
        }

        window.addEventListener("message", onMessage)
        return () => window.removeEventListener("message", onMessage)
    }, [appendChat, clearRunWatchdog, startRun])

    // Run once after mount if sandbox booted before URL hash check settled (and no shared snippet awaits explicit Run)
    useEffect(() => {
        if (!hashSettled || bootState !== "ready" || sharedPendingRun || lastRanRef.current !== null) return
        startRun(latestCodeRef.current, latestModeRef.current)
    }, [bootState, hashSettled, sharedPendingRun, startRun])

    // Debounced auto-run when user edits code (360ms quiet period so typing stays zero-jank)
    useEffect(() => {
        if (!autoRun || !hashSettled || sharedPendingRun || bootState !== "ready") return
        if (lastRanRef.current?.code === code && lastRanRef.current?.mode === mode) return
        const timer = window.setTimeout(() => {
            triggerRun(code, mode)
        }, 360)
        return () => window.clearTimeout(timer)
    }, [code, mode, autoRun, bootState, hashSettled, sharedPendingRun, triggerRun])

    useEffect(() => {
        const log = chatLogRef.current
        if (log) log.scrollTop = log.scrollHeight
    }, [chat])

    const selectPreset = (preset: PlaygroundPreset) => {
        setPresetId(preset.id)
        setMode(preset.mode)
        setCode(preset.code)
        setDraft(preset.quickMessages[0] ?? "!ping")
        setSharedPendingRun(false)
        sharedPendingRunRef.current = false
        setArmedFault(null)
        setSending(false)
        activeSayIdRef.current = 0
        activeFaultIdRef.current = 0
        window.history.replaceState(null, "", `#${preset.id}`)
        triggerRun(preset.code, preset.mode)
    }

    const resetSandbox = () => {
        clearRunWatchdog()
        const preset = getPreset(presetId)
        setMode(preset.mode)
        setCode(preset.code)
        setDraft(preset.quickMessages[0] ?? "!ping")
        setSharedPendingRun(false)
        sharedPendingRunRef.current = false
        setSandboxTimedOut(false)
        setRunning(false)
        setInteractive(false)
        setSending(false)
        setRunError(null)
        setBootError(null)
        setArmedFault(null)
        activeSayIdRef.current = 0
        activeFaultIdRef.current = 0
        lastRanRef.current = null
        pendingRestartRunRef.current = { code: preset.code, mode: preset.mode }
        setBootState("loading")
        if (!iframeSrcDoc) {
            ensureRuntimeLoaded()
        } else {
            setIframeKey((previous) => previous + 1)
        }
    }

    const sendChat = (text: string) => {
        const trimmed = text.trim()
        if (!trimmed || !interactive || sending || running) return
        setSending(true)
        const requestId = ++reqSeqRef.current
        activeSayIdRef.current = requestId
        pendingSayRef.current = {
            beforeWaits: telemetry.counters.rateLimitWaits,
            faultWas: armedFault,
        }
        appendChat([{ id: chatSeqRef.current++, kind: "user", author: "you", text: trimmed }])
        postToSandbox({ type: "say", requestId, content: trimmed })
    }

    const onChatSubmit = (event: { preventDefault(): void }) => {
        event.preventDefault()
        sendChat(draft)
        setDraft("")
    }

    const triggerFault = (fault: SandboxFaultKind) => {
        if (!interactive || running) return
        const requestId = ++reqSeqRef.current
        activeFaultIdRef.current = requestId
        postToSandbox({ type: "fault", requestId, fault })
    }

    const shareLink = async () => {
        if (shareTimerRef.current !== undefined) window.clearTimeout(shareTimerRef.current)
        const token = await encodeShareState({ preset: presetId, mode, code })
        if (token === null) {
            setShareStatus("too-large")
            appendChat([
                {
                    id: chatSeqRef.current++,
                    kind: "error",
                    text: "Snippet exceeds the 64 KiB share link limit",
                },
            ])
            shareTimerRef.current = window.setTimeout(() => setShareStatus("idle"), 2200)
            return
        }
        const url = `${window.location.origin}${window.location.pathname}#s=${token}`
        window.history.replaceState(null, "", `#s=${token}`)
        const copied = await copyText(url)
        setShareStatus(copied ? "copied" : "ready")
        shareTimerRef.current = window.setTimeout(() => setShareStatus("idle"), 2000)
    }

    const statusTone = bootState === "error" || runError ? "error" : running || bootState === "loading" || sharedPendingRun ? "busy" : "ok"
    const statusLabel =
        bootState === "loading"
            ? "Booting runtime"
            : bootState === "error"
              ? "Boot error"
              : running
                ? "Running"
                : sharedPendingRun
                  ? "Review before run"
                  : runError
                    ? runError.name
                    : interactive
                      ? "Bot online"
                      : "Script finished"

    return (
        <div className="pg" data-still={still || undefined}>
            {iframeSrcDoc && (
                <iframe
                    key={iframeKey}
                    ref={iframeRef}
                    className="pg-sandbox-frame"
                    sandbox="allow-scripts"
                    title="Isolated Fluxerly SDK sandbox runtime"
                    srcDoc={iframeSrcDoc}
                />
            )}

            <div className="pg-toolbar glass">
                <div className="pg-presets" role="group" aria-label="SDK Examples">
                    {playgroundPresets.map((preset) => (
                        <button
                            key={preset.id}
                            type="button"
                            className="pg-preset-btn"
                            data-active={presetId === preset.id || undefined}
                            onClick={() => selectPreset(preset)}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>

                <div className="pg-actions">
                    <span className="pg-status-pill" data-tone={statusTone}>
                        <span className="pg-dot" aria-hidden="true" />
                        {statusLabel}
                        {compileMs !== null && runMs !== null && !running && !runError && (
                            <span className="pg-timing">{Math.round((compileMs + runMs) * 10) / 10} ms</span>
                        )}
                    </span>

                    <button
                        type="button"
                        className="pg-btn pg-btn-subtle"
                        data-active={advanced || undefined}
                        aria-pressed={advanced}
                        onClick={toggleAdvanced}
                    >
                        {advanced ? "Advanced" : "Guided"}
                    </button>

                    <button
                        type="button"
                        className="pg-btn pg-btn-primary"
                        disabled={(bootState !== "ready" && !sandboxTimedOut) || running}
                        onClick={() => triggerRun()}
                    >
                        <PlayIcon size={16} weight="fill" aria-hidden="true" />
                        Run
                    </button>

                    <button type="button" className="pg-btn pg-btn-subtle" onClick={resetSandbox} aria-label="Reset sandbox and code">
                        <ArrowClockwiseIcon size={16} weight="bold" aria-hidden="true" />
                        Reset
                    </button>

                    <button type="button" className="pg-btn pg-btn-subtle" onClick={() => void shareLink()} aria-label="Copy shareable playground URL">
                        {shareStatus === "copied" || shareStatus === "ready" ? (
                            <CheckIcon size={16} weight="bold" aria-hidden="true" />
                        ) : shareStatus === "too-large" ? (
                            <WarningCircleIcon size={16} weight="bold" aria-hidden="true" />
                        ) : (
                            <ShareNetworkIcon size={16} weight="bold" aria-hidden="true" />
                        )}
                        {shareStatus === "copied"
                            ? "Copied"
                            : shareStatus === "ready"
                              ? "Link updated"
                              : shareStatus === "too-large"
                                ? "Too large"
                                : "Share"}
                    </button>
                </div>
            </div>

            <div className="pg-split" data-advanced={advanced || undefined}>
                <section className="pg-pane pg-editor-pane glass" aria-label="SDK Code Editor">
                    <header className="pg-pane-head">
                        <div className="pg-file-meta">
                            <TerminalWindowIcon size={18} weight="duotone" className="pg-file-icon" aria-hidden="true" />
                            <span className="pg-file-name">{activePreset.filename}</span>
                            {sdkVersion && <span className="pg-sdk-tag">v{sdkVersion}</span>}
                        </div>
                        <div className="pg-editor-controls">
                            <label className="pg-autorun">
                                <input type="checkbox" checked={autoRun} onChange={(event) => setAutoRun(event.target.checked)} />
                                <span>Auto-Run</span>
                            </label>
                            {advanced && <span className="pg-shortcut" aria-hidden="true">Ctrl+Enter</span>}
                        </div>
                    </header>

                    <div className="pg-editor-body">
                        <CodeEditor value={code} onChange={setCode} onRunShortcut={() => triggerRun()} />
                    </div>

                    {(bootError || runError) && (
                        <div className="pg-error-drawer" role="alert">
                            <div className="pg-error-head">
                                <WarningCircleIcon size={18} weight="fill" aria-hidden="true" />
                                <strong>
                                    {bootError ? "Runtime Load Error" : runError!.name}
                                    {runError?.line ? ` (line ${runError.line})` : ""}
                                </strong>
                            </div>
                            <pre className="pg-error-pre">{bootError ?? runError!.message}</pre>
                        </div>
                    )}
                </section>

                <div className="pg-right-stack" data-advanced={advanced || undefined}>
                    <section className="pg-pane pg-channel-pane glass" aria-label="Live Simulated Fluxer Channel">
                        <header className="pg-pane-head">
                            <div className="pg-channel-id">
                                <span className="pg-hash" aria-hidden="true">#</span>
                                <h2>Live Channel</h2>
                            </div>
                            <div className="pg-fault-strip" role="group" aria-label="Fault Injection Controls">
                                {advanced ? (
                                    <>
                                        <button
                                            type="button"
                                            className="pg-fault-btn"
                                            data-armed={armedFault === "429" || undefined}
                                            disabled={!interactive || running}
                                            onClick={() => triggerFault("429")}
                                        >
                                            <LightningIcon size={15} weight="fill" aria-hidden="true" />
                                            429
                                        </button>
                                        <button
                                            type="button"
                                            className="pg-fault-btn"
                                            data-armed={armedFault === "403" || undefined}
                                            disabled={!interactive || running}
                                            onClick={() => triggerFault("403")}
                                        >
                                            403
                                        </button>
                                        <button
                                            type="button"
                                            className="pg-fault-btn"
                                            disabled={!interactive || running}
                                            onClick={() => triggerFault("disconnect")}
                                        >
                                            <PlugsIcon size={15} weight="bold" aria-hidden="true" />
                                            Drop WS
                                        </button>
                                    </>
                                ) : (
                                    activePreset.guidedFault && (
                                        <button
                                            type="button"
                                            className="pg-fault-btn"
                                            data-armed={armedFault === activePreset.guidedFault.fault || undefined}
                                            disabled={!interactive || running}
                                            onClick={() => triggerFault(activePreset.guidedFault!.fault)}
                                        >
                                            <LightningIcon size={15} weight="fill" aria-hidden="true" />
                                            {activePreset.guidedFault.label}
                                        </button>
                                    )
                                )}
                            </div>
                        </header>

                        {!advanced && (
                            <div className="pg-guide-bar">
                                <span className="pg-guide-label">Try</span>
                                <span>{activePreset.guide}</span>
                            </div>
                        )}

                        <div ref={chatLogRef} className="pg-chat-log" aria-live="polite">
                            {chat.length === 0 ? (
                                <p className="pg-empty">Waiting for the in-memory Fluxer gateway to connect</p>
                            ) : (
                                chat.map((item) => (
                                    <div key={item.id} className={`pg-msg pg-msg-${item.kind}`}>
                                        {item.kind === "system" || item.kind === "error" ? (
                                            <div className="pg-sys-line">{item.text}</div>
                                        ) : (
                                            <>
                                                <div className="pg-msg-meta">
                                                    <span className="pg-msg-author">{item.author}</span>
                                                    {item.kind === "bot" && <span className="pg-bot-badge">BOT</span>}
                                                    {item.badge && <span className="pg-msg-ms">{item.badge}</span>}
                                                </div>
                                                {item.text && <p className="pg-msg-text">{item.text}</p>}
                                                {item.embeds?.map((embed, index) => <EmbedPreview key={index} embed={embed} />)}
                                            </>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>

                        <div className="pg-quick-row" aria-label="Quick Test Messages">
                            {activePreset.quickMessages.map((sample) => (
                                <button
                                    key={sample}
                                    type="button"
                                    className="pg-quick-chip"
                                    disabled={!interactive || sending || running}
                                    onClick={() => sendChat(sample)}
                                >
                                    {sample}
                                </button>
                            ))}
                        </div>

                        <form className="pg-composer" onSubmit={onChatSubmit}>
                            <label className="sr-only" htmlFor={`${baseId}-chat`}>
                                Message to send to the running bot
                            </label>
                            <input
                                id={`${baseId}-chat`}
                                type="text"
                                className="pg-input"
                                value={draft}
                                disabled={!interactive}
                                placeholder={
                                    interactive
                                        ? "Send a message to your running bot, e.g. !ping"
                                        : sharedPendingRun
                                          ? "Review the shared snippet and click Run to connect"
                                          : bootState === "loading"
                                            ? "Booting isolated sandbox runtime"
                                            : runError
                                              ? "Fix code error above to reconnect"
                                              : "Export a defineBot config and click Run to chat"
                                }
                                onChange={(event) => setDraft(event.target.value)}
                                autoComplete="off"
                            />
                            <button type="submit" className="pg-btn pg-btn-subtle" disabled={!interactive || sending || running || !draft.trim()}>
                                <PaperPlaneTiltIcon size={16} weight="fill" aria-hidden="true" />
                                Send
                            </button>
                        </form>
                    </section>

                    {advanced && (
                        <section className="pg-pane pg-inspector-pane glass" aria-label="SDK Runtime Inspector">
                        <header className="pg-pane-head">
                            <div className="pg-inspector-tabs" role="tablist" aria-label="Inspector Views">
                                <button
                                    type="button"
                                    role="tab"
                                    className="pg-itab"
                                    aria-selected={inspectorTab === "logs"}
                                    onClick={() => setInspectorTab("logs")}
                                >
                                    Logs ({consoleEntries.length + telemetry.logs.length})
                                </button>
                                <button
                                    type="button"
                                    role="tab"
                                    className="pg-itab"
                                    aria-selected={inspectorTab === "rest"}
                                    onClick={() => setInspectorTab("rest")}
                                >
                                    REST ({telemetry.requests.length})
                                </button>
                                <button
                                    type="button"
                                    role="tab"
                                    className="pg-itab"
                                    aria-selected={inspectorTab === "gateway"}
                                    onClick={() => setInspectorTab("gateway")}
                                >
                                    WS ({telemetry.gateway.length})
                                </button>
                            </div>

                            <div className="pg-counters" aria-label="SDK Diagnostics Counters">
                                <span aria-label={`Rate-limit 429 waits: ${telemetry.counters.rateLimitWaits}`}>429 {telemetry.counters.rateLimitWaits}</span>
                                <span aria-label={`Gateway resumes: ${telemetry.counters.resumes}`}>Resumes {telemetry.counters.resumes}</span>
                                {bootMs !== null && <span aria-label={`Sandbox cold boot time: ${bootMs} milliseconds`}>Boot {bootMs} ms</span>}
                            </div>
                        </header>

                        <div className="pg-inspector-body">
                            {inspectorTab === "logs" && (
                                <div className="pg-log-list">
                                    {consoleEntries.map((entry) => (
                                        <div key={`c-${entry.id}`} className="pg-log-row" data-level={entry.level}>
                                            <span className="pg-log-tag">console.{entry.level}</span>
                                            <pre className="pg-log-text">{entry.text}</pre>
                                        </div>
                                    ))}
                                    {telemetry.logs.map((record, index) => (
                                        <div key={`l-${index}`} className="pg-log-row" data-level={record.level}>
                                            <span className="pg-log-tag">
                                                {record.level} · {record.category}
                                            </span>
                                            <div className="pg-log-detail">
                                                <span className="pg-log-code">[{record.code}]</span> {record.message}
                                                {record.status !== undefined && <span className="pg-log-kv"> status={record.status}</span>}
                                                {record.delayMs !== undefined && <span className="pg-log-kv"> delay={record.delayMs}ms</span>}
                                                {record.errorMessage && <div className="pg-log-err">{record.errorName}: {record.errorMessage}</div>}
                                                {record.errorHint && <div className="pg-log-hint">Hint: {record.errorHint}</div>}
                                            </div>
                                        </div>
                                    ))}
                                    {consoleEntries.length === 0 && telemetry.logs.length === 0 && (
                                        <p className="pg-empty">No console output or SDK logs yet</p>
                                    )}
                                </div>
                            )}

                            {inspectorTab === "rest" && (
                                <div className="pg-log-list">
                                    {telemetry.requests.length === 0 ? (
                                        <p className="pg-empty">No REST requests sent yet. Send a command in the channel above</p>
                                    ) : (
                                        telemetry.requests.map((req) => (
                                            <div key={req.index} className="pg-log-row" data-level={req.matched ? "warn" : "info"}>
                                                <span className="pg-log-tag">
                                                    #{req.index} {req.method}
                                                </span>
                                                <div className="pg-log-detail">
                                                    <span className="pg-log-code">{req.path}</span>
                                                    {req.matched && <span className="pg-log-kv"> (fault responder)</span>}
                                                    {req.bodyPreview && <pre className="pg-log-text">{req.bodyPreview}</pre>}
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}

                            {inspectorTab === "gateway" && (
                                <div className="pg-log-list">
                                    {telemetry.gateway.length === 0 ? (
                                        <p className="pg-empty">No gateway frames recorded yet</p>
                                    ) : (
                                        telemetry.gateway.map((frame) => (
                                            <div key={frame.index} className="pg-log-row" data-level="info">
                                                <span className="pg-log-tag">
                                                    OP {frame.op} · {frame.opName}
                                                </span>
                                                <div className="pg-log-detail">
                                                    {frame.shardId !== null && <span className="pg-log-kv">shard={frame.shardId} </span>}
                                                    <pre className="pg-log-text">{frame.summary}</pre>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>
                    </section>
                    )}
                </div>
            </div>
        </div>
    )
}
