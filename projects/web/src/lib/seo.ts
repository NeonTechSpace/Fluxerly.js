import { links } from "./links"

// What search engines and link previews read about the site. Every page's head goes through
// src/components/Seo.astro, and these are the shared facts it describes

export const siteUrl = import.meta.env.SITE.replace(/\/$/, "")
export const siteName = "Fluxerly.js"

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

const org: Node = {
    "@type": "Organization",
    "@id": `${siteUrl}/#org`,
    name: "NeonTechSpace",
    url: "https://github.com/NeonTechSpace",
    logo: `${siteUrl}/icon-512.png`,
}

const website: Node = {
    "@type": "WebSite",
    "@id": `${siteUrl}/#website`,
    url: `${siteUrl}/`,
    name: siteName,
    alternateName: "Fluxerly",
    description: homeDescription,
    image: shareImage.url,
    inLanguage: "en",
    publisher: { "@id": org["@id"] },
}

const sdk: Node = {
    "@type": "SoftwareSourceCode",
    "@id": `${siteUrl}/#sdk`,
    name: siteName,
    description: homeDescription,
    url: `${siteUrl}/`,
    image: shareImage.url,
    codeRepository: links.github,
    programmingLanguage: ["JavaScript", "TypeScript"],
    runtimePlatform: "Node.js",
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
