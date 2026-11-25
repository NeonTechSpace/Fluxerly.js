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

function loadRuntimeScript(): Promise<string> {
    runtimeScriptPromise ??= fetch("/playground/runtime.js").then(async (response) => {
        if (!response.ok) throw new Error(`Could not load playground runtime (HTTP ${response.status})`)
        return response.text()
    })
    return runtimeScriptPromise
}

function buildSandboxSrcDoc(runtimeScript: string): string {
    // Prevent any literal </script> inside bundled strings from terminating the inline script element
    const safeScript = runtimeScript.replace(/<\/script/gi, "<\\/script")
    return [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; connect-src \'none\'; img-src \'none\'; style-src \'none\'; form-action \'none\';">',
        "</head><body>",
        `<script>${safeScript}</script>`,
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

async function encodeShareState(payload: { preset: string; mode: SandboxMode; code: string }): Promise<string> {
    const raw = new TextEncoder().encode(JSON.stringify(payload))
    if (typeof CompressionStream === "function") {
        const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))
        const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
        return `z.${toBase64Url(compressed)}`
    }
    return `r.${toBase64Url(raw)}`
}

async function decodeShareState(token: string): Promise<{ preset?: string; mode?: SandboxMode; code?: string } | null> {
    try {
        if (token.startsWith("z.") && typeof DecompressionStream === "function") {
            const bytes = new Uint8Array(fromBase64Url(token.slice(2)))
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
            const text = await new Response(stream).text()
            return JSON.parse(text) as { preset?: string; mode?: SandboxMode; code?: string }
        }
        if (token.startsWith("r.")) {
            const text = new TextDecoder().decode(fromBase64Url(token.slice(2)))
            return JSON.parse(text) as { preset?: string; mode?: SandboxMode; code?: string }
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
    const [shareCopied, setShareCopied] = useState(false)

    const iframeRef = useRef<HTMLIFrameElement>(null)
    const runSeqRef = useRef(0)
    const reqSeqRef = useRef(0)
    const chatSeqRef = useRef(1)
    const chatLogRef = useRef<HTMLDivElement>(null)
    const latestCodeRef = useRef(code)
    const latestModeRef = useRef(mode)
    const pendingSayRef = useRef<{ readonly beforeWaits: number; readonly faultWas: string | null }>({
        beforeWaits: 0,
        faultWas: null,
    })

    latestCodeRef.current = code
    latestModeRef.current = mode

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

    // Restore shared code from URL hash (#s=...) or preset hash (#results, #effect, etc.) on mount
    useEffect(() => {
        const hash = window.location.hash
        if (hash.startsWith("#s=")) {
            void decodeShareState(hash.slice(3)).then((decoded) => {
                if (!decoded?.code) return
                if (decoded.preset) setPresetId(getPreset(decoded.preset).id)
                if (decoded.mode === "default" || decoded.mode === "effect") setMode(decoded.mode)
                setCode(decoded.code)
            })
        } else if (hash.length > 1) {
            const matched = playgroundPresets.find((item) => item.id === hash.slice(1))
            if (matched) {
                setPresetId(matched.id)
                setMode(matched.mode)
                setCode(matched.code)
                setDraft(matched.quickMessages[0] ?? "!ping")
            }
        }
    }, [])

    // Lazily fetch the pre-bundled browser SDK runtime once and build the sandbox srcDoc
    useEffect(() => {
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

    const postToSandbox = useCallback((message: ParentToSandboxMessage) => {
        iframeRef.current?.contentWindow?.postMessage(message, "*")
    }, [])

    const triggerRun = useCallback(
        (nextCode?: string, nextMode?: SandboxMode) => {
            if (bootState !== "ready") return
            const targetCode = nextCode ?? latestCodeRef.current
            const targetMode = nextMode ?? latestModeRef.current
            const runId = ++runSeqRef.current
            setRunning(true)
            setRunError(null)
            setArmedFault(null)
            setConsoleEntries([])
            postToSandbox({ type: "run", runId, code: targetCode, mode: targetMode })
        },
        [bootState, postToSandbox],
    )

    // Listen to postMessage events coming exclusively from our own sandbox iframe window
    useEffect(() => {
        const onMessage = (event: MessageEvent<SandboxToParentMessage>) => {
            if (event.source !== iframeRef.current?.contentWindow) return
            const data = event.data
            if (!data || typeof data !== "object") return

            if (data.type === "booted") {
                setBootState("ready")
                setBootError(null)
                setBootMs(data.bootMs)
                setSdkVersion(data.sdkVersion)
                const runId = ++runSeqRef.current
                setRunning(true)
                setRunError(null)
                setConsoleEntries([])
                iframeRef.current?.contentWindow?.postMessage(
                    { type: "run", runId, code: latestCodeRef.current, mode: latestModeRef.current } satisfies ParentToSandboxMessage,
                    "*",
                )
                return
            }

            if (data.type === "console") {
                setConsoleEntries((previous) => [...previous.slice(-119), data.entry])
                setChat((previous) => [
                    ...previous,
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
                setRunning(false)
                setCompileMs(data.compileMs)
                setRunMs(data.runMs)
                setInteractive(data.interactive)
                setTelemetry(data.telemetry)
                setRunError(data.error ?? null)
                if (data.ok) {
                    setChat([
                        {
                            id: chatSeqRef.current++,
                            kind: "system",
                            text: `Connected ${data.botName} on in-memory Fluxer gateway (${data.compileMs} ms compile, ${data.runMs} ms boot)`,
                        },
                    ])
                }
                return
            }

            if (data.type === "sayResult") {
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
                        text: `Delivery rejected with HTTP ${pending.faultWas}. Check Output and Logs for Result / describeError details`,
                    })
                } else {
                    additions.push({
                        id: chatSeqRef.current++,
                        kind: "system",
                        text: `No reply sent (${data.durationMs} ms)`,
                    })
                }
                setChat((previous) => [...previous, ...additions])
                return
            }

            if (data.type === "faultResult") {
                setTelemetry(data.telemetry)
                if (data.ok && data.fault !== "disconnect") {
                    setArmedFault(data.fault)
                }
                setChat((previous) => [
                    ...previous,
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
    }, [])

    // Debounced auto-run when user edits code (360ms quiet period so typing stays zero-jank)
    useEffect(() => {
        if (!autoRun || bootState !== "ready") return
        const timer = window.setTimeout(() => {
            triggerRun(code, mode)
        }, 360)
        return () => window.clearTimeout(timer)
    }, [code, mode, autoRun, bootState, triggerRun])

    useEffect(() => {
        const log = chatLogRef.current
        if (log) log.scrollTop = log.scrollHeight
    }, [chat])

    const selectPreset = (preset: PlaygroundPreset) => {
        setPresetId(preset.id)
        setMode(preset.mode)
        setCode(preset.code)
        setDraft(preset.quickMessages[0] ?? "!ping")
        setArmedFault(null)
        window.history.replaceState(null, "", `#${preset.id}`)
        if (!autoRun) triggerRun(preset.code, preset.mode)
    }

    const resetSandbox = () => {
        const preset = getPreset(presetId)
        setMode(preset.mode)
        setCode(preset.code)
        setDraft(preset.quickMessages[0] ?? "!ping")
        setArmedFault(null)
        setBootState("loading")
        setIframeKey((previous) => previous + 1)
    }

    const sendChat = (text: string) => {
        const trimmed = text.trim()
        if (!trimmed || !interactive || sending || running) return
        setSending(true)
        pendingSayRef.current = {
            beforeWaits: telemetry.counters.rateLimitWaits,
            faultWas: armedFault,
        }
        setChat((previous) => [...previous, { id: chatSeqRef.current++, kind: "user", author: "you", text: trimmed }])
        postToSandbox({ type: "say", requestId: ++reqSeqRef.current, content: trimmed })
    }

    const onChatSubmit = (event: { preventDefault(): void }) => {
        event.preventDefault()
        sendChat(draft)
        setDraft("")
    }

    const triggerFault = (fault: SandboxFaultKind) => {
        if (!interactive || running) return
        postToSandbox({ type: "fault", requestId: ++reqSeqRef.current, fault })
    }

    const shareLink = async () => {
        const token = await encodeShareState({ preset: presetId, mode, code })
        const url = `${window.location.origin}${window.location.pathname}#s=${token}`
        window.history.replaceState(null, "", `#s=${token}`)
        await copyText(url)
        setShareCopied(true)
        window.setTimeout(() => setShareCopied(false), 1800)
    }

    const statusTone = bootState === "error" || runError ? "error" : running || bootState === "loading" ? "busy" : "ok"
    const statusLabel =
        bootState === "loading"
            ? "Booting runtime"
            : bootState === "error"
              ? "Boot error"
              : running
                ? "Running"
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

                    <button type="button" className="pg-btn pg-btn-primary" disabled={bootState !== "ready" || running} onClick={() => triggerRun()}>
                        <PlayIcon size={16} weight="fill" aria-hidden="true" />
                        Run
                    </button>

                    <button type="button" className="pg-btn pg-btn-subtle" onClick={resetSandbox} aria-label="Reset sandbox and code">
                        <ArrowClockwiseIcon size={16} weight="bold" aria-hidden="true" />
                        Reset
                    </button>

                    <button type="button" className="pg-btn pg-btn-subtle" onClick={() => void shareLink()} aria-label="Copy shareable playground URL">
                        {shareCopied ? <CheckIcon size={16} weight="bold" aria-hidden="true" /> : <ShareNetworkIcon size={16} weight="bold" aria-hidden="true" />}
                        {shareCopied ? "Copied" : "Share"}
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
                                <span>Auto-run</span>
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
                                placeholder={interactive ? "Send a message to your running bot, e.g. !ping" : "Fix code error above to reconnect"}
                                onChange={(event) => setDraft(event.target.value)}
                                autoComplete="off"
                            />
                            <button type="submit" className="pg-btn pg-btn-primary" disabled={!interactive || sending || running || !draft.trim()}>
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
                                <span title="429 rate-limit waits">429 {telemetry.counters.rateLimitWaits}</span>
                                <span title="Gateway resumes">Resumes {telemetry.counters.resumes}</span>
                                {bootMs !== null && <span title="Sandbox cold boot time">Boot {bootMs} ms</span>}
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
