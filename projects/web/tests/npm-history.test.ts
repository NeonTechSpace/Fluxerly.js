// Tests the npm history fetch and its validator, the code the snapshot script, the endpoint and the page share.
// npm is a fake fetch and the time is a number, so nothing here depends on the network or the clock
import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchNpmHistory, isNpmHistory, packageName } from "../src/lib/npm-history.ts"

const dayMs = 86_400_000
const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10)

// A registry that says when the package was created, and a downloads API that counts 5 on every day
function fakeNpm(created: unknown, count = (_day: string) => 5) {
    const ranges: string[] = []
    const fetchNpm = (async (url: string | URL | Request) => {
        const href = String(url)
        if (href.startsWith("https://registry.npmjs.org/")) return Response.json({ time: { created } })
        const range = /\/range\/(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\//.exec(href)
        assert.ok(range, `unexpected request ${href}`)
        ranges.push(`${range[1]}:${range[2]}`)
        const downloads = []
        for (let time = Date.parse(range[1]); time <= Date.parse(range[2]); time += dayMs) downloads.push({ day: dayOf(time), downloads: count(dayOf(time)) })
        return Response.json({ downloads })
    }) as typeof fetch
    return { fetchNpm, ranges }
}

test("the history runs from the creation day to yesterday in UTC", async () => {
    const { fetchNpm } = fakeNpm("2026-09-14T23:59:59.000Z")
    // Just after midnight UTC on the 9th, the 8th is the last day that has ended
    const history = await fetchNpmHistory(fetchNpm, Date.parse("2026-10-09T00:00:01Z"))

    assert.equal(history.package, packageName)
    assert.equal(history.days[0].day, "2026-09-14")
    assert.equal(history.days.at(-1)!.day, "2026-10-08")
    assert.equal(history.days.length, 25)
})

test("a history longer than a year is asked for in chunks of at most a year, without gaps", async () => {
    const { fetchNpm, ranges } = fakeNpm("2024-01-01T00:00:00.000Z")
    const history = await fetchNpmHistory(fetchNpm, Date.parse("2026-03-01T12:00:00Z"))

    assert.deepEqual(ranges, ["2024-01-01:2024-12-30", "2024-12-31:2025-12-30", "2025-12-31:2026-02-28"])
    assert.equal(history.days.length, (Date.parse("2026-02-28T00:00:00Z") - Date.parse("2024-01-01T00:00:00Z")) / dayMs + 1)
    assert.ok(isNpmHistory(history))
})

test("days npm has not counted yet are dropped from the end, and days it left out count as zero", async () => {
    const { fetchNpm } = fakeNpm("2026-09-14T10:00:00.000Z", (day) => (day >= "2026-10-07" ? 0 : 5))
    const history = await fetchNpmHistory(fetchNpm, Date.parse("2026-10-09T12:00:00Z"))
    assert.equal(history.days.at(-1)!.day, "2026-10-06")

    // A zero in the middle stays, and a package whose every day reads 0 keeps its first day
    const quiet = await fetchNpmHistory(fakeNpm("2026-09-14T10:00:00.000Z", () => 0).fetchNpm, Date.parse("2026-10-09T12:00:00Z"))
    assert.deepEqual(quiet.days, [{ day: "2026-09-14", downloads: 0 }])
})

test("npm failing, or answering with nothing the chart can use, is an error", async () => {
    const now = Date.parse("2026-10-09T12:00:00Z")
    await assert.rejects(fetchNpmHistory((async () => new Response("down", { status: 502 })) as typeof fetch, now), /502/)
    await assert.rejects(fetchNpmHistory(fakeNpm(undefined).fetchNpm, now), /creation date/)
    await assert.rejects(fetchNpmHistory(fakeNpm("not a date").fetchNpm, now), /creation date/)
    await assert.rejects(fetchNpmHistory(fakeNpm("2026-10-09T08:00:00.000Z").fetchNpm, now), /no full day/)
    await assert.rejects(fetchNpmHistory(fakeNpm("2026-09-14T00:00:00.000Z", () => "many" as unknown as number).fetchNpm, now), /whole numbers/)
})

test("the validator accepts only a package's days in a row with whole counts", () => {
    const good = { package: packageName, days: [{ day: "2026-02-27", downloads: 1 }, { day: "2026-02-28", downloads: 0 }, { day: "2026-03-01", downloads: 7 }] }
    assert.ok(isNpmHistory(good))

    const bad: unknown[] = [
        null,
        "history",
        {},
        { ...good, package: "someone-else" },
        { ...good, days: [] },
        { ...good, days: "none" },
        { ...good, days: [good.days[0], good.days[2]] },
        { ...good, days: [good.days[1], good.days[0]] },
        { ...good, days: [good.days[0], good.days[0]] },
        { ...good, days: [{ day: "2026-02-31", downloads: 1 }] },
        { ...good, days: [{ day: "2026-2-27", downloads: 1 }] },
        { ...good, days: [{ day: "2026-02-27", downloads: -1 }] },
        { ...good, days: [{ day: "2026-02-27", downloads: 0.5 }] },
        { ...good, days: [{ day: "2026-02-27", downloads: "3" }] },
        { ...good, days: [{ day: "2026-02-27" }] },
        { ...good, days: [null] },
    ]
    for (const value of bad) assert.equal(isNpmHistory(value), false, JSON.stringify(value))
})
