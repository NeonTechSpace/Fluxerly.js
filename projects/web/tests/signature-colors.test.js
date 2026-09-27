import assert from "node:assert/strict"
import test from "node:test"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { rehypeSignatureColors } from "../scripts/signature-colors.js"
import { find, findAll, hasClass, parseHtml, textContent } from "./html.js"

const processor = createMarkdownProcessor({ rehypePlugins: [rehypeSignatureColors] })
const render = async (source) => parseHtml((await (await processor).render(source)).code)
const isToken = (node) => node.tagName === "span" && hasClass(node, "syntax-token")
const colour = (node) => /(?:^|;)color:(#[A-Fa-f0-9]+)/.exec(node.properties.style ?? "")?.[1]

test("Syntax colours preserve linked method signatures and multiline return types", async () => {
    const tree = await render('> **addRole**(`member`, `roleId`, `options?`): `Effect`\\<`void`, [`GuildOperationFailure`](/failure/)\\>\n\n> `Effect`\\<<br />&#160;&#160;[`Client`](/client/),<br />`Scope` \\| `R`<br />\\>')
    const [method, returned] = findAll(tree, "blockquote").map((quote) => find(quote, "p"))
    // Colouring wraps existing text without changing it or dropping links and breaks
    assert.equal(textContent(method), "addRole(member, roleId, options?): Effect<void, GuildOperationFailure>")
    assert.equal(textContent(returned).replace(/\s+/g, ""), "Effect<Client,Scope|R>")
    assert.deepEqual(findAll(tree, "a").map((link) => link.properties.href), ["/failure/", "/client/"])
    assert.equal(findAll(returned, "br").length, 3)
    const tokens = findAll(tree, isToken)
    assert.ok(new Set(tokens.map(colour).filter(Boolean)).size >= 3)
    for (const name of ["addRole", "GuildOperationFailure", "Client"])
        assert.ok(tokens.some((token) => textContent(token) === name), name)
    assert.ok(isToken(find(find(tree, "a"), "code").children[0]))
})

test("Inline types get syntax colours without nesting highlighters in fenced examples", async () => {
    const tree = await render('`string | undefined`\n\n```ts\nconst value = 204\n```')
    const inline = find(tree, (node, ancestors) => node.tagName === "code" && !ancestors.some((parent) => parent.tagName === "pre"))
    assert.ok(isToken(inline.children[0]))
    assert.equal(textContent(inline), "string | undefined")
    assert.deepEqual(findAll(find(tree, "pre"), isToken), [])
})

test("A return type consisting only of a linked type still receives syntax colours", async () => {
    const tree = await render('> [`Client`](/client/)')
    const link = find(tree, "a")
    assert.equal(link.properties.href, "/client/")
    const token = find(find(link, "code"), isToken)
    assert.equal(textContent(token), "Client")
    assert.ok(colour(token))
})
