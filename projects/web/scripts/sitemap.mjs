import { writeFile } from "node:fs/promises"

// Thin single-error-class reference pages and near-duplicate Effect reference detail pages are excluded from sitemap.xml
// so search engines focus crawl budget on unique guides, feature pages, module overviews and Effect index pages
const excluded = [
    /^\/?404\/?$/,
    /^\/?docs\/api\/(?:js-ts|testing)\/[^/]*error\/$/i,
    /^\/?docs\/api\/effect(?:-testing)?\/.+/,
]

export function sitemapPaths(pathnames) {
    return pathnames
        .filter((path) => (path === "" || path.endsWith("/")) && !excluded.some((pattern) => pattern.test(path)))
        .sort()
}

export function buildSitemap(site, pathnames, lastmod) {
    const entries = sitemapPaths(pathnames).map((path) => `    <url><loc>${new URL(path, site).href}</loc><lastmod>${lastmod}</lastmod></url>`)
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`
}

// Writes sitemap.xml after every build from the pages that were actually built, so no page is ever listed by hand.
// Endpoints (their paths do not end in a slash), 404, single error classes and Effect detail twins are left out
export default function sitemap() {
    let site = ""
    const lastmod = /^\d{4}-\d{2}-\d{2}$/.test(process.env.DOCS_BUILD_DATE ?? "") ? process.env.DOCS_BUILD_DATE : new Date().toISOString().slice(0, 10)
    return {
        name: "fluxerly-sitemap",
        hooks: {
            "astro:config:done": ({ config }) => {
                site = config.site ?? ""
            },
            "astro:build:done": async ({ dir, pages }) => {
                if (!site) throw new Error("The sitemap needs `site` in astro.config.mjs")
                const xml = buildSitemap(
                    site,
                    pages.map((page) => page.pathname),
                    lastmod,
                )
                await writeFile(new URL("sitemap.xml", dir), xml)
            },
        },
    }
}
