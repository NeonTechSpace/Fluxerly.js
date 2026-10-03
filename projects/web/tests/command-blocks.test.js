import assert from "node:assert/strict"
import test from "node:test"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { commandVariant, escapeHtml, remarkCommandBlocks, renderCommandBlock, validateCommand } from "../scripts/command-blocks.js"
import { commandPreferencesKey, parseCommandPreferences } from "../src/components/command-preferences.ts"
import { authoredGuides } from "../scripts/generate.js"
import { find, findAll, hasClass, parseHtml, textContent } from "./html.js"

const install = { kind: "install", package: "@neontechspace/fluxerly", version: "1000.0.0-rc.2" }
const managers = ["npm", "pnpm", "bun"]

test("Authored guide command blocks render with supported metadata", async () => {
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkCommandBlocks] })
    for (const guide of await authoredGuides()) {
        const content = guide.content.replaceAll("{{effect-version}}", "4.0.0")
        await assert.doesNotReject(() => processor.render(content), guide.slug)
    }
})

test("SDK install variants pin a prerelease exactly and keep the normal range for a Stable release", () => {
    assert.deepEqual(managers.map((manager) => commandVariant(install, manager).command), [
        "npm install --save-exact @neontechspace/fluxerly@1000.0.0-rc.2",
        "pnpm add --save-exact @neontechspace/fluxerly@1000.0.0-rc.2",
        // Bun ignores --save-exact without an error and saves a range
        "bun add --exact @neontechspace/fluxerly@1000.0.0-rc.2",
    ])
    const stable = { ...install, version: "1000.0.0" }
    assert.deepEqual(managers.map((manager) => commandVariant(stable, manager).command), [
        "npm install @neontechspace/fluxerly@1000.0.0",
        "pnpm add @neontechspace/fluxerly@1000.0.0",
        "bun add @neontechspace/fluxerly@1000.0.0",
    ])
    assert.equal(commandVariant(install).note, "")
    assert.equal(commandVariant(install, "pnpm").note, "")
})

test("Effect add and list use the chosen manager, while node execution follows the example language", () => {
    // A stable Effect is installed at the tested version with the normal range, so later Effect 4 releases still satisfy it
    const add = { kind: "add", package: "effect", version: "4.0.0" }
    assert.deepEqual(managers.map((manager) => commandVariant(add, manager).command),
        ["npm install effect@4.0.0", "pnpm add effect@4.0.0", "bun add effect@4.0.0"])
    // Older SDK snapshots required one exact Effect release candidate, which stays pinned
    const candidate = { ...add, version: "4.0.0-rc.29" }
    assert.deepEqual(managers.map((manager) => commandVariant(candidate, manager).command), [
        "npm install --save-exact effect@4.0.0-rc.29",
        "pnpm add --save-exact effect@4.0.0-rc.29",
        "bun add --exact effect@4.0.0-rc.29",
    ])
    // Bun's list command ignores a package filter, and bun why prints the installed version
    assert.deepEqual(managers.map((manager) => commandVariant({ kind: "list", package: "effect" }, manager).command),
        ["npm list effect", "pnpm list effect", "bun why effect"])
    for (const manager of managers) {
        const run = { kind: "run", command: "node --env-file=.env bot.js" }
        assert.deepEqual(commandVariant(run, manager), { command: "node --env-file=.env bot.js", note: "" })
        assert.deepEqual(commandVariant(run, manager, "ts"), { command: "node --env-file=.env bot.ts", note: "" })
        assert.deepEqual(commandVariant({ kind: "run", command: "node bot.js" }, manager, "ts"), { command: "node bot.ts", note: "" })
    }
})

test("Development dependency installs use each manager's own flag", () => {
    // Bun ignores --save-dev without an error and adds a regular dependency
    assert.deepEqual(managers.map((manager) => commandVariant({ kind: "dev", package: "@types/node" }, manager).command),
        ["npm install --save-dev @types/node", "pnpm add --save-dev @types/node", "bun add --dev @types/node"])
})

test("The agent setup command runs the installed SDK command with each manager", () => {
    // pnpx and pnpm dlx would download a fresh copy instead of the installed version
    assert.deepEqual(managers.map((manager) => commandVariant({ kind: "agents" }, manager).command),
        ["npx fluxerly agents", "pnpm exec fluxerly agents", "bunx fluxerly agents"])
})

test("Invalid command metadata fails closed without exposing input", () => {
    for (const value of [null, [], {}, { ...install, version: "latest" }, { ...install, version: "dev" }, { ...install, version: "0.0.0" },
        { ...install, version: "1.0.0; secret-value" }, { ...install, package: "other" }, { ...install, token: "secret-value" },
        { kind: "run", command: "echo secret-value" }, { kind: "run", command: "node bot.ts" }, { kind: "add", package: "effect", version: "4.0.0-rc.01" },
        { kind: "list", package: "effect", version: "4.0.0" }, { kind: "dev", package: "effect" }, { kind: "agents", package: "effect" }]) {
        assert.throws(() => validateCommand(value), { message: "Invalid command metadata" })
    }
    assert.throws(() => commandVariant(install, "yarn"), { message: "Invalid command preference" })
    assert.throws(() => commandVariant(install, "npm", "tsx"), { message: "Invalid command preference" })
    assert.throws(() => remarkCommandBlocks()({ children: [{ type: "code", lang: "command", value: "secret-value" }] }),
        { message: "Invalid command metadata" })
})

test("Static widgets use native labeled inert controls and escaped metadata", () => {
    assert.equal(escapeHtml('<&>"\''), "&lt;&amp;&gt;&quot;&#39;")
    // The no-JavaScript browser check covers the hidden copy button and fallback text
    const tree = parseHtml(renderCommandBlock(install))
    const block = find(tree, (node) => hasClass(node, "command-block"))
    assert.deepEqual(JSON.parse(block.properties.dataCommand), install)
    const selects = findAll(block, "select")
    assert.equal(selects.length, 1)
    assert.equal(selects[0].properties.dataCommandPreference, "manager")
    assert.equal(selects[0].properties.ariaLabel, "Package manager")
    assert.equal(selects[0].properties.disabled, true)
    assert.deepEqual(findAll(selects[0], "option").map((option) => option.properties.value), managers)
    // The command is keyboard scrollable and a copy result is announced
    const pre = find(block, "pre")
    assert.equal(pre.properties.tabIndex, 0)
    assert.equal(textContent(find(pre, (node) => node.properties.dataCommandCode !== undefined)), commandVariant(install).command)
    assert.equal(find(block, (node) => node.properties.dataCommandCopyStatus !== undefined).properties.role, "status")
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
    const tree = parseHtml((await processor.render(`\`\`\`command\n${JSON.stringify(install)}\n\`\`\``)).code)
    const block = find(tree, (node) => hasClass(node, "command-block"))
    assert.ok(block)
    assert.equal(textContent(find(block, "code")), "npm install --save-exact @neontechspace/fluxerly@1000.0.0-rc.2")
    assert.equal(findAll(block, "select").length, 1)
    assert.deepEqual(findAll(tree, (node) => hasClass(node, "language-command")), [])
    assert.ok(!textContent(tree).includes("<select"))
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
