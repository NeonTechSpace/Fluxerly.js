import { parseVersion } from "./versions.js"

const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const labels = { latest: "Latest", rc: "RC", canary: "Canary" }

function rebaseLinkTargets(value, sourceVersion, alias) {
    const version = escapePattern(sourceVersion)
    const boundary = "(?=[/#?\\s)\\\"'>]|$)"
    return value
        .replace(new RegExp(`(\\]\\(\\s*<?)/docs/${version}${boundary}`, "g"), `$1/docs/${alias}`)
        .replace(new RegExp(`^(\\s{0,3}\\[[^\\]]+\\]:\\s*<?)/docs/${version}${boundary}`, "g"), `$1/docs/${alias}`)
        .replace(
            new RegExp(`(\\b(?:href|src)\\s*=\\s*[\\\"'])/docs/${version}${boundary}`, "g"),
            `$1/docs/${alias}`,
        )
}

function rebaseOutsideInlineCode(line, sourceVersion, alias) {
    let output = ""
    let cursor = 0
    while (cursor < line.length) {
        const opening = line.slice(cursor).match(/`+/)
        if (!opening || opening.index === undefined) return output + rebaseLinkTargets(line.slice(cursor), sourceVersion, alias)
        const start = cursor + opening.index
        output += rebaseLinkTargets(line.slice(cursor, start), sourceVersion, alias)
        const delimiter = opening[0]
        const end = line.indexOf(delimiter, start + delimiter.length)
        if (end < 0) return output + line.slice(start)
        output += line.slice(start, end + delimiter.length)
        cursor = end + delimiter.length
    }
    return output
}

export function rebaseAliasMarkdown(content, sourceVersion, alias) {
    parseVersion(sourceVersion)
    if (!Object.hasOwn(labels, alias)) throw new Error("Unknown documentation alias")
    let fence
    return content
        .split(/(?<=\n)/)
        .map((line) => {
            const body = line.endsWith("\n") ? line.slice(0, -1) : line
            const candidate = body.endsWith("\r") ? body.slice(0, -1) : body
            const marker = candidate.match(/^ {0,3}(`{3,}|~{3,})/)
            if (fence) {
                const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`)
                if (closing.test(candidate)) fence = undefined
                return line
            }
            if (marker) {
                fence = { character: marker[1][0], length: marker[1].length }
                return line
            }
            return rebaseOutsideInlineCode(line, sourceVersion, alias)
        })
        .join("")
}

export function docsAliasFiles(files, sourceVersion, alias) {
    parseVersion(sourceVersion)
    if (!Object.hasOwn(labels, alias)) throw new Error("Unknown documentation alias")
    if (!Array.isArray(files) || files.length === 0) throw new Error("Documentation alias source is empty")
    return files.map((file) => {
        if (file.path === "meta.json") {
            const metadata = JSON.parse(file.content)
            return { ...file, content: JSON.stringify({ ...metadata, title: labels[alias], root: "version" }) }
        }
        return file.path.endsWith(".md")
            ? { ...file, content: rebaseAliasMarkdown(file.content, sourceVersion, alias) }
            : { ...file }
    })
}
