// Tests what the docs tell search engines: titles that no two pages share, and short descriptions completed from the
// page's own words without repeating it or running past what a search result shows
import assert from "node:assert/strict"
import { test } from "node:test"
import { changelogPage } from "../scripts/docs/generate.mjs"
import { completeDescription, docsPageTitle, openingParagraphs, titleQualifiers } from "../src/lib/docs-meta.ts"

test("pages that share a title take the nearest step that tells them apart", () => {
    const qualifiers = titleQualifiers([
        { href: "/docs/api/js-ts/client/", title: "Client", context: ["JavaScript & TypeScript", "Client and lifecycle"] },
        { href: "/docs/api/effect/client/", title: "Client", context: ["Effect API", "Client and lifecycle"] },
        { href: "/docs/api/js-ts/helpererror/", title: "HelperError", context: ["JavaScript & TypeScript", "Errors"] },
    ])
    assert.equal(qualifiers.get("/docs/api/js-ts/client/"), "JavaScript & TypeScript")
    assert.equal(qualifiers.get("/docs/api/effect/client/"), "Effect API")
    assert.equal(qualifiers.has("/docs/api/js-ts/helpererror/"), false)
})

test("a step that repeats the title is skipped, and steps still clashing go one further", () => {
    const qualifiers = titleQualifiers([
        { href: "/docs/api/testing/", title: "Testing", context: ["Overview"] },
        { href: "/docs/api/testing/testing/", title: "Testing", context: ["Testing", "Symbols"] },
        { href: "/docs/api/effect-testing/testing/", title: "Testing", context: ["Effect testing", "Symbols"] },
        { href: "/a/", title: "Options", context: ["Effect API", "Client"] },
        { href: "/b/", title: "Options", context: ["Effect API", "Commands"] },
    ])
    assert.deepEqual([...qualifiers.values()].slice(0, 3), ["Overview", "Symbols", "Effect testing"])
    assert.equal(qualifiers.get("/a/"), "Effect API · Client")
    assert.equal(qualifiers.get("/b/"), "Effect API · Commands")
})

test("a title that would be cut in a search result drops the word docs", () => {
    assert.equal(docsPageTitle("Client", "Effect API"), "Client · Effect API · Fluxerly.js docs")
    assert.equal(docsPageTitle("Sharding and supervision", "JavaScript & TypeScript"), "Sharding and supervision · JavaScript & TypeScript · Fluxerly.js")
})

test("a description long enough stays as it is", () => {
    const long = "Readable records from the first run, with error codes, hints and the token masked, so a failed start says what went wrong"
    assert.equal(completeDescription(long, ["Something else entirely that the page says next"], ["Levels"]), long)
})

test("a short description goes on with the page's lead and opening paragraphs, whole sentences only", () => {
    const text = completeDescription(
        "Send !ping and receive Pong! from a bot",
        ["", "Before starting, create a Fluxer bot, store its token and add it to a community. Fluxerly is tested against Node.js 24.15 or newer, and this sentence is far too long to fit in what remains of a search result"],
        ["Install the SDK", "Write the bot"],
    )
    assert.equal(text, "Send !ping and receive Pong! from a bot. Before starting, create a Fluxer bot, store its token and add it to a community")
})

test("a paragraph that starts with the description replaces it instead of repeating it", () => {
    const text = completeDescription("Raised when a helper fails", ["Raised when a helper fails. The error names the helper and keeps the cause."], [])
    assert.equal(text, "Raised when a helper fails. The error names the helper and keeps the cause")
})

test("with no prose left, a short description names the page's sections, skipping generic ones", () => {
    const text = completeDescription("What each code means and what to do about it", [], ["Methods", "Startup", "Gateway", "REST", "Commands"])
    assert.equal(text, "What each code means and what to do about it. Sections: Startup, Gateway, REST, Commands")
    const crowded = completeDescription("Short", [], Array.from({ length: 40 }, (_, index) => `Section number ${index + 1}`))
    assert.ok(crowded.length <= 160 && / and \d+ more$/.test(crowded), crowded)
    const nearlyFull = "Read the default output, choose a level, mask secrets and send records to your own sink in prod"
    assert.equal(completeDescription(nearlyFull, [], ["Read the default output of a bot", "Choose a level for each category", "Mask secrets"]), nearlyFull)
})

test("opening paragraphs are the page's prose, without notes, code, labels or markup", () => {
    const html =
        '<blockquote><p>Tip: a note</p></blockquote><p>Each <a class="peek" href="/x">shard</a> of a <code>Client</code> &amp; its <strong>gateway</strong>&#x27;s state</p><pre><code>run()</code></pre><p class="ref-label">Parameters</p><ul><li><p>Item</p></li></ul><p>Second​ one</p>'
    assert.deepEqual(openingParagraphs(html), ["Each shard of a Client & its gateway's state", "Second one"])
})

test("The changelog page says there are no releases only when it has nothing to show", () => {
    const empty = "# Changelog\n\n"
    assert.match(changelogPage(empty, ""), /No package releases have been recorded yet/)
    const nightly = changelogPage(empty, "- A change\n")
    assert.match(nightly, /## Unreleased/)
    assert.doesNotMatch(nightly, /No package releases/)
})
