// Tests the docs' hover peeks: the index built from the reference model, the code catalogue and the glossary, the
// curated meanings' links to the sections they cite, and the recogniser through the same Markdown pipeline the guides use
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import rehypeCodeBreaks from "../scripts/docs/code-breaks.mjs"
import { gitignoreGrammar } from "../scripts/docs/gitignore-grammar.mjs"
import remarkEntries from "../scripts/docs/remark-entries.mjs"
import remarkGuides from "../scripts/docs/remark-guides.mjs"
import { buildPeek, slug } from "../src/lib/peek-index.ts"
import { closeCodes, httpStatuses, logLevels } from "../src/lib/peek-meanings.ts"
import rehypePeek, { type MarkKind } from "../src/lib/rehype-peek.ts"
import fluxerlyTheme from "../src/styles/shiki-fluxerly.json" with { type: "json" }

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const model = JSON.parse(read("content/reference/model.json"))
const codes = JSON.parse(read("content/reference/codes.json"))
const guides = Object.fromEntries(
    readdirSync(new URL("../content/guides/", import.meta.url))
        .filter((file) => file.endsWith(".md"))
        .map((file) => [file.replace(/\.md$/, ""), read(`content/guides/${file}`)]),
)
const { index, terms } = buildPeek({ model, codes, glossary: guides.glossary!, guideTitles: { logging: "Logging & debugging" } })

// The guides' own pipeline, as astro.config.mjs sets it up
let marks: { kind: MarkKind; key: string; text: string; quiet: boolean }[] = []
const processor = await createMarkdownProcessor({
    shikiConfig: { theme: fluxerlyTheme as never, langs: [gitignoreGrammar as never] },
    remarkPlugins: [remarkGuides, remarkEntries],
    rehypePlugins: [[rehypePeek, { terms, onMark: (mark: (typeof marks)[number]) => marks.push(mark) }], rehypeCodeBreaks],
    smartypants: false,
})

// A reference comment renders without a guide's path, and may name the symbol it documents as self
async function render(markdown: string, page: string | undefined = "messages", self?: string) {
    marks = []
    const fileURL = page ? new URL(`../content/guides/${page}.md`, import.meta.url) : undefined
    const { code } = await processor.render(markdown, { fileURL, frontmatter: self ? { peekSelf: self } : {} })
    // The seams that let long inline code wrap are not what these tests look at
    return { html: code.replaceAll("<wbr>", ""), marks: [...marks] }
}

// A published version's guides sit in a snapshot's own folder, which is where the public site reads them from
const snapshotGuide = (page: string) => new URL(`../.astro/public-x/content/1000.0.0-nightly.1/guides/${page}.md`, import.meta.url)
const hrefOf = (html: string, name: string) => new RegExp(`href="([^"]+)"[^>]*>(?:<code[^>]*>)?${name}\\b`).exec(html)?.[1]

test("a guide in a published version's snapshot looks names up in its own entry point", async () => {
    const { code } = await processor.render("Call `runBot` here", { fileURL: snapshotGuide("effect-first-bot") })
    assert.match(hrefOf(code, "runBot") ?? "", /^\/docs\/api\/effect\//)
})

test("the glossary in a published version's snapshot does not mark its own terms", async () => {
    marks = []
    await processor.render(guides.glossary!, { fileURL: snapshotGuide("glossary") })
    assert.deepEqual(marks.filter((mark) => mark.kind === "term"), [])
})

test("a reference comment looks names up in its page's entry point first", async () => {
    const lookUp = async (entry?: string) => hrefOf((await processor.render("Call `runBot` here", { frontmatter: entry ? { peekEntry: entry } : {} })).code, "runBot") ?? ""
    assert.match(await lookUp("effect"), /^\/docs\/api\/effect\//)
    assert.match(await lookUp(), /^\/docs\/api\/js-ts\//)
})

test("a declaration's peek shows its signature with type names as links, and its summary's first sentence", () => {
    const commands = index.entries["/docs/api/js-ts/commands/#commands"]
    assert.ok(commands)
    assert.match(commands.t, /^<span class="ty-k">const <\/span><span class="ty-n">commands<\/span>: <a class="ty-t" href="\/docs\/api\/js-ts\/commands\/#[\w-]+">\w+<\/a>$/)
    assert.equal(commands.k, "Constant")
    assert.ok(commands.d && !commands.d.endsWith("."))
})

test("signatures fit the card in at most three lines", () => {
    for (const [key, entry] of Object.entries(index.entries)) if (!entry.f) assert.ok(entry.t.split("\n").length <= 3, key)
})

test("an option names the options interface it belongs to", () => {
    const sharding = index.entries["/docs/api/js-ts/options/#clientoptions-sharding"]
    assert.equal(sharding?.k, "Option of ClientOptions")
    assert.match(sharding!.t, /^<span class="ty-n">sharding<\/span>\?: /)
})

test("an error code of a family carries its reason's meaning and links to the family", () => {
    const rejected = index.entries["code:message.send.rejected"]
    assert.equal(rejected?.p, "/docs/codes/#error-message-send-reason")
    assert.match(rejected!.x!, /^<span class="peek-x-label">rejected<\/span> Fluxer refused the request/)
    assert.ok(index.entries["/docs/codes/#log-lifecycle-connectionended"]?.lv?.length)
})

// Only the cited sections are checked. Their wording is reviewed, not frozen, so rewording a guide passes
test("every curated meaning cites a guide heading, reference declaration or codes reason that exists", () => {
    for (const meaning of [...httpStatuses, ...closeCodes, ...logLevels])
        for (const source of meaning.sources) {
            if ("guide" in source) {
                const guide = guides[source.guide]
                assert.ok(guide, `${meaning.key} cites a missing guide ${source.guide}`)
                const anchors = [...guide.matchAll(/^#{2,3} +(.+)$/gm)].map((heading) => slug(heading[1]!))
                if (source.anchor) assert.ok(anchors.includes(source.anchor), `${meaning.key}: ${source.guide} has no heading #${source.anchor}`)
            } else if ("codes" in source) {
                const anchors = codes.reasons.map((reason: { reason: string }) => `reason-${reason.reason.toLowerCase()}`)
                assert.ok(anchors.includes(source.codes), `${meaning.key}: the codes page has no reason #${source.codes}`)
            } else {
                const [name, member] = source.api.split(".")
                const node = terms.declarations.get(name!)?.get(terms.entries[0]!)
                assert.ok(member ? node?.members.get(member) : node, `${meaning.key}: the reference has no ${source.api}`)
            }
        }
})

// A request other than GET may opt into GET's retries. Unnamed, a reader takes it for one that is never sent again
test("every request that retries like a GET is named in the retry rule and the 5xx peek", () => {
    const sdk = new URL("../../sdk/src/", import.meta.url)
    // The SDK function that builds the request, and the public method that sends it
    const publicName: Record<string, string> = { threadPostData: "threads.fetchPostData" }
    const rule = guides.reliability!.split(/\n\s*\n/).find((paragraph) => paragraph.includes("is retried at most twice"))
    assert.ok(rule, "the reliability guide has no retry rule")
    const peek = httpStatuses.find((meaning) => meaning.status === 503)!.meaning
    const files = readdirSync(sdk, { recursive: true }).filter((file) => String(file).endsWith(".ts"))
    let seen = 0
    for (const file of files) {
        const source = readFileSync(new URL(String(file), sdk), "utf8")
        for (const match of source.matchAll(/retryRead: true/g)) {
            seen++
            const builder = [...source.slice(0, match.index).matchAll(/function (\w+)/g)].at(-1)?.[1]
            const name = publicName[builder!]
            assert.ok(name, `${file}: ${builder} retries like a GET. Name its public method in the reliability guide's retry rule and here`)
            assert.ok(rule.includes(name), `the reliability guide's retry rule does not name ${name}`)
            assert.ok(peek.includes(name), `the 5xx peek does not name ${name}`)
        }
    }
    assert.ok(seen > 0, "no request in the SDK retries like a GET, so this list is out of date")
})

test("a name is marked in full at its first mention in a section, and quietly after that", async () => {
    const { html, marks } = await render("Call `runBot` to start. Then `runBot` stops on a signal\n\n## Later\n\nAgain `runBot`")
    assert.deepEqual(
        marks.map((mark) => [mark.text, mark.quiet]),
        [["runBot", false], ["runBot", true], ["runBot", false]],
    )
    assert.match(html, /<a class="peek peek-api" href="\/docs\/api\/js-ts\/[\w-]+\/#runbot"><code>runBot<\/code><\/a> to start\. Then <a class="peek peek-api peek-quiet" href="[^"]+" tabindex="-1"><code>runBot<\/code><\/a>/)
})

test("example code, headings and existing links stay as they are", async () => {
    const { html, marks } = await render("## Use `runBot` with HTTP 429\n\n```js\nrunBot({ token })\n```\n\nSee [`runBot`](/docs/api/js-ts/client-and-lifecycle/#runbot) and the [shard](/docs/glossary/#shard) guide")
    assert.deepEqual(marks, [])
    assert.match(html, /<h2[^>]*>Use <code>runBot<\/code> with HTTP 429<\/h2>/)
})

test("an existing link counts as the full first mention of what it points to", async () => {
    const { marks } = await render("A [shard](/docs/glossary/#shard) carries data, and each shard keeps a session")
    assert.deepEqual(
        marks.map((mark) => [mark.text, mark.quiet]),
        [["shard", true], ["session", false]],
    )
})

test("HTTP statuses and close codes become chips that peek their meaning", async () => {
    const { html, marks } = await render("Fluxer answers HTTP 401 or 403, and a 404 response\n\nThe connection ends with close 4004, or 4011 when Fluxer closes it")
    assert.deepEqual(
        marks.map((mark) => mark.key),
        ["http-401", "http-403", "http-404", "close-4004", "close-4011"],
    )
    assert.match(html, /HTTP <a class="peek peek-code" href="\/docs\/troubleshooting\/#a-webhook-or-oauth-call-fails-with-http-401" data-peek="http-401"><code>401<\/code><\/a> or/)
})

test("every HTTP 400 shares one card, so it links to reading the error rather than to one cause", async () => {
    // Discovery that is turned off is one of several causes that have nothing to do with two-factor authentication
    const { html, marks } = await render("Searching fails with HTTP 400 and details.providerCode `DISCOVERY_DISABLED`")
    assert.deepEqual(marks.filter((mark) => mark.kind === "code").map((mark) => mark.key), ["http-400"])
    assert.match(html, /href="\/docs\/reliability\/#read-an-sdk-error" data-peek="http-400"/)
})

test("a bare four-digit number is a close code only where the paragraph speaks of closing", async () => {
    assert.deepEqual((await render("Up to 4011 messages are kept")).marks, [])
    assert.deepEqual((await render("A child's connection was closed with 4011")).marks.map((mark) => mark.key), ["close-4011"])
})

test("log levels are tags where the word names the level, not where it opens a sentence", async () => {
    const { html, marks } = await render("Waits are logged at Warn, and failures at Error\n\nError handling is separate. Debug records stay off")
    assert.deepEqual(
        marks.map((mark) => mark.key),
        ["level-warn", "level-error", "level-debug"],
    )
    assert.match(html, /<a class="peek peek-level" href="\/docs\/logging\/#choose-levels-and-categories" data-peek="level-warn" data-level="warn">Warn<\/a>/)
})

test("a glossary term is marked in full once a page, quietly after that, and not on the glossary", async () => {
    const text = "A shard carries events\n\n## Next\n\nAnother shard joins"
    for (const page of ["messages", "sharding"])
        assert.deepEqual(
            (await render(text, page)).marks.map((mark) => [mark.text, mark.quiet]),
            [["shard", false], ["events", false], ["shard", true]],
        )
    assert.deepEqual((await render(text, "glossary")).marks, [])
})

test("a name that is also an ordinary word is a glossary term only where it is the name", async () => {
    const { marks } = await render("Identify each copy by its ID\n\nThe bot sends Identify when it logs in")
    assert.deepEqual(
        marks.filter((mark) => mark.kind === "term").map((mark) => mark.text),
        ["ID", "Identify"],
    )
})

test("every occurrence is marked, however many a paragraph holds, and levels and status codes always in full", async () => {
    const { marks } = await render("A shard with `runBot`, `createClient`, `describeError` and HTTP 429 logs at Warn, then HTTP 429 again at Warn")
    assert.deepEqual(
        marks.map((mark) => [mark.text, mark.quiet]),
        [["shard", false], ["runBot", false], ["createClient", false], ["describeError", false], ["429", false], ["Warn", false], ["429", false], ["Warn", false]],
    )
})

test("a lone lowercase word is an option only where the sentence makes it one", async () => {
    const plain = await render("The categories are `rest`, `cache` and `format`")
    assert.deepEqual(plain.marks, [])
    const option = await render("Enable it with the client's `cache` option, or set `sharding: \"auto\"`")
    assert.deepEqual(
        option.marks.map((mark) => mark.key),
        ["/docs/api/js-ts/options/#clientoptions-cache", "/docs/api/js-ts/options/#clientoptions-sharding"],
    )
})

test("a parameter name is not a property of a parameter that is not an options object", async () => {
    const { marks } = await render("Fetch one community member by decimal `guildId` and `userId`", undefined)
    assert.deepEqual(marks.filter((mark) => mark.kind === "api"), [])
})

test("dotted paths follow the client, its parts and a namespace's type", async () => {
    const { marks } = await render("Register with `client.on`, read with `members.fetch` and check `errors.isRetryable(error)`")
    assert.deepEqual(
        marks.map((mark) => mark.key),
        ["/docs/api/js-ts/client/#on", "/docs/api/js-ts/guilds-and-members/#members-fetch", "/docs/api/js-ts/errors/#errortools-isretryable"],
    )
})

test("the word after a code decides between a method and a log record", async () => {
    assert.deepEqual((await render("The `gateway.send` record")).marks.map((mark) => mark.kind), ["code"])
    assert.deepEqual((await render("The `gateway.send` method")).marks.map((mark) => mark.kind), ["api"])
})

test("Effect guides look names up in the Effect entry point first", async () => {
    const native = await render("Start with `runBot`")
    const effect = await render("Start with `runBot`", "effect-first-bot")
    assert.match(native.marks[0]!.key, /^\/docs\/api\/js-ts\//)
    assert.match(effect.marks[0]!.key, /^\/docs\/api\/effect\//)
})

test("the entries a table of sentences becomes are marked like prose, but not their column labels", async () => {
    const table = [
        "| Record code | What it means | What to do |",
        "| --- | --- | --- |",
        "| `lifecycle.connectionEnded` with close 4004 | Fluxer rejected the bot token, so the gateway connection ended for good and will not come back | Check the token, then start the bot again with `runBot` and watch the next record |",
    ].join("\n")
    const { html, marks } = await render(table)
    assert.match(html, /<dt class="entry-term"><a class="peek peek-code" href="\/docs\/codes\/#log-lifecycle-connectionended"><code class="record">/)
    assert.doesNotMatch(html, /<span class="entry-label">[^<]*<a /)
    assert.deepEqual(
        marks.map((mark) => mark.text),
        ["lifecycle.connectionEnded", "4004", "gateway", "runBot"],
    )
})

test("a reference comment does not mark the symbol it documents", async () => {
    const own = "/docs/api/js-ts/client-and-lifecycle/#createclient"
    assert.deepEqual((await render("Use `createClient` or `runBot`", undefined, own)).marks.map((mark) => mark.text), ["runBot"])
    assert.deepEqual((await render("Use `createClient` or `runBot`", undefined)).marks.map((mark) => mark.text), ["createClient", "runBot"])
})

test("a reference comment is its own section, and its glossary terms are quiet", async () => {
    const comment = await createMarkdownProcessor({ remarkPlugins: [remarkGuides], rehypePlugins: [[rehypePeek, { terms, comment: true }]], smartypants: false })
    const { code } = await comment.render("Each shard of `runBot` keeps a session")
    assert.match(code, /<a class="peek peek-term peek-quiet" href="\/docs\/glossary\/#shard" tabindex="-1">shard<\/a>/)
    assert.match(code, /<a class="peek peek-api" href="[^"]+#runbot">/)
})

test("every mark in every guide has a peek in the index", async () => {
    let total = 0
    for (const [page, source] of Object.entries(guides)) {
        const { marks } = await render(source.replace(/^---[\s\S]*?\n---\n/, ""), page)
        for (const mark of marks) assert.ok(index.entries[mark.key], `${page}: ${mark.text} has no peek ${mark.key}`)
        total += marks.length
    }
    assert.ok(total > 300)
})
