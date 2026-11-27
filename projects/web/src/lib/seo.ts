import sdkPackage from "../../../sdk/package.json" with { type: "json" }
import { links } from "./links.ts"
import { siteOrigin } from "./site-address.mjs"

// What search engines and link previews read about the site. Every page's head goes through
// src/components/Seo.astro, and these are the shared facts it describes

export const siteUrl = (import.meta.env?.SITE ?? siteOrigin).replace(/\/$/, "")
export const siteName = "Fluxerly.js"

const sdkVersion = process.env.DOCS_VERSION ?? sdkPackage.version

export const homeTitle = "Fluxerly.js · Fluxer bot SDK for JavaScript, TypeScript, Effect"
export const homeDescription =
    "Build Fluxer bots and applications in JavaScript, TypeScript or Effect. Start with one file and take full control when you need it. Open source by NeonTechSpace"

// The picture every link preview shows
export const shareImage = {
    url: `${siteUrl}/og-image.jpg`,
    width: 1200,
    height: 630,
    alt: "Fluxerly.js, a Fluxer-native bot SDK: a few lines of bot code and the conductor mascot answering Pong!",
}

type Node = Record<string, unknown>

export const org: Node = {
    "@type": "Organization",
    "@id": `${siteUrl}/#org`,
    name: "NeonTechSpace",
    url: "https://github.com/NeonTechSpace",
    logo: `${siteUrl}/icon-512.png`,
    sameAs: ["https://github.com/NeonTechSpace", "https://www.npmjs.com/org/neontechspace"],
}

const website: Node = {
    "@type": "WebSite",
    "@id": `${siteUrl}/#website`,
    url: `${siteUrl}/`,
    name: siteName,
    alternateName: ["Fluxerly", "FluxerlyJS", "@neontechspace/fluxerly"],
    description: homeDescription,
    image: shareImage.url,
    inLanguage: "en",
    publisher: { "@id": org["@id"] },
}

const sdk: Node = {
    "@type": "SoftwareSourceCode",
    "@id": `${siteUrl}/#sdk`,
    name: siteName,
    alternateName: ["Fluxerly", "FluxerlyJS", "@neontechspace/fluxerly"],
    description: homeDescription,
    url: `${siteUrl}/`,
    image: shareImage.url,
    codeRepository: links.github,
    sameAs: [links.github, links.npm],
    softwareVersion: sdkVersion,
    programmingLanguage: ["JavaScript", "TypeScript"],
    runtimePlatform: "Node.js",
    keywords: ["Fluxer", "Fluxer bot", "Fluxer SDK", "Fluxerly", "Fluxerly.js", "FluxerlyJS", "JavaScript", "TypeScript", "Effect", "Node.js"],
    license: "https://www.apache.org/licenses/LICENSE-2.0",
    author: { "@id": org["@id"] },
    publisher: { "@id": org["@id"] },
}

// The homepage carries the whole picture: the site, the SDK and the org behind both
export const homeGraph: Node[] = [website, sdk, org]

// Markdown from the reference turned into the plain sentence a search result shows: code marks and link targets go,
// the words stay
export function plainText(markdown = ""): string {
    return markdown
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[`*_]/g, "")
        .replace(/\s+/g, " ")
        .trim()
}

// A trail of named steps for a docs page, ending at the page itself. Search engines show a trail of two steps or more, so a
// shorter one, such as the docs overview's own, is left out
export function breadcrumbs(steps: { name: string; path: string }[]): Node | undefined {
    if (steps.length < 2) return undefined
    return {
        "@type": "BreadcrumbList",
        itemListElement: steps.map((step, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: step.name,
            item: new URL(step.path, `${siteUrl}/`).href,
        })),
    }
}

export interface FaqItem {
    question: string
    answer: string
}

// Structured FAQPage node for pages that present direct question-and-answer lists
export function faqGraph(items: readonly FaqItem[]): Node | undefined {
    const clean = items.map((item) => ({ question: item.question.trim(), answer: item.answer.trim() })).filter((item) => item.question && item.answer)
    if (!clean.length) return undefined
    return {
        "@type": "FAQPage",
        mainEntity: clean.map((item) => ({
            "@type": "Question",
            name: item.question,
            acceptedAnswer: {
                "@type": "Answer",
                text: item.answer,
            },
        })),
    }
}

// Extracts plain-text question and answer pairs from a guide written as ## Question sections
export function faqFromMarkdown(source: string): FaqItem[] {
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    const parts = body.split(/^##\s+/m).slice(1)
    return parts
        .map((part) => {
            const newline = part.indexOf("\n")
            if (newline < 0) return { question: "", answer: "" }
            const question = plainText(part.slice(0, newline))
            const answer = plainText(part.slice(newline + 1))
            return { question, answer }
        })
        .filter((item) => item.question && item.answer)
}

// Structured TechArticle node for guide pages
export function techArticleGraph({ title, description, path }: { title: string; description: string; path: string }): Node {
    const url = new URL(path, `${siteUrl}/`).href
    return {
        "@type": "TechArticle",
        headline: title,
        description,
        url,
        mainEntityOfPage: url,
        image: shareImage.url,
        inLanguage: "en",
        isPartOf: { "@id": website["@id"] },
        about: { "@id": sdk["@id"] },
        author: { "@id": org["@id"] },
        publisher: { "@id": org["@id"] },
    }
}

// Structured CollectionPage node for the docs overview page (keeps breadcrumb trails to deeper docs pages)
export function docsIndexGraph({ title, description }: { title: string; description: string }): Node[] {
    return [
        {
            "@type": "CollectionPage",
            "@id": `${siteUrl}/docs/#collection`,
            name: title,
            description,
            url: `${siteUrl}/docs/`,
            inLanguage: "en",
            isPartOf: { "@id": website["@id"] },
            about: { "@id": sdk["@id"] },
        },
    ]
}

// Structured WebPage and BreadcrumbList nodes for a feature page
export function featurePageGraph({ title, description, path }: { title: string; description: string; path: string }): Node[] {
    const webPage: Node = {
        "@type": "WebPage",
        name: title,
        description,
        url: new URL(path, `${siteUrl}/`).href,
        inLanguage: "en",
        isPartOf: { "@id": website["@id"] },
        about: { "@id": sdk["@id"] },
    }
    const trail = breadcrumbs([
        { name: siteName, path: "/" },
        { name: title, path },
    ])
    return trail ? [webPage, trail] : [webPage]
}
