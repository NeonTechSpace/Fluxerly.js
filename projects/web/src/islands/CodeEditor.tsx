// Fast, lightweight CodeMirror 6 TypeScript/JavaScript editor themed to match Fluxerly's exact shiki-fluxerly palette,
// backed by a lazy-loaded static TypeScript 6.0 Web Worker for type-aware autocomplete, hover docs and live squiggles
import { useEffect, useRef } from "react"
import { EditorState, StateEffect, StateField } from "@codemirror/state"
import {
    Decoration,
    type DecorationSet,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    hoverTooltip,
    keymap,
    lineNumbers,
    placeholder,
    type Tooltip,
    tooltips,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { javascript } from "@codemirror/lang-javascript"
import {
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    type Completion,
    type CompletionContext,
    type CompletionResult,
} from "@codemirror/autocomplete"
import { tags } from "@lezer/highlight"
import type { TsCompletionDetails, TsDiagnostic, TsDocTag } from "../playground-ts/protocol"
import { playgroundTsClient } from "./ts-client"

const fluxerlyHighlight = HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#8089b3", fontStyle: "italic" },
    { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.self], color: "#b490ff" },
    { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket, tags.brace, tags.paren], color: "#8d94bb" },
    { tag: [tags.string, tags.special(tags.string)], color: "#ecc46e" },
    { tag: [tags.escape, tags.regexp], color: "#f8dfa0" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#ff8f9c" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#46e3ef" },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: "#7fe3a6" },
    { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.propertyName)], color: "#b9c7ff" },
    { tag: [tags.variableName, tags.definition(tags.variableName)], color: "#e6e9ff" },
])

const fluxerlyEditorTheme = EditorView.theme(
    {
        "&": {
            height: "100%",
            color: "#e6e9ff",
            backgroundColor: "transparent",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--type-small)",
        },
        ".cm-scroller": {
            fontFamily: "var(--font-mono)",
            lineHeight: "1.6",
            overflow: "auto",
        },
        ".cm-content": {
            padding: "14px 12px 18px 6px",
            caretColor: "#46e3ef",
        },
        ".cm-gutters": {
            backgroundColor: "#050820",
            color: "rgb(195 200 230 / 0.42)",
            borderRight: "1px solid rgb(160 190 255 / 0.1)",
            paddingRight: "6px",
            zIndex: "2",
        },
        ".cm-lineNumbers .cm-gutterElement": {
            padding: "0 10px 0 12px",
            minWidth: "36px",
        },
        ".cm-activeLine": {
            backgroundColor: "rgb(70 227 239 / 0.05)",
        },
        ".cm-activeLineGutter": {
            backgroundColor: "rgb(70 227 239 / 0.08)",
            color: "#c8fbff",
        },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
            backgroundColor: "rgb(70 227 239 / 0.22) !important",
        },
        ".cm-cursor, .cm-dropCursor": {
            borderLeftColor: "#46e3ef",
            borderLeftWidth: "2px",
        },
        ".cm-matchingBracket": {
            backgroundColor: "rgb(165 124 255 / 0.26)",
            outline: "1px solid rgb(165 124 255 / 0.55)",
        },
        ".cm-tooltip": {
            backgroundColor: "#0d1131",
            border: "1px solid rgb(160 190 255 / 0.28)",
            borderRadius: "var(--corner-medium)",
            color: "#eef0ff",
            boxShadow: "0 16px 40px -12px rgb(2 3 15 / 0.85)",
        },
        ".cm-tooltip-autocomplete > ul": {
            fontFamily: "var(--font-mono)",
            fontSize: "var(--type-small)",
            maxHeight: "260px",
        },
        ".cm-tooltip-autocomplete > ul > li": {
            padding: "4px 10px",
        },
        ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
            backgroundColor: "rgb(70 227 239 / 0.2)",
            color: "#c8fbff",
        },
        "&.cm-focused": {
            outline: "none",
        },
    },
    { dark: true },
)

// Instant zero-latency fallback completions used only during the first ~300ms while the TS 6.0 Web Worker boots
const fallbackCompletions: readonly Completion[] = [
    { label: "defineBot", type: "function", detail: "Fluxerly bot config" },
    { label: "createTestBot", type: "function", detail: "@neontechspace/fluxerly/testing" },
    { label: "createTestClient", type: "function", detail: "@neontechspace/fluxerly/testing" },
    { label: "builders.embed()", type: "function", detail: "EmbedBuilder" },
    { label: "builders.message()", type: "function", detail: "MessageBuilder" },
    { label: "commands.parseQuoted", type: "property", detail: "Quoted argument parser" },
    { label: "describeError", type: "function", detail: "Format FluxerlyError with hints" },
    { label: "errors.apiCode", type: "function", detail: "Extract Fluxer API error code" },
    { label: "errors.isRetryable", type: "function", detail: "Check if safe to retry" },
    { label: "errors.isNotFound", type: "function", detail: "Check 404 resource miss" },
    { label: "errors.outcome", type: "function", detail: "Check applied vs unknown write" },
    { label: "errors.retryAfterMs", type: "function", detail: "Read 429 retry delay" },
    { label: "colors.parse", type: "function", detail: "Convert #hex to Fluxer color int" },
    { label: "format.userMention", type: "function", detail: "Format <@id> mention" },
    { label: "format.timestamp", type: "function", detail: "Format Fluxer timestamp tag" },
    { label: "guards.guildOnly", type: "function", detail: "Require community channel" },
    { label: "guards.requirePermissions", type: "function", detail: "Require Fluxer permission bits" },
    { label: "Permissions", type: "constant", detail: "Fluxer permission bitfield flags" },
    { label: "TimestampStyles", type: "constant", detail: "Relative / short / long timestamp" },
    { label: "Effect.gen", type: "function", detail: "Effect 4 generator program" },
    { label: "Effect.catch", type: "function", detail: "Handle typed Effect failure" },
    { label: "Effect.catchTag", type: "function", detail: "Handle tagged FluxerlyError" },
]

const setTsDiagnosticsEffect = StateEffect.define<readonly TsDiagnostic[]>()

const tsDiagnosticsListField = StateField.define<readonly TsDiagnostic[]>({
    create: () => [],
    update(current, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setTsDiagnosticsEffect)) return effect.value
        }
        if (!tr.docChanged || current.length === 0) return current
        const maxLen = tr.newDoc.length
        const mapped: TsDiagnostic[] = []
        for (const diag of current) {
            const from = tr.changes.mapPos(diag.from, 1)
            const to = Math.max(from, Math.min(tr.changes.mapPos(diag.to, -1), maxLen))
            if (from < to) mapped.push({ ...diag, from, to })
        }
        return mapped
    },
})

function diagnosticSpan(diag: TsDiagnostic, maxLen: number): readonly [number, number] | null {
    if (maxLen === 0) return null
    let from = Math.max(0, Math.min(diag.from, maxLen))
    let to = Math.max(from, Math.min(Math.max(diag.to, from + 1), maxLen))
    // EOF syntax errors (for example `const x =` at end of file) have from === maxLen; anchor onto the final character
    if (from >= to) {
        from = Math.max(0, maxLen - 1)
        to = maxLen
    }
    return from < to ? [from, to] : null
}

const tsDiagnosticDecorationsField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setTsDiagnosticsEffect)) {
                const maxLen = tr.state.doc.length
                if (maxLen === 0) return Decoration.none
                const ranges = []
                for (const diag of [...effect.value].sort((a, b) => a.from - b.from || a.to - b.to)) {
                    const span = diagnosticSpan(diag, maxLen)
                    if (span) {
                        ranges.push(
                            Decoration.mark({
                                class: diag.severity === "warning" ? "cm-ts-warning" : "cm-ts-error",
                            }).range(span[0], span[1]),
                        )
                    }
                }
                return Decoration.set(ranges, true)
            }
        }
        return tr.docChanged ? decorations.map(tr.changes) : decorations
    },
    provide: (field) => EditorView.decorations.from(field),
})

function collectDocumentIdentifiers(docText: string, excludeWord: string): Completion[] {
    const seen = new Set<string>(fallbackCompletions.map((item) => item.label))
    if (excludeWord) seen.add(excludeWord)
    const results: Completion[] = []
    const matches = docText.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g)
    for (const match of matches) {
        const word = match[0]
        if (seen.has(word)) continue
        seen.add(word)
        results.push({ label: word, type: "variable", boost: -10 })
        if (results.length >= 60) break
    }
    return results
}

function buildInfoNode(display: string, documentation: string, tagsList: readonly TsDocTag[]): HTMLElement {
    const root = document.createElement("div")
    root.className = "pg-ts-doc"

    if (display) {
        const sig = document.createElement("pre")
        sig.className = "pg-ts-sig"
        sig.textContent = display
        root.appendChild(sig)
    }

    if (documentation) {
        const doc = document.createElement("p")
        doc.className = "pg-ts-text"
        doc.textContent = documentation
        root.appendChild(doc)
    }

    if (tagsList.length > 0) {
        const list = document.createElement("div")
        list.className = "pg-ts-tags"
        for (const tag of tagsList) {
            const row = document.createElement("div")
            row.className = "pg-ts-tag"
            const name = document.createElement("span")
            name.className = "pg-ts-tag-name"
            name.textContent = `@${tag.name}`
            row.appendChild(name)
            if (tag.text) {
                const body = document.createElement("span")
                body.className = "pg-ts-tag-body"
                body.textContent = tag.text
                row.appendChild(body)
            }
            list.appendChild(row)
        }
        root.appendChild(list)
    }

    return root
}

function buildDiagnosticHoverNode(
    overlapping: readonly TsDiagnostic[],
    quickInfo: { readonly display: string; readonly documentation: string; readonly tags: readonly TsDocTag[] } | null,
): HTMLElement {
    const root = document.createElement("div")
    root.className = "pg-ts-hover"

    for (const diag of overlapping) {
        const box = document.createElement("div")
        box.className = diag.severity === "warning" ? "pg-ts-diag pg-ts-diag-warn" : "pg-ts-diag pg-ts-diag-error"
        const head = document.createElement("span")
        head.className = "pg-ts-diag-code"
        head.textContent = `TS${diag.code}`
        const msg = document.createElement("span")
        msg.className = "pg-ts-diag-msg"
        msg.textContent = diag.message
        box.appendChild(head)
        box.appendChild(msg)
        root.appendChild(box)
    }

    if (quickInfo && (quickInfo.display || quickInfo.documentation)) {
        root.appendChild(buildInfoNode(quickInfo.display, quickInfo.documentation, quickInfo.tags))
    }

    return root
}

export interface CodeEditorJumpTarget {
    readonly offset: number
    readonly seq: number
}

interface CodeEditorProps {
    readonly value: string
    readonly filename?: string
    readonly onChange: (next: string) => void
    readonly onRunShortcut: () => void
    readonly onDiagnosticsChange?: (diagnostics: readonly TsDiagnostic[]) => void
    readonly jumpToOffset?: CodeEditorJumpTarget | null
    readonly ariaLabel?: string
}

export default function CodeEditor({
    value,
    filename = "bot.ts",
    onChange,
    onRunShortcut,
    onDiagnosticsChange,
    jumpToOffset,
    ariaLabel = "Fluxerly SDK code editor",
}: CodeEditorProps) {
    const hostRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const onChangeRef = useRef(onChange)
    const onRunRef = useRef(onRunShortcut)
    const onDiagnosticsRef = useRef(onDiagnosticsChange)
    const filenameRef = useRef(filename)
    const lastSyncedFileRef = useRef(filename)
    const valueRef = useRef(value)
    onChangeRef.current = onChange
    onRunRef.current = onRunShortcut
    onDiagnosticsRef.current = onDiagnosticsChange
    filenameRef.current = filename
    valueRef.current = value

    useEffect(() => {
        const host = hostRef.current
        if (!host) return

        const completionSource = async (context: CompletionContext): Promise<CompletionResult | null> => {
            const docText = context.state.doc.toString()
            const currentFile = filenameRef.current
            const charBefore = context.pos > 0 ? context.state.sliceDoc(context.pos - 1, context.pos) : ""
            const isTriggerChar = charBefore === "." || charBefore === '"' || charBefore === "'" || charBefore === "/"
            const word = context.matchBefore(/[A-Za-z0-9_$]+/)
            const inImport = /(?:from|import)\s*\(?\s*["'][^"']*$/.test(
                context.state.sliceDoc(Math.max(0, context.pos - 80), context.pos),
            )

            if (!context.explicit && !isTriggerChar && !inImport && (!word || word.from === word.to)) {
                return null
            }

            if (playgroundTsClient.isReady()) {
                const triggerCharacter = isTriggerChar ? charBefore : undefined
                const response = await playgroundTsClient.complete(
                    currentFile,
                    docText,
                    context.pos,
                    triggerCharacter,
                    context.explicit,
                )
                if (context.aborted) return null
                if (!response || response.items.length === 0) return null

                const detailCache = new Map<string, Promise<TsCompletionDetails | null>>()
                const offset = context.pos
                const responseFrom = response.from
                const initialLowerPrefix = docText.slice(response.from, response.to).toLowerCase()
                const options: Completion[] = response.items.map((item, idx) => {
                    const insert = item.insertText ?? item.label
                    const apply: Completion["apply"] =
                        item.replaceFrom !== undefined && item.replaceTo !== undefined
                            ? (view, _completion, from, to) => {
                                  const prefixShift = Math.max(0, responseFrom - item.replaceFrom!)
                                  const replaceFrom = Math.max(0, Math.min(from - prefixShift, view.state.doc.length))
                                  const replaceTo = Math.max(replaceFrom, Math.min(to, view.state.doc.length))
                                  view.dispatch({
                                      changes: { from: replaceFrom, to: replaceTo, insert },
                                      selection: { anchor: replaceFrom + insert.length },
                                  })
                              }
                            : insert

                    return {
                        label: item.label,
                        type: item.kind,
                        detail: item.detail,
                        apply,
                        // Preserve TypeScript's exact relevance ordering inside CodeMirror's scorer
                        boost: item.isRecommended ? 50 - idx * 0.1 : 20 - idx * 0.1,
                        info: item.detail
                            ? undefined
                            : () => {
                                  const key = `${item.label}\0${item.source ?? ""}`
                                  let pending = detailCache.get(key)
                                  if (!pending) {
                                      pending = playgroundTsClient.completionDetails(currentFile, offset, item.label, item.source)
                                      detailCache.set(key, pending)
                                  }
                                  return pending.then((details) => {
                                      if (!details) {
                                          if (detailCache.get(key) === pending) detailCache.delete(key)
                                          return null
                                      }
                                      if (!details.display && !details.documentation) return null
                                      return buildInfoNode(details.display, details.documentation, details.tags)
                                  })
                              },
                    }
                })

                return {
                    from: response.from,
                    to: response.to,
                    options,
                    filter: !inImport,
                    validFor:
                        !response.isIncomplete && !inImport
                            ? (text) =>
                                  /^[A-Za-z0-9_$]*$/.test(text) &&
                                  (!initialLowerPrefix || text.toLowerCase().includes(initialLowerPrefix))
                            : undefined,
                }
            }

            // Worker is still warming up: start it now and return instant local + curated Fluxerly completions
            void playgroundTsClient.ensureStarted(currentFile, docText)
            const fallbackWord = context.matchBefore(/[A-Za-z_][A-Za-z0-9_.]*/)
            if (!fallbackWord || (fallbackWord.from === fallbackWord.to && !context.explicit)) return null
            return {
                from: fallbackWord.from,
                options: [...fallbackCompletions, ...collectDocumentIdentifiers(docText, fallbackWord.text)],
            }
        }

        const hoverSource = async (view: EditorView, pos: number): Promise<Tooltip | null> => {
            const docBefore = view.state.doc
            const docLen = docBefore.length
            const diagnostics = view.state.field(tsDiagnosticsListField)
            const overlapping = diagnostics.filter((diag) => {
                const span = diagnosticSpan(diag, docLen)
                return span !== null && pos >= span[0] && pos <= span[1]
            })

            const docText = docBefore.toString()
            const currentFile = filenameRef.current
            const quickInfo = playgroundTsClient.isReady()
                ? await playgroundTsClient.hover(currentFile, docText, pos)
                : (void playgroundTsClient.ensureStarted(currentFile, docText), null)

            if (view.state.doc !== docBefore || filenameRef.current !== currentFile) return null
            if (overlapping.length === 0 && (!quickInfo || (!quickInfo.display && !quickInfo.documentation))) {
                return null
            }

            const maxLen = view.state.doc.length
            const firstDiagSpan = overlapping.length > 0 ? diagnosticSpan(overlapping[0]!, maxLen) : null
            const rawFrom = quickInfo ? quickInfo.from : (firstDiagSpan?.[0] ?? 0)
            const rawTo = quickInfo ? quickInfo.to : (firstDiagSpan?.[1] ?? rawFrom)
            const from = Math.max(0, Math.min(rawFrom, maxLen))
            const to = Math.max(from, Math.min(rawTo, maxLen))

            return {
                pos: from,
                end: to,
                above: true,
                create: () => ({
                    dom: buildDiagnosticHoverNode(overlapping, quickInfo),
                }),
            }
        }

        const state = EditorState.create({
            doc: valueRef.current,
            extensions: [
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightActiveLine(),
                history(),
                indentOnInput(),
                bracketMatching(),
                closeBrackets(),
                javascript({ typescript: true }),
                syntaxHighlighting(fluxerlyHighlight),
                fluxerlyEditorTheme,
                tsDiagnosticsListField,
                tsDiagnosticDecorationsField,
                tooltips({ parent: document.body }),
                autocompletion({
                    override: [completionSource],
                    activateOnTyping: true,
                    maxRenderedOptions: 40,
                    closeOnBlur: true,
                }),
                hoverTooltip(hoverSource, { hoverTime: 180 }),
                placeholder("Write @neontechspace/fluxerly TypeScript, JavaScript or Effect code"),
                EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
                EditorView.domEventHandlers({
                    focus: () => {
                        void playgroundTsClient.ensureStarted(filenameRef.current, viewRef.current?.state.doc.toString() ?? valueRef.current)
                        return false
                    },
                }),
                keymap.of([
                    {
                        key: "Mod-Enter",
                        run: () => {
                            onRunRef.current()
                            return true
                        },
                    },
                    indentWithTab,
                    ...closeBracketsKeymap,
                    ...defaultKeymap,
                    ...historyKeymap,
                ]),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        const nextText = update.state.doc.toString()
                        onChangeRef.current(nextText)
                        playgroundTsClient.updateDocument(filenameRef.current, nextText, false)
                    }
                }),
            ],
        })

        const view = new EditorView({ state, parent: host })
        viewRef.current = view

        const unsubscribeDiagnostics = playgroundTsClient.subscribeDiagnostics((diagFile, _version, diagnostics) => {
            if (diagFile !== filenameRef.current) return
            const activeView = viewRef.current
            if (!activeView) return
            activeView.dispatch({ effects: setTsDiagnosticsEffect.of(diagnostics) })
            onDiagnosticsRef.current?.(diagnostics)
        })

        // Defer worker download until after initial paint so LCP/FCP stay untouched
        let idleHandle: number | undefined
        let timeoutHandle: number | undefined
        const kickOff = () => {
            void playgroundTsClient.ensureStarted(filenameRef.current, viewRef.current?.state.doc.toString() ?? valueRef.current)
        }
        const win = window as Window & {
            requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
            cancelIdleCallback?: (handle: number) => void
        }
        if (typeof win.requestIdleCallback === "function") {
            idleHandle = win.requestIdleCallback(kickOff, { timeout: 600 })
        } else {
            timeoutHandle = window.setTimeout(kickOff, 350)
        }

        return () => {
            unsubscribeDiagnostics()
            if (idleHandle !== undefined && typeof win.cancelIdleCallback === "function") {
                win.cancelIdleCallback(idleHandle)
            }
            if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle)
            view.destroy()
            viewRef.current = null
        }
    }, [ariaLabel])

    // Sync external value or filename changes (preset switches, reset, shared URL load) without bypassing typing debounce
    useEffect(() => {
        const view = viewRef.current
        if (!view) return
        const current = view.state.doc.toString()
        const fileChanged = filename !== lastSyncedFileRef.current
        lastSyncedFileRef.current = filename
        if (current !== value) {
            view.dispatch({
                changes: { from: 0, to: current.length, insert: value },
                effects: setTsDiagnosticsEffect.of([]),
            })
            onDiagnosticsRef.current?.([])
            playgroundTsClient.updateDocument(filename, value, true)
        } else if (fileChanged) {
            playgroundTsClient.updateDocument(filename, value, true)
        }
    }, [value, filename])

    useEffect(() => {
        if (!jumpToOffset) return
        const view = viewRef.current
        if (!view) return
        const pos = Math.max(0, Math.min(jumpToOffset.offset, view.state.doc.length))
        view.focus()
        view.dispatch({
            selection: { anchor: pos },
            scrollIntoView: true,
        })
    }, [jumpToOffset])

    return <div ref={hostRef} className="pg-cm-host" />
}
