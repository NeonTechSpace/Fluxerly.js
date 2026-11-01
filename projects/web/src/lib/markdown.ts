// Renders Markdown outside the guides collection, such as TypeDoc comments in the reference, with the guides' code
// blocks, command chips and highlighting theme
import { createMarkdownProcessor, type MarkdownRenderer } from "@astrojs/markdown-remark"
import remarkGuides from "../../scripts/docs/remark-guides.mjs"
import remarkEntries from "../../scripts/docs/remark-entries.mjs"
import rehypeCodeBreaks, { collapseLongCode, remarkLongCode } from "../../scripts/docs/code-breaks.mjs"
import fluxerlyTheme from "../styles/shiki-fluxerly.json"
import { gitignoreGrammar } from "../../scripts/docs/gitignore-grammar.mjs"
import { peekData } from "./peek-data"
import rehypePeek from "./rehype-peek"

let processor: Promise<MarkdownRenderer> | undefined

/** Markdown as HTML, with what its prose names marked for peeks. Each comment is read on its own, so it is its own
 * section, and its glossary terms are quiet. A comment names the symbol it documents as self, so it does not mark
 * itself */
export async function renderMarkdown(markdown: string, options: { self?: string } = {}): Promise<string> {
    processor ??= createMarkdownProcessor({
        shikiConfig: { theme: fluxerlyTheme as never, langs: [gitignoreGrammar as never], transformers: [collapseLongCode] },
        remarkPlugins: [remarkBareNames, remarkGuides, remarkLongCode, remarkFrameBars, remarkEntries],
        rehypePlugins: [[rehypePeek, { terms: peekData().terms, comment: true }], rehypeCodeBreaks],
        smartypants: false,
    })
    return (await (await processor).render(markdown, { frontmatter: options.self ? { peekSelf: options.self } : {} })).code
}

// Words whose period does not end a sentence
const abbreviations = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|approx)$/i

/** One paragraph of Markdown as its first sentence, the summary, then the rest of its sentences as one paragraph, the
 * words unchanged. A paragraph's last period is left out, as everywhere on the site. Text with blank lines, lists,
 * quotes, headings or code blocks stays as it is */
export function leadParagraphs(markdown: string | undefined): string | undefined {
    const text = markdown?.trim()
    if (!text || /\n\s*\n/.test(text) || /^\s*(?:[-*+] |\d+[.)] |#|>|```|\|)/m.test(text)) return markdown
    // Inline code and links are set aside first, so a period inside them never ends a sentence
    const kept: string[] = []
    const masked = text.replace(/`[^`]*`|\[[^\]]*\]\([^)]*\)/g, (match) => `\u0000${kept.push(match) - 1}\u0001`).replace(/\s*\n\s*/g, " ")
    const restore = (part: string) => part.replace(/\u0000(\d+)\u0001/g, (_, index) => kept[Number(index)]!)
    const ending = (part: string) => part.replace(/(?<!\.)\.$/, "")
    for (const match of masked.matchAll(/\.\s+(?=[A-Z"(\u0000])/g)) {
        const before = masked.slice(0, match.index)
        if (abbreviations.test(before) || !/[\w)"'\u0001]$/.test(before)) continue
        return `${restore(before)}\n\n${restore(ending(masked.slice(match.index + match[0].length)))}`
    }
    return restore(ending(masked))
}

// Names in comment prose

interface MdNode {
    type: string
    value?: string
    lang?: string | null
    children?: MdNode[]
}

// Prose that already marks or links its text, or that is code
const unmarked = new Set(["inlineCode", "code", "link", "linkReference", "heading", "html", "definition"])

// A package specifier, a file path, a call, a dotted path, or a word with an inner capital such as waitForClose
const bareName =
    /(?<![\w.$/#@'`-])(@[\w-]+\/[\w-]+(?:\/[\w-]+)*|(?:[\w@.-]+\/)+[\w-]+\.[a-z]{2,5}|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\)|[A-Za-z_$][\w$]+(?:\.[A-Za-z_$][\w$]+)+|[A-Za-z_$]*[a-z][A-Z][\w$]*)(?![\w$-])/g

// Product names such as Node.js read as words, not code
const productName = /^[A-Z][a-z]+\.js$/

/** Whether a bare token in comment prose names code. A capitalised word with an inner capital, such as MessageFlags, is
 * code only when the reference declares it, so TypeScript and GitHub stay words */
function namesCode(token: string): boolean {
    if (token.startsWith("@") || token.includes("/") || token.endsWith("()")) return true
    if (token.includes(".")) return !productName.test(token)
    return /^[a-z_$]/.test(token) || peekData().terms.declarations.has(token)
}

/** Wraps the API names, paths and packages that a source comment leaves bare in inline code, as the guides write them.
 * The peek marks then treat them as the guides' names */
function remarkBareNames() {
    const visit = (node: MdNode) => {
        if (!node.children) return
        node.children = node.children.flatMap((child): MdNode[] => {
            if (unmarked.has(child.type)) return [child]
            if (child.type !== "text") return (visit(child), [child])
            const value = child.value ?? ""
            const pieces: MdNode[] = []
            let at = 0
            for (const match of value.matchAll(bareName)) {
                const token = match[1]!
                if (!namesCode(token)) continue
                if (match.index > at) pieces.push({ type: "text", value: value.slice(at, match.index) })
                pieces.push({ type: "inlineCode", value: token })
                at = match.index + token.length
            }
            if (!pieces.length) return [child]
            if (at < value.length) pieces.push({ type: "text", value: value.slice(at) })
            return pieces
        })
    }
    return (tree: MdNode) => visit(tree)
}

// Code frames

const languageNames: Record<string, string> = { ts: "TypeScript", typescript: "TypeScript", js: "JavaScript", javascript: "JavaScript", json: "JSON", sh: "Shell", bash: "Shell", shell: "Shell", log: "Log", systemd: "systemd unit", ini: "INI" }

/** A code frame without a bar gets one that names its language, so every example in the reference wears the same bar as
 * a JavaScript and TypeScript pair. The copy button moves from the corner into the bar */
function remarkFrameBars() {
    const corner = /^<figure class="code-frame" data-copy-root><div class="code-corner">([\s\S]*)<\/div>$/
    const visit = (node: MdNode) => {
        const children = node.children
        if (!children) return
        children.forEach((child, index) => {
            const frame = child.type === "html" ? corner.exec(child.value ?? "") : null
            // The frame's opening is followed by the variant's opening and then the code
            const code = children[index + 2]
            const language = code?.type === "code" ? languageNames[code.lang ?? ""] : undefined
            if (frame && language) child.value = `<figure class="code-frame has-bar" data-copy-root><div class="code-bar"><span class="code-file" data-pagefind-ignore>${language}</span>${frame[1]}</div>`
            else visit(child)
        })
    }
    return (tree: MdNode) => visit(tree)
}
