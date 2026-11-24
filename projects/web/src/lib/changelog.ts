// The changelog as the docs show it. Changesets writes each change as a list item that starts with its commit and continues on lines
// of its own, such as the Affected and Migration lines of a breaking change. The words stay as they are: the commit moves to a quiet
// link after the change's first line, and each written line starts a line of its own instead of running on in one paragraph

// Lines that start a block of their own in Markdown, which a line before them never runs into
const startsBlock = /^\s*(?:[-*+] |\d+\. |#|```|~~~|>|\|)/

/** The changelog's Markdown, with each change's commit as a link at the end of its first line and its continuation lines kept apart */
export function changelogMarkdown(source: string, repository: string): string {
    const lines = source.replaceAll("\r\n", "\n").split("\n")
    let fenced = false
    return lines
        .map((raw, index) => {
            let line = raw.replace(/\s+$/, "")
            if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced
            if (fenced) return raw
            const commitMatch = /^(\s*[-*+] )([0-9a-f]{7,40}): (.*)$/.exec(line)
            if (commitMatch) line = `${commitMatch[1]}${commitMatch[3]} [${commitMatch[2]}](${repository}/commit/${commitMatch[2]})`
            const next = lines[index + 1]
            // A line followed by another of the same paragraph breaks there, as it was written
            const continues = line.trim() !== "" && !/^\s*#/.test(line) && next !== undefined && next.trim() !== "" && !startsBlock.test(next)
            return continues ? `${line}\\` : line
        })
        .join("\n")
}

/** Marks the rendered changelog for its styles: each commit link, and the label of one or two words that starts a line, such as
 * Affected, Migration or API reference */
export function markChangelog(html: string): string {
    return html
        .replace(/<a href="([^"]*\/commit\/([0-9a-f]{7,40}))"/g, (_, href: string, commit: string) => `<a class="change-commit" href="${href}" aria-label="Commit ${commit}"`)
        .replace(/(<br>\s*|<p(?: style="[^"]*")?>|<li(?: [^>]*)?>)([A-Z][\w-]*(?: [a-z][\w-]*)?):(?= )/g, '$1<span class="change-label">$2:</span>')
}
