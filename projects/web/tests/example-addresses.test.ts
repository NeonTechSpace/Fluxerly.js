import assert from "node:assert/strict"
import { existsSync, globSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { breakableHtml } from "../scripts/docs/code-breaks.mjs"
import remarkExampleAddresses, { exampleAddress } from "../scripts/docs/remark-example-addresses.mjs"

// An example address in a doc comment, such as https://example.test, leads nowhere, so Markdown's own linking of bare addresses
// leaves it as code. Addresses that lead somewhere, and links the author wrote, stay links

test("reserved example and local hosts, and hosts with no dot, are example addresses", () => {
    for (const href of ["https://example.test", "https://example.test/", "https://fluxer.example", "https://user:password@host/path", "http://localhost:3000", "https://api.localhost", "https://bad.invalid", "https://example.com/x", "https://www.example.org", "https://docs.example.net"]) {
        assert.equal(exampleAddress(href), true, href)
    }
    for (const href of ["https://effect.website", "https://github.com/fluxerapp/fluxer", "https://notexample.com", "https://example.community", "not a url"]) {
        assert.equal(exampleAddress(href), false, href)
    }
})

const processor = await createMarkdownProcessor({ remarkPlugins: [remarkExampleAddresses], smartypants: false })
const render = async (markdown: string) => (await processor.render(markdown)).code

test("a bare example address reads as code instead of a link", async () => {
    assert.equal(await render("such as https://example.test/ for https://example.test, so"), "<p>such as <code>https://example.test/</code> for <code>https://example.test</code>, so</p>")
    assert.equal(await render("such as https://fluxer.example."), "<p>such as <code>https://fluxer.example</code>.</p>")
    assert.equal(await render("user:password in https://user:password@host/path, are masked"), "<p>user:password in <code>https://user:password@host/path</code>, are masked</p>")
    assert.equal(await render("Visit www.example.com today"), "<p>Visit <code>www.example.com</code> today</p>")
})

test("a real address stays a link, and so does a link the author wrote", async () => {
    assert.equal(await render("Built on https://effect.website"), '<p>Built on <a href="https://effect.website">https://effect.website</a></p>')
    assert.equal(await render("See [the example](https://example.test/docs)"), '<p>See <a href="https://example.test/docs">the example</a></p>')
    assert.equal(await render("See <https://example.test>"), '<p>See <a href="https://example.test">https://example.test</a></p>')
})

test("no built page links an example address", () => {
    assert.ok(existsSync(join("dist", "index.html")), "Build the site first: the check reads the built pages in dist")
    const offenders: string[] = []
    for (const page of globSync("dist/**/*.html")) {
        const html = readFileSync(page, "utf8")
        for (const [, href] of html.matchAll(/<a\b[^>]*\shref="(https?:\/\/[^"]*)"/g)) if (exampleAddress(href!.replaceAll("&amp;", "&"))) offenders.push(`${page} links ${href}`)
    }
    assert.deepEqual(offenders.slice(0, 20), [])
})

test("an address in inline code never breaks right after its scheme", () => {
    assert.equal(breakableHtml("https://user:password@host/path"), "https://user:password@host/<wbr>path")
    assert.equal(breakableHtml("src/lib/markdown.ts"), "src/<wbr>lib/<wbr>markdown.ts")
})
