import { writeFile } from "node:fs/promises"

// Writes sitemap.xml after every build from the pages that were actually built, so no page is ever listed by hand.
// Endpoints (their paths do not end in a slash) and the 404 page are left out. The docs change with each release, so they
// ask to be crawled more often than the homepage and feature pages
export default function sitemap() {
    let site = ""
    return {
        name: "fluxerly-sitemap",
        hooks: {
            "astro:config:done": ({ config }) => {
                site = config.site ?? ""
            },
            "astro:build:done": async ({ dir, pages }) => {
                if (!site) throw new Error("The sitemap needs `site` in astro.config.mjs")
                const paths = pages
                    .map((page) => page.pathname)
                    .filter((path) => (path === "" || path.endsWith("/")) && !/^404\/?$/.test(path))
                    .sort()
                const entries = paths.map((path) => `    <url><loc>${new URL(path, site).href}</loc><changefreq>${/^\/?docs\//.test(path) ? "weekly" : "monthly"}</changefreq></url>`)
                const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`
                await writeFile(new URL("sitemap.xml", dir), xml)
            },
        },
    }
}
