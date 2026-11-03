// @ts-check
import { execFileSync } from "node:child_process"
import { existsSync, globSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Which parts of the website the changed files can reach, for `pnpm check:ui --changed` and the screen check's --changed.
// The answer is a set of areas, the ones the screen check's pages fall in: home is /, docs is everything under /docs/,
// missing is any page the site doesn't have, and each other page, such as commands for /commands/, is an area of its
// own. Paths are from the repository root. How a changed file is placed, first match first:
//
// 1. Outside the website nothing is reached, except the SDK files the build turns into the reference, the guides' code
//    and the changelog: projects/sdk/src, projects/sdk/examples, projects/sdk/package.json and projects/sdk/CHANGELOG.md,
//    and the Fluxer pin in projects/release/upstream, which feeds the endpoint map and the docs pages' commit line.
//    They count as a change to the generated content. The workspace's package files reach everything, since they pick
//    the versions the site is built with
// 2. Website files no screen shows reach nothing: its tests, its Cloudflare functions, its Markdown notes such as
//    AGENTS.md, and the checks the screen check doesn't run
// 3. Content in projects/web/content, generated or written, reaches the pages that read the content collection or
//    import from @content
// 4. A file under projects/web/src reaches the pages that import it, directly or through other files, read from the
//    source's import statements, CSS imports and import.meta.glob. A page in src/pages gives its area, and a page no
//    screen opens, such as llms.txt.ts, gives none
// 5. Any other website file, such as astro.config.mjs, the public folder, the art scripts, the screen check itself, or a
//    file in src that no page imports yet, reaches everything
//
// The changed files are those that differ from where HEAD left the pushed main, committed or not, plus untracked ones, as the live
// runner counts them

const all = "all"

/** @param {string} path */
const outsideWebsite = (path) => {
    if (/^projects\/sdk\/(src|examples)\//.test(path) || /^projects\/sdk\/(package\.json|CHANGELOG\.md)$/.test(path)) return "content"
    if (/^projects\/(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path)) return all
    // The Fluxer pin feeds the endpoint map and the commit line on every docs page
    if (/^projects\/release\/upstream\//.test(path)) return "content"
    return "nothing"
}

const unseen = [
    /^projects\/web\/tests\//,
    /^projects\/web\/functions\//,
    /^projects\/web\/(?!content\/)(.*\/)?[^/]+\.md$/,
    /^projects\/web\/scripts\/checks\/(design-scores\.json|look\.mjs|search\.mjs|versions\.mjs)$/,
]

const extensions = ["", ".ts", ".tsx", ".astro", ".mjs", ".js", ".json", ".css", "/index.ts", "/index.astro"]

/**
 * The files each file under src imports, as paths from the website's folder. Content stands for every file in
 * content/, and the content collection's configuration reads it
 * @param {string} site
 */
function importGraph(site) {
    /** @type {Map<string, Set<string>>} */
    const graph = new Map()
    for (const file of globSync("src/**/*", { cwd: site })) {
        const path = file.replaceAll("\\", "/")
        if (!statSync(join(site, path)).isFile()) continue
        /** @type {Set<string>} */
        const imports = new Set()
        graph.set(path, imports)
        if (!/\.(astro|ts|tsx|mjs|js|css)$/.test(path)) continue
        const source = readFileSync(join(site, path), "utf8")
        const specifiers = [
            ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'\n]+)["']/g),
            ...source.matchAll(/@import\s+(?:url\(\s*)?["']([^"'\n]+)["']/g),
            ...source.matchAll(/\burl\(\s*["']?(\.\.?\/[^"')\n]+)["']?\s*\)/g),
        ].map((match) => match[1])
        for (const match of source.matchAll(/import\.meta\.glob(?:<[^>]*>)?\(\s*["']([^"'\n]+)["']/g)) {
            if (match[1].startsWith("@content/")) imports.add("content")
            else if (match[1].startsWith(".")) for (const hit of globSync(resolve(dirname(join(site, path)), match[1]))) imports.add(relative(site, hit).replaceAll("\\", "/"))
        }
        for (const specifier of specifiers) {
            const bare = specifier.split("?")[0]
            if (bare === "astro:content") imports.add("src/content.config.ts")
            else if (bare.startsWith("@content/")) imports.add("content")
            else if (bare.startsWith("./") || bare.startsWith("../")) {
                const base = resolve(dirname(join(site, path)), bare)
                const found = extensions.map((extension) => base + extension).find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
                if (found) imports.add(relative(site, found).replaceAll("\\", "/"))
            }
        }
    }
    graph.get("src/content.config.ts")?.add("content")
    return graph
}

/** @param {string} page A file in src/pages, from the website's folder @returns {string | undefined} */
function areaOfPage(page) {
    const name = page.slice("src/pages/".length)
    if (name.startsWith("docs/")) return "docs"
    if (name === "index.astro") return "home"
    if (name === "404.astro") return "missing"
    if (/^[^/]+\.astro$/.test(name)) return name.slice(0, -".astro".length)
    return undefined
}

/**
 * The areas the changed files reach, all for everything, and why each file counts
 * @param {string[]} paths Paths from the repository root
 * @param {string} repository The repository's root folder
 * @returns {{ areas: Set<string> | "all", reasons: string[] }}
 */
export function areasForChanges(paths, repository) {
    const site = join(repository, "projects/web")
    /** @type {Map<string, Set<string>> | undefined} */
    let graph
    /** @type {Map<string, Set<string>>} */
    const reached = new Map()
    // Every file a page reaches, and through that the pages each file reaches
    const pagesReaching = (/** @type {string} */ node) => {
        if (!graph) {
            graph = importGraph(site)
            for (const page of [...graph.keys()].filter((file) => file.startsWith("src/pages/"))) {
                const seen = new Set([page])
                const stack = [page]
                while (stack.length) for (const next of graph.get(/** @type {string} */ (stack.pop())) ?? []) if (!seen.has(next)) seen.add(next), stack.push(next)
                for (const file of seen) reached.set(file, (reached.get(file) ?? new Set()).add(page))
            }
        }
        return [...(reached.get(node) ?? [])]
    }

    /** @type {Set<string>} */
    const areas = new Set()
    /** @type {string[]} */
    const reasons = []
    let everything = false
    for (const path of [...new Set(paths)].sort()) {
        /** @type {string} */
        let node
        if (!path.startsWith("projects/web/")) {
            const kind = outsideWebsite(path)
            if (kind === "nothing") continue
            if (kind === all) {
                everything = true
                reasons.push(`${path}: Everything, it sets the site's dependencies`)
                continue
            }
            node = "content"
        } else {
            const inside = path.slice("projects/web/".length)
            if (unseen.some((pattern) => pattern.test(path))) continue
            node = inside.startsWith("content/") ? "content" : inside
        }
        const pages = node === "content" || node.startsWith("src/") ? pagesReaching(node) : []
        if (pages.length === 0) {
            everything = true
            reasons.push(`${path}: Everything, no page imports it`)
            continue
        }
        const reach = [...new Set(pages.map(areaOfPage).filter((area) => area !== undefined))].sort()
        for (const area of reach) areas.add(area)
        reasons.push(`${path}: ${reach.length ? reach.join(", ") : "No screen, only pages the screen check doesn't open"}`)
    }
    return { areas: everything ? all : areas, reasons }
}

/**
 * The repository's changed paths: Those that differ from where HEAD left the pushed main, so commits not yet pushed to
 * main still count, committed or not, and untracked ones. Then the local main is tried, and finally HEAD
 * @param {string} repository
 */
export function changedPaths(repository) {
    const git = (/** @type {string[]} */ ...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" })
    let from = "HEAD"
    for (const main of ["origin/main", "main"])
        try {
            from = git("merge-base", "HEAD", main).trim()
            break
        } catch {
            // allow-silent: The next candidate, and finally HEAD, still covers uncommitted changes
        }
    const lines = (/** @type {string} */ text) => text.split("\n").filter(Boolean)
    return [...new Set([...lines(git("diff", "--name-only", from)), ...lines(git("ls-files", "--others", "--exclude-standard"))])]
}

export const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url))

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { areas, reasons } = areasForChanges(changedPaths(repositoryRoot), repositoryRoot)
    for (const reason of reasons) console.log(reason)
    console.log(areas === all ? "Reaches every screen" : areas.size ? `Reaches ${[...areas].sort().join(", ")}` : "Reaches no screen")
}
