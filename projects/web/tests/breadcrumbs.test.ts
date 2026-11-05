import assert from "node:assert/strict"
import { existsSync, globSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { test } from "node:test"

// Search engines show a page's trail only when it has two steps or more, so a trail of one, such as the docs overview's own, is left
// out of the page. The pages are read as built, so a trail any route writes is checked

type Node = { "@type"?: string; itemListElement?: unknown[] }

const trailsOf = (html: string) =>
    [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(([, json]) => {
        const data = JSON.parse(json!) as { "@graph"?: Node[] } & Node
        return [...(data["@graph"] ?? [data])].filter((node) => node["@type"] === "BreadcrumbList")
    })

test("no built page carries a trail of fewer than two steps", () => {
    const dist = "dist"
    assert.ok(existsSync(join(dist, "index.html")), "Build the site first: the check reads the built pages in dist")
    const short: string[] = []
    for (const file of globSync(`${dist}/**/*.html`)) {
        for (const trail of trailsOf(readFileSync(file, "utf8"))) if ((trail.itemListElement?.length ?? 0) < 2) short.push(`${relative(dist, file)}: ${trail.itemListElement?.length ?? 0} steps`)
    }
    assert.deepEqual(short.slice(0, 20), [])
})

test("the docs overview has no trail, and a guide keeps its two steps", () => {
    assert.deepEqual(trailsOf(readFileSync("dist/docs/index.html", "utf8")), [])
    const [trail] = trailsOf(readFileSync("dist/docs/quick-start/index.html", "utf8"))
    assert.equal(trail?.itemListElement?.length, 2)
})
