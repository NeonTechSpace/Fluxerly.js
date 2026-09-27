import assert from "node:assert/strict"
import test from "node:test"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { remarkProse } from "../scripts/prose.js"
import { find, findAll, hasClass, normalizedText, parseHtml } from "./html.js"

const kinds = ["keyword", "constant", "number"]
const processor = createMarkdownProcessor({ remarkPlugins: [remarkProse] })
async function render(source) {
    return parseHtml((await (await processor).render(source)).code)
}
const highlight = (node) => node.tagName === "span" && kinds.some((kind) => hasClass(node, `prose-${kind}`))
// Rendered sentences per paragraph, independent of serialization and soft-wrap whitespace
const paragraphTexts = (tree) => findAll(tree, "p").map(normalizedText)
const highlights = (tree) => findAll(tree, highlight).map((node) => ({
    kind: kinds.find((kind) => hasClass(node, `prose-${kind}`)),
    text: normalizedText(node),
}))

test("Standalone sentences use source paragraphs with inline formatting intact", async () => {
    const tree = await render("Read guild members\n\nHTTP methods return Effects\n\nKeep `members` and [their roles](/roles/) together\n\nReturned members are frozen. Optional retention follows your settings")
    assert.deepEqual(paragraphTexts(tree), ["Read guild members", "HTTP methods return Effects",
        "Keep members and their roles together", "Returned members are frozen. Optional retention follows your settings"])
    assert.equal(findAll(tree, "br").length, 0)
    const formatted = findAll(tree, "p")[2]
    assert.equal(normalizedText(find(formatted, "code")), "members")
    const link = find(formatted, "a")
    assert.equal(link.properties.href, "/roles/")
    assert.equal(normalizedText(link), "their roles")
})

test("Soft wrapping and explicit hard breaks do not invent paragraph boundaries", async () => {
    const tree = await render("Use the supported runtime.\nJavaScript consumers do not need TypeScript\n\nInvalid snapshots return\nGuildOperationError without retaining the input\n\nA deliberate hard break  \nstill belongs to this paragraph")
    assert.deepEqual(paragraphTexts(tree), ["Use the supported runtime. JavaScript consumers do not need TypeScript",
        "Invalid snapshots return GuildOperationError without retaining the input",
        "A deliberate hard break still belongs to this paragraph"])
    const breaks = findAll(tree, "br")
    assert.equal(breaks.length, 1)
    assert.equal(findAll(findAll(tree, "p")[2], "br").length, 1)
})

test("Structured blocks retain their boundaries and executable or linked text is not rewritten", async () => {
    const tree = await render('> `Effect`<br />`Client`\n>\n> A separate quoted paragraph about HTTP 204\n\n- HTTP reads\n\n  Another paragraph in this list item\n\n| Type | Detail |\n| --- | --- |\n| number | 30,000 ms |\n\n```text\nHTTP 204 MANAGE_ROLES\n```\n\n`HTTP 204 MANAGE_ROLES` and [HTTP 204](/204/)')
    const quote = find(tree, "blockquote")
    const quoted = findAll(quote, "p")
    assert.deepEqual(quoted.map((paragraph) => findAll(paragraph, "code").map(normalizedText)), [["Effect", "Client"], []])
    assert.equal(findAll(quoted[0], "br").length, 1)
    assert.equal(normalizedText(quoted[1]), "A separate quoted paragraph about HTTP 204")
    const items = findAll(tree, "li")
    assert.equal(items.length, 1)
    assert.deepEqual(findAll(items[0], "p").map(normalizedText), ["HTTP reads", "Another paragraph in this list item"])
    assert.equal(findAll(tree, "table").length, 1)
    assert.match(normalizedText(find(tree, "pre")), /HTTP 204 MANAGE_ROLES/)
    const last = findAll(tree, "p").at(-1)
    assert.equal(normalizedText(find(last, "code")), "HTTP 204 MANAGE_ROLES")
    assert.equal(find(last, "a").properties.href, "/204/")
    assert.equal(normalizedText(find(last, "a")), "HTTP 204")
    // Code, links, fences and quotations keep their text unhighlighted
    for (const tag of ["code", "a", "pre", "blockquote"])
        assert.deepEqual(findAll(tree, (node, ancestors) => highlight(node) && ancestors.some((parent) => parent.tagName === tag)), [], tag)
    // Ordinary list and table prose is still highlighted
    assert.deepEqual(highlights(tree), [{ kind: "keyword", text: "HTTP" }, { kind: "number", text: "30,000" }])
})

test("Prose highlights protocols, numeric values and constants without changing its text", async () => {
    const source = ["HTTP 204 requires MANAGE_ROLES, with 30,000 ms and Node 24.11.0", "HTTPS and WSS are supported", "A request is unchanged"]
    const tree = await render(source.join("\n\n"))
    assert.deepEqual(paragraphTexts(tree), source)
    assert.deepEqual(highlights(tree), [
        { kind: "keyword", text: "HTTP" },
        { kind: "number", text: "204" },
        { kind: "constant", text: "MANAGE_ROLES" },
        { kind: "number", text: "30,000" },
        { kind: "number", text: "24.11.0" },
        { kind: "keyword", text: "HTTPS" },
        { kind: "keyword", text: "WSS" },
    ])
    assert.equal(findAll(tree, "em").length, 0)
})

test("Prose highlights numbers before terminal punctuation without matching numeric fragments", async () => {
    const source = ["HTTP 204. A timeout of 30,000. is valid", "v24.11.0 and 24.11.0beta remain unchanged"]
    const tree = await render(source.join("\n\n"))
    assert.deepEqual(paragraphTexts(tree), source)
    assert.deepEqual(highlights(tree), [
        { kind: "keyword", text: "HTTP" },
        { kind: "number", text: "204" },
        { kind: "number", text: "30,000" },
    ])
})

test("Prose highlights explicit technical vocabulary as whole tokens", async () => {
    const vocabulary = "API APIs SDK SDKs JSON HTML XML ESM OAuth OAuth2 URL URLs URI UTF-8 Node.js JavaScript TypeScript WebSocket WebSockets HTTP HTTPS WS WSS REST CLI npm pnpm"
    const tree = await render(vocabulary)
    assert.deepEqual(paragraphTexts(tree), [vocabulary])
    assert.deepEqual(highlights(tree), vocabulary.split(" ").map((text) => ({ kind: "keyword", text })))
})

test("Prose does not highlight vocabulary inside identifiers", async () => {
    const source = "HTMLish privateHTML $HTML #HTML HTML_value Node.jsish npmPackage pnpm_config URLValue v24.11.0"
    const tree = await render(source)
    assert.deepEqual(paragraphTexts(tree), [source])
    assert.deepEqual(highlights(tree), [])
})
