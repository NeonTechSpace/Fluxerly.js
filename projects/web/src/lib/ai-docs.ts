// The docs as plain text for AI tools and anything else that reads text: each guide as Markdown, an index of them, all guides in one file, and
// a condensed reference. A version's files describe that version, and their first lines name it
import { readFileSync } from "node:fs"
import { guideAsMarkdown } from "../../scripts/docs/remark-guides.mjs"
import inventory from "@content/guides/meta.json"
import { titleCase } from "./title-case"
import { isReexport, model, type Declaration, type Doc, type Member, type Signature, type Type, type TypeParameter } from "./reference"
import { typeHtml } from "./reference-format.ts"

const raw = import.meta.glob<string>("@content/guides/*.md", { query: "?raw", import: "default", eager: true })
export const site = "https://fluxerly.neontechspace.com"
const base = import.meta.env.PUBLIC_DOCS_BASE ?? "/docs/"
const version = process.env.DOCS_VERSION ?? (JSON.parse(readFileSync("../sdk/package.json", "utf8")) as { version: string }).version
const about = `Fluxerly.js is a Fluxer-native bot SDK for JavaScript, TypeScript and Effect\n\nThese files describe SDK version ${version}`

export const guides = Object.entries(raw)
    .map(([path, source]) => ({
        slug: /([\w-]+)\.md$/.exec(path)![1]!,
        title: titleCase(/^title:\s*["']?(.+?)["']?$/m.exec(source)?.[1] ?? ""),
        source,
    }))
    .sort((a, b) => (a.slug === "index" ? -1 : b.slug === "index" ? 1 : a.slug.localeCompare(b.slug)))

export const asText = (body: string) => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } })
export const asMarkdown = (body: string) => new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8" } })

const guideSlugs = new Set(guides.map((guide) => guide.slug))

// Text is read away from the site, so every link is a full address in this version. A guide's link goes to its Markdown, which keeps a reader in text
const absolute = (url: string) => `${site}${url.replace(/^\/docs\//, base)}`
function linkOf(url: string): string {
    const match = /^\/docs\/(?:([\w-]+)\/)?(#.*)?$/.exec(url)
    const slug = match?.[1] ?? "index"
    return match && guideSlugs.has(slug) ? `${site}${base}${slug}.md${match[2] ?? ""}` : absolute(url)
}

export const guideMarkdown = (source: string) => guideAsMarkdown(source).replace(/\]\((\/docs\/[^)\s]*)\)/g, (_: string, url: string) => `](${linkOf(url)})`)

const entryOf = (item: string | { title: string; href: string }) => {
    if (typeof item !== "string") return `- [${item.title}](${linkOf(item.href)})`
    const guide = guides.find((candidate) => candidate.slug === item)
    if (!guide) return undefined
    const description = /^description:\s*["']?(.+?)["']?$/m.exec(guide.source)?.[1]
    return `- [${guide.title}](${site}${base}${guide.slug}.md)${description ? `: ${description}` : ""}`
}

// Every version names the others, so a tool can match the version a project installed
function versionLines(): string[] {
    const listed = [...JSON.parse(process.env.DOCS_VERSIONS ?? "[]"), ...JSON.parse(process.env.DOCS_OLDER_VERSIONS ?? "[]")] as { label: string; version: string; base: string }[]
    return listed.filter((item) => item.base !== base).map((item) => `- [${item.label === item.version ? item.version : `${item.label} (${item.version})`}](${site}${item.base}llms.txt)`)
}

export function indexText(): string {
    const groups = inventory.groups.map((group) => {
        const entries = group.items.map(entryOf).filter(Boolean)
        return `## ${group.title}\n\n${entries.join("\n")}`
    })
    const versions = versionLines()
    const sections = [
        ...groups,
        `## Reference\n\n- [Every client method by task](${site}${base}api/tasks.md)\n- [The whole reference, condensed](${site}${base}llms-reference.txt): Every export with its signatures and members`,
        ...(versions.length ? [`## Other versions\n\n${versions.join("\n")}`] : []),
        `## Optional\n\n- [All guides in one file](${site}${base}llms-full.txt)`,
    ]
    return `# Fluxerly.js\n\n> ${about}\n\n${sections.join("\n\n")}\n`
}

export function fullText(): string {
    return `# Fluxerly.js guides\n\n> ${about}\n\n${guides.map((guide) => guideMarkdown(guide.source)).join("\n---\n\n")}`
}

// The reference's text is HTML, and each of its sentences sits on its own line
const plainText = (html: string) =>
    html
        .replace(/<[^>]+>/g, "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&amp;", "&")
const firstSentence = (text = "") => plainText(/^[^\n]*?[.!?](?=\s|$)|^[^\n]*/.exec(text.trim())?.[0] ?? "").trim()

export function tasksMarkdown(): string {
    const sections = model.entries
        .filter((entry) => entry.tasks?.length)
        .map((entry) => {
            const groups = entry.tasks!.map((group) => `### ${group.name}\n\n${group.rows.map((row) => `- [\`${row.method}\`](${absolute(row.url)}): ${firstSentence(row.task)}`).join("\n")}`)
            return `## ${entry.title}\n\n${groups.join("\n\n")}`
        })
    return `# Every client method by task\n\n> ${about}\n\n${sections.join("\n\n")}\n`
}

// A type as plain text, cut short when it's too long to be useful on one line
const typeText = (type: Type): string => {
    const text = plainText(typeHtml(type, 100_000)).replace(/\s+/g, " ").trim()
    return text.length > 200 ? `${text.slice(0, 200)}...` : text
}
// The generics a signature or a declaration names, so its types aren't left undeclared
const generics = (parameters: TypeParameter[] = []) =>
    parameters.length ? `<${parameters.map((parameter) => `${parameter.n}${parameter.c ? ` extends ${typeText(parameter.c)}` : ""}${parameter.d ? ` = ${typeText(parameter.d)}` : ""}`).join(", ")}>` : ""
const call = (name: string, signature: Signature) =>
    `${name}${generics(signature.tp)}(${signature.p.map((parameter) => `${parameter.r ? "..." : ""}${parameter.n}${parameter.o ? "?" : ""}: ${typeText(parameter.t)}`).join(", ")}): ${typeText(signature.r)}`
const summaryOf = (doc?: Doc) => (doc?.summary ? `: ${firstSentence(doc.summary)}` : "")

function memberLines(members: Member[] = []): string[] {
    return members.flatMap((member) =>
        member.signatures?.length
            ? member.signatures.map((signature) => `- \`${call(member.name, signature)}\`${summaryOf(signature.doc ?? member.doc)}`)
            : [`- \`${member.name}${member.optional ? "?" : ""}: ${member.type ? typeText(member.type) : "unknown"}\`${summaryOf(member.doc)}`],
    )
}

function declarationLines(item: Declaration): string[] {
    const head = `#### ${item.kind} ${item.name}${generics(item.tp)}\n\nPage: ${absolute(item.url)}`
    // An inherited member is written out only where it's declared, so its owner is named here
    const inherited = (item.inherited ?? []).map((group) => `- Inherits from \`${group.from}\`: ${group.m.map((member) => `\`${member.n}\``).join(", ")}`)
    const about = item.doc?.summary ? [firstSentence(item.doc.summary)] : []
    const signatures = (item.signatures ?? []).map((signature) => `- \`${call(item.name, signature)}\`${summaryOf(signature.doc)}`)
    const shape = item.type && !item.members?.length ? [`- \`${typeText(item.type)}\``] : []
    return [head, ...about, [...signatures, ...shape, ...memberLines(item.members), ...inherited].join("\n")].filter(Boolean)
}

export function referenceText(): string {
    const sections = model.entries.map((entry) => {
        const categories = entry.categories.map((category) => {
            const items = category.items.map((item) =>
                isReexport(item) ? `#### ${item.name}\n\nPage: ${absolute(item.url)}\n\nThe same as in ${item.home}` : declarationLines(item).join("\n\n"),
            )
            return `### ${category.title}\n\n${items.join("\n\n")}`
        })
        return `## ${entry.title}\n\nImport from \`${entry.importPath}\`\n\n${categories.join("\n\n")}`
    })
    return `# Fluxerly.js reference, condensed\n\n> ${about}\n\n${sections.join("\n\n")}\n`
}
