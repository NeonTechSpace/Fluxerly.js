import { readdir, readFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

// The error and log codes page is generated from the SDK's code catalogue. The check below scans the SDK source for
// the codes it creates, so a new code without a catalogue entry, or an entry for a removed code, fails generation

export const codePageSlug = "error-and-log-codes"
const catalogueFile = join("src", "internal", "code-catalogue.ts")
const dotted = /^[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)+$/

async function sourceFiles(directory) {
    const files = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path)
    }
    return files
}

/** A template literal as a catalogue key: each substitution becomes <name> from its last identifier */
function templateKey(template) {
    if (template.startsWith("${")) return undefined
    return template.replace(/\$\{([^}]*)\}/g, (_, expression) => `<${expression.match(/(\w+)\s*$/)?.[1] ?? "value"}>`)
}

/**
 * Codes the SDK source creates: string and template literals in code: properties, operationErrorSettings prefixes as
 * <prefix>.<reason> families, and every dotted string literal, used to find catalogue entries whose code is gone
 */
export async function scanSdkCodes(sdkRoot) {
    const created = new Map()
    const literals = new Set()
    for (const file of await sourceFiles(join(sdkRoot, "src"))) {
        const path = relative(sdkRoot, file)
        if (path === catalogueFile) continue
        const lines = (await readFile(file, "utf8")).split(/\r?\n/)
        lines.forEach((line, index) => {
            if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) return
            const where = `${path.split(sep).join("/")}:${index + 1}`
            for (const match of line.matchAll(/"([^"\\]*)"/g)) if (dotted.test(match[1])) literals.add(match[1])
            const property = line.match(/\bcode:\s*(.+)$/)
            if (property) {
                // Only the code value, not later properties on the same line such as a message template
                const value = property[1].split(/,\s*\w+\s*:/)[0]
                for (const match of value.matchAll(/"([^"\\]*)"/g))
                    if (dotted.test(match[1]) && !created.has(match[1])) created.set(match[1], where)
                for (const match of value.matchAll(/`([^`]*)`/g)) {
                    const key = templateKey(match[1])
                    if (key !== undefined && !created.has(key)) created.set(key, where)
                }
            }
            for (const match of line.matchAll(/operationErrorSettings\(\s*"([^"]+)"/g)) {
                const key = `${match[1]}.<reason>`
                if (!created.has(key)) created.set(key, where)
            }
        })
    }
    return { created, literals }
}

/** Import the SDK's catalogue from source. Node strips its TypeScript types */
export async function readCodeCatalogue(sdkRoot) {
    const { errorCodes, logCodes, operationReasonMeanings } = await import(pathToFileURL(resolve(sdkRoot, catalogueFile)).href)
    return { errorCodes, logCodes, operationReasonMeanings }
}

/** Throw when a created code has no entry, or an entry names a code the source no longer creates or uses */
export function checkCodeCatalogue({ errorCodes, logCodes }, { created, literals }) {
    const problems = []
    for (const [code, where] of created)
        if (!Object.hasOwn(errorCodes, code) && !Object.hasOwn(logCodes, code))
            problems.push(`${code} (${where}) has no entry in the SDK code catalogue`)
    for (const code of Object.keys(errorCodes))
        if (!created.has(code)) problems.push(`Error code ${code} is catalogued but no longer created`)
    // Log codes are type-checked where they are emitted, so a catalogued log code only needs to appear in the source
    for (const code of Object.keys(logCodes))
        if (!created.has(code) && !literals.has(code))
            problems.push(`Log code ${code} is catalogued but no longer emitted`)
    if (problems.length)
        throw new Error(`The SDK code catalogue (${catalogueFile.split(sep).join("/")}) is out of date:\n  ${problems.join("\n  ")}`)
}

const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ")
const byCode = ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)

/** The catalogue page as Markdown with frontmatter */
export function renderCodeCatalogue({ errorCodes, logCodes, operationReasonMeanings }) {
    const reasons = Object.entries(operationReasonMeanings).map(([reason, meaning]) => `| \`${reason}\` | ${cell(meaning)} |`)
    const errors = Object.entries(errorCodes)
        .sort(byCode)
        .map(([code, entry]) => {
            const placeholder = code.match(/<(\w+)>/)?.[1]
            const values = entry.values?.map((value) => `\`${value}\``)
            const meaning =
                values === undefined || placeholder === undefined
                    ? entry.meaning
                    : `${entry.meaning}. The ${placeholder} is one of ${values.slice(0, -1).join(", ")} or ${values.at(-1)}`
            return `| \`${code}\` | \`${entry.error}\` | ${cell(meaning)} | ${cell(entry.action ?? "")} |`
        })
    const logs = Object.entries(logCodes)
        .sort(byCode)
        .map(([code, entry]) => `| \`${code}\` | ${entry.levels.join(", ")} | ${cell(entry.meaning)} | ${cell(entry.action ?? "")} |`)
    return [
        "---",
        `title: ${JSON.stringify("Error and log codes")}`,
        "---",
        "",
        "Every SDK error has a stable `code`, and every log record has a `code` too. Search this page for a code copied from an error or a log line",
        "",
        "A code with a placeholder, such as `guild.<reason>`, stands for a family. The error's field of the same name, such as `reason`, supplies the value",
        "",
        "## Error codes",
        "",
        "The output of `describeError(error)` shows the code in brackets after the error name. In JSON log output, a record's `error.code` holds it",
        "",
        "| Code | Error | Meaning | What to do |",
        "| --- | --- | --- | --- |",
        ...errors,
        "",
        "## Operation reasons",
        "",
        "Request failures, such as `guild.<reason>` and `message.<reason>`, share these reasons",
        "",
        "| Reason | Meaning |",
        "| --- | --- |",
        ...reasons,
        "",
        "## Log record codes",
        "",
        "Readable console lines show the record code in brackets after the category, and JSON lines hold it in `code`",
        "",
        "| Code | Levels | Meaning | What to do |",
        "| --- | --- | --- | --- |",
        ...logs,
        "",
    ].join("\n")
}

/** Check the SDK's catalogue against its source and render the page */
export async function generateCodeCatalogue(sdkRoot) {
    const catalogue = await readCodeCatalogue(sdkRoot)
    checkCodeCatalogue(catalogue, await scanSdkCodes(sdkRoot))
    return renderCodeCatalogue(catalogue)
}
