// A comment's prose in the reference, parted so it reads as steps instead of a wall. The words stay as they are, and a paragraph's
// last period is left out, as everywhere on the site

// Words whose period does not end a sentence
const abbreviations = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|approx)$/i

// A block of Markdown that isn't running text
const notProse = /^\s*(?:[-*+] |\d+[.)] |#|>|```|\|)/m

// A paragraph over this many words is a wall, and it is parted into paragraphs of about this many at most
const wall = 80
const part = 55

const words = (text: string) => text.trim().split(/\s+/).length
const withoutLastPeriod = (text: string) => text.replace(/(?<!\.)\.$/, "")

// Inline code and links are set aside first, so a period inside them never ends a sentence
function sentencesOf(text: string) {
    const kept: string[] = []
    const masked = text.replace(/`[^`]*`|\[[^\]]*\]\([^)]*\)/g, (match) => `\u0000${kept.push(match) - 1}\u0001`).replace(/\s*\n\s*/g, " ")
    const sentences: string[] = []
    let from = 0
    for (const match of masked.matchAll(/\.\s+(?=[A-Z"(\u0000])/g)) {
        const before = masked.slice(0, match.index)
        if (abbreviations.test(before) || !/[\w)"'\u0001]$/.test(before)) continue
        sentences.push(masked.slice(from, match.index))
        from = match.index + match[0].length
    }
    sentences.push(withoutLastPeriod(masked.slice(from)))
    return sentences.map((sentence) => sentence.replace(/\u0000(\d+)\u0001/g, (_, index) => kept[Number(index)]!))
}

/** One paragraph of Markdown as its first sentence, the summary, then the rest of its sentences, parted like any long
 * paragraph. Text with blank lines, lists, quotes, headings or code blocks stays as it is */
export function leadParagraphs(markdown: string | undefined): string | undefined {
    const [first, rest] = splitLead(markdown)
    return rest ? `${first}\n\n${rest}` : first
}

/** One paragraph of Markdown as its first sentence and the rest of its sentences, parted like any long paragraph, so a page
 * can put something between them. Text with blank lines, lists, quotes, headings or code blocks stays whole as the first */
export function splitLead(markdown: string | undefined): [string | undefined, string | undefined] {
    const text = markdown?.trim()
    if (!text || /\n\s*\n/.test(text) || notProse.test(text)) return [markdown, undefined]
    const [first, ...rest] = sentencesOf(text)
    return [first, rest.length ? shortParagraphs(rest.join(". ")) : undefined]
}

/** Whether Markdown runs longer than one paragraph a reader takes in at once */
export const isLong = (markdown: string | undefined) => !!markdown && words(markdown) > wall

/** Markdown with each long paragraph parted at its sentence ends. Lists, quotes, headings and code stay as they are */
export function shortParagraphs(markdown: string | undefined): string | undefined {
    if (!markdown) return markdown
    let inCode = false
    return markdown
        .split(/(\n\s*\n)/)
        .map((block, index) => {
            if (index % 2) return block
            const fences = block.match(/^\s*```/gm)?.length ?? 0
            const code = inCode || fences > 0
            if (fences % 2) inCode = !inCode
            if (code || notProse.test(block) || words(block) <= wall) return block
            const parts: string[][] = [[]]
            for (const sentence of sentencesOf(block.trim())) {
                const current = parts.at(-1)!
                if (current.length && words(current.join(" ")) + words(sentence) > part) parts.push([sentence])
                else current.push(sentence)
            }
            return parts.map((sentences) => sentences.join(". ")).join("\n\n")
        })
        .join("")
}
