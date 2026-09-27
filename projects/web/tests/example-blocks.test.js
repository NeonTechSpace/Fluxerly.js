import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { exampleVariants, isEffectExample, remarkExampleBlocks, renderExampleBlock } from "../scripts/example-blocks.js"
import { exampleLanguageKey, parseExampleLanguage } from "../src/components/example-preferences.ts"
import { find, findAll, hasClass, parseHtml, textContent } from "./html.js"

test("Canonical TypeScript keeps source intact while JavaScript removes declarations and assertions", () => {
    const source = `import { createClient } from "@neontechspace/fluxerly"
import type { Client } from "@neontechspace/fluxerly"
declare const client: Client
type BotName = string
interface Options { name: BotName }
const name: BotName = "ping"
const created = createClient({ token: "YOUR_BOT_TOKEN" } satisfies { token: string })
const value = created as unknown
await Promise.resolve(value)
console.log(name, { ...created })`
    const variants = exampleVariants(source, "ts")
    assert.equal(variants.ts, source)
    assert.match(variants.js, /import \{ createClient \} from "@neontechspace\/fluxerly"/)
    assert.doesNotMatch(variants.js, /import type|declare const|type BotName|interface Options|satisfies|as unknown|name: BotName/)
    assert.match(variants.js, /await Promise.resolve\(value\)/)
    assert.match(variants.js, /\.\.\.created/)
    assert.match(variants.js, /YOUR_BOT_TOKEN/)
})

test("Type erasure preserves executable results and modern runtime syntax", async () => {
    const source = `type Count = bigint
const value: Count = 2n
const selected = { nested: { value } }?.nested?.value ?? 0n
export const result = await Promise.resolve(selected + 1n)`
    const variants = exampleVariants(source, "typescript")
    const load = (code) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)
    const javascript = await load(variants.js)
    const typescript = await load(stripTypeScriptTypes(variants.ts))
    assert.equal(javascript.result, 3n)
    assert.equal(typescript.result, javascript.result)
    assert.match(variants.js, /\?\.nested\?\.value \?\? 0n/)
})

test("JavaScript examples serve the same untyped source as their TypeScript variant", () => {
    const source = `import { createClient } from "@neontechspace/fluxerly"
const client = createClient({ token: process.env.FLUXER_TOKEN })
await client.connect()`
    for (const language of ["js", "javascript"])
        assert.deepEqual(exampleVariants(source, language), { js: source, ts: source })
})

test("Both variants of the authored pure-helper example execute through the built public SDK", async () => {
    const owner = await readFile(new URL("../../sdk/src/index.ts", import.meta.url), "utf8")
    const source = [...owner.matchAll(/\* ```ts\r?\n([\s\S]*?)\* ```/g)]
        .map((match) => match[1].split(/\r?\n/).map((line) => line.replace(/^ \* ?/, "")).join("\n").trimEnd())
        .find((code) => code.includes("export function pureHelpersExample("))
    assert.ok(source, "The canonical runnable helper example must remain in public source")
    const sdk = new URL("../../sdk/dist/index.js", import.meta.url).href
    const variants = exampleVariants(source, "ts")
    const load = (code) => import(`data:text/javascript;base64,${Buffer.from(code.replaceAll('"@neontechspace/fluxerly"', JSON.stringify(sdk))).toString("base64")}`)
    const javascript = await load(variants.js)
    const typescript = await load(stripTypeScriptTypes(variants.ts))
    const actual = javascript.pureHelpersExample(0n, "Ping!")
    assert.deepEqual(actual, typescript.pureHelpersExample(0n, "Ping!"))
    assert.equal(typeof actual.required, "bigint")
    assert.ok(actual.required > 0n)
    assert.equal(actual.color, 0xff8800)
})

test("Malformed examples fail explicitly without exposing authored literals", () => {
    assert.throws(() => exampleVariants('const secret-value = "private"', "ts"),
        { message: "TypeScript example conversion failed: Invalid syntax" })
    assert.throws(() => exampleVariants("echo secret", "sh"), { message: "Unsupported example language" })
})

test("Static examples are highlighted, escaped and keyboard accessible with a usable JavaScript fallback", async () => {
    // The no-JavaScript browser check covers the hidden copy button and fallback text
    const tree = parseHtml(await renderExampleBlock('const value: string = "<private>"', "ts"))
    const select = find(tree, (node) => node.tagName === "select" && node.properties.dataExampleLanguage !== undefined)
    assert.ok(select.properties.ariaLabel)
    assert.equal(select.properties.disabled, true)
    const variants = Object.fromEntries(findAll(tree, (node) => node.properties.dataExampleVariant !== undefined)
        .map((node) => [node.properties.dataExampleVariant, node]))
    assert.deepEqual(Object.keys(variants).sort(), ["js", "ts"])
    assert.equal(variants.js.properties.hidden, undefined)
    assert.equal(variants.ts.properties.hidden, true)
    for (const [language, variant] of Object.entries(variants)) {
        // Each variant is a highlighted, keyboard-scrollable block whose literal stays text
        const pre = find(variant, "pre")
        assert.ok(hasClass(pre, "astro-code"), language)
        assert.equal(pre.properties.tabIndex, 0, language)
        assert.ok(findAll(pre, "span").length > 1, language)
        assert.match(textContent(pre), /"<private>"/, language)
    }
    assert.match(textContent(variants.ts), /value: string/)
    assert.doesNotMatch(textContent(variants.js), /value: string/)
    assert.deepEqual(findAll(tree, "private"), [])
    assert.equal(find(tree, (node) => node.properties.dataExampleCopyStatus !== undefined).properties.role, "status")
})

test("Remark converts executable JS and TS fences but leaves shell, JSON, text and Effect examples alone", async () => {
    const root = { children: [
        { type: "code", lang: "js", value: "console.log('ping')" },
        { type: "blockquote", children: [{ type: "code", lang: "ts", value: "const value: number = 1" }] },
        ...["sh", "json", "text"].map((lang) => ({ type: "code", lang, value: "unchanged" })),
        { type: "code", lang: "ts", value: 'import { Effect } from "effect"' },
        { type: "code", lang: "ts", value: "interface Options { token: string }" },
        { type: "code", lang: "ts", value: 'import type { Client } from "@neontechspace/fluxerly"\ndeclare const client: Client' },
    ] }
    await remarkExampleBlocks()(root, { path: "content/docs/preview/api/modules/js-ts.md" })
    assert.equal(root.children[0].type, "html")
    assert.equal(root.children[1].children[0].type, "html")
    for (const child of root.children.slice(2)) assert.equal(child.type, "code")
    for (const path of ["content/docs/preview/api/modules/Effect.md", "content/docs/preview/api/interfaces/Effect.Client.md",
        "C:\\docs\\api\\functions\\Effect.createClient.md", "content/docs/preview/api/modules/Effect-testing.md",
        "content/docs/preview/api/interfaces/Effect-testing.TestClient.md"]) {
        assert.equal(isEffectExample("const value: number = 1", path), true)
        const effectRoot = { children: [{ type: "code", lang: "ts", value: "const value: number = 1" }] }
        await remarkExampleBlocks()(effectRoot, { path })
        assert.equal(effectRoot.children[0].type, "code")
    }
    assert.equal(isEffectExample('import { createClient } from "@neontechspace/fluxerly/effect"'), true)
    assert.equal(isEffectExample('import { createClient } from "@neontechspace/fluxerly"'), false)
    assert.equal(isEffectExample('import { createTestClient } from "@neontechspace/fluxerly/effect/testing"'), true)
    // Default testing examples keep the JavaScript option
    assert.equal(isEffectExample('import { createTestClient } from "@neontechspace/fluxerly/testing"'), false)
    assert.equal(isEffectExample("const value: number = 1", "content/docs/preview/api/modules/testing.md"), false)
    assert.equal(isEffectExample("const value: number = 1", "content/docs/preview/api/interfaces/testing.TestClient.md"), false)
})

test("Astro renders both variants as HTML and build errors identify only their owner", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkExampleBlocks] })
    const tree = parseHtml((await processor.render('```ts\nconst value: number = 1\n```')).code)
    const block = find(tree, (node) => node.properties.dataExampleBlock !== undefined)
    assert.ok(block)
    assert.equal(findAll(block, "select").length, 1)
    assert.equal(findAll(block, (node) => node.properties.dataExampleVariant !== undefined).length, 2)
    assert.ok(!textContent(tree).includes("<select"))
    await assert.rejects(() => remarkExampleBlocks()({ children: [
        { type: "code", lang: "ts", value: 'const private-value = "secret"', position: { start: { line: 7 } } },
    ] }, { path: "guide.md" }), { message: "Example rendering failed at guide.md:7" })
})

test("Remembered example language retains only its allowlisted nonsecret choice", () => {
    assert.equal(exampleLanguageKey, "fluxerly.docs.example-language")
    assert.equal(parseExampleLanguage("ts"), "ts")
    for (const value of [null, "js", "typescript", "tsx", "broken", '{"language":"ts"}'])
        assert.equal(parseExampleLanguage(value), "js")
})
