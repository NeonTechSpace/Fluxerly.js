// Tables whose cells hold sentences read as prose squeezed into columns, so they become entries: the first column as
// the entry's own line, then the other columns in their order, each under its column's name as a quiet label. A table
// of two columns needs no labels, the term and its text say enough. Tables of short cells stay tables. The decision is
// made from the table's shape, so the Markdown stays a plain table and later imports keep working.
// An entry whose term holds a record code, such as lifecycle.connectionLost, is anchored at that code, so a log line's
// code can be linked and found on the page

// Cells outside the first column that average more characters than this read as prose
const proseCells = 60

const recordCode = /^[a-z][A-Za-z]*\.[A-Za-z][\w.]*$/

const textOf = (node) => (node.type === "text" || node.type === "inlineCode" ? node.value : (node.children ?? []).map(textOf).join(""))

const isProse = (table) => {
    const cells = table.children.slice(1).flatMap((row) => row.children.slice(1))
    return cells.length > 0 && cells.reduce((sum, cell) => sum + textOf(cell).trim().length, 0) / cells.length > proseCells
}

const node = (type, tagName, properties, children) => ({ type, data: { hName: tagName, hProperties: properties }, children })

// The rest of a term, without filler words, tells two entries for the same code apart: lifecycle.connectionEnded-close-4004
const qualifier = (text) =>
    text
        .toLowerCase()
        .replace(/\b(?:with|for|an?|the|and|or)\b/g, " ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")

// Column names that carry one of the site's two voices: violet for what the SDK reports, cyan for what the reader does
const voiceOf = (label) => (/\bmeans?\b/i.test(label) ? "sdk" : /\bwhat to do\b/i.test(label) ? "you" : undefined)

function anchor(term, used) {
    const codes = term.children.filter((child) => child.type === "inlineCode" && recordCode.test(child.value))
    let id
    for (const code of codes) {
        code.data = { ...code.data, hProperties: { ...code.data?.hProperties, className: ["record"] } }
        if (used.has(code.value)) continue
        used.add(code.value)
        // The first new code names the entry, any further one marks its own place in the term
        if (id) code.data.hProperties.id = code.value
        else id = code.value
    }
    if (id || !codes.length) return id
    const base = `${codes[0].value}-${qualifier(textOf(term).replace(codes[0].value, "")) || "more"}`
    let candidate = base
    for (let count = 2; used.has(candidate); count++) candidate = `${base}-${count}`
    used.add(candidate)
    return candidate
}

function entries(table, used) {
    const [head, ...rows] = table.children
    const labels = head.children.slice(1)
    const labelled = labels.length > 1
    return node(
        "entries",
        "dl",
        { className: ["entries"], dataParts: labels.length },
        rows.map((row) => {
            const [term, ...parts] = row.children
            const id = anchor(term, used)
            const mark = id
                ? [node("entryMark", "a", { className: ["entry-mark"], href: `#${id}`, ariaLabel: `Link to ${textOf(term).trim()}`, dataPagefindIgnore: "" }, [{ type: "text", value: "#" }])]
                : []
            return node("entry", "div", { className: ["entry"], ...(id ? { id } : {}) }, [
                node("entryTerm", "dt", { className: ["entry-term"] }, [...term.children, ...mark]),
                ...parts
                    .map((cell, index) => [cell, labels[index]])
                    .filter(([cell]) => textOf(cell).trim())
                    .map(([cell, label]) => {
                        const voice = label ? voiceOf(textOf(label)) : undefined
                        // The leading space keeps the term and the part apart in the search index, and renders as nothing
                        return node("entryPart", "dd", { className: ["entry-part"], ...(voice ? { dataVoice: voice } : {}) }, [
                            { type: "text", value: " " },
                            ...(labelled && label ? [node("entryLabel", "span", { className: ["entry-label"] }, structuredClone(label.children))] : []),
                            { type: "paragraph", children: cell.children },
                        ])
                    }),
            ])
        }),
    )
}

export default function remarkEntries() {
    return (tree) => {
        const used = new Set()
        const visit = (parent) => {
            if (!Array.isArray(parent.children)) return
            parent.children = parent.children.map((child) => (child.type === "table" && child.children.length > 1 && isProse(child) ? entries(child, used) : (visit(child), child)))
        }
        visit(tree)
    }
}
