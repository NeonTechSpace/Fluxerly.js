// Builds the public site from the published versions' snapshots in released/, which scripts/fetch-releases.js imports. The newest version
// (Stable, otherwise Nightly) is the site: its docs live at /docs/ and only they are indexed. Every other version gets its own
// docs, reference and search under its own address: /docs/nightly/ and /docs/<exact Stable version>/. They are told to stay out of
// search results, so one page never competes with itself. /docs/latest/ and the newest version's own address redirect to /docs/.
// The version menu marks the versions npm marks as deprecated, read fresh from npm's registry on every build, so a later deprecation
// shows with the next build. A build that can't read it stops, rather than leave a deprecation out. --registry FILE reads that
// document from a file instead, which the version check uses for its made-up versions
// Usage: node scripts/docs/build-public.mjs [--released FOLDER] [--out FOLDER] [--registry FILE]
import { execFileSync } from "node:child_process"
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { channelTargets, compareVersions, npmDeprecations, parseVersion, validateSnapshot } from "../versions.js"
import { snapshotContent } from "./snapshot-content.mjs"
import { writeSearchWords } from "./search-words.mjs"

const site = fileURLToPath(new URL("../../", import.meta.url))
const option = (name, fallback) => {
    const at = process.argv.indexOf(name)
    return resolve(at < 0 ? fallback : process.argv[at + 1])
}
const released = option("--released", join(site, "released"))
const out = option("--out", join(site, "dist"))
const packageName = "@neontechspace/fluxerly"
const registryAt = process.argv.indexOf("--registry")
const bin = (name) => join(site, "node_modules/.bin", name)

const snapshots = new Map()
for (const name of (await readdir(released).catch(() => [])).filter((file) => file.endsWith(".json"))) {
    const snapshot = validateSnapshot(JSON.parse(await readFile(join(released, name), "utf8")))
    snapshots.set(snapshot.version, snapshot)
}
if (snapshots.size === 0) throw new Error("A public build needs at least one published version with a current docs snapshot in released/")

const channels = channelTargets([...snapshots.keys()])
const newest = channels[0]
// Older Stable versions keep their own addresses, listed after the channels
const others = [...snapshots.keys()]
    .filter((version) => parseVersion(version).channel === "stable" && !channels.some((target) => target.version === version))
    .sort(compareVersions)
    .reverse()
    .map((version) => ({ version, label: version, path: version }))
const baseOf = (target) => (target.version === newest.version ? "/docs/" : `/docs/${target.path}/`)

/** The package's registry document, which says which versions are deprecated. Read on every build, since a deprecation can come at any time.
 * npm's short form for installs carries each version's deprecation too, and stays small while the full document grows with every nightly */
async function readRegistry() {
    if (registryAt >= 0) return JSON.parse(await readFile(resolve(process.argv[registryAt + 1]), "utf8"))
    const url = `https://registry.npmjs.org/${packageName.replace("/", "%2F")}`
    const response = await fetch(url, { headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return response.json()
}
let deprecated
try {
    deprecated = npmDeprecations(await readRegistry(), [...snapshots.keys()])
} catch (error) {
    throw new Error(`The public build reads npm's registry to mark deprecated versions in the version menu, and couldn't: ${error.message}. It stops rather than leave a deprecation out`, { cause: error })
}
const versionEntry = (target) => ({ label: target.label, version: target.version, base: baseOf(target), ...(deprecated[target.version] ? { deprecated: deprecated[target.version] } : {}) })
const shown = channels.map(versionEntry)
const builds = [...channels.slice(1), ...others]

// Astro moves files into its output, so the builds stay on the project's own disk
await mkdir(join(site, ".astro"), { recursive: true })
const temporary = await mkdtemp(join(site, ".astro/public-"))

async function materialize(snapshot) {
    const root = join(temporary, "content", snapshot.version)
    for (const file of snapshot.files) {
        const path = join(root, file.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, snapshotContent(snapshot, file))
    }
    return root
}

async function build(target, outDir) {
    const isNewest = target.version === newest.version
    const content = await materialize(snapshots.get(target.version))
    await rm(join(site, ".astro/data-store.json"), { force: true })
    await rm(join(site, "node_modules/.astro/data-store.json"), { force: true })
    execFileSync(bin("astro"), ["build", "--outDir", outDir], {
        cwd: site,
        stdio: "inherit",
        env: {
            ...process.env,
            DOCS_CONTENT: content,
            DOCS_VERSION: target.version,
            DOCS_VERSIONS: JSON.stringify(shown),
            DOCS_OLDER_VERSIONS: JSON.stringify(others.map(versionEntry)),
            ...(isNewest ? {} : { PUBLIC_DOCS_BASE: `/docs/${target.path}/` }),
            // npm's plain install follows `latest`, so only the newest Stable's pages can rely on it. Every other page names its exact version
            ...(isNewest && target.label === "Stable" ? {} : { DOCS_PACKAGE_SPEC: `${packageName}@${target.version}` }),
            // The homepage's short command, for a site with no Stable yet
            ...(isNewest && target.label !== "Stable" ? { PUBLIC_PACKAGE_SPEC: `${packageName}@nightly` } : {}),
        },
    })
}

async function filesUnder(directory) {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

const anchor = /<a\b[^>]*>/g
// A version's pages keep the reader in that version. The links in the version switch name their own version and stay as they are
function moveLinks(html, base) {
    return html
        .replace(anchor, (tag) => (tag.includes("data-docs-version") ? tag : tag.replace(/href="\/docs\//, `href="${base}`)))
        .replace(/<link rel="canonical"[^>]*>/, '<meta name="robots" content="noindex" />')
        // The share address and the structured data name this version too
        .replaceAll(`"https://fluxerly.neontechspace.com/docs/`, `"https://fluxerly.neontechspace.com${base}`)
}

await rm(out, { recursive: true, force: true })
await build(newest, out)
execFileSync(bin("pagefind"), ["--site", out], { cwd: site, stdio: "inherit" })
await writeSearchWords(out)

for (const target of builds) {
    const base = `/docs/${target.path}/`
    const outDir = join(temporary, "built", target.path)
    await build(target, outDir)
    const docs = join(outDir, "docs")
    for (const path of await filesUnder(docs)) {
        if (path.endsWith(".html")) await writeFile(path, moveLinks(await readFile(path, "utf8"), base))
        else if (path.endsWith("peek.json")) await writeFile(path, (await readFile(path, "utf8")).replaceAll('"/docs/', `"${base}`))
    }
    execFileSync(bin("pagefind"), ["--site", docs], { cwd: site, stdio: "inherit" })
    await writeSearchWords(docs)
    await cp(docs, join(out, "docs", target.path), { recursive: true })
    await cp(join(outDir, "_astro"), join(out, "_astro"), { recursive: true })
}

// Addresses that lead to the newest version, and those that must stay out of search results
const redirects = ["/docs/latest /docs/ 302", "/docs/latest/* /docs/:splat 302"]
const newestAddress = `/docs/${newest.path}`
redirects.push(`${newestAddress} /docs/ 302`, `${newestAddress}/* /docs/:splat 302`)
await writeFile(join(out, "_redirects"), `${redirects.join("\n")}\n`)
const hidden = builds.map((target) => `/docs/${target.path}/*\n  X-Robots-Tag: noindex\n`).join("\n")
if (hidden) await appendFile(join(out, "_headers"), `\n${hidden}`)
await rm(temporary, { recursive: true, force: true })
console.log(JSON.stringify({ newest: newest.version, others: builds.map((target) => target.version), deprecated: Object.keys(deprecated) }))
