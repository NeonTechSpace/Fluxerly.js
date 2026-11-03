// Tests the commands that add the SDK: a prerelease saves its exact version, as fluxerly init does, in every generator of
// these commands, and a Stable keeps the package manager's plain form
import assert from "node:assert/strict"
import { test } from "node:test"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { installCommandFor } from "../scripts/docs/install-command.mjs"

const name = "@neontechspace/fluxerly"
const nightly = `${name}@1001.0.0-nightly.20261102.1`

test("a prerelease or the nightly tag saves the exact version, with each manager's own flag", () => {
    for (const spec of [nightly, `${name}@nightly`]) {
        assert.equal(installCommandFor("npm", spec), `npm install --save-exact ${spec}`)
        assert.equal(installCommandFor("pnpm", spec), `pnpm add --save-exact ${spec}`)
        assert.equal(installCommandFor("bun", spec), `bun add --exact ${spec}`)
    }
})

test("a Stable keeps the plain command", () => {
    for (const spec of [name, `${name}@1000.0.0`]) {
        assert.equal(installCommandFor("npm", spec), `npm install ${spec}`)
        assert.equal(installCommandFor("pnpm", spec), `pnpm add ${spec}`)
        assert.equal(installCommandFor("bun", spec), `bun add ${spec}`)
    }
})

test("a guide built for a nightly shows the exact install for every manager", async () => {
    // The plugin reads the version when it loads, so this copy of it is loaded with a nightly's
    process.env.DOCS_PACKAGE_SPEC = nightly
    const { default: remarkGuides } = await import(`../scripts/docs/remark-guides.mjs?${"nightly"}`)
    delete process.env.DOCS_PACKAGE_SPEC
    const processor = await createMarkdownProcessor({ remarkPlugins: [remarkGuides], smartypants: false })
    const text = (await processor.render("{{installation}}")).code.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")
    for (const command of [`npm install --save-exact ${nightly}`, `pnpm add --save-exact ${nightly}`, `bun add --exact ${nightly}`]) assert.ok(text.includes(command), `${command} in: ${text}`)
})
