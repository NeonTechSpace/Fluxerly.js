import assert from "node:assert/strict"
import test from "node:test"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { rehypeSignatureColors } from "../scripts/signature-colors.js"

test("Syntax colours preserve linked method signatures and multiline return types", async () => {
    const processor = await createMarkdownProcessor({ rehypePlugins: [rehypeSignatureColors] })
    const { code } = await processor.render('> **addRole**(`member`, `roleId`, `options?`): `Effect`\\<`void`, [`GuildOperationFailure`](/failure/)\\>\n\n> `Effect`\\<<br />&#160;&#160;[`Client`](/client/),<br />`Scope` \\| `R`<br />\\>')
    assert.match(code, /href="\/failure\/"/)
    assert.match(code, /href="\/client\/"/)
    assert.match(code, /syntax-token/)
    assert.ok(new Set([...code.matchAll(/color:(#[A-Fa-f0-9]+)/g)].map((match) => match[1])).size >= 3)
    assert.match(code, /addRole<\/span>/)
    assert.match(code, /GuildOperationFailure<\/span>/)
    assert.equal((code.match(/<br/g) ?? []).length, 3)
})

test("Inline types get syntax colours without nesting highlighters in fenced examples", async () => {
    const processor = await createMarkdownProcessor({ rehypePlugins: [rehypeSignatureColors] })
    const { code } = await processor.render('`string | undefined`\n\n```ts\nconst value = 204\n```')
    assert.match(code, /<code><span[^>]+syntax-token/)
    const fenced = code.slice(code.indexOf("<pre"))
    assert.doesNotMatch(fenced, /syntax-token/)
})

test("A return type consisting only of a linked type still receives syntax colours", async () => {
    const processor = await createMarkdownProcessor({ rehypePlugins: [rehypeSignatureColors] })
    const { code } = await processor.render('> [`Client`](/client/)')
    assert.match(code, /<a href="\/client\/"><code><span[^>]+syntax-token[^>]*>Client<\/span><\/code><\/a>/)
})
