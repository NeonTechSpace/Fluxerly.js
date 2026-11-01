import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { getExperience, prefersReducedMotion, subscribeExperience } from "../lib/experience"
import CodeLines from "./CodeLines"
import { CommandChip } from "./CopyButton"
import { lineOf, starterSamples } from "./samples"
import { initCommand } from "../lib/links"
import "./first-reply.css"

interface ChatMessage {
    id: number
    from: "you" | "bot"
    text: string
}

// Which line of the handler a run ends on: the reply, or the check that returns early
type Target = "reply" | "guard"
type Signal = "off" | "drawing" | "shown" | "fading"

const trigger = "!ping"
const targetText: Record<Target, string> = {
    reply: 'reply("Pong!")',
    guard: `message.content !== "${trigger}"`,
}

// One run in milliseconds, when motion is allowed. The message takes `draw` to reach the code,
// the reply takes `back` to return, and Send waits until the run is over
const timing = { start: 160, draw: 900, back: 700, settle: 500, fade: 700, unlight: 1200 }
// Without a line to watch, in the stacked layout, the bot simply types and answers
const quick = { start: 60, draw: 120, back: 420, settle: 300 }

// A wave riding a curve from one point to another, fading out at both ends. Up to three crests, each
// at least about 70 pixels long, so a short way gets fewer and calmer crests instead of a scribble
function wavePath(x1: number, y1: number, x2: number, y2: number) {
    const bend = (x2 - x1) * 0.55
    const carrier = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + bend).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - bend).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`
    const span = Math.hypot(x2 - x1, y2 - y1)
    const crests = Math.max(1, Math.min(3, Math.floor(span / 70)))
    const height = Math.min(6.5, span / 16)
    const steps = 72
    const points: string[] = []
    for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const mt = 1 - t
        const x = mt * mt * mt * x1 + 3 * mt * mt * t * (x1 + bend) + 3 * mt * t * t * (x2 - bend) + t * t * t * x2
        const y = mt * mt * mt * y1 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y2
        const dx = 3 * mt * mt * bend + 6 * mt * t * (x2 - x1 - 2 * bend) + 3 * t * t * bend
        const dy = 6 * mt * t * (y2 - y1)
        const length = Math.hypot(dx, dy) || 1
        const amplitude = height * Math.sin(Math.PI * t) * Math.sin(t * Math.PI * 2 * crests)
        points.push(`${(x - (dy / length) * amplitude).toFixed(1)} ${(y + (dx / length) * amplitude).toFixed(1)}`)
    }
    return { carrier, wave: `M ${points.join(" L ")}` }
}

// The first character of a code line that is not indentation, so the signal lands on the code itself
function firstGlyph(line: HTMLElement): DOMRect | null {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.search(/\S/) ?? -1
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 1)
        return range.getBoundingClientRect()
    }
    return null
}

function isStill() {
    return getExperience() === "still" || prefersReducedMotion()
}

export default function FirstReply() {
    const [tab, setTab] = useState(0)
    const [draft, setDraft] = useState(trigger)
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [silent, setSilent] = useState(false)
    const [target, setTarget] = useState<Target>("reply")
    const [lit, setLit] = useState(false)
    const [signal, setSignal] = useState<Signal>("off")
    const [back, setBack] = useState<Signal>("off")
    const [busy, setBusy] = useState(false)
    const [typing, setTyping] = useState(false)
    const [path, setPath] = useState<{
        out: { carrier: string; wave: string }
        home: { carrier: string; wave: string }
        x1: number
        x2: number
        y1: number
        y: number
    } | null>(null)
    const [run, setRun] = useState(0)
    const [still, setStill] = useState(false)

    const rootRef = useRef<HTMLDivElement>(null)
    const windowRef = useRef<HTMLDivElement>(null)
    const logRef = useRef<HTMLOListElement>(null)
    const sendRef = useRef<HTMLButtonElement>(null)
    const preRef = useRef<HTMLPreElement>(null)
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
    const timers = useRef<number[]>([])
    const nextId = useRef(0)
    const baseId = useId()
    // A safe fragment for url(#id), whatever characters React puts in its ids
    const gradientId = `fr-signal-${baseId.replace(/[^\w-]/g, "")}`

    const sample = starterSamples[tab]
    const targetLine = lineOf(sample.code, targetText[target])

    useEffect(() => {
        const update = () => {
            const now = isStill()
            setStill(now)
            // A line still drawn from a run in motion goes away once time stands still
            if (now) {
                setSignal("off")
                setBack("off")
            }
        }
        update()
        const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
        motionQuery.addEventListener("change", update)
        const unsubscribe = subscribeExperience(update)
        return () => {
            motionQuery.removeEventListener("change", update)
            unsubscribe()
        }
    }, [])

    useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), [])

    // New messages scroll the channel to its newest line
    useEffect(() => {
        const log = logRef.current
        if (log) log.scrollTop = log.scrollHeight
    }, [messages, silent, typing])

    // The message leaves from the waves on the Send button, crosses the gutter and the line's indentation
    // and ends just before the first word of the target line. The reply runs back along the same way
    const measure = useCallback(() => {
        const root = rootRef.current
        const send = sendRef.current
        const pre = preRef.current
        const line = pre?.querySelector<HTMLElement>(`[data-line="${targetLine}"]`)
        if (!root || !send || !pre || !line) return
        const box = root.getBoundingClientRect()
        const button = send.getBoundingClientRect()
        const waves = send.querySelector("svg")?.getBoundingClientRect() ?? button
        const row = line.getBoundingClientRect()
        const text = firstGlyph(line) ?? row
        // Boxes come in viewport pixels, which the page zoom on wide screens scales up, while the SVG
        // draws in the page's own pixels. Without this the line lands 15 percent off at 2560 wide
        const zoom = root.offsetWidth > 0 ? box.width / root.offsetWidth : 1
        const x1 = (waves.right - box.left) / zoom + 4
        const y1 = (button.top + button.height / 2 - box.top) / zoom
        const x2 = (text.left - box.left) / zoom - 8
        const y2 = (text.top + text.height / 2 - box.top) / zoom
        // One column: the code sits under the chat, with no gutter to cross
        if (x2 - x1 < 48 || row.left < button.right) {
            setPath(null)
            return
        }
        // The reply rides back along the same line, so the return path is the same curve reversed
        setPath({ out: wavePath(x1, y1, x2, y2), home: wavePath(x2, y2, x1, y1), x1, x2, y1, y: y2 })
    }, [targetLine])

    useLayoutEffect(() => {
        measure()
        const root = rootRef.current
        if (!root) return
        const observer = new ResizeObserver(measure)
        observer.observe(root)
        // The code panel can re-wrap a long comment without changing the grid's height
        if (preRef.current) observer.observe(preRef.current)
        if (windowRef.current) observer.observe(windowRef.current)
        document.fonts?.ready.then(measure)
        return () => observer.disconnect()
    }, [measure])

    const send = () => {
        const text = draft.trim()
        // One run at a time. A click during a run is ignored instead of restarting it
        if (!text || busy) return
        // Measure right before the run, so the line meets the code where it is now
        measure()
        timers.current.forEach((timer) => window.clearTimeout(timer))
        timers.current = []
        // Fluxer trims a message before the bot receives it, so the scene decides on the trimmed text too
        const answers = text === trigger
        const sent: ChatMessage = { id: nextId.current++, from: "you", text }
        const reply: ChatMessage = { id: nextId.current++, from: "bot", text: "Pong!" }
        setTarget(answers ? "reply" : "guard")
        setRun((value) => value + 1)
        setSilent(false)

        // The channel keeps its history, like a real one. Only the last few messages stay in view
        const keep = (list: ChatMessage[]) => list.slice(-8)

        // Still: the reply is simply there and the handler's line is lit. No signal line, which drawn at once and
        // left standing would only be a squiggle across the code
        if (isStill()) {
            setStill(true)
            setMessages((previous) => keep(answers ? [...previous, sent, reply] : [...previous, sent]))
            setSilent(!answers)
            setLit(true)
            setSignal("off")
            setBack("off")
            return
        }

        setStill(false)
        setBusy(true)
        setMessages((previous) => keep([...previous, sent]))
        setLit(false)
        setSignal("off")
        setBack("off")
        const at = (delay: number, step: () => void) => timers.current.push(window.setTimeout(step, delay))
        const pace = path ? timing : quick
        const reached = pace.start + pace.draw
        const returned = reached + (answers ? pace.back : pace.settle)
        at(pace.start, () => setSignal("drawing"))
        at(reached, () => {
            setLit(true)
            if (answers) {
                setTyping(true)
                setBack("drawing")
            } else {
                setSilent(true)
            }
        })
        at(returned, () => {
            if (answers) {
                setTyping(false)
                setMessages((previous) => keep([...previous, reply]))
                setBack("shown")
            }
            setSignal("shown")
        })
        at(returned + pace.settle, () => {
            setSignal("fading")
            if (answers) setBack("fading")
            setBusy(false)
        })
        at(returned + pace.settle + timing.unlight, () => setLit(false))
    }

    const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
        const last = starterSamples.length - 1
        const moves: Record<string, number> = {
            ArrowRight: tab === last ? 0 : tab + 1,
            ArrowLeft: tab === 0 ? last : tab - 1,
            Home: 0,
            End: last,
        }
        const next = moves[event.key]
        if (next === undefined) return
        event.preventDefault()
        setTab(next)
        tabRefs.current[next]?.focus()
    }

    const litLine = lit ? targetLine : -1

    return (
        <div className="fr" ref={rootRef} data-still={still || undefined}>
            <div className="fr-chat">
                <div className="fr-window glass" ref={windowRef}>
                    <div className="fr-window-head">
                        <span className="fr-hash" aria-hidden="true">
                            #
                        </span>
                        general
                    </div>
                    <ol className="fr-log" ref={logRef} aria-live="polite" aria-label="Messages">
                        {messages.length === 0 && <li className="fr-empty">Press Send to post the message in this channel</li>}
                        {messages.map((message) => (
                            <li key={message.id} className={`fr-bubble fr-${message.from}`}>
                                <span className="fr-author">{message.from === "you" ? "You" : "starter bot"}</span>
                                <span className="fr-text">{message.text}</span>
                            </li>
                        ))}
                        {typing && (
                            <li className="fr-bubble fr-bot fr-typing" aria-label="starter bot is typing">
                                <span className="fr-author">starter bot</span>
                                <span className="fr-text fr-dots">
                                    <i />
                                    <i />
                                    <i />
                                </span>
                            </li>
                        )}
                        {silent && (
                            <li className="fr-silent">
                                The starter only answers <code>{trigger}</code>
                            </li>
                        )}
                    </ol>
                    <form
                        className="fr-composer"
                        onSubmit={(event) => {
                            event.preventDefault()
                            send()
                        }}
                    >
                        <input
                            className="fr-input"
                            type="text"
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            aria-label="Message"
                            maxLength={120}
                            spellCheck={false}
                            autoComplete="off"
                        />
                        <button className="fr-send" type="submit" ref={sendRef} disabled={!draft.trim()} data-busy={busy || undefined} aria-busy={busy}>
                            Send
                            <svg className="fr-send-waves" viewBox="0 0 20 14" aria-hidden="true" focusable="false">
                                <path d="M1.5 4.2c2.3-2.9 4.6-2.9 6.9 0s4.6 2.9 6.9 0 2.5-2.1 3.2-1.4" />
                                <path d="M1.5 10.4c2.3-2.9 4.6-2.9 6.9 0s4.6 2.9 6.9 0 2.5-2.1 3.2-1.4" />
                            </svg>
                        </button>
                    </form>
                </div>
                <p className="fr-note">This chat is a preview. The test that fluxerly init writes sends !ping and hello to the SDK's in-memory Fluxer and checks the answers</p>
            </div>

            <svg className="fr-signal" aria-hidden="true" focusable="false">
                <defs>
                    {path && (
                        <>
                            <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={path.x1} x2={path.x2} y1="0" y2="0">
                                <stop offset="0" stopColor="#46e3ef" stopOpacity="0.55" />
                                <stop offset="1" stopColor="#8ef1f7" />
                            </linearGradient>
                            <linearGradient id={`${gradientId}-back`} gradientUnits="userSpaceOnUse" x1={path.x2} x2={path.x1} y1="0" y2="0">
                                <stop offset="0" stopColor="#a57cff" stopOpacity="0.55" />
                                <stop offset="1" stopColor="#c8b4ff" />
                            </linearGradient>
                        </>
                    )}
                </defs>
                {path && (
                    <g key={run}>
                        <g className="fr-signal-out" data-signal={signal}>
                            <path className="fr-signal-glow" d={path.out.carrier} pathLength={1} />
                            <path className="fr-signal-line" d={path.out.wave} pathLength={1} stroke={`url(#${gradientId})`} />
                            <circle className="fr-signal-end" cx={path.x2} cy={path.y} r={3.5} />
                        </g>
                        <g className="fr-signal-back" data-signal={back}>
                            <path className="fr-signal-glow" d={path.home.carrier} pathLength={1} />
                            <path className="fr-signal-line" d={path.home.wave} pathLength={1} stroke={`url(#${gradientId}-back)`} />
                            <circle className="fr-signal-end" cx={path.x1} cy={path.y1} r={3.5} />
                        </g>
                    </g>
                )}
            </svg>

            <div className="fr-code glass">
                <div className="fr-code-head">
                    <div className="fr-tabs" role="tablist" aria-label="Language">
                        {starterSamples.map((item, index) => (
                            <button
                                key={item.label}
                                ref={(element) => {
                                    tabRefs.current[index] = element
                                }}
                                className="fr-tab"
                                type="button"
                                role="tab"
                                id={`${baseId}-tab-${index}`}
                                aria-selected={index === tab}
                                aria-controls={`${baseId}-panel`}
                                tabIndex={index === tab ? 0 : -1}
                                onClick={() => setTab(index)}
                                onKeyDown={onTabKey}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                    <span className="fr-file">{sample.filename}</span>
                </div>
                <pre
                    className="code fr-pre"
                    ref={preRef}
                    role="tabpanel"
                    id={`${baseId}-panel`}
                    aria-labelledby={`${baseId}-tab-${tab}`}
                    tabIndex={0}
                >
                    <CodeLines code={sample.code} lit={target === "reply" ? litLine : -1} quiet={target === "guard" ? litLine : -1} />
                </pre>
            </div>

            <div className="fr-chips">
                <CommandChip command={initCommand} />
                <CommandChip command={`node --env-file=.env ${sample.filename}`} />
            </div>
        </div>
    )
}
