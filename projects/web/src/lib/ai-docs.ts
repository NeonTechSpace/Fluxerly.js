// The docs as plain text for AI tools and anything else that reads text: each guide as Markdown, an index of them, all guides in one file, and
// a condensed reference. A version's files describe that version, and their first lines name it
import { readFileSync } from "node:fs"
import { guideAsMarkdown } from "../../scripts/docs/remark-guides.mjs"
import inventory from "@content/guides/meta.json"
import { featurePages } from "./links"
import { titleCase } from "./title-case"
import { model } from "./reference"
import { checkedText, referenceText as condensedText, referenceTextProblems, tasksMarkdown as tasksText } from "./reference-text.ts"

const raw = import.meta.glob<string>("@content/guides/*.md", { query: "?raw", import: "default", eager: true })
export const site = "https://fluxerly.neontechspace.com"
const base = import.meta.env.PUBLIC_DOCS_BASE ?? "/docs/"
const version = process.env.DOCS_VERSION ?? (JSON.parse(readFileSync("../sdk/package.json", "utf8")) as { version: string }).version
const about = `Fluxerly.js is a Fluxer-native bot SDK for JavaScript, TypeScript and Effect\n\nVoice: Fluxerly waits for Fluxer's new voice system and does not support voice over LiveKit. Fluxer is replacing LiveKit with its own voice system, which should arrive soon, and bot voice will come with it\n\nThese files describe SDK version ${version}`

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

// One guide read on its own, away from the site, says which SDK version it describes. The combined export says so once, at its top
export const singleGuideMarkdown = (source: string) => guideMarkdown(source).replace(/^(?:# .*\n\n)?/, (title) => `${title}This guide describes SDK version ${version}\n\n`)

const entryOf = (item: string | { title: string; href: string }) => {
    // The docs menu links this index itself, which the index doesn't list
    if (typeof item !== "string" && item.href === "/docs/llms.txt") return undefined
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
    // The feature pages describe the site's newest version, so only that version's index lists them
    const features = base === "/docs/" ? [`## What Fluxerly includes\n\n${featurePages.map((page) => `- [${page.title}](${site}/${page.slug}/): ${page.summary}`).join("\n")}`] : []
    const sections = [
        ...features,
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

export const tasksMarkdown = () => checkedText(tasksText(model.entries, { about, absolute }), referenceTextProblems(model.entries))

export const referenceText = () => checkedText(condensedText(model.entries, { about, absolute }), referenceTextProblems(model.entries))
