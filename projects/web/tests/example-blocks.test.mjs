import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { exampleVariants, isEffectExample, remarkExampleBlocks, renderExampleBlock } from "../scripts/example-blocks.mjs"
import { exampleLanguageKey, parseExampleLanguage } from "../src/components/example-preferences.ts"

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

test("First-bot JavaScript and inferred TypeScript share ESM setup and use standard extensions", async () => {
    const guide = await readFile(new URL("../content/guides/quick-start.md", import.meta.url), "utf8")
    const source = guide.match(/```js\n([\s\S]*?)\n```/)[1]
    assert.deepEqual(exampleVariants(source, "javascript"), { js: source, ts: source })
    const setup = guide.match(/```json\r?\n([\s\S]*?)\r?\n```/)
    assert.equal(JSON.parse(setup[1]).type, "module")
    assert.ok(guide.indexOf('"type": "module"') < guide.indexOf("{{installation}}"))
    assert.match(guide, /data-example-filename>bot.js/)
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
    assert.ok(actual.required.isOk())
    assert.ok(actual.color.isOk())
    assert.equal(actual.color.value, 0xff8800)
})

test("Malformed examples fail explicitly without exposing authored literals", () => {
    assert.throws(() => exampleVariants('const secret-value = "private"', "ts"),
        { message: "TypeScript example conversion failed: Invalid syntax" })
    assert.throws(() => exampleVariants("echo secret", "sh"), { message: "Unsupported example language" })
})

test("Static examples are highlighted, escaped and keyboard accessible with a usable JavaScript fallback", async () => {
    const html = await renderExampleBlock('const value: string = "<private>"', "ts")
    const select = html.match(/<select\b[^>]*\bdata-example-language\b[^>]*>/)[0]
    assert.match(select, /\baria-label="[^"]+"/)
    assert.match(select, /\bdisabled(?:\s|=|>)/)
    assert.match(html, /data-example-variant="js">/)
    assert.match(html, /data-example-variant="ts" hidden>/)
    assert.match(html, /astro-code/)
    assert.match(html, /tabindex="0"/)
    assert.doesNotMatch(html, /<private>/)
    assert.match(html, /data-example-copy hidden/)
    assert.match(html, /data-example-copy-status role="status"/)
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
    await remarkExampleBlocks()(root, { path: "content/docs/dev/api/modules/js-ts.md" })
    assert.equal(root.children[0].type, "html")
    assert.equal(root.children[1].children[0].type, "html")
    for (const child of root.children.slice(2)) assert.equal(child.type, "code")
    for (const path of ["content/docs/dev/api/modules/Effect.md", "content/docs/dev/api/interfaces/Effect.Client.md",
        "C:\\docs\\api\\functions\\Effect.createClient.md"]) {
        assert.equal(isEffectExample("const value: number = 1", path), true)
        const effectRoot = { children: [{ type: "code", lang: "ts", value: "const value: number = 1" }] }
        await remarkExampleBlocks()(effectRoot, { path })
        assert.equal(effectRoot.children[0].type, "code")
    }
    assert.equal(isEffectExample('import { createClient } from "@neontechspace/fluxerly/effect"'), true)
    assert.equal(isEffectExample('import { createClient } from "@neontechspace/fluxerly"'), false)
})

test("Astro renders both variants as HTML and build errors identify only their owner", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkExampleBlocks] })
    const result = await processor.render('```ts\nconst value: number = 1\n```')
    assert.match(result.code, /data-example-block/)
    assert.doesNotMatch(result.code, /&lt;select/)
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
