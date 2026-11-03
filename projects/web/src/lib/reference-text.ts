// The condensed reference and the task list as plain text, built from the reference model, and the checks that keep that
// text faithful to the model. The pages that serve them refuse to build while a check fails
import type { Declaration, Doc, Entry, Item, Member, Reexport, Signature, Type, TypeParameter } from "./reference"
import { typeHtml } from "./reference-format.ts"

// The same test as reference.ts, which loads the model through the site's bundler and so cannot be imported by tests
const isReexport = (item: Item): item is Reexport => item.kind === "reexport"

/** What the text needs besides the model: The line that names the SDK version, and how a site path becomes a full address */
export interface TextContext {
    about: string
    absolute: (url: string) => string
}

// The reference's text is HTML. Its source wraps sentences across lines and separates paragraphs with a blank line
const plainText = (html: string) =>
    html
        .replace(/<[^>]+>/g, "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&amp;", "&")

/** The first paragraph of a description on one line */
const firstParagraph = (text = "") => plainText(text.trim().split(/\n\s*\n/)[0] ?? "").replace(/\s*\n\s*/g, " ").trim()

/** The first sentence of a description, or its whole first paragraph when that has no sentence end */
export const firstSentence = (text = "") => {
    const paragraph = firstParagraph(text)
    return (/^.*?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph).trim()
}

/**
 * A first sentence as the text shows it. Public text ends no line with a period, so one final period goes, while ! and ?,
 * an ellipsis and periods inside the sentence stay. firstSentence keeps the period, which tells a whole sentence from one
 * that was cut
 */
export const shownSentence = (text = "") => firstSentence(text).replace(/(?<!\.)\.$/, "")

export function tasksMarkdown(entries: Entry[], { about, absolute }: TextContext): string {
    const sections = entries
        .filter((entry) => entry.tasks?.length)
        .map((entry) => {
            const groups = entry.tasks!.map((group) => `### ${group.name}\n\n${group.rows.map((row) => `- [\`${row.method}\`](${absolute(row.url)}): ${shownSentence(row.task)}`).join("\n")}`)
            return `## ${entry.title}\n\n${groups.join("\n\n")}`
        })
    return `# Every client method by task\n\n> ${about}\n\n${sections.join("\n\n")}\n`
}

/** A type as plain text on one line, in full */
const fullTypeText = (type: Type) => plainText(typeHtml(type, 100_000)).replace(/\s+/g, " ").trim()
// A type as plain text, cut short when it's too long to be useful on one line
const typeText = (type: Type): string => {
    const text = fullTypeText(type)
    return text.length > 200 ? `${text.slice(0, 200)}...` : text
}
// The generics a signature or a declaration names, so its types aren't left undeclared
const generics = (parameters: TypeParameter[] = []) =>
    parameters.length ? `<${parameters.map((parameter) => `${parameter.n}${parameter.c ? ` extends ${typeText(parameter.c)}` : ""}${parameter.d ? ` = ${typeText(parameter.d)}` : ""}`).join(", ")}>` : ""
const call = (name: string, signature: Signature) =>
    `${name}${generics(signature.tp)}(${signature.p.map((parameter) => `${parameter.r ? "..." : ""}${parameter.n}${parameter.o ? "?" : ""}: ${typeText(parameter.t)}`).join(", ")}): ${typeText(signature.r)}`
const summaryOf = (doc?: Doc) => (doc?.summary ? `: ${shownSentence(doc.summary)}` : "")

function memberLines(members: Member[] = []): string[] {
    return members.flatMap((member) => {
        // A static member is called on the class, not on an instance
        const name = `${member.static ? "static " : ""}${member.name}`
        return member.signatures?.length
            ? member.signatures.map((signature) => `- \`${call(name, signature)}\`${summaryOf(signature.doc ?? member.doc)}`)
            : [`- \`${name}${member.optional ? "?" : ""}: ${member.type ? typeText(member.type) : "unknown"}\`${summaryOf(member.doc)}`]
    })
}

function declarationLines(item: Declaration, absolute: TextContext["absolute"]): string[] {
    const head = `#### ${item.kind} ${item.name}${generics(item.tp)}\n\nPage: ${absolute(item.url)}`
    // An inherited member is written out only where it's declared, so its owner is named here
    const inherited = (item.inherited ?? []).map((group) => `- Inherits from \`${group.from}\`: ${group.m.map((member) => `\`${member.n}\``).join(", ")}`)
    const about = item.doc?.summary ? [shownSentence(item.doc.summary)] : []
    const signatures = (item.signatures ?? []).map((signature) => `- \`${call(item.name, signature)}\`${summaryOf(signature.doc)}`)
    const shape = item.type && !item.members?.length ? [`- \`${typeText(item.type)}\``] : []
    return [head, ...about, [...signatures, ...shape, ...memberLines(item.members), ...inherited].join("\n")].filter(Boolean)
}

export function referenceText(entries: Entry[], { about, absolute }: TextContext): string {
    const sections = entries.map((entry) => {
        const categories = entry.categories.map((category) => {
            const items = category.items.map((item) =>
                isReexport(item) ? `#### ${item.name}\n\nPage: ${absolute(item.url)}\n\nThe same as in ${item.home}` : declarationLines(item, absolute).join("\n\n"),
            )
            return `### ${category.title}\n\n${items.join("\n\n")}`
        })
        return `## ${entry.title}\n\nImport from \`${entry.importPath}\`\n\n${categories.join("\n\n")}`
    })
    return `# Fluxerly.js reference, condensed\n\n> ${about}\n\n${sections.join("\n\n")}\n`
}

/**
 * Whether a rest parameter's type is a tuple literal without a rest element, which reads as a fixed number of
 * arguments. TypeDoc drops the rest element and labels of a readonly tuple, so a variadic tuple can arrive this way.
 * Arrays, conditional types and other computed types are left alone
 */
function fixedTuple(type: Type): boolean {
    const inner = typeof type === "object" && "k" in type && type.k === "op" && type.op === "readonly" ? type.t : type
    if (typeof inner !== "object" || !("k" in inner) || inner.k !== "tuple") return false
    const rest = (element: Type): boolean =>
        typeof element === "object" && "k" in element && (element.k === "rest" || (element.k === "named" && rest(element.t)))
    return !inner.t.some(rest)
}

/**
 * What the text would get wrong about the model, one line each: A description cut inside a sentence, a rest parameter
 * shown as a fixed number of arguments, a static member shown without its marker, or an export with no category, which
 * the text leaves out. An empty list means the text can be served
 */
export function referenceTextProblems(entries: Entry[]): string[] {
    const problems: string[] = []
    const description = (where: string, text?: string) => {
        if (!text) return
        const shown = firstSentence(text)
        if (shown !== firstParagraph(text) && !/[.!?]$/.test(shown)) problems.push(`${where}: Its description is cut inside a sentence, at "${shown.slice(-40)}"`)
    }
    const signature = (where: string, name: string, item: Signature) => {
        description(where, item.doc?.summary)
        const shown = call(name, item)
        for (const parameter of item.p.filter((candidate) => candidate.r)) {
            if (!shown.includes(`...${parameter.n}`)) problems.push(`${where}: Rest parameter ${parameter.n} is shown without "..."`)
            else if (fixedTuple(parameter.t)) problems.push(`${where}: Rest parameter ${parameter.n} has the fixed-length type ${fullTypeText(parameter.t)}`)
        }
    }
    for (const entry of entries) {
        for (const item of entry.uncategorized) problems.push(`${entry.title} ${item.name}: The export has no @category, so the text reference leaves it out`)
        for (const category of entry.categories)
            for (const item of category.items) {
                if (isReexport(item)) continue
                const where = `${entry.title} ${item.name}`
                description(where, item.doc?.summary)
                for (const each of item.signatures ?? []) signature(where, item.name, each)
                for (const member of item.members ?? []) {
                    const at = `${where}.${member.name}`
                    description(at, member.doc?.summary)
                    for (const each of member.signatures ?? []) signature(at, member.name, each)
                    if (member.static && !memberLines([member]).every((line) => line.startsWith("- `static "))) problems.push(`${at}: The static member is shown without "static"`)
                }
            }
        for (const group of entry.tasks ?? []) for (const row of group.rows) description(`${entry.title} task ${row.method}`, row.task)
    }
    return problems
}

/** Text to serve, or a build failure that lists every problem */
export function checkedText(text: string, problems: string[]): string {
    if (problems.length) throw new Error(`The text reference does not match the reference model:\n${problems.map((problem) => `- ${problem}`).join("\n")}`)
    return text
}
