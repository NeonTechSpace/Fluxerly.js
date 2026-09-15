import assert from "node:assert/strict"
import test from "node:test"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { remarkProse } from "../scripts/prose.mjs"

function withoutProseHighlights(code) {
    return code.replace(/<span class="prose-(?:keyword|constant|number)">([^<]*)<\/span>/g, "$1")
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

test("Standalone sentences use source paragraphs with inline formatting intact", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkProse] })
    const { code } = await processor.render("Read guild members\n\nHTTP methods return Effects\n\nKeep `members` and [their roles](/roles/) together\n\nReturned members are frozen. Optional retention follows your settings")
    const prose = withoutProseHighlights(code)
    assert.equal((code.match(/<p>/g) ?? []).length, 4)
    assert.doesNotMatch(code, /<br/)
    assert.match(prose, /<code>members<\/code> and <a href="\/roles\/">their roles<\/a> together<\/p>/)
    assert.match(prose, /<p>Returned members are frozen\. Optional retention follows your settings<\/p>/)
})

test("Soft wrapping and explicit hard breaks do not invent paragraph boundaries", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkProse] })
    const { code } = await processor.render("Use the supported runtime.\nJavaScript consumers do not need TypeScript\n\nInvalid snapshots return\nGuildOperationError without retaining the input\n\nA deliberate hard break  \nstill belongs to this paragraph")
    const prose = withoutProseHighlights(code)
    assert.equal((code.match(/<p>/g) ?? []).length, 3)
    assert.match(prose, /<p>Use the supported runtime\.\nJavaScript consumers do not need TypeScript<\/p>/)
    assert.match(prose, /<p>Invalid snapshots return\nGuildOperationError without retaining the input<\/p>/)
    assert.equal((code.match(/<br\s*\/?>/g) ?? []).length, 1)
})

test("Structured blocks retain their boundaries and executable or linked text is not rewritten", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkProse] })
    const { code } = await processor.render('> `Effect`<br />`Client`\n>\n> A separate quoted paragraph\n\n- HTTP reads\n\n  Another paragraph in this list item\n\n| Type | Detail |\n| --- | --- |\n| number | 30,000 ms |\n\n```text\nHTTP 204 MANAGE_ROLES\n```\n\n`HTTP 204 MANAGE_ROLES` and [HTTP 204](/204/)')
    assert.match(code, /<blockquote>\s*<p><code>Effect<\/code><br\s*\/?>.*<code>Client<\/code><\/p>/s)
    assert.equal((code.match(/<li>/g) ?? []).length, 1)
    assert.match(code, /<p>A separate quoted paragraph<\/p>\s*<\/blockquote>/)
    assert.match(code, /<p>Another paragraph in this list item<\/p>\s*<\/li>/)
    assert.equal((code.match(/<table>/g) ?? []).length, 1)
    assert.match(code, /<code>HTTP 204 MANAGE_ROLES<\/code> and <a href="\/204\/">HTTP 204<\/a>/)
    assert.match(code, /<pre[^>]*>[\s\S]*HTTP 204 MANAGE_ROLES[\s\S]*<\/pre>/)
})

test("Prose highlights protocols, numeric values and constants without changing its text", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkProse] })
    const { code } = await processor.render("HTTP 204 requires MANAGE_ROLES, with 30,000 ms and Node 24.11.0\n\nHTTPS and WSS are supported\n\nA request is unchanged")
    const prose = withoutProseHighlights(code)
    assert.match(code, /class="prose-keyword">HTTP<\/span>/)
    assert.match(code, /class="prose-constant">MANAGE_ROLES<\/span>/)
    for (const number of ["204", "30,000", "24.11.0"]) assert.ok(code.includes(`class="prose-number">${number}</span>`))
    assert.match(prose, /<p>A request is unchanged<\/p>/)
    assert.doesNotMatch(code, /<em>/)
})

test("Prose highlights numbers before terminal punctuation without matching numeric fragments", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkProse] })
    const source = "HTTP 204. A timeout of 30,000. is valid\n\nv24.11.0 and 24.11.0beta remain unchanged"
    const { code } = await processor.render(source)
    assert.match(code, /class="prose-number">204<\/span>\./)
    assert.match(code, /class="prose-number">30,000<\/span>\./)
    assert.doesNotMatch(code, /prose-number">(?:24\.11\.0|11\.0)/)
    assert.equal(withoutProseHighlights(code), `<p>${source.replace("\n\n", "</p>\n<p>")}</p>`)
})

test("Prose highlights explicit technical vocabulary as whole tokens", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkProse] })
    const vocabulary = "API APIs SDK SDKs JSON HTML XML ESM OAuth OAuth2 URL URLs URI UTF-8 Node.js JavaScript TypeScript WebSocket WebSockets HTTP HTTPS WS WSS REST CLI npm pnpm"
    const { code } = await processor.render(vocabulary)
    for (const term of vocabulary.split(" "))
        assert.match(code, new RegExp(`class="prose-keyword">${escapeRegex(term)}<\\/span>`))
    assert.equal(withoutProseHighlights(code), `<p>${vocabulary}</p>`)
})

test("Prose does not highlight vocabulary inside identifiers", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkProse] })
    const source = "HTMLish privateHTML $HTML #HTML HTML_value Node.jsish npmPackage pnpm_config URLValue v24.11.0"
    const { code } = await processor.render(source)
    assert.doesNotMatch(code, /prose-(?:keyword|constant|number)/)
    assert.equal(code, `<p>${source}</p>`)
})
