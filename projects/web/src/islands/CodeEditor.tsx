// Fast, lightweight CodeMirror 6 TypeScript/JavaScript editor themed to match Fluxerly's exact shiki-fluxerly palette
import { useEffect, useRef } from "react"
import { EditorState } from "@codemirror/state"
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { javascript } from "@codemirror/lang-javascript"
import { autocompletion, closeBrackets, closeBracketsKeymap, type Completion, type CompletionContext } from "@codemirror/autocomplete"
import { tags } from "@lezer/highlight"

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
            padding: "14px 12px 18px 0",
            caretColor: "#46e3ef",
        },
        ".cm-gutters": {
            backgroundColor: "rgb(4 5 26 / 0.35)",
            color: "rgb(195 200 230 / 0.42)",
            borderRight: "1px solid rgb(160 190 255 / 0.1)",
            paddingRight: "6px",
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
            border: "1px solid rgb(160 190 255 / 0.24)",
            borderRadius: "var(--corner-medium)",
            color: "#eef0ff",
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

const fluxerlyCompletions: readonly Completion[] = [
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

function fluxerlyCompletionSource(context: CompletionContext) {
    const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_.]*/)
    if (!word || (word.from === word.to && !context.explicit)) return null
    return {
        from: word.from,
        options: [...fluxerlyCompletions],
    }
}

interface CodeEditorProps {
    readonly value: string
    readonly onChange: (next: string) => void
    readonly onRunShortcut: () => void
    readonly ariaLabel?: string
}

export default function CodeEditor({ value, onChange, onRunShortcut, ariaLabel = "Fluxerly SDK code editor" }: CodeEditorProps) {
    const hostRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const onChangeRef = useRef(onChange)
    const onRunRef = useRef(onRunShortcut)
    onChangeRef.current = onChange
    onRunRef.current = onRunShortcut

    useEffect(() => {
        const host = hostRef.current
        if (!host) return

        const state = EditorState.create({
            doc: value,
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
                autocompletion({ override: [fluxerlyCompletionSource] }),
                placeholder("Write @neontechspace/fluxerly TypeScript, JavaScript or Effect code"),
                EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
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
                    if (update.docChanged) onChangeRef.current(update.state.doc.toString())
                }),
            ],
        })

        const view = new EditorView({ state, parent: host })
        viewRef.current = view
        return () => {
            view.destroy()
            viewRef.current = null
        }
    }, [ariaLabel])

    // Sync external value changes (preset switches, reset, shared URL load) without resetting cursor during normal typing
    useEffect(() => {
        const view = viewRef.current
        if (!view) return
        const current = view.state.doc.toString()
        if (current === value) return
        view.dispatch({
            changes: { from: 0, to: current.length, insert: value },
        })
    }, [value])

    return <div ref={hostRef} className="pg-cm-host" />
}
