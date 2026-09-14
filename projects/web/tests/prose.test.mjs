import assert from "node:assert/strict"
import test from "node:test"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { remarkProse } from "../scripts/prose.mjs"

test("Standalone sentences use source paragraphs with inline formatting intact", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkProse] })
    const { code } = await processor.render("Read guild members\n\nHTTP methods return Effects\n\nKeep `members` and [their roles](/roles/) together\n\nReturned members are frozen. Optional retention follows your settings")
    assert.equal((code.match(/<p>/g) ?? []).length, 4)
    assert.doesNotMatch(code, /<br/)
    assert.match(code, /<code>members<\/code> and <a href="\/roles\/">their roles<\/a> together<\/p>/)
    assert.match(code, /<p>Returned members are frozen\. Optional retention follows your settings<\/p>/)
})

test("Soft wrapping and explicit hard breaks do not invent paragraph boundaries", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkProse] })
    const { code } = await processor.render("Use the supported runtime.\nJavaScript consumers do not need TypeScript\n\nInvalid snapshots return\nGuildOperationError without retaining the input\n\nA deliberate hard break  \nstill belongs to this paragraph")
    assert.equal((code.match(/<p>/g) ?? []).length, 3)
    assert.match(code, /<p>Use the supported runtime\.\nJavaScript consumers do not need TypeScript<\/p>/)
    assert.match(code, /<p>Invalid snapshots return\nGuildOperationError without retaining the input<\/p>/)
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
    assert.match(code, /class="prose-keyword">HTTP<\/span>/)
    assert.match(code, /class="prose-constant">MANAGE_ROLES<\/span>/)
    for (const number of ["204", "30,000", "24.11.0"]) assert.ok(code.includes(`class="prose-number">${number}</span>`))
    assert.match(code, /<p>A request is unchanged<\/p>/)
    assert.doesNotMatch(code, /<em>/)
})
