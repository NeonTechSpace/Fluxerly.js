import assert from "node:assert/strict"
import test from "node:test"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { commandVariant, escapeHtml, remarkCommandBlocks, renderCommandBlock, validateCommand } from "../scripts/command-blocks.js"
import { commandPreferencesKey, parseCommandPreferences } from "../src/components/command-preferences.ts"
import { authoredGuides } from "../scripts/generate.js"

const install = { kind: "install", package: "@neontechspace/fluxerly", version: "1000.0.0-rc.2" }
const managers = ["npm", "pnpm"]

test("Authored guide command blocks render with supported metadata", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkCommandBlocks] })
    for (const guide of await authoredGuides()) {
        const content = guide.content.replaceAll("{{effect-version}}", "4.0.0-rc.117")
        await assert.doesNotReject(() => processor.render(content), guide.slug)
    }
})

test("SDK install variants retain the exact selected release", () => {
    assert.deepEqual(managers.map((manager) => commandVariant(install, manager).command), [
        "npm install @neontechspace/fluxerly@1000.0.0-rc.2",
        "pnpm add @neontechspace/fluxerly@1000.0.0-rc.2",
    ])
    assert.equal(commandVariant(install).note, "")
    assert.equal(commandVariant(install, "pnpm").note, "")
})

test("Effect add and list use the chosen manager, while node execution follows the example language", () => {
    for (const manager of managers) {
        assert.equal(commandVariant({ kind: "add", package: "effect", version: "4.0.0-rc.29" }, manager).command,
            `${manager === "npm" ? "npm install" : "pnpm add"} --save-exact effect@4.0.0-rc.29`)
        assert.equal(commandVariant({ kind: "list", package: "effect" }, manager).command, `${manager} list effect`)
        assert.deepEqual(commandVariant({ kind: "run", command: "node bot.js" }, manager),
            { command: "node bot.js", note: "" })
        assert.deepEqual(commandVariant({ kind: "run", command: "node bot.js" }, manager, "ts"),
            { command: "node bot.ts", note: "" })
    }
})

test("Invalid command metadata fails closed without exposing input", () => {
    for (const value of [null, [], {}, { ...install, version: "latest" }, { ...install, version: "dev" }, { ...install, version: "0.0.0" },
        { ...install, version: "1.0.0; secret-value" }, { ...install, package: "other" }, { ...install, token: "secret-value" },
        { kind: "run", command: "echo secret-value" }, { kind: "add", package: "effect", version: "4.0.0-rc.01" },
        { kind: "list", package: "effect", version: "4.0.0" }]) {
        assert.throws(() => validateCommand(value), { message: "Invalid command metadata" })
    }
    assert.throws(() => commandVariant(install, "yarn"), { message: "Invalid command preference" })
    assert.throws(() => commandVariant(install, "npm", "tsx"), { message: "Invalid command preference" })
    assert.throws(() => remarkCommandBlocks()({ children: [{ type: "code", lang: "command", value: "secret-value" }] }),
        { message: "Invalid command metadata" })
})

test("Static widgets use native labeled inert controls and escaped metadata", () => {
    assert.equal(escapeHtml('<&>"\''), "&lt;&amp;&gt;&quot;&#39;")
    const html = renderCommandBlock(install)
    const metadata = html.match(/data-command="([^"]+)"/)[1].replaceAll("&quot;", '"')
    assert.deepEqual(JSON.parse(metadata), install)
    const selects = html.match(/<select\b[^>]*>/g)
    assert.equal(selects.length, 1)
    assert.match(selects[0], /data-command-preference="manager"/)
    assert.match(selects[0], /\baria-label="Package manager"/)
    assert.match(selects[0], /\bdisabled(?:\s|=|>)/)
    assert.match(html, /<pre tabindex="0">/)
    assert.match(html, /<code data-command-code>npm install @neontechspace\/fluxerly@1000\.0\.0-rc\.2<\/code>/)
    assert.match(html, /data-command-copy hidden/)
    assert.match(html, /data-command-copy-status role="status"/)
    assert.match(html, /data-command-fallback>[^<]+</)
    const root = { children: [{ type: "blockquote", children: [
        { type: "code", lang: "command", value: JSON.stringify(install) },
        { type: "code", lang: "js", value: "console.log('unchanged')" },
    ] }] }
    remarkCommandBlocks()(root)
    assert.equal(root.children[0].children[0].type, "html")
    assert.deepEqual(root.children[0].children[1], { type: "code", lang: "js", value: "console.log('unchanged')" })
})

test("Astro Markdown renders the widget as static HTML rather than a highlighted JSON fence", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkCommandBlocks] })
    const result = await processor.render(`\`\`\`command\n${JSON.stringify(install)}\n\`\`\``)
    assert.match(result.code, /<div class="command-block"/)
    assert.match(result.code, /npm install @neontechspace\/fluxerly@1000\.0\.0-rc\.2/)
    assert.doesNotMatch(result.code, /language-command|&lt;select/)
})

test("Stored preferences retain the package manager while ignoring unrelated fields", () => {
    assert.equal(commandPreferencesKey, "fluxerly.docs.command-preferences")
    for (const manager of managers) {
        assert.deepEqual(parseCommandPreferences(JSON.stringify({ manager, ignored: "not retained" })), { manager })
    }
    for (const raw of [null, "broken", "null", "[]", "{}", '{"manager":"yarn"}']) {
        assert.deepEqual(parseCommandPreferences(raw), { manager: "npm" })
    }
})
