import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { isExcludedFromSearch } from "../src/lib/index-policy.mjs"

export { isExcludedFromSearch }

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const isoDate = /^\d{4}-\d{2}-\d{2}$/
const commitHash = /^[a-f0-9]{40}$/i
const sitePaths = ["projects/web/src"]
const docsPaths = ["projects/web/content", "projects/sdk/src", "projects/sdk/CHANGELOG.md", "projects/release/upstream/manifest.json"]

export function sitemapPaths(pathnames) {
    return pathnames
        .filter((path) => (path === "" || path.endsWith("/")) && !isExcludedFromSearch(path))
        .sort()
}

export function buildSitemap(site, pathnames, lastmod) {
    const resolveDate = typeof lastmod === "function" ? lastmod : () => lastmod
    const entries = sitemapPaths(pathnames).map((path) => {
        const date = resolveDate(path)
        const stamp = date && isoDate.test(date) ? `<lastmod>${date}</lastmod>` : ""
        return `    <url><loc>${new URL(path, site).href}</loc>${stamp}</url>`
    })
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`
}

// Collect the latest commit date (YYYY-MM-DD) for tracked files under the given paths at `ref`
// in one fast git pass. Logs a clear warning and returns null on shallow checkouts or missing commits
function readGitFileDates(ref, paths, warn = console.warn) {
    try {
        const isShallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim()
        if (isShallow === "true") {
            warn(`Sitemap lastmod: shallow git checkout at ${ref}, falling back to build date`)
            return null
        }
        const log = execFileSync("git", ["log", ref, "--format=DATE:%cs", "--name-only", "--", ...paths], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
        })
        const dates = new Map()
        let current = ""
        for (const raw of log.split("\n")) {
            const line = raw.trim()
            if (!line) continue
            if (line.startsWith("DATE:")) {
                current = line.slice(5)
            } else if (current && !dates.has(line)) {
                dates.set(line, current)
            }
        }
        if (!dates.size) {
            warn(`Sitemap lastmod: git log at ${ref} returned no matching file dates, falling back to build date`)
            return null
        }
        return dates
    } catch (error) {
        const reason = (error && typeof error === "object" && "stderr" in error && String(error.stderr).trim()) || (error instanceof Error ? error.message : String(error))
        warn(`Sitemap lastmod: unable to read git dates for ${ref} (${reason}), falling back to build date`)
        return null
    }
}

function newestDate(dates, prefixes) {
    if (!dates) return undefined
    let best = ""
    for (const [file, date] of dates) {
        if (prefixes.some((prefix) => file === prefix || file.startsWith(prefix))) {
            if (date > best) best = date
        }
    }
    return best || undefined
}

export function routeLastmodResolver(siteDates, fallback, docsDates = siteDates) {
    if (!siteDates && !docsDates) return () => fallback
    const apiDate = newestDate(docsDates, ["projects/sdk/src/"]) ?? fallback
    return (pathname) => {
        const clean = pathname.replace(/^\/|\/$/g, "")
        if (!clean)
            return newestDate(siteDates, ["projects/web/src/pages/index.astro", "projects/web/src/components/Hero.astro", "projects/web/src/components/sections/"]) ?? fallback
        if (clean === "playground") return newestDate(siteDates, ["projects/web/src/pages/playground.astro", "projects/web/src/islands/Playground.tsx"]) ?? fallback
        if (clean === "docs") return newestDate(docsDates, ["projects/web/content/guides/index.md"]) ?? fallback
        if (clean === "docs/changelog") return newestDate(docsDates, ["projects/sdk/CHANGELOG.md"]) ?? fallback
        if (clean === "docs/codes") return newestDate(docsDates, ["projects/sdk/src/"]) ?? fallback
        if (clean === "docs/api/endpoints") return newestDate(docsDates, ["projects/release/upstream/manifest.json", "projects/sdk/src/"]) ?? fallback
        if (clean.startsWith("docs/api")) return apiDate
        if (clean.startsWith("docs/")) {
            const slug = clean.slice("docs/".length)
            return newestDate(docsDates, [`projects/web/content/guides/${slug}.md`]) ?? fallback
        }
        return newestDate(siteDates, [`projects/web/src/pages/${clean}.astro`, "projects/web/src/lib/links.ts"]) ?? fallback
    }
}

// Writes sitemap.xml after every build from the pages that were actually built, so no page is ever listed by hand.
// Public snapshot builds anchor /docs/* dates to DOCS_SNAPSHOT_COMMIT so website-only deploys never bump published docs dates
export default function sitemap() {
    let site = ""
    const forcedDate = isoDate.test(process.env.DOCS_BUILD_DATE ?? "") ? process.env.DOCS_BUILD_DATE : undefined
    const fallback = forcedDate ?? new Date().toISOString().slice(0, 10)
    const snapshotRef = commitHash.test(process.env.DOCS_SNAPSHOT_COMMIT ?? "") ? process.env.DOCS_SNAPSHOT_COMMIT : undefined
    const siteDates = forcedDate ? null : readGitFileDates("HEAD", sitePaths)
    const docsDates = forcedDate ? null : readGitFileDates(snapshotRef ?? "HEAD", docsPaths)
    const resolveLastmod = routeLastmodResolver(siteDates, fallback, docsDates)
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
                    resolveLastmod,
                )
                await writeFile(new URL("sitemap.xml", dir), xml)
            },
        },
    }
}
