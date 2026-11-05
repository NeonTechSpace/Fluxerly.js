import assert from "node:assert/strict"
import { existsSync, globSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { test } from "node:test"
import rehypeExternalLinks, { leavesSite } from "../src/lib/external-links.mjs"

// Every link that leaves the site opens in a new tab with rel="noopener", whether a component, a guide, the reference or the changelog
// wrote it. The pages are read as built, so a link added by any route fails here

test("a web address on another host leaves the site, the site's own pages and relative links don't", () => {
    assert.equal(leavesSite("https://github.com/NeonTechSpace"), true)
    assert.equal(leavesSite("//docs.fluxer.com/x"), true)
    assert.equal(leavesSite("https://fluxerly.neontechspace.com/docs/"), false)
    assert.equal(leavesSite("/docs/quick-start/"), false)
    assert.equal(leavesSite("#top"), false)
    assert.equal(leavesSite("mailto:someone@example.test"), false)
})

test("Markdown links that leave the site get a new tab and keep their other rel values", () => {
    const tree = {
        type: "root",
        children: [
            { type: "element", tagName: "a", properties: { href: "https://effect.website", rel: ["external"] }, children: [] },
            { type: "element", tagName: "a", properties: { href: "/docs/" }, children: [] },
        ],
    }
    rehypeExternalLinks()(tree)
    assert.deepEqual(tree.children[0]!.properties, { href: "https://effect.website", rel: ["external", "noopener"], target: "_blank" })
    assert.deepEqual(tree.children[1]!.properties, { href: "/docs/" })
})

test("every built page opens links that leave the site in a new tab", () => {
    const dist = "dist"
    assert.ok(existsSync(join(dist, "index.html")), "Build the site first: the check reads the built pages in dist")
    const offenders = new Set<string>()
    for (const file of globSync(`${dist}/**/*.html`)) {
        for (const [tag] of readFileSync(file, "utf8").matchAll(/<a\b[^>]*>/g)) {
            const href = /\shref="([^"]*)"/.exec(tag)?.[1]?.replaceAll("&amp;", "&")
            if (!leavesSite(href)) continue
            const rel = /\srel="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? []
            if (!/\starget="_blank"/.test(tag) || !rel.includes("noopener")) offenders.add(`${relative(dist, file)}: ${tag.slice(0, 160)}`)
        }
    }
    assert.deepEqual([...offenders].slice(0, 20), [])
})
