// Measures docs search against the built index: every query in tests/search-queries.json runs through the same code as the
// search dialog, src/lib/docs-search.ts, including the empty-answer check, and the report shows how often an expected page
// comes first (hit@1), within the first three (hit@3), the mean reciprocal rank (MRR) and how many queries find no
// expected page among all their results (missed), per set and per kind of query. It fails when a set falls below the
// file's floors, misses more queries than its ceilings allow, or an essential query does not find its page first, so a
// good average cannot hide a query that finds nothing. A query may also list pages in shows, one of which must be among
// its results. Pagefind runs on the main thread here, so no result depends on timing
// Usage: node scripts/checks/search.mjs [--site dist] [--queries FILE] [--failures] [--ranking termSimilarity=1,...] [--json FILE]
// [--lib FILE], which measures another copy of the search code
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const web = fileURLToPath(new URL("../../", import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => {
    const at = args.indexOf(name)
    return at < 0 ? fallback : args[at + 1]
}
const site = resolve(web, option("--site", "dist"))
const queriesFile = resolve(web, option("--queries", "tests/search-queries.json"))
const index = join(site, "pagefind")
const { answer, pagefindOptions } = await import(pathToFileURL(resolve(web, option("--lib", "src/lib/docs-search.ts"))).href)

// Pagefind reads its files with fetch. Here they come from the built site on disk, and nothing else may be fetched
let failedChunks = 0
globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith("file:")) throw new Error(`The search check fetches only the built index, not ${url}`)
    try {
        return new Response(await readFile(fileURLToPath(url)))
    } catch {
        if (url.includes("/pagefind/index/")) failedChunks += 1
        return new Response("", { status: 404 })
    }
}

// Ranking weights to try instead of the dialog's, such as termSimilarity=2,pageLength=0.5
const ranking = option("--ranking")
const options = ranking
    ? { ...pagefindOptions, ranking: { ...pagefindOptions.ranking, ...Object.fromEntries(ranking.split(",").map((pair) => [pair.split("=")[0], Number(pair.split("=")[1])])) } }
    : pagefindOptions

const entry = join(index, "pagefind.js")
await stat(entry).catch(() => {
    throw new Error(`No search index at ${index}. Build the site first with pnpm run build`)
})
const pagefind = await import(pathToFileURL(entry).href)
const open = async () => {
    const api = pagefind.createInstance({ ...options, baseUrl: "/" })
    await api.init()
    // The dialog's debounce only skips queries a newer one replaced. Each query here runs alone
    return { ...api, search: api.search.bind(api), debouncedSearch: (text, searchOptions) => api.search(text, searchOptions) }
}
const searcher = await open()
let checker
let checks = 0
const copies = {
    searcher: async () => searcher,
    checker: async () => {
        checks += 1
        return (checker ??= await open())
    },
    reachIndex: async () => {
        await stat(join(index, "pagefind-entry.json"))
    },
    failedChunks: () => failedChunks,
    forgetSearcher() {},
    forgetChecker() {
        checker = undefined
    },
}

const { floors, ceilings, queries } = JSON.parse(await readFile(queriesFile, "utf8"))

// An address as the dialog links it, without index.html and with a slash before the anchor
const place = (url) => url.replace(/index\.html/, "").replace(/\/?(#|$)/, "/$1")
const matches = (url, expected) => {
    const [page, anchor] = place(url).split("#")
    const [wantPage, wantAnchor] = place(expected).split("#")
    return page === wantPage && (!wantAnchor || anchor === wantAnchor)
}

const results = []
const times = []
for (const query of queries) {
    const started = performance.now()
    const hits = (await answer(query.q, () => false, copies)) ?? []
    const ms = performance.now() - started
    times.push(ms)
    const rank = hits.findIndex((hit) => query.expect.some((expected) => matches(hit.url, expected))) + 1
    // Whether one of the pages the query must show is among its results, whichever page comes first
    const shown = !query.shows || hits.some((hit) => query.shows.some((expected) => matches(hit.url, expected)))
    results.push({ ...query, rank, shown, got: hits.slice(0, 3).map((hit) => hit.url), ms })
}

function score(list) {
    const count = list.length
    return {
        count,
        hit1: list.filter((result) => result.rank === 1).length / count,
        hit3: list.filter((result) => result.rank >= 1 && result.rank <= 3).length / count,
        mrr: list.reduce((sum, result) => sum + (result.rank ? 1 / result.rank : 0), 0) / count,
        missed: list.filter((result) => !result.rank).length,
    }
}

const sets = ["tune", "holdout"]
const kinds = [...new Set(queries.map((query) => query.kind))].sort()
const summary = {
    all: score(results),
    sets: Object.fromEntries(sets.map((set) => [set, score(results.filter((result) => result.set === set))])),
    kinds: Object.fromEntries(kinds.map((kind) => [kind, score(results.filter((result) => result.kind === kind))])),
}

async function sizeOf(path) {
    const info = await stat(path)
    if (!info.isDirectory()) return info.size
    let total = 0
    for (const name of await readdir(path)) total += await sizeOf(join(path, name))
    return total
}
const sorted = [...times].sort((a, b) => a - b)
const speed = {
    indexBytes: await sizeOf(join(index, "index")),
    fragmentBytes: await sizeOf(join(index, "fragment")),
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    checks,
}

const percent = (value) => `${(value * 100).toFixed(1)}%`.padStart(6)
const row = (name, value) =>
    `${name.padEnd(16)} ${String(value.count).padStart(4)}  ${percent(value.hit1)}  ${percent(value.hit3)}  ${value.mrr.toFixed(3)}  ${String(value.missed).padStart(6)}`
console.log(`${"".padEnd(16)} ${"n".padStart(4)}  ${"hit@1".padStart(6)}  ${"hit@3".padStart(6)}  MRR    missed`)
console.log(row("all", summary.all))
for (const set of sets) console.log(row(set, summary.sets[set]))
console.log("")
for (const kind of kinds) console.log(row(kind, summary.kinds[kind]))
console.log("")
console.log(
    `Index ${(speed.indexBytes / 1024).toFixed(0)} KiB of word chunks and ${(speed.fragmentBytes / 1024).toFixed(0)} KiB of page fragments. ` +
        `A query took ${speed.medianMs.toFixed(1)} ms at the median and ${speed.p95Ms.toFixed(1)} ms at p95 on the main thread here, and ${checks} empty answers were checked again`,
)

if (args.includes("--failures")) {
    console.log("")
    for (const result of results.filter((entry) => entry.rank !== 1)) {
        console.log(`${result.set.padEnd(7)} ${result.kind.padEnd(12)} rank ${result.rank || "-"}  ${JSON.stringify(result.q)}  want ${result.expect[0]}  got ${result.got.join("  ") || "nothing"}`)
    }
}
const json = option("--json")
if (json) await writeFile(json, JSON.stringify({ summary, speed, results }, null, 1))

// Floors hold the measured numbers, so a later change can't make search worse without failing here
const below = []
for (const set of sets) {
    for (const metric of ["hit1", "hit3", "mrr"]) {
        const floor = floors?.[set]?.[metric]
        if (floor !== undefined && summary.sets[set][metric] < floor - 1e-9) below.push(`${set} ${metric} is ${summary.sets[set][metric].toFixed(3)}, below its floor of ${floor}`)
    }
}
// Ceilings hold the measured number of queries that find nothing expected, so one more such query fails however well the
// others do
for (const set of sets) {
    const ceiling = ceilings?.[set]?.missed
    if (ceiling !== undefined && summary.sets[set].missed > ceiling) below.push(`${set} missed ${summary.sets[set].missed} queries, above its ceiling of ${ceiling}`)
}
// An essential query names a task every reader needs, such as a first bot or a pasted error code, and must find its page first
for (const result of results.filter((entry) => entry.essential && entry.rank !== 1)) {
    below.push(`Essential query ${JSON.stringify(result.q)} found ${result.rank ? `its page at place ${result.rank}` : "no expected page"}, not first`)
}
// A query with more than one meaning, such as mute a member for a voice mute or a timeout, lists in shows a page that must be
// among its results, so finding one meaning first cannot hide that the other is missing
for (const result of results.filter((entry) => !entry.shown)) {
    below.push(`Query ${JSON.stringify(result.q)} shows none of the pages it must show, such as ${result.shows[0]}`)
}
if (below.length) {
    console.error(`\nSearch got worse:\n${below.join("\n")}\nRun with --failures to see which queries no longer find their page first`)
    process.exitCode = 1
}
