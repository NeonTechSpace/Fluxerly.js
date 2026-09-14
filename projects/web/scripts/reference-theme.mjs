import { MarkdownPageEvent, MarkdownTheme, MarkdownThemeContext } from "typedoc-plugin-markdown"
import { DeclarationReflection } from "typedoc"

// TypeDoc owns symbol routes and anchors, this adapter maps its files to Astro pages
export function pageUrl(url) {
    if (!url || /^(https?:|mailto:)/.test(url)) return url
    return url.replace(/(?:^|\/)index\.md(?=#|$)/, "/").replace(/\.md(?=#|$)/, "/")
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

class Context extends MarkdownThemeContext {
    constructor(...args) {
        super(...args)
        this.templates.index = (page) => {
            const entry = (name) => page.project.children.find((child) => child.name === name)
            return `Look up the methods and types available in the SDK.
If you're starting your first bot, follow the [first-bot guide](${this.options.getValue("publicPath").replace(/\/api$/, "/quick-start/")}) first

## JavaScript & TypeScript

Use this API for a JavaScript or TypeScript bot.
Import from \`@neontechspace/fluxerly\`

[Browse methods and types](${this.urlTo(entry("js-ts"))})

## Effect-native

Use this entry point if your application already uses Effect.
Import from \`@neontechspace/fluxerly/effect\`

[Browse the Effect API](${this.urlTo(entry("Effect"))})
`
        }
        const renderReflection = this.templates.reflection
        this.templates.reflection = (page) => page.model === page.project
            ? this.templates.index(page)
            : renderReflection(page)
        const renderComment = this.partials.comment
        this.partials.comment = (comment, options) => {
            const isFunction = this.page.model instanceof DeclarationReflection &&
                this.page.model.signatures?.some((signature) => signature.comment === comment)
            const isIntroduction = this.page.model.comment === comment || isFunction
            const remarks = comment.blockTags.filter((tag) => tag.tag === "@remarks")
            if (!isIntroduction || remarks.length === 0) return renderComment(comment, options)
            const introduction = comment.clone()
            introduction.blockTags = introduction.blockTags.filter((tag) => tag.tag !== "@remarks")
            const summary = renderComment(introduction, options)
            if (options?.showSummary === false) return summary
            const detailComment = comment.clone()
            detailComment.summary = []
            detailComment.blockTags = remarks
            const detail = isFunction ? remarks.map((tag) => this.helpers.getCommentParts(tag.content)).join("\n\n")
                : renderComment(detailComment, options)
            return `${summary}\n\n<details${isFunction ? ' id="remarks"' : ""}>\n<summary>Usage details</summary>\n\n${detail}\n\n</details>`
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
        this.partials.groups = (model, options) => {
            if (model.parent !== this.page.project) return renderGroups(model, options)
            return (model.groups ?? []).map((group) => {
                const title = group.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
                return `<details>\n<summary>${title}</summary>\n\n${renderGroups({ ...model, groups: [group] }, options)}\n\n</details>`
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
    app.renderer.on(MarkdownPageEvent.BEGIN, (page) => {
        page.frontmatter = {
            ...page.frontmatter,
            title: page.model === page.project ? "API reference"
                : page.model.parent === page.project && page.model.name === "js-ts" ? "JavaScript & TypeScript"
                : page.model.parent === page.project && page.model.name === "Effect" ? "Effect-native"
                : page.model.name,
        }
    })
}
