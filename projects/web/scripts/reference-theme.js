import { readFileSync } from "node:fs"
import { MarkdownPageEvent, MarkdownTheme, MarkdownThemeContext } from "typedoc-plugin-markdown"
import { DeclarationReflection, KindRouter, ReflectionKind } from "typedoc"
import { referenceEntries } from "./reference-entries.js"

// Classes, interfaces and enums keep their own pages. Functions, variables and type aliases
// render as sections of their entry point's page
const inlineKinds = ReflectionKind.Function | ReflectionKind.Variable | ReflectionKind.TypeAlias
export const referenceRouter = "fluxerly-kind"
export const apiIndexPartial = new URL("../content/partials/api-index.md", import.meta.url)

class ReferenceRouter extends KindRouter {
    extension = ".md"
    getPageKind(target) {
        if (target instanceof DeclarationReflection && target.kindOf(inlineKinds)) return undefined
        return super.getPageKind(target)
    }
}

// TypeDoc owns symbol routes and anchors, this adapter maps its files to Astro pages
export function pageUrl(url) {
    if (!url || /^(https?:|mailto:)/.test(url)) return url
    return url.replace(/(?:^|\/)index\.md(?=#|$)/, "/").replace(/\.md(?=#|$)/, "/")
}

// Category anchors are shared by the entry point page and the reference sidebar
export function categoryAnchor(title) {
    const slug = title.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")
    return `category-${slug || "other"}`
}

// Format from TypeDoc's type tree, not by parsing TypeScript or altering its links
export function readableType(type, render) {
    const inline = render(type)
    if (type?.type !== "reference" || !type.typeArguments?.length || type.toString().length < 60) return inline
    const argumentsText = type.typeArguments.map(render)
    const suffix = `\\<${argumentsText.join(", ")}\\>`
    if (!inline.endsWith(suffix)) return inline
    return `${inline.slice(0, -suffix.length)}\\<<br />&#160;&#160;${argumentsText.join(",<br />&#160;&#160;")}<br />\\>`
}

// The task index is derived from each client's namespaces and method summaries, not authored separately
const taskIndexes = new WeakMap()
export const taskIndexFor = (app) => taskIndexes.get(app)
const tableText = (value) => value.replace(/\s+/g, " ").replaceAll("|", "\\|").trim()

function taskIndex(context, project) {
    // The first sentence of the summary's first paragraph, even when source wrapping splits it across lines
    const firstSentence = (comment) => {
        const text = comment ? context.helpers.getCommentParts(comment.summary) : ""
        const paragraph = tableText(text.split(/\r?\n\s*\r?\n/)[0] ?? "")
        const end = paragraph.search(/\.(?=\s+[A-Z])/)
        return (end < 0 ? paragraph : paragraph.slice(0, end)).replace(/\.$/, "")
    }
    const methodRows = (owner, prefix) => (owner.children ?? [])
        .filter((child) => child.kindOf(ReflectionKind.Method) && child.signatures?.length)
        .flatMap((method) => {
            const task = firstSentence(method.signatures[0].comment ?? method.comment)
            return task ? [`| ${task} | [\`${prefix}.${method.name}\`](${context.urlTo(method)}) |`] : []
        })
    const table = (rows) => ["| Task | Method |", "| --- | --- |", ...rows].join("\n")
    // Entry points without a Client interface, such as the testing entry points, contribute no section
    const sections = referenceEntries.flatMap(({ name, title }) => {
        const client = project.children?.find((child) => child.name === name)?.children
            ?.find((child) => child.name === "Client" && child.kindOf(ReflectionKind.Interface))
        if (!client) return []
        const groups = [["client", methodRows(client, "client")]]
        for (const property of client.children ?? []) {
            const target = property.type?.type === "reference" ? property.type.reflection : undefined
            if (target instanceof DeclarationReflection && target.kindOf(ReflectionKind.Interface))
                groups.push([`client.${property.name}`, methodRows(target, `client.${property.name}`)])
        }
        const content = groups.filter(([, rows]) => rows.length).map(([heading, rows]) => `### ${heading}\n\n${table(rows)}`)
        return content.length ? [`## ${title}`, ...content] : []
    })
    return sections.length ? sections.join("\n\n") + "\n" : undefined
}

const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

class Context extends MarkdownThemeContext {
    constructor(...args) {
        super(...args)
        this.templates.index = (page) => {
            const base = this.options.getValue("publicPath").replace(/\/api$/, "")
            const tasks = taskIndex(this, page.project)
            if (tasks) taskIndexes.set(this.theme.application, tasks)
            // The optional task section is kept only when a task index page is generated
            const index = readFileSync(apiIndexPartial, "utf8")
                .replace(/<!-- task-index -->\r?\n([\s\S]*?)<!-- \/task-index -->\r?\n?/, tasks ? "$1" : "")
            return index.trim().replaceAll("/docs/{{version}}", base) + "\n"
        }
        const renderReflection = this.templates.reflection
        this.templates.reflection = (page) => page.model === page.project
            ? this.templates.index(page)
            : renderReflection(page)
        // Remarks stay collapsed below the summary without a separate heading or renamed TOC entry
        const renderComment = this.partials.comment
        this.partials.comment = (comment, options) => {
            const remarks = comment.blockTags.filter((tag) => tag.tag === "@remarks")
            if (remarks.length === 0 || options?.isTableColumn) return renderComment(comment, options)
            const introduction = comment.clone()
            introduction.blockTags = introduction.blockTags.filter((tag) => tag.tag !== "@remarks")
            const summary = renderComment(introduction, options)
            if (options?.showSummary === false) return summary
            const detail = remarks.map((tag) => this.helpers.getCommentParts(tag.content)).join("\n\n")
            return `${summary}\n\n<details>\n<summary>Usage details</summary>\n\n${detail}\n\n</details>`
        }
        const renderType = (type) => this.partials.someType(type)
        const renderTitle = this.partials.signatureTitle
        this.partials.signatureTitle = (model, options) => {
            const title = renderTitle(model, options)
            if (!model.type) return title
            const inline = renderType(model.type)
            return title.endsWith(inline) ? title.slice(0, -inline.length) + readableType(model.type, renderType) : title
        }
        const renderReturns = this.partials.signatureReturns
        this.partials.signatureReturns = (model, options) => {
            const result = renderReturns(model, options)
            if (!model.type) return result
            const inline = this.helpers.getReturnType(model.type)
            if (inline.includes("\n")) return result
            return result.split("\n\n").map((block) => block === inline
                ? `> ${readableType(model.type, renderType)}` : block).join("\n\n")
        }
        const renderGroups = this.partials.groups
        const renderBody = this.partials.body
        const isEntryPoint = (model) => model.parent === this.page.project
        const hasOwnPages = (children) => children.every((child) => this.router.hasOwnDocument(child))
        // Own-page groups are compact indexes, while grouped symbols remain directly readable
        const renderGroup = (model, group, options) => {
            if (!hasOwnPages(group.children)) return renderGroups({ ...model, groups: [group] }, options)
            return `<details>\n<summary>${escapeHtml(group.title)}</summary>\n\n${renderGroups({ ...model, groups: [group] }, options)}\n\n</details>`
        }
        this.partials.groups = (model, options) => {
            if (!isEntryPoint(model)) return renderGroups(model, options)
            return (model.groups ?? []).map((group) => renderGroup(model, group, options)).join("\n\n")
        }
        // Categories lead entry point navigation once source comments assign them
        this.partials.body = (model, options) => {
            if (!isEntryPoint(model) || !model.categories?.length) return renderBody(model, options)
            return model.categories.map((category) => {
                const members = new Set(category.children)
                const groups = (model.groups ?? []).flatMap((group) => {
                    const children = group.children.filter((child) => members.has(child))
                    // Keep the group prototype, because partials may call its methods
                    return children.length
                        ? [Object.assign(Object.create(Object.getPrototypeOf(group)), group, { children, categories: undefined })]
                        : []
                })
                const content = groups.map((group) => renderGroup(model, group, { ...options, headingLevel: options.headingLevel + 1 }))
                return [`<a id="${categoryAnchor(category.title)}"></a>`, `## ${category.title}`, ...content].join("\n\n")
            }).join("\n\n")
        }
    }
    urlTo(reflection) {
        return pageUrl(super.urlTo(reflection))
    }
    relativeURL(url) {
        return pageUrl(super.relativeURL(url))
    }
}
class Theme extends MarkdownTheme {
    getRenderContext(page) {
        return new Context(this, page, this.application.options)
    }
}
export function load(app) {
    app.renderer.defineTheme("fluxerly", Theme)
    app.renderer.defineRouter(referenceRouter, ReferenceRouter)
    app.renderer.on(MarkdownPageEvent.BEGIN, (page) => {
        page.frontmatter = {
            ...page.frontmatter,
            title: page.model === page.project ? "API reference"
                : (page.model.parent === page.project && referenceEntries.find((entry) => entry.name === page.model.name)?.title)
                    || page.model.name,
        }
    })
}
