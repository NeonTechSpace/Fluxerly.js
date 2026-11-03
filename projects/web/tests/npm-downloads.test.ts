// Tests the npm downloads endpoint through its public entry point, onRequest. Only the outside world is
// faked: Workers KV, the edge cache, npm's two APIs, waitUntil and the clock. Nothing here reads real time or
// reaches the network
import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, mock, test } from "node:test"
import { answerDownloads } from "../functions/api/npm-downloads.ts"
import { packageName, type NpmHistory } from "../src/lib/npm-history.ts"

const hourMs = 3_600_000
const dayMs = 24 * hourMs
// Noon UTC on 9 October 2026, so the history ends with 8 October
const start = Date.parse("2026-10-09T12:00:00Z")
// The first 04:00 UTC after the start, when a copy fetched since the start stops being fresh
const nextRefresh = Date.parse("2026-10-10T04:00:00Z")
// A copy fetched before the last 04:00 UTC, which is stale at the start
const staleAt = start - dayMs
const created = "2026-09-14T09:30:00.000Z"

// What npm counts on a day, the same wherever the fake needs it
const countOn = (day: string) => (Date.parse(`${day}T00:00:00Z`) / dayMs) % 9 + 1

function historyBetween(first: string, last: string): NpmHistory {
    const days = []
    for (let time = Date.parse(`${first}T00:00:00Z`); time <= Date.parse(`${last}T00:00:00Z`); time += dayMs) {
        const day = new Date(time).toISOString().slice(0, 10)
        days.push({ day, downloads: countOn(day) })
    }
    return { package: packageName, days }
}

// The history npm gives at the starting time, and an older one a previous refresh would have stored
const current = historyBetween("2026-09-14", "2026-10-08")
const older = historyBetween("2026-09-14", "2026-10-07")

class FakeKv {
    entries = new Map<string, string>()
    reads = 0
    writes: string[] = []
    async get(key: string, type: "json") {
        assert.equal(type, "json")
        this.reads++
        const value = this.entries.get(key)
        return value === undefined ? null : JSON.parse(value)
    }
    async put(key: string, value: string) {
        this.writes.push(value)
        this.entries.set(key, value)
    }
    seed(history: NpmHistory, fetchedAt: number) {
        this.entries.set("history", JSON.stringify({ fetchedAt, history }))
    }
    stored() {
        const value = this.entries.get("history")
        return value === undefined ? undefined : JSON.parse(value)
    }
}

// A cache that works the way Cloudflare's does for what the endpoint uses: GET keys only, and an entry's own
// Cache-Control says how long it lives
class FakeCache {
    entries = new Map<string, { body: string; cacheControl: string | null }>()
    puts = 0
    async match(request: Request) {
        const entry = this.entries.get(request.url)
        return entry && new Response(entry.body, { headers: { "content-type": "application/json", "cache-control": entry.cacheControl ?? "" } })
    }
    async put(request: Request, response: Response) {
        if (request.method !== "GET") throw new TypeError("Cache.put only takes GET requests")
        this.puts++
        this.entries.set(request.url, { body: await response.text(), cacheControl: response.headers.get("cache-control") })
    }
    entry() {
        return [...this.entries.values()].at(0)
    }
    lifetime() {
        return Number(/max-age=(\d+)/.exec(this.entry()?.cacheControl ?? "")?.[1])
    }
}

// The registry and the downloads API as the endpoint calls them. A gate holds every answer until it is opened
function fakeNpm(options: { failing?: boolean; countOf?: (day: string) => unknown; range?: unknown } = {}) {
    const calls: string[] = []
    let open: () => void = () => {}
    let gate: Promise<void> = Promise.resolve()
    const countOf = options.countOf ?? countOn
    const fetchNpm = async (url: string | URL | Request) => {
        const href = String(url)
        calls.push(href)
        await gate
        if (options.failing) return new Response("npm is down", { status: 503 })
        if (href.startsWith("https://registry.npmjs.org/")) return Response.json({ time: { created } })
        const range = /\/range\/(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\//.exec(href)
        assert.ok(range, `unexpected request ${href}`)
        if (options.range !== undefined) return Response.json(options.range)
        const downloads = []
        for (let time = Date.parse(`${range[1]}T00:00:00Z`); time <= Date.parse(`${range[2]}T00:00:00Z`); time += dayMs) {
            const day = new Date(time).toISOString().slice(0, 10)
            downloads.push({ day, downloads: countOf(day) })
        }
        return Response.json({ start: range[1], end: range[2], package: packageName, downloads })
    }
    return {
        calls,
        fetchNpm,
        hold() {
            gate = new Promise((resolve) => (open = resolve))
        },
        release: () => open(),
    }
}

let kv: FakeKv
let cache: FakeCache
let npm: ReturnType<typeof fakeNpm>
let pending: Promise<unknown>[]
const realFetch = globalThis.fetch

beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: start })
    mock.method(console, "error", () => {})
    kv = new FakeKv()
    cache = new FakeCache()
    npm = fakeNpm()
    pending = []
    Reflect.set(globalThis, "caches", { default: cache })
    globalThis.fetch = ((url: string | URL | Request) => npm.fetchNpm(url)) as typeof fetch
})

afterEach(() => {
    mock.timers.reset()
    mock.restoreAll()
    globalThis.fetch = realFetch
    Reflect.deleteProperty(globalThis, "caches")
})

// A request as Pages hands it over, with the KV binding left out when asked
function ask(options: { method?: string; binding?: boolean; path?: string; built?: { fetchedAt: number; history: NpmHistory } } = {}) {
    const request = new Request(`https://fluxerly.test${options.path ?? "/api/npm-downloads"}`, { method: options.method ?? "GET" })
    const env = options.binding === false ? {} : { NPM_DOWNLOADS: kv }
    return answerDownloads({ request, env, waitUntil: (promise) => void pending.push(promise) }, options.built)
}

// Waits for everything the endpoint left running after it answered
async function settle() {
    while (pending.length) await Promise.all(pending.splice(0))
}

const bodyOf = async (response: Response) => JSON.parse(await response.text())

describe("a fresh copy in KV", () => {
    test("is served without asking npm, with the headers the browser needs", async () => {
        kv.seed(older, start - 2 * hourMs)
        const response = await ask()
        await settle()

        assert.equal(response.status, 200)
        assert.equal(response.headers.get("content-type"), "application/json")
        assert.equal(response.headers.get("cache-control"), "public, max-age=300")
        assert.deepEqual(await bodyOf(response), older)
        assert.deepEqual(npm.calls, [])
        assert.equal(kv.writes.length, 0)
    })

    for (const [now, left] of [
        [start, 16 * 3600],
        [nextRefresh - 90_000, 90],
        [nextRefresh - 5_000, 60],
    ] as const) {
        test(`is cached at the edge until the next 04:00 UTC, ${(nextRefresh - now) / 1000} s ahead, and for a minute at least`, async () => {
            kv.seed(older, start - hourMs)
            mock.timers.setTime(now)
            await ask()
            await settle()

            assert.equal(cache.lifetime(), left)
            assert.deepEqual(JSON.parse(cache.entry()!.body), older)
            assert.deepEqual(npm.calls, [])
        })
    }

    test("is then answered by the edge cache without KV or npm", async () => {
        kv.seed(older, start - hourMs)
        await ask()
        await settle()
        const reads = kv.reads

        const second = await ask()
        assert.deepEqual(await bodyOf(second), older)
        assert.equal(second.headers.get("cache-control"), "public, max-age=300")
        assert.equal(kv.reads, reads)
        assert.deepEqual(npm.calls, [])
    })
})

describe("a stale copy in KV", () => {
    test("is served at once and replaced in the background", async () => {
        kv.seed(older, staleAt)
        npm.hold()
        const response = await ask()

        // The answer is here while npm has not answered yet
        assert.deepEqual(await bodyOf(response), older)
        assert.equal(response.headers.get("cache-control"), "public, max-age=300")

        npm.release()
        await settle()
        assert.equal(npm.calls.length, 2, "the registry and one year of downloads")
        assert.equal(kv.writes.length, 1)
        assert.deepEqual(kv.stored(), { fetchedAt: start, history: current })
        // This location now holds the new copy until the next 04:00 UTC, and the next visitor sees it
        assert.equal(cache.lifetime(), 16 * 3600)
        assert.deepEqual(await bodyOf(await ask()), current)
        assert.equal(npm.calls.length, 2)
    })

    test("is cached for only a minute while the refresh runs, so one location does not ask npm twice", async () => {
        kv.seed(older, staleAt)
        npm.hold()
        await ask()
        await new Promise((resolve) => setImmediate(resolve))

        assert.equal(cache.lifetime(), 60)
        const again = await ask()
        assert.deepEqual(await bodyOf(again), older)
        assert.equal(npm.calls.length, 1, "only the first request started a refresh")

        npm.release()
        await settle()
    })

    test("stays what the visitors get when npm cannot be reached, and is cached for 15 minutes", async () => {
        kv.seed(older, staleAt)
        npm = fakeNpm({ failing: true })
        const response = await ask()
        await settle()

        assert.equal(response.status, 200)
        assert.deepEqual(await bodyOf(response), older)
        assert.equal(kv.writes.length, 0)
        assert.deepEqual(kv.stored(), { fetchedAt: staleAt, history: older })
        assert.equal(cache.lifetime(), 15 * 60)
        assert.deepEqual(JSON.parse(cache.entry()!.body), older)
    })

    test("is not overwritten with a malformed answer from npm", async () => {
        kv.seed(older, staleAt)
        npm = fakeNpm({ countOf: (day) => (day === "2026-10-01" ? "many" : 1) })
        const response = await ask()
        await settle()

        assert.deepEqual(await bodyOf(response), older)
        assert.equal(kv.writes.length, 0)
        assert.equal(cache.lifetime(), 15 * 60)
    })
})

describe("no copy anywhere", () => {
    test("fetches from npm, stores the copy with its time and serves it", async () => {
        const response = await ask()
        await settle()

        assert.equal(response.status, 200)
        assert.equal(response.headers.get("cache-control"), "public, max-age=300")
        assert.deepEqual(await bodyOf(response), current)
        assert.match(npm.calls[0], /^https:\/\/registry\.npmjs\.org\/@neontechspace\/fluxerly$/)
        assert.match(npm.calls[1], /^https:\/\/api\.npmjs\.org\/downloads\/range\/2026-09-14:2026-10-08\/@neontechspace\/fluxerly$/)
        assert.equal(npm.calls.length, 2)
        assert.deepEqual(kv.stored(), { fetchedAt: start, history: current })
        assert.equal(cache.lifetime(), 16 * 3600)
    })

    test("is asked of npm once for any number of later visitors", async () => {
        await ask()
        await settle()
        for (let visitor = 0; visitor < 5; visitor++) assert.deepEqual(await bodyOf(await ask()), current)
        assert.equal(npm.calls.length, 2)
        assert.equal(kv.writes.length, 1)
    })

    test("answers 503 without caching when npm cannot be reached", async () => {
        npm = fakeNpm({ failing: true })
        const response = await ask()
        await settle()

        assert.equal(response.status, 503)
        assert.equal(response.headers.get("cache-control"), "no-store")
        assert.equal(kv.writes.length, 0)
        assert.equal(cache.puts, 0)
    })

    test("does not store or serve a malformed answer from npm", async () => {
        const malformed = [
            { countOf: () => "many" },
            { countOf: () => -1 },
            { countOf: () => 1.5 },
            { range: { downloads: "none" } },
            { range: { error: "package not found" } },
            { range: [] },
        ]
        for (const options of malformed) {
            npm = fakeNpm(options)
            const response = await ask()
            await settle()

            assert.equal(response.status, 503)
            assert.equal(response.headers.get("cache-control"), "no-store")
            assert.equal(kv.writes.length, 0)
            assert.equal(cache.puts, 0)
        }
    })

    test("drops the newest days npm has not counted yet", async () => {
        npm = fakeNpm({ countOf: (day) => (day >= "2026-10-07" ? 0 : countOn(day)) })
        const response = await ask()
        await settle()

        assert.deepEqual(await bodyOf(response), historyBetween("2026-09-14", "2026-10-06"))
    })
})

describe("without the KV binding", () => {
    test("the edge cache alone keeps the copy until the next 04:00 UTC and npm is asked once", async () => {
        const response = await ask({ binding: false })
        await settle()

        assert.equal(response.status, 200)
        assert.deepEqual(await bodyOf(response), current)
        assert.equal(cache.lifetime(), 16 * 3600)

        assert.deepEqual(await bodyOf(await ask({ binding: false })), current)
        assert.equal(npm.calls.length, 2)
        assert.equal(kv.reads, 0)
        assert.equal(kv.writes.length, 0)
    })

    test("answers 503 when the cache is empty and npm cannot be reached", async () => {
        npm = fakeNpm({ failing: true })
        const response = await ask({ binding: false })
        assert.equal(response.status, 503)
        assert.equal(response.headers.get("cache-control"), "no-store")
    })
})

describe("the request", () => {
    test("HEAD gets the headers and no body, and shares the cached copy with GET", async () => {
        kv.seed(older, start - hourMs)
        const head = await ask({ method: "HEAD" })
        await settle()
        assert.equal(head.status, 200)
        assert.equal(head.headers.get("content-type"), "application/json")
        assert.equal(head.headers.get("cache-control"), "public, max-age=300")
        assert.equal(await head.text(), "")

        const get = await ask({ path: "/api/npm-downloads?cache=skip" })
        assert.deepEqual(await bodyOf(get), older)
        assert.equal(cache.puts, 1)
        assert.equal(kv.reads, 1)
    })

    test("any other method is refused", async () => {
        const response = await ask({ method: "POST" })
        assert.equal(response.status, 405)
        assert.equal(response.headers.get("allow"), "GET, HEAD")
        assert.deepEqual(npm.calls, [])
    })

    test("a copy in KV that is not a history is ignored and replaced", async () => {
        kv.entries.set("history", JSON.stringify({ fetchedAt: start, history: { package: packageName, days: [{ day: "2026-09-14", downloads: "1" }] } }))
        const response = await ask()
        await settle()

        assert.deepEqual(await bodyOf(response), current)
        assert.deepEqual(kv.stored(), { fetchedAt: start, history: current })
    })
})

describe("a new deployment", () => {
    test("serves the counts it fetched, ahead of an older copy and any earlier edge answer, without asking npm", async () => {
        kv.seed(older, start - hourMs)
        await ask()
        await settle()
        assert.deepEqual(JSON.parse(cache.entry()!.body), older)

        const response = await ask({ built: { fetchedAt: start, history: current } })
        await settle()
        assert.deepEqual(await bodyOf(response), current)
        assert.deepEqual(npm.calls, [])
    })

    test("is good until the first 04:00 UTC after the build, then asks npm again", async () => {
        const built = { fetchedAt: start - hourMs, history: older }
        await ask({ built })
        await settle()
        mock.timers.setTime(nextRefresh - 1)
        cache.entries.clear()
        await ask({ built })
        await settle()
        assert.deepEqual(npm.calls, [])

        mock.timers.setTime(nextRefresh)
        cache.entries.clear()
        await ask({ built })
        await settle()
        assert.equal(npm.calls.length > 0, true)
        assert.equal(kv.stored().fetchedAt, nextRefresh)
    })

    test("gives way to a newer copy in KV", async () => {
        kv.seed(current, start - hourMs)
        const response = await ask({ built: { fetchedAt: start - dayMs, history: older } })
        await settle()
        assert.deepEqual(await bodyOf(response), current)
    })
})

// Visits one Cloudflare location with an empty edge cache at the given moment, with a copy in KV fetched at the given
// time, and tells whether npm was asked and how long the edge cache keeps the answer
async function visit(now: number, fetchedAt: number) {
    mock.timers.setTime(now)
    kv = new FakeKv()
    cache = new FakeCache()
    npm = fakeNpm()
    Reflect.set(globalThis, "caches", { default: cache })
    kv.seed(older, fetchedAt)
    await ask()
    await settle()
    return { asked: npm.calls.length > 0, lifetime: cache.lifetime() }
}

const at = (time: string) => Date.parse(time)

describe("the daily refresh at 04:00 UTC", () => {
    test("a copy fetched just before 04:00 is refreshed once 04:00 has passed that same day", async () => {
        const fetchedAt = at("2026-10-09T03:50:00Z")
        assert.deepEqual(await visit(fetchedAt, fetchedAt), { asked: false, lifetime: 600 })
        assert.equal((await visit(at("2026-10-09T03:59:59.999Z"), fetchedAt)).asked, false)
        assert.deepEqual(await visit(at("2026-10-09T04:00:00Z"), fetchedAt), { asked: true, lifetime: 24 * 3600 })
    })

    test("a copy fetched after 04:00 is refreshed after 04:00 the next day", async () => {
        const fetchedAt = at("2026-10-09T04:30:00Z")
        assert.deepEqual(await visit(at("2026-10-09T23:59:00Z"), fetchedAt), { asked: false, lifetime: 4 * 3600 + 60 })
        assert.equal((await visit(at("2026-10-10T03:59:59.999Z"), fetchedAt)).asked, false)
        assert.equal((await visit(at("2026-10-10T04:00:00Z"), fetchedAt)).asked, true)
    })

    test("a copy fetched exactly at 04:00 lasts until 04:00 the next day", async () => {
        const fetchedAt = at("2026-10-09T04:00:00Z")
        assert.deepEqual(await visit(fetchedAt, fetchedAt), { asked: false, lifetime: 24 * 3600 })
    })

    test("a local clock change does not move the refresh", async () => {
        // Summer time ends in Europe on 25 October 2026, and the refresh stays at 04:00 UTC
        const saturday = at("2026-10-24T04:30:00Z")
        assert.deepEqual(await visit(saturday, saturday), { asked: false, lifetime: 23.5 * 3600 })
        assert.equal((await visit(at("2026-10-25T03:59:59.999Z"), saturday)).asked, false)
        assert.equal((await visit(at("2026-10-25T04:00:00Z"), saturday)).asked, true)
    })

    // The next 04:00 UTC, found by walking the UTC days
    function refreshAfter(time: number) {
        for (let day = Math.floor(time / dayMs); ; day++) {
            const refresh = day * dayMs + 4 * hourMs
            if (refresh > time) return refresh
        }
    }

    test("the edge cache never keeps an answer past the next 04:00, beyond its one-minute floor", async () => {
        const step = 37 * 60 * 1000
        const seenBranches = { fresh: 0, refreshed: 0 }
        for (let fetchedAt = at("2026-10-20T00:00:00Z"); fetchedAt < at("2026-11-01T00:00:00Z"); fetchedAt += step) {
            const now = fetchedAt + 7 * 60 * 1000
            const refresh = refreshAfter(fetchedAt)
            const seen = await visit(now, fetchedAt)
            const moment = new Date(fetchedAt).toISOString()
            if (now < refresh) {
                seenBranches.fresh++
                assert.equal(seen.asked, false, moment)
                assert.equal(seen.lifetime, Math.max(60, Math.floor((refresh - now) / 1000)), moment)
                if (refresh - now >= 60_000) assert.ok(seen.lifetime * 1000 <= refresh - now, moment)
            } else {
                // Refreshed, and the new copy is kept until the 04:00 after now
                seenBranches.refreshed++
                assert.equal(seen.asked, true, moment)
                assert.equal(seen.lifetime, Math.floor((refreshAfter(now) - now) / 1000), moment)
            }
        }
        assert.ok(seenBranches.fresh > 400 && seenBranches.refreshed > 0, JSON.stringify(seenBranches))
    })
})
