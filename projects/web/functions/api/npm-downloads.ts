// GET /api/npm-downloads: the npm download history of the SDK package, as the homepage chart reads it. It has
// the same shape as src/data/npm-downloads.json, which is only the build's first paint and fallback
//
// The counts update when a new version of the site is deployed, and from then on once a day after 04:00 UTC. npm
// counts whole UTC days and publishes the previous one around 01:00 UTC, so 04:00 leaves it three hours. The deploy
// fetches the counts into the snapshot this file is built with. After that npm is asked about once a day for everyone.
// The global copy lives in Workers KV under one key, with the time it was fetched, and the newer of that copy and the
// snapshot is the one served. A copy is fresh until the first 04:00 UTC after it was fetched, so every location counts
// to the same moment. In front of KV, each Cloudflare location keeps the answer in its edge cache until that moment,
// under a key tied to this deployment, so most requests touch neither KV nor npm, and a deploy replaces every
// location's answer at once. Browsers keep it until that moment too. A copy past that time is still served at once and
// refreshed in the background, so nobody waits for npm, and browsers keep that one for a minute only
//
// One-time setup, before the first deploy that carries this file:
//   1. Create the KV namespace: wrangler kv namespace create NPM_DOWNLOADS
//   2. Bind it to the Pages project with the variable name NPM_DOWNLOADS: Cloudflare dashboard, Workers & Pages,
//      the project, Settings, Bindings, Add, KV namespace. Set it for Production, and for Preview if wanted
//   3. Deploy with wrangler pages deploy run from the app folder (projects/web), because wrangler takes functions/
//      from the folder it runs in. A binding applies from the next deployment on
// Without the binding the function still works from the snapshot and the edge cache: Each location asks npm once a
// day on its own

import snapshot from "../../src/data/npm-downloads.json" with { type: "json" }
import { fetchNpmHistory, isNpmHistory, type NpmHistory } from "../../src/lib/npm-history.ts"

// The few parts of the Workers runtime that this file touches, so it type-checks without the Workers types
interface Kv {
    get(key: string, type: "json"): Promise<unknown>
    put(key: string, value: string): Promise<void>
}
interface EdgeCache {
    match(request: Request): Promise<Response | undefined>
    put(request: Request, response: Response): Promise<void>
}
interface Context {
    request: Request
    env: { NPM_DOWNLOADS?: Kv }
    waitUntil(promise: Promise<unknown>): void
}
interface Copy {
    // Milliseconds since the epoch at which npm was asked
    fetchedAt: number
    history: NpmHistory
}

const kvKey = "history"
const hourMs = 60 * 60 * 1000
const dayMs = 24 * hourMs
// A cache entry, at the edge or in a browser, never lives for less than this, so a stale copy is not looked up again on
// every request
const shortestCacheMs = 60 * 1000
// When npm cannot be reached, the stale copy is cached for this long before the next try
const retryMs = 15 * 60 * 1000
// The edge cache entry's header with the moment its copy goes stale, so an answer from the edge tells browsers the same
const staleAtHeader = "x-stale-at"

const json = { "content-type": "application/json" }

// Seconds a cache keeps an answer, until the given moment and for a minute at least
const cacheSeconds = (lifetimeMs: number) => Math.floor(Math.max(shortestCacheMs, lifetimeMs) / 1000)

// Browsers keep the answer until its copy goes stale, the moment this function asks npm again. An edge entry without the
// moment counts as stale
const answer = (request: Request, body: string, staleAt: number) =>
    new Response(request.method === "HEAD" ? null : body, {
        headers: { ...json, "cache-control": `public, max-age=${cacheSeconds((Number.isFinite(staleAt) ? staleAt : 0) - Date.now())}` },
    })

function readCopy(value: unknown): Copy | undefined {
    const { fetchedAt, history } = (value ?? {}) as Partial<Copy>
    return Number.isFinite(fetchedAt) && isNpmHistory(history) ? { fetchedAt: fetchedAt!, history } : undefined
}

// KV and the edge cache are helpers to this answer. When either one fails, the request goes on without it
async function readKv(kv: Kv | undefined) {
    try {
        return kv ? readCopy(await kv.get(kvKey, "json")) : undefined
    } catch (error) {
        console.error("The npm downloads copy could not be read from KV", error)
    }
}

async function writeKv(kv: Kv | undefined, copy: Copy) {
    try {
        await kv?.put(kvKey, JSON.stringify(copy))
    } catch (error) {
        console.error("The npm downloads copy could not be stored in KV", error)
    }
}

// The entry lives for the given time, which the edge cache takes from the entry's own Cache-Control
async function cachePut(edge: EdgeCache, key: Request, copy: Copy, lifetimeMs: number) {
    const headers = { ...json, "cache-control": `public, max-age=${cacheSeconds(lifetimeMs)}`, [staleAtHeader]: String(nextRefresh(copy.fetchedAt)) }
    try {
        await edge.put(key, new Response(JSON.stringify(copy.history), { headers }))
    } catch (error) {
        console.error("The npm downloads answer could not be cached", error)
    }
}

// The first 04:00 UTC after the given moment
const nextRefresh = (time: number) => Math.floor((time - 4 * hourMs) / dayMs) * dayMs + 4 * hourMs + dayMs

// How long a copy has left before the first 04:00 UTC after it was fetched. Every location counts to the same moment
const timeLeft = (copy: Copy) => nextRefresh(copy.fetchedAt) - Date.now()

// Asks npm, and keeps the answer only once it has passed the same check the chart applies
async function fetchCopy(kv: Kv | undefined): Promise<Copy> {
    const history = await fetchNpmHistory((url, init) => fetch(url, init), Date.now())
    const copy = { fetchedAt: Date.now(), history }
    await writeKv(kv, copy)
    return copy
}

// The snapshot's history and the time this deployment's build fetched it
function builtCopy(): Copy | undefined {
    const { fetchedAt, ...history } = snapshot as NpmHistory & { fetchedAt?: number }
    return readCopy({ fetchedAt, history })
}

const newerCopy = (first: Copy | undefined, second: Copy | undefined) => (first && second ? (first.fetchedAt >= second.fetchedAt ? first : second) : (first ?? second))

export const onRequest = (context: Context) => answerDownloads(context, builtCopy())

export async function answerDownloads(context: Context, built: Copy | undefined): Promise<Response> {
    const { request, env } = context
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } })
    }

    const edge = (caches as unknown as { default: EdgeCache }).default
    // Every request for this path shares one entry, whatever its method or query string, and a new deployment starts a new one
    const url = new URL(request.url)
    url.search = built ? `?built=${built.fetchedAt}` : ""
    const key = new Request(url)

    const hit = await edge.match(key)
    if (hit) return answer(request, await hit.text(), Number(hit.headers.get(staleAtHeader)))

    const kv = env.NPM_DOWNLOADS
    const stored = newerCopy(await readKv(kv), built)

    if (stored) {
        const left = timeLeft(stored)
        if (left > 0) {
            context.waitUntil(cachePut(edge, key, stored, left))
        } else {
            // Past its 04:00 UTC: served as it is, while this location asks npm for the next copy
            context.waitUntil(
                (async () => {
                    await cachePut(edge, key, stored, shortestCacheMs)
                    try {
                        const next = await fetchCopy(kv)
                        await cachePut(edge, key, next, timeLeft(next))
                    } catch (error) {
                        console.error("npm could not be asked for the download counts, the older copy stays for now", error)
                        await cachePut(edge, key, stored, retryMs)
                    }
                })(),
            )
        }
        return answer(request, JSON.stringify(stored.history), nextRefresh(stored.fetchedAt))
    }

    // No copy anywhere: this request waits for npm, and has nothing older to fall back on if npm fails
    try {
        const copy = await fetchCopy(kv)
        context.waitUntil(cachePut(edge, key, copy, timeLeft(copy)))
        return answer(request, JSON.stringify(copy.history), nextRefresh(copy.fetchedAt))
    } catch (error) {
        console.error("npm could not be asked for the download counts", error)
        return new Response("The download counts are not available right now", { status: 503, headers: { "content-type": "text/plain", "cache-control": "no-store" } })
    }
}
