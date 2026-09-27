import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { entryPreference, importsOnlyEffect, inlineLinkLimit, pageContext, readReferenceIndex, remarkReferenceLinks, resolveInlineCode } from "../scripts/reference-links.js"
import { analyzeCode, rehypeReferenceCode, tokenUrl, wrapRanges } from "../scripts/reference-code.js"
import { renderExampleBlock } from "../scripts/example-blocks.js"
import { find, findAll, hasClass, parseHtml, textContent } from "./html.js"

// A generated reference in the shape TypeDoc writes it, for a docs version that no real snapshot uses
const base = "/docs/9.9.9/api"
const reference = {
    "modules/js-ts.md": `## Client and lifecycle

### Type Aliases

<a id="formathelpers"></a>

#### FormatHelpers

> **FormatHelpers** = \`Readonly\`\\<\\{ \`userMention\`: \`string\`; \\}\\>

### Functions

<a id="runbot"></a>

#### runBot()

> **runBot**(\`options\`): \`void\`

Start a bot

<a id="sleep"></a>

#### sleep()

> **sleep**(): \`void\`

Wait

### Variables

<a id="errors"></a>

#### errors

> \`const\` **errors**: [\`ErrorTools\`](${base}/interfaces/js-ts.ErrorTools/)

Error helpers

<a id="commands"></a>

#### commands

> \`const\` **commands**: \`object\`

Command helpers

<a id="format"></a>

#### format

> \`const\` **format**: [\`FormatHelpers\`](${base}/modules/js-ts/#formathelpers)

Markup helpers
`,
    "modules/Effect.md": `### References

<a id="errors"></a>

#### errors

Re-exports [errors](${base}/modules/js-ts/#errors)

### Functions

<a id="runbot"></a>

#### runBot()

> **runBot**(\`options\`): \`Effect\`
`,
    "modules/testing.md": `### Functions

<a id="createtestclient"></a>

#### createTestClient()

> **createTestClient**(): \`TestClient\`
`,
    "modules/Effect-testing.md": `### Functions

<a id="createtestclient"></a>

#### createTestClient()

> **createTestClient**(): \`TestClient\`
`,
    "interfaces/js-ts.ErrorTools.md": `## Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="apicode"></a> \`apiCode\` | \`readonly\` | (\`error\`) => \`string\` | The error code |
`,
    "interfaces/js-ts.Client.md": `## Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="messages"></a> \`messages\` | \`readonly\` | [\`Messages\`](${base}/interfaces/js-ts.Messages/)\\<\`M\`\\> | Messages |
| <a id="cache"></a> \`cache?\` | \`readonly\` | \`object\` | Cache |
`,
    "interfaces/js-ts.Messages.md": `## Methods

<a id="send"></a>

### send()

> **send**(\`channelId\`): \`void\`

Send a message
`,
    "interfaces/Effect.Client.md": `## Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="messages"></a> \`messages\` | \`readonly\` | [\`Messages\`](${base}/interfaces/Effect.Messages/) | Messages |
`,
    "interfaces/Effect.Messages.md": `## Methods

<a id="send"></a>

### send()

> **send**(\`channelId\`): \`Effect\`
`,
}

let root
let index
test.before(async () => {
    root = await mkdtemp(join(tmpdir(), "reference-links-"))
    for (const [path, content] of Object.entries(reference)) {
        const target = join(root, "content/docs/9.9.9/api", path)
        await mkdir(join(target, ".."), { recursive: true })
        await writeFile(target, content)
    }
    index = await readReferenceIndex(join(root, "content/docs/9.9.9/api"), base)
})
test.after(() => rm(root, { recursive: true, force: true }))

const defaultApi = entryPreference(undefined, false)
const effectApi = entryPreference(undefined, true)

test("Inline code links public functions, variables, namespace members and member chains of the page's API", () => {
    assert.equal(resolveInlineCode(index, "runBot", defaultApi), `${base}/modules/js-ts/#runbot`)
    assert.equal(resolveInlineCode(index, "runBot()", defaultApi), `${base}/modules/js-ts/#runbot`)
    assert.equal(resolveInlineCode(index, "runBot", effectApi), `${base}/modules/Effect/#runbot`)
    assert.equal(resolveInlineCode(index, "errors.apiCode", defaultApi), `${base}/interfaces/js-ts.ErrorTools/#apicode`)
    // A re-export resolves members through the symbol it re-exports
    assert.equal(resolveInlineCode(index, "errors.apiCode", effectApi), `${base}/interfaces/js-ts.ErrorTools/#apicode`)
    assert.equal(resolveInlineCode(index, "client.messages.send", defaultApi), `${base}/interfaces/js-ts.Messages/#send`)
    assert.equal(resolveInlineCode(index, "client.messages.send", effectApi), `${base}/interfaces/Effect.Messages/#send`)
    assert.equal(resolveInlineCode(index, "Client.cache", defaultApi), `${base}/interfaces/js-ts.Client/#cache`)
    assert.equal(resolveInlineCode(index, "ErrorTools", defaultApi), `${base}/interfaces/js-ts.ErrorTools/`)
    assert.equal(resolveInlineCode(index, "sleep()", defaultApi), `${base}/modules/js-ts/#sleep`)
})

test("Inline code that is not exactly one unambiguous public name stays plain", () => {
    for (const code of [
        "errors.apiCode(result.error)", // A call with arguments is an expression, not a name
        "errors", "commands", "format", "sleep", // Lowercase words are ordinary words unless called as a function
        "commands()", // A variable written as a call names another API's method
        "client", "client.missing", "format.userMention", // Conventional roots and members without anchors
        "Unknown", "--token", "undefined",
    ]) assert.equal(resolveInlineCode(index, code, defaultApi), undefined, code)
    // The default API has no createTestClient. It exists in both testing entry points, so it is ambiguous there
    assert.equal(resolveInlineCode(index, "createTestClient", ["js-ts"]), undefined)
    assert.equal(resolveInlineCode(index, "createTestClient", defaultApi), `${base}/modules/testing/#createtestclient`)
})

test("Page context selects the version and API, with Effect for pages whose examples import only the Effect API", () => {
    const guide = pageContext(`${root}/content/docs/9.9.9/messages.md`)
    assert.equal(guide.version, "9.9.9")
    assert.equal(guide.url, "/docs/9.9.9/messages/")
    assert.equal(guide.entry, undefined)
    assert.equal(pageContext(`${root}/content/docs/9.9.9/api/interfaces/Effect.Client.md`).entry, "Effect")
    assert.equal(pageContext(`${root}/content/docs/9.9.9/api/modules/Effect-testing.md`).entry, "Effect-testing")
    assert.equal(pageContext(`${root}/content/guides/messages.md`), undefined)
    assert.equal(importsOnlyEffect(['import { runBot } from "@neontechspace/fluxerly/effect"']), true)
    assert.equal(importsOnlyEffect(['import { runBot } from "@neontechspace/fluxerly/effect"', 'import { runBot } from "@neontechspace/fluxerly"']), false)
    assert.equal(importsOnlyEffect(["const value = 1"]), false)
})

async function renderPage(page, markdown) {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkReferenceLinks] })
    return parseHtml((await processor.render(markdown, { fileURL: join(root, "content/docs/9.9.9", page) })).code)
}

test("Guides link inline code but never inside headings or authored links, and stay below the page limit", async () => {
    const tree = await renderPage("guide.md", `## Use \`runBot\`

Start with \`runBot\` or [\`runBot\`](https://example.com), then check \`errors.apiCode\`.

${Array.from({ length: inlineLinkLimit + 5 }, () => "`runBot`").join(" ")}
`)
    assert.equal(findAll(find(tree, "h2"), "a").length, 0)
    const links = findAll(tree, (node) => node.tagName === "a" && node.properties.dataReferenceLink !== undefined)
    assert.equal(links.length, inlineLinkLimit)
    assert.equal(links[0].properties.href, `${base}/modules/js-ts/#runbot`)
    assert.equal(links[1].properties.href, `${base}/interfaces/js-ts.ErrorTools/#apicode`)
    assert.equal(findAll(tree, (node) => node.tagName === "a" && node.properties.href === "https://example.com").length, 1)
})

test("Reference pages link to their own API, skip signatures and do not link a page to itself", async () => {
    const tree = await renderPage("api/interfaces/Effect.Client.md", "> **send**(`runBot`): `Client`\n\nUse `runBot` with a `Client`, see `client.messages.send`\n")
    const targets = findAll(tree, "a").map((node) => node.properties.href)
    assert.deepEqual(targets, [`${base}/modules/Effect/#runbot`, `${base}/interfaces/Effect.Messages/#send`])
})

// Code tokens resolve through the TypeScript checker against the built SDK declarations
const bot = `import { runBot, errors, createClient } from "@neontechspace/fluxerly"
const client = createClient({ token: "x" })
const sent = await client.messages.send("1", "hi")
if (sent.isErr()) errors.apiCode(sent.error)
await runBot({ token: "x", commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong!") } } } })`

function linked(source, language, preference = ["js-ts", "testing"]) {
    return analyzeCode(source, language).map((token) => [source.slice(token.start, token.end), tokenUrl(index, token, preference)])
}

test("Code identifiers resolve imports, member chains and destructured context members, but not local names", () => {
    for (const language of ["ts", "js"]) {
        const tokens = linked(bot, language)
        const url = (name) => tokens.find(([text, target]) => text === name && target)?.[1]
        assert.equal(url("runBot"), `${base}/modules/js-ts/#runbot`, language)
        assert.equal(url("messages"), `${base}/interfaces/js-ts.Client/#messages`, language)
        assert.equal(url("send"), `${base}/interfaces/js-ts.Messages/#send`, language)
        assert.equal(url("apiCode"), `${base}/interfaces/js-ts.ErrorTools/#apicode`, language)
        // The destructured reply and its call both name the command context member, which this fixture has no page for
        assert.ok(tokens.filter(([text]) => text === "reply").length === 2, language)
        assert.equal(url("reply"), undefined, language)
        // Local variables and unrelated names are not public API
        for (const local of ["client", "sent", "isErr", "ping", "x"]) assert.equal(url(local), undefined, `${language} ${local}`)
    }
    assert.deepEqual(linked("const value = 1", "ts"), [])
    assert.deepEqual(analyzeCode("echo runBot", "sh"), [])
})

test("Code in the Effect API resolves to the Effect reference", () => {
    const tokens = linked(`import { Effect } from "effect"
import { runBot } from "@neontechspace/fluxerly/effect"
Effect.runPromise(runBot({ token: "x" }))`, "ts", ["Effect", "Effect-testing", "js-ts", "testing"])
    assert.deepEqual(tokens.filter(([, url]) => url).map(([text, url]) => [text, url]).filter(([text]) => text === "runBot"),
        [["runBot", `${base}/modules/Effect/#runbot`], ["runBot", `${base}/modules/Effect/#runbot`]])
})

test("Wrapping code tokens keeps the highlighted text and splits only the covered token", () => {
    const code = { type: "element", tagName: "code", children: [
        { type: "element", tagName: "span", properties: { style: "color:red" }, children: [{ type: "text", value: "client." }] },
        { type: "element", tagName: "span", properties: {}, children: [{ type: "text", value: "messages" }] },
    ] }
    wrapRanges(code, [{ start: 7, end: 15, url: "/m" }, { start: 0, end: 3, url: "/partial" }])
    assert.equal(textContent(code), "client.messages")
    const tokens = findAll({ children: [code] }, (node) => hasClass(node, "reference-token"))
    assert.deepEqual(tokens.map((node) => [textContent(node), node.properties.dataReference]), [["cli", "/partial"], ["messages", "/m"]])
})

test("Highlighted code blocks and both example variants carry reference tokens without changing their text", async () => {
    const processor = await createMarkdownProcessor({ rehypePlugins: [rehypeReferenceCode] })
    const page = join(root, "content/docs/9.9.9/guide.md")
    const block = parseHtml((await processor.render(`\`\`\`ts\n${bot}\n\`\`\``, { fileURL: page })).code)
    assert.equal(textContent(find(block, "code")), bot)
    assert.ok(findAll(block, (node) => node.properties.dataReference === `${base}/interfaces/js-ts.Messages/#send`).length)
    const example = parseHtml(await renderExampleBlock(bot, "ts", page))
    for (const variant of findAll(example, (node) => node.properties.dataExampleVariant !== undefined)) {
        const tokens = findAll(variant, (node) => hasClass(node, "reference-token"))
        assert.ok(tokens.some((node) => node.properties.dataReference === `${base}/modules/js-ts/#runbot`), variant.properties.dataExampleVariant)
        // Tokens are not links or tab stops
        assert.ok(tokens.every((node) => node.tagName === "span" && node.properties.tabIndex === undefined))
    }
    // Examples rendered outside generated docs stay unlinked
    assert.equal(findAll(parseHtml(await renderExampleBlock(bot, "ts")), (node) => hasClass(node, "reference-token")).length, 0)
})
