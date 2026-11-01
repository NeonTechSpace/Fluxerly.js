// What a docs page tells search engines: a title that no other page shares and a description long enough to fill a
// search result. Both are made from what the pages already hold, so new guides and reference pages get them too

export interface TitledPage {
    href: string
    title: string
    // The steps that can tell this page apart from another of the same name, nearest first, such as its entry point
    context: string[]
}

// Pages that share a title each take the nearest step of their context that tells them apart. A step that repeats the
// title is skipped, and when the nearest steps still clash, the clashing pages take one more step
export function titleQualifiers(pages: TitledPage[]): Map<string, string> {
    const groups = new Map<string, TitledPage[]>()
    for (const page of pages) {
        const key = page.title.toLowerCase()
        groups.set(key, [...(groups.get(key) ?? []), page])
    }
    const qualifiers = new Map<string, string>()
    for (const group of groups.values()) {
        if (group.length < 2) continue
        const steps = new Map(group.map((page) => [page, page.context.filter((step) => step.toLowerCase() !== page.title.toLowerCase())]))
        const taken = new Map(group.map((page) => [page, 1]))
        const label = (page: TitledPage) => steps.get(page)!.slice(0, taken.get(page)).join(" · ")
        for (let round = 0; round < 4; round++) {
            const counts = new Map<string, number>()
            for (const page of group) counts.set(label(page), (counts.get(label(page)) ?? 0) + 1)
            const clashing = group.filter((page) => counts.get(label(page))! > 1 && taken.get(page)! < steps.get(page)!.length)
            if (!clashing.length) break
            for (const page of clashing) taken.set(page, taken.get(page)! + 1)
        }
        for (const page of group) if (label(page)) qualifiers.set(page.href, label(page))
    }
    return qualifiers
}

// A search result cuts a title at about 65 characters, so a long one drops the word docs before it would be cut
export function docsPageTitle(title: string, qualifier?: string): string {
    const name = qualifier ? `${title} · ${qualifier}` : title
    const full = `${name} · Fluxerly.js docs`
    return full.length > 65 ? `${name} · Fluxerly.js` : full
}

const enough = 100
const room = 160
const genericSections = new Set(["constructor", "properties", "methods", "inherited", "categories", "other"])

const clean = (text: string) =>
    text
        .replace(/[​­]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.:]$/, "")

const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z0-9`"])/)

// A search result shows about 155 characters, and a description much shorter than that leaves the result half empty.
// A short one goes on with the page's own words, in the order given, such as its opening paragraphs and its lead, then
// its section names.
// Text the description already says is not repeated, and a sentence only joins when it fits whole
export function completeDescription(base: string, more: string[], sections: string[]): string {
    let text = clean(base)
    for (const candidate of more.map(clean)) {
        if (text.length >= enough) break
        if (!candidate || text.toLowerCase().includes(candidate.toLowerCase())) continue
        // The page's paragraph starts with what the description says, such as a reference entry's first sentence
        const parts = candidate.toLowerCase().startsWith(text.toLowerCase()) ? sentences(candidate) : [text, ...sentences(candidate)]
        let joined = ""
        for (const part of parts.map(clean)) {
            const next = joined ? `${joined}. ${part}` : part
            if (next.length > room) break
            joined = next
        }
        if (joined.length > text.length) text = joined
    }
    const named = sections.map(clean).filter((section) => section && !genericSections.has(section.toLowerCase()))
    if (text.length < enough && named.length) {
        const listed = (count: number) => named.slice(0, count).join(", ") + (count < named.length ? ` and ${named.length - count} more` : "")
        let shown = 0
        while (shown < named.length && `${text}. Sections: ${listed(shown + 1)}`.length <= room) shown++
        // One name followed by "and 10 more" says little, so a list names at least two sections or all there are
        if (shown >= Math.min(2, named.length)) text = `${text}. Sections: ${listed(shown)}`
    }
    return text
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

// The text of a rendered page's opening paragraphs. Notes, code, lists, tables and figures are left out, since a
// search result should read the page's own prose. So are paragraphs with a class, which are labels and links such as
// a reference page's Parameters
export function openingParagraphs(html: string, count = 3): string[] {
    const prose = html.replace(/<(blockquote|aside|figure|details|nav|table|pre|ul|ol|script|style)\b[\s\S]*?<\/\1>/gi, "")
    return [...prose.matchAll(/<p>([\s\S]*?)<\/p>/gi)]
        .slice(0, count)
        .map((match) =>
            match[1]!
                .replace(/<[^>]+>/g, "")
                .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
                .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
                .replace(/&(\w+);/g, (entity, name: string) => entities[name] ?? entity),
        )
        .map(clean)
        .filter(Boolean)
}
