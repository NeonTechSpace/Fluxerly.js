import type { Node } from "fumadocs-core/page-tree"
import { source } from "./source"
import { commandVariant } from "../../scripts/command-blocks.js"
import { firstSentence, summarizeReference } from "../../scripts/reference-summary.js"
import versions from "../../content/versions.json"

// The generated file types its values from whatever the last generation wrote, so declare the contract instead
const targets = versions.targets as { version: string; label: string; path: string }[]
const previewVersion = versions.previewVersion as string | null

type Page = ReturnType<typeof source.getPages>[number]

const isReference = (page: Page) => page.slugs[1] === "api"
// The changelog is release history, not usage, and would crowd the AI files
const isChangelog = (page: Page) => page.slugs.length === 2 && page.slugs[1] === "changelog"

/** Markdown twin of a non-reference page, next to its HTML page */
export function markdownTwinUrl(slugs: string[]) {
    return `/docs/${slugs.length === 1 ? `${slugs[0]}/index` : slugs.join("/")}.md`
}

function label(version: string) {
    if (version === "preview") return previewVersion ? `planned ${previewVersion}, unreleased source preview` : "unreleased source preview"
    const target = targets.find((entry) => entry.path === version)
    return target ? `${target.label} channel, SDK ${target.version}` : `SDK ${version}`
}

/** Pages of one documentation version in sidebar order */
export function versionPages(version: string): Page[] {
    const folder = source.getPageTree().children.find((node) => node.type === "folder" && node.$ref?.folder === version)
    const order: string[] = []
    const visit = (node: Node) => {
        if (node.type === "page") order.push(node.url)
        else if (node.type === "folder") {
            if (node.index) order.push(node.index.url)
            node.children.forEach(visit)
        }
    }
    if (folder) visit(folder)
    const pages = source.getPages().filter((page) => page.slugs[0] === version)
    const position = (page: Page) => {
        const index = order.indexOf(page.url)
        return index < 0 ? order.length : index
    }
    return pages.sort((left, right) => position(left) - position(right) || left.url.localeCompare(right.url))
}

// Package manager choices are browser controls, so assistants receive the default npm command
function readableCommands(markdown: string) {
    return markdown.replace(/^```command\r?\n([\s\S]*?)\r?\n```$/gm, (_block, metadata: string) =>
        "```sh\n" + commandVariant(JSON.parse(metadata)).command + "\n```")
}

/** Guide Markdown with its title, without generated metadata or browser-only syntax */
export function pageMarkdown(page: Page) {
    const description = page.data.description ? `\n\n${page.data.description}` : ""
    return `# ${page.data.title}${description}\n\n${readableCommands(page.data.entry.body ?? "").trim()}\n`
}

function describe(page: Page) {
    if (page.data.description) return page.data.description
    const body = page.data.entry.body ?? ""
    if (isReference(page) && page.slugs.length > 2) return summarizeReference(body).summary
    const paragraph = body.split(/\r?\n\r?\n/).find((block) => block.trim() && !/^\s*(?:#|```|<|\||>|-\s)/.test(block))
    return paragraph ? firstSentence(paragraph) : ""
}

const entry = (page: Page, url: string) => {
    const description = describe(page)
    return `- [${page.data.title}](${url})${description ? `: ${description}` : ""}`
}

export function llmsIndex(version: string) {
    const pages = versionPages(version)
    const guides = pages.filter((page) => !isReference(page))
    const reference = pages.filter(isReference)
    return [
        `# Fluxerly.js documentation`,
        `> Documentation for the Fluxerly.js SDK (${label(version)}). Guides are linked as Markdown. Every guide is in /docs/${version}/llms-full.txt and a condensed API reference is in /docs/${version}/llms-reference.txt`,
        `## Guides`,
        guides.map((page) => entry(page, markdownTwinUrl(page.slugs))).join("\n"),
        `## API reference`,
        reference.map((page) => entry(page, page.url)).join("\n"),
    ].join("\n\n") + "\n"
}

function condensedReference(page: Page) {
    const summary = summarizeReference(page.data.entry.body ?? "")
    const lines = [`## ${page.data.title}`, "", `Page: ${page.url}`]
    if (summary.summary) lines.push("", summary.summary)
    const members = summary.sections.map((section) => {
        const signature = section.signature || section.name
        return `- \`${signature}\`${section.summary ? `: ${section.summary}` : ""}`
    })
    const properties = summary.properties.map((property) =>
        `- \`${property.owner ?? page.data.title}.${property.name}\`${property.summary ? `: ${property.summary}` : ""}`)
    if (members.length) lines.push("", ...members)
    if (properties.length) lines.push("", ...properties)
    return lines.join("\n")
}

// Guides and reference are separate files, so each fits in one AI context
export function llmsFull(version: string) {
    const guides = versionPages(version).filter((page) => !isReference(page) && !isChangelog(page))
    return [
        `# Fluxerly.js documentation`,
        `> Documentation for the Fluxerly.js SDK (${label(version)}). This file contains every guide. A condensed API reference with signatures and first summary sentences is in /docs/${version}/llms-reference.txt`,
        ...guides.map((page) => `---\n\n${pageMarkdown(page).replace(/^# /, "# Guide: ").trim()}`),
    ].join("\n\n") + "\n"
}

export function llmsReference(version: string) {
    const reference = versionPages(version).filter((page) => isReference(page) && page.slugs.length > 2 && page.slugs[2] !== "tasks")
    return [
        `# Fluxerly.js API reference`,
        `> Condensed API reference for the Fluxerly.js SDK (${label(version)}), with signatures and first summary sentences. Every guide is in /docs/${version}/llms-full.txt`,
        ...reference.map(condensedReference),
    ].join("\n\n") + "\n"
}

/** Site-wide entry for AI tools, listing each documentation version's index */
export function llmsRoot(served: string[]) {
    return [
        `# Fluxerly.js`,
        `> Fluxerly.js is a bot SDK for Fluxer, for JavaScript, TypeScript and Effect. Each documentation version below has an index of its guides as Markdown, every guide in llms-full.txt and a condensed API reference in llms-reference.txt`,
        `## Documentation versions`,
        served.map((version) => `- [${label(version)}](/docs/${version}/llms.txt)`).join("\n"),
    ].join("\n\n") + "\n"
}
