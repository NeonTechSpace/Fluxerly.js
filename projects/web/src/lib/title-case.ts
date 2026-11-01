// Title case for the titles the site prints: page titles, headings, nav and buttons. Short joining words stay lower
// inside a title, and a word that carries its own spelling, such as npm, OAuth or bot.ts, is left as written

const small = new Set("a an and as at but by en for from if in into nor of on onto or over per the to via vs with".split(" "))
// Names spelled in lower case on purpose
const spelled = new Set(["npm", "pnpm", "npx", "bunx", "js"])

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

const written = (word: string) => /[\p{Lu}\p{N}./_@#]/u.test(word) || spelled.has(word)

const casePart = (part: string, edge: boolean) => {
    if (written(part)) return part
    if (!edge && small.has(part)) return part
    return capital(part)
}

export interface TitleEdges {
    // Whether this text starts or ends the title. A heading split around inline code passes false where the code touches
    first?: boolean
    last?: boolean
}

export function titleCase(text: string, { first = true, last = true }: TitleEdges = {}): string {
    const tokens = text.split(/(\s+)/)
    const words = tokens.flatMap((token, index) => (/\S/.test(token) ? [index] : []))
    let afterStop = false
    for (const [position, index] of words.entries()) {
        const token = tokens[index]!
        const match = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(token)!
        const [, before, word, after] = match
        const edge = (first && position === 0) || (last && position === words.length - 1) || afterStop
        // Each side of a hyphen counts as a word, and only the outer side of it can be an edge
        const cased = word!
            .split("-")
            .map((part, partIndex) => casePart(part, edge && partIndex === 0))
            .join("-")
        tokens[index] = `${before}${cased}${after}`
        afterStop = /[:?!]$/.test(token)
    }
    return tokens.join("")
}
