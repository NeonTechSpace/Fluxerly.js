// Zero-backend, isolated browser SDK sandbox running the real @neontechspace/fluxerly SDK + createTestBot
// inside a sandbox="allow-scripts" iframe (opaque origin, connect-src 'none') communicating strictly via postMessage
import { useCallback, useEffect, useId, useRef, useState } from "react"
import {
    ArrowClockwiseIcon,
    CheckIcon,
    InfoIcon,
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
import CodeEditor, { type CodeEditorJumpTarget } from "./CodeEditor"
import type { TsChannel, TsDiagnostic } from "../playground-ts/protocol"
import { playgroundTsClient } from "./ts-client"
import { getPreset, playgroundPresets, type PlaygroundPreset } from "./playground-presets"
import "./playground.css"

type RightTab = "channel" | "logs" | "rest" | "gateway"

const rightTabs: readonly RightTab[] = ["channel", "logs", "rest", "gateway"]

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

const runtimeScriptPromises = new Map<string, Promise<string>>()
const maxShareTokenChars = 65_536
const maxSharePayloadBytes = 65_536
const maxChatItems = 120
const runTimeoutMs = 8_000

function runtimeUrlForChannel(channel: TsChannel): string {
    return channel === "nightly" ? "/playground/runtime-nightly.js" : "/playground/runtime.js"
}

function loadRuntimeScript(channel: TsChannel): Promise<string> {
    const url = runtimeUrlForChannel(channel)
    let pending = runtimeScriptPromises.get(url)
    if (!pending) {
        pending = fetch(url, { cache: "no-cache" })
            .then(async (response) => {
                if (!response.ok) throw new Error(`Could not load playground runtime (HTTP ${response.status})`)
                return response.text()
            })
            .catch((error: unknown) => {
                runtimeScriptPromises.delete(url)
                throw error
            })
        runtimeScriptPromises.set(url, pending)
    }
    return pending
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

export interface PlaygroundProps {
    readonly stableVersion?: string
    readonly nightlyVersion?: string
}

export default function Playground({ stableVersion = "", nightlyVersion }: PlaygroundProps = {}) {
    const baseId = useId()
    const [still, setStill] = useState(false)
    const [mac, setMac] = useState(false)
    const [sdkChannel, setSdkChannel] = useState<TsChannel>("stable")
    const [runtimeReloadSeq, setRuntimeReloadSeq] = useState(0)
    const [nightlyInfoOpen, setNightlyInfoOpen] = useState(false)
    const channelSwitchRef = useRef<HTMLDivElement>(null)
    const [presetId, setPresetId] = useState<string>(playgroundPresets[0]!.id)
    const [mode, setMode] = useState<SandboxMode>(playgroundPresets[0]!.mode)
    const [code, setCode] = useState<string>(playgroundPresets[0]!.code)
    const [autoRun, setAutoRun] = useState(true)

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

    const [rightTab, setRightTab] = useState<RightTab>("channel")
    const [consoleEntries, setConsoleEntries] = useState<SandboxConsoleEntry[]>([])
    const [telemetry, setTelemetry] = useState<SandboxTelemetry>(emptyTelemetry)
    const [tabPulse, setTabPulse] = useState<{ logs: number; rest: number; gateway: number }>({ logs: 0, rest: 0, gateway: 0 })
    const prevCountsRef = useRef<{ logs: number; rest: number; gateway: number }>({ logs: 0, rest: 0, gateway: 0 })
    const bootSettledRef = useRef(false)
    const [shareStatus, setShareStatus] = useState<"idle" | "copied" | "ready" | "too-large">("idle")
    const shareTimerRef = useRef<number | undefined>(undefined)
    const [tsDiagnostics, setTsDiagnostics] = useState<readonly TsDiagnostic[]>([])
    const [jumpTarget, setJumpTarget] = useState<CodeEditorJumpTarget | null>(null)
    const jumpDiagIndexRef = useRef(0)
    const jumpSeqRef = useRef(1)

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
    const lastScrolledChatIdRef = useRef(0)
    const tabRefs = useRef<Partial<Record<RightTab, HTMLButtonElement | null>>>({})
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
        setMac(/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent))
    }, [])

    const logsCount = consoleEntries.length + telemetry.logs.length
    const restCount = telemetry.requests.length
    const gatewayCount = telemetry.gateway.length

    useEffect(() => {
        const prev = prevCountsRef.current
        const next = { logs: logsCount, rest: restCount, gateway: gatewayCount }
        prevCountsRef.current = next
        if (!bootSettledRef.current) {
            if (hashSettled && bootState === "ready" && !running && (lastRanRef.current !== null || sharedPendingRun)) {
                bootSettledRef.current = true
            }
            return
        }
        const bumpLogs = rightTab !== "logs" && next.logs > prev.logs
        const bumpRest = rightTab !== "rest" && next.rest > prev.rest
        const bumpGateway = rightTab !== "gateway" && next.gateway > prev.gateway
        if (bumpLogs || bumpRest || bumpGateway) {
            setTabPulse((current) => ({
                logs: bumpLogs ? current.logs + 1 : current.logs,
                rest: bumpRest ? current.rest + 1 : current.rest,
                gateway: bumpGateway ? current.gateway + 1 : current.gateway,
            }))
        }
    }, [logsCount, restCount, gatewayCount, rightTab, bootState, running, hashSettled, sharedPendingRun])

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

    // Lazily fetch only the selected channel's pre-bundled browser SDK runtime (Stable by default, Nightly only on click)
    useEffect(() => {
        let cancelled = false
        setBootState("loading")
        setBootError(null)
        setInteractive(false)
        setRunning(false)
        loadRuntimeScript(sdkChannel)
            .then((script) => {
                if (!cancelled) {
                    setIframeSrcDoc(buildSandboxSrcDoc(script))
                    setIframeKey((key) => key + 1)
                }
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
    }, [sdkChannel, runtimeReloadSeq])

    useEffect(() => {
        if (!nightlyInfoOpen) return
        const onPointerDown = (event: PointerEvent) => {
            if (!channelSwitchRef.current?.contains(event.target as Node)) setNightlyInfoOpen(false)
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setNightlyInfoOpen(false)
        }
        document.addEventListener("pointerdown", onPointerDown)
        document.addEventListener("keydown", onKeyDown)
        return () => {
            document.removeEventListener("pointerdown", onPointerDown)
            document.removeEventListener("keydown", onKeyDown)
        }
    }, [nightlyInfoOpen])

    const selectSdkChannel = useCallback(
        (next: TsChannel) => {
            if (next === "nightly" && !nightlyVersion) {
                setNightlyInfoOpen((open) => !open)
                return
            }
            setNightlyInfoOpen(false)
            if (next === sdkChannel) return
            clearRunWatchdog()
            runSeqRef.current += 1
            pendingRestartRunRef.current = null
            setSdkChannel(next)
            void playgroundTsClient.setChannel(next, activePreset.filename, latestCodeRef.current)
        },
        [activePreset.filename, clearRunWatchdog, nightlyVersion, sdkChannel],
    )

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
                        text: `Delivery rejected with HTTP ${pending.faultWas}. Open the Logs or REST tab to inspect details`,
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
                return
            }

            if (data.type === "faultCleared") {
                if (data.requestId !== activeFaultIdRef.current) return
                setTelemetry(data.telemetry)
                setArmedFault(null)
                appendChat([
                    {
                        id: chatSeqRef.current++,
                        kind: "system",
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
        if (chat.length === 0 && !sending) {
            lastScrolledChatIdRef.current = 0
            return
        }
        if (rightTab !== "channel") return
        const latestId = chat.at(-1)?.id ?? 0
        if (!sending && latestId === lastScrolledChatIdRef.current) return
        lastScrolledChatIdRef.current = latestId
        const log = chatLogRef.current
        if (log) log.scrollTop = log.scrollHeight
    }, [chat, rightTab, sending])

    const onTabKeyDown = (event: { key: string; preventDefault(): void }, current: RightTab) => {
        const index = rightTabs.indexOf(current)
        let nextIndex = -1
        if (event.key === "ArrowRight") nextIndex = (index + 1) % rightTabs.length
        else if (event.key === "ArrowLeft") nextIndex = (index - 1 + rightTabs.length) % rightTabs.length
        else if (event.key === "Home") nextIndex = 0
        else if (event.key === "End") nextIndex = rightTabs.length - 1
        if (nextIndex < 0) return
        event.preventDefault()
        const next = rightTabs[nextIndex]!
        setRightTab(next)
        tabRefs.current[next]?.focus()
    }

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
            setRuntimeReloadSeq((previous) => previous + 1)
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
        if (fault !== "disconnect" && armedFault === fault) {
            setArmedFault(null)
            postToSandbox({ type: "clearFault", requestId })
            return
        }
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

            <header className="pg-head">
                <h1 className="page-title" id="page-title">
                    <span className="hi">Fluxerly</span> SDK Sandbox
                </h1>
                <div className="pg-channel-bar">
                    {(sdkVersion || (sdkChannel === "nightly" ? nightlyVersion : stableVersion)) && (
                        <span className="pg-sdk-tag">
                            v{sdkVersion || (sdkChannel === "nightly" ? nightlyVersion : stableVersion)}
                        </span>
                    )}
                    <div
                        ref={channelSwitchRef}
                        className="pg-channel-switch"
                        role="group"
                        aria-label="SDK release channel"
                        data-info-open={nightlyInfoOpen ? "true" : undefined}
                    >
                        <button
                            type="button"
                            className="pg-channel-btn"
                            data-active={sdkChannel === "stable" ? "" : undefined}
                            aria-pressed={sdkChannel === "stable"}
                            onClick={() => selectSdkChannel("stable")}
                        >
                            Stable
                        </button>
                        <span className="pg-channel-nightly-wrap">
                            <button
                                type="button"
                                className="pg-channel-btn"
                                data-active={sdkChannel === "nightly" ? "" : undefined}
                                data-info-open={nightlyInfoOpen ? "" : undefined}
                                aria-pressed={sdkChannel === "nightly"}
                                aria-disabled={!nightlyVersion}
                                aria-describedby={!nightlyVersion ? `${baseId}-nightly-info` : undefined}
                                onClick={() => selectSdkChannel("nightly")}
                            >
                                <span className="pg-channel-label">Nightly</span>
                                {!nightlyVersion && (
                                    <span className="pg-channel-info-icon" aria-hidden="true">
                                        <InfoIcon size={15} weight="bold" />
                                    </span>
                                )}
                            </button>
                            {!nightlyVersion && (
                                <div
                                    id={`${baseId}-nightly-info`}
                                    role="tooltip"
                                    className="pg-channel-info"
                                    data-open={nightlyInfoOpen ? "true" : undefined}
                                >
                                    <strong className="pg-channel-info-title">Nightly matches Stable</strong>
                                    <p className="pg-channel-info-body">
                                        Stable {sdkVersion || stableVersion ? `v${sdkVersion || stableVersion}` : "release"} already includes the latest changes. Nightly unlocks when a newer prerelease ships
                                    </p>
                                </div>
                            )}
                        </span>
                    </div>
                </div>
            </header>

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

                    <button type="button" className="pg-btn pg-btn-subtle pg-btn-share" onClick={() => void shareLink()} aria-label="Copy shareable playground URL">
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

            <div className="pg-split">
                <section className="pg-pane pg-editor-pane glass" aria-label="SDK Code Editor">
                    <header className="pg-pane-head">
                        <div className="pg-file-meta">
                            <TerminalWindowIcon size={18} weight="duotone" className="pg-file-icon" aria-hidden="true" />
                            <span className="pg-file-name">{activePreset.filename}</span>
                            {tsDiagnostics.length > 0 && (
                                <button
                                    type="button"
                                    className="pg-diag-pill"
                                    onClick={() => {
                                        const nextIndex = jumpDiagIndexRef.current % tsDiagnostics.length
                                        jumpDiagIndexRef.current = nextIndex + 1
                                        setJumpTarget({ offset: tsDiagnostics[nextIndex]!.from, seq: jumpSeqRef.current++ })
                                    }}
                                    aria-label={`Jump to TypeScript diagnostic (${tsDiagnostics.length} found)`}
                                >
                                    <WarningCircleIcon size={14} weight="fill" aria-hidden="true" />
                                    <span>
                                        {tsDiagnostics.length} {tsDiagnostics.length === 1 ? "issue" : "issues"}
                                    </span>
                                </button>
                            )}
                        </div>
                        <div className="pg-editor-controls">
                            <label className="pg-autorun">
                                <input type="checkbox" checked={autoRun} onChange={(event) => setAutoRun(event.target.checked)} />
                                <span>Auto-Run</span>
                            </label>
                            <span className="pg-shortcut" aria-hidden="true">{mac ? "Cmd+Enter" : "Ctrl+Enter"}</span>
                        </div>
                    </header>

                    <div className="pg-editor-body">
                        <CodeEditor
                            value={code}
                            filename={activePreset.filename}
                            onChange={setCode}
                            onRunShortcut={() => triggerRun()}
                            onDiagnosticsChange={(next) => {
                                jumpDiagIndexRef.current = 0
                                setTsDiagnostics(next)
                            }}
                            jumpToOffset={jumpTarget}
                        />
                    </div>

                    {(bootError || runError) && (
                        <div className="pg-error-drawer" role="alert">
                            <div className="pg-error-head">
                                <WarningCircleIcon size={18} weight="fill" aria-hidden="true" />
                                <strong>{bootError ? "Runtime Load Error" : runError!.name}</strong>
                                {!bootError && runError?.line !== undefined && (
                                    <button
                                        type="button"
                                        className="pg-error-line-btn"
                                        onClick={() => setJumpTarget({ line: runError.line, seq: jumpSeqRef.current++ })}
                                        aria-label={`Jump to line ${runError.line} in editor`}
                                    >
                                        Line {runError.line}
                                    </button>
                                )}
                            </div>
                            <pre className="pg-error-pre">{bootError ?? runError!.message}</pre>
                        </div>
                    )}
                </section>

                <section className="pg-pane pg-right-pane glass" aria-label="Live Simulated Fluxer Channel and Runtime Inspector">
                    <header className="pg-pane-head pg-right-head">
                        <div className="pg-view-tabs" role="tablist" aria-label="Playground Output Views">
                            <button
                                ref={(node) => {
                                    tabRefs.current.channel = node
                                }}
                                type="button"
                                role="tab"
                                id={`${baseId}-tab-channel`}
                                aria-controls={`${baseId}-panel-channel`}
                                className="pg-vtab"
                                aria-selected={rightTab === "channel"}
                                tabIndex={rightTab === "channel" ? 0 : -1}
                                onClick={() => setRightTab("channel")}
                                onKeyDown={(event) => onTabKeyDown(event, "channel")}
                            >
                                <span className="pg-hash" aria-hidden="true">#</span>
                                Channel
                            </button>
                            <button
                                ref={(node) => {
                                    tabRefs.current.logs = node
                                }}
                                type="button"
                                role="tab"
                                id={`${baseId}-tab-logs`}
                                aria-controls={`${baseId}-panel-logs`}
                                className="pg-vtab"
                                aria-selected={rightTab === "logs"}
                                tabIndex={rightTab === "logs" ? 0 : -1}
                                onClick={() => setRightTab("logs")}
                                onKeyDown={(event) => onTabKeyDown(event, "logs")}
                            >
                                Logs
                                <span key={`logs-${tabPulse.logs}`} className="pg-vtab-count" data-pulse={tabPulse.logs > 0 || undefined}>
                                    {logsCount}
                                </span>
                            </button>
                            <button
                                ref={(node) => {
                                    tabRefs.current.rest = node
                                }}
                                type="button"
                                role="tab"
                                id={`${baseId}-tab-rest`}
                                aria-controls={`${baseId}-panel-rest`}
                                className="pg-vtab"
                                aria-selected={rightTab === "rest"}
                                tabIndex={rightTab === "rest" ? 0 : -1}
                                onClick={() => setRightTab("rest")}
                                onKeyDown={(event) => onTabKeyDown(event, "rest")}
                            >
                                REST
                                <span key={`rest-${tabPulse.rest}`} className="pg-vtab-count" data-pulse={tabPulse.rest > 0 || undefined}>
                                    {restCount}
                                </span>
                            </button>
                            <button
                                ref={(node) => {
                                    tabRefs.current.gateway = node
                                }}
                                type="button"
                                role="tab"
                                id={`${baseId}-tab-gateway`}
                                aria-controls={`${baseId}-panel-gateway`}
                                className="pg-vtab"
                                aria-selected={rightTab === "gateway"}
                                tabIndex={rightTab === "gateway" ? 0 : -1}
                                onClick={() => setRightTab("gateway")}
                                onKeyDown={(event) => onTabKeyDown(event, "gateway")}
                            >
                                WS
                                <span key={`ws-${tabPulse.gateway}`} className="pg-vtab-count" data-pulse={tabPulse.gateway > 0 || undefined}>
                                    {gatewayCount}
                                </span>
                            </button>
                        </div>

                        {rightTab === "channel" ? (
                            <div className="pg-fault-strip" role="group" aria-label="Fault Injection Controls">
                                <button
                                    type="button"
                                    className="pg-fault-btn"
                                    data-armed={armedFault === "429" || undefined}
                                    aria-pressed={armedFault === "429"}
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
                                    aria-pressed={armedFault === "403"}
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
                            </div>
                        ) : (
                            <div className="pg-counters" role="group" aria-label="SDK Diagnostics Counters">
                                <span>
                                    <span className="sr-only">Rate-limit 429 waits: </span>
                                    <span aria-hidden="true">429 </span>
                                    {telemetry.counters.rateLimitWaits}
                                </span>
                                <span>
                                    <span className="sr-only">Gateway resumes: </span>
                                    <span aria-hidden="true">Resumes </span>
                                    {telemetry.counters.resumes}
                                </span>
                                {bootMs !== null && (
                                    <span>
                                        <span className="sr-only">Sandbox cold boot time: </span>
                                        <span aria-hidden="true">Boot </span>
                                        {bootMs} ms
                                    </span>
                                )}
                            </div>
                        )}
                    </header>

                    <div
                        className="pg-channel-view"
                        role="tabpanel"
                        id={`${baseId}-panel-channel`}
                        aria-labelledby={`${baseId}-tab-channel`}
                        hidden={rightTab !== "channel"}
                    >
                        <div ref={chatLogRef} className="pg-chat-log" aria-live="polite">
                            <div className="pg-guide-bar">
                                <span className="pg-guide-label">Try</span>
                                <span>{activePreset.guide}</span>
                            </div>
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
                            {sending && (
                                <div className="pg-msg pg-msg-bot pg-msg-typing" role="status">
                                    <span className="sr-only">Bot is replying</span>
                                    <span className="pg-msg-text pg-dots" aria-hidden="true">
                                        <i />
                                        <i />
                                        <i />
                                    </span>
                                </div>
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
                    </div>

                    <div
                        className="pg-inspector-body"
                        role="tabpanel"
                        id={`${baseId}-panel-logs`}
                        aria-labelledby={`${baseId}-tab-logs`}
                        hidden={rightTab !== "logs"}
                    >
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
                    </div>

                    <div
                        className="pg-inspector-body"
                        role="tabpanel"
                        id={`${baseId}-panel-rest`}
                        aria-labelledby={`${baseId}-tab-rest`}
                        hidden={rightTab !== "rest"}
                    >
                        <div className="pg-log-list">
                            {telemetry.requests.length === 0 ? (
                                <p className="pg-empty">No REST requests sent yet. Send a command in the Channel tab</p>
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
                    </div>

                    <div
                        className="pg-inspector-body"
                        role="tabpanel"
                        id={`${baseId}-panel-gateway`}
                        aria-labelledby={`${baseId}-tab-gateway`}
                        hidden={rightTab !== "gateway"}
                    >
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
                    </div>
                </section>
            </div>
        </div>
    )
}
