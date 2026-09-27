import assert from "node:assert/strict"
import test from "node:test"
import { parseFrontmatter } from "@astrojs/markdown-remark"
import { docsAliasFiles, rebaseAliasMarkdown } from "../scripts/docs-alias.js"
import { materializeFiles } from "../scripts/snapshot-schema.js"
import { requireTransformSchema, transformSchemas } from "../scripts/transform-schemas.js"

test("Schema 1 channel reading rebases documentation links without changing examples or external URLs", () => {
    const source = `---
title: "Alias fixture"
---

[Root](/docs/1000.1.0-rc.1) [Guide](/docs/1000.1.0-rc.1/guide/#start) [Relative](other/)
[Query](/docs/1000.1.0-rc.1/quick-start/?from=home#install)
[External](https://example.test/docs/1000.1.0-rc.1/guide/) and \`[inline](/docs/1000.1.0-rc.1/private/)\`
<a href="/docs/1000.1.0-rc.1/api/">API</a>
[reference]: /docs/1000.1.0-rc.1/changelog/

\`\`\`command
{"documentation":"/docs/1000.1.0-rc.1/guide/","version":"1000.1.0-rc.1"}
\`\`\`still-code
[Also code](/docs/1000.1.0-rc.1/guide/)
\`\`\`
`
    const rebased = rebaseAliasMarkdown(source, "1000.1.0-rc.1", "rc")
    assert.match(rebased, /\[Root\]\(\/docs\/rc\)/)
    assert.match(rebased, /\[Guide\]\(\/docs\/rc\/guide\/#start\)/)
    assert.match(rebased, /\[Relative\]\(other\/\)/)
    assert.match(rebased, /\[Query\]\(\/docs\/rc\/quick-start\/\?from=home#install\)/)
    assert.match(rebased, /https:\/\/example\.test\/docs\/1000\.1\.0-rc\.1\/guide\//)
    assert.match(rebased, /`\[inline\]\(\/docs\/1000\.1\.0-rc\.1\/private\/\)`/)
    assert.match(rebased, /href="\/docs\/rc\/api\/"/)
    assert.match(rebased, /\[reference\]: \/docs\/rc\/changelog\//)
    assert.match(rebased, /"documentation":"\/docs\/1000\.1\.0-rc\.1\/guide\/"/)
    assert.match(rebased, /\[Also code\]\(\/docs\/1000\.1\.0-rc\.1\/guide\/\)/)
})

for (const channel of ["canary", "rc"]) {
    // Link rebasing itself is covered on rebaseAliasMarkdown and through Schema 1 channel materialization
    test(`The ${channel} alias retitles its navigation without mutating the source files`, () => {
        const version = `1000.1.0-${channel}.2`
        const files = [
            { path: "index.md", content: `[Guide](/docs/${version}/quick-start/)\n` },
            { path: "meta.json", content: JSON.stringify({ title: version, root: "version", pages: ["index"] }) },
        ]
        const original = structuredClone(files)
        const alias = docsAliasFiles(files, version, channel)
        assert.deepEqual(files, original)
        assert.ok(alias[0].content.includes(`(/docs/${channel}/quick-start/)`))
        assert.equal(JSON.parse(alias[1].content).title, channel === "rc" ? "RC" : "Canary")
    })
}

test("Alias generation rejects unknown destinations, including the redirect-only latest path", () => {
    const files = [{ path: "meta.json", content: "{}" }]
    for (const alias of ["../escape", "stable", "constructor", "latest"])
        assert.throws(() => docsAliasFiles(files, "1000.0.0", alias), /Unknown documentation alias/)
    for (const version of ["latest", "canary", "../escape"])
        assert.throws(() => docsAliasFiles(files, version, "rc"), /canary or rc suffix/)
})

test("Schema 2 snapshots fill the link placeholder for each served path and record their schema", () => {
    const files = [
        { path: "guide.md", content: '---\ntitle: "Guide"\n---\n\n[API](/docs/{{version}}/api/) `/docs/1000.0.0/`\n' },
        { path: "meta.json", content: JSON.stringify({ title: "1000.0.0", pages: ["guide"] }) },
    ]
    const original = structuredClone(files)
    for (const path of ["1000.0.0", "rc", "preview"]) {
        const [guide, meta] = materializeFiles(files, { schemaVersion: 2, sourceVersion: "1000.0.0", path })
        assert.ok(guide.content.includes(`[API](/docs/${path}/api/)`))
        assert.ok(guide.content.includes("`/docs/1000.0.0/`"))
        assert.ok(!guide.content.includes("{{version}}"))
        const { frontmatter } = parseFrontmatter(guide.content)
        assert.equal(frontmatter.snapshotSchema, 2)
        assert.equal(frontmatter.title, "Guide")
        assert.equal(meta.content, files[1].content)
    }
    assert.deepEqual(files, original)
})

test("Schema 1 snapshots keep exact-version links on their Stable path and rebase them on channels", () => {
    const files = [{ path: "guide.md", content: '---\ntitle: "Guide"\n---\n\n[API](/docs/1000.1.0-rc.1/api/)\n' }]
    assert.ok(materializeFiles(files, { schemaVersion: 1, sourceVersion: "1000.1.0-rc.1", path: "1000.1.0-rc.1" })[0].content
        .includes("(/docs/1000.1.0-rc.1/api/)"))
    const channel = materializeFiles(files, { schemaVersion: 1, sourceVersion: "1000.1.0-rc.1", path: "rc" })[0].content
    assert.ok(channel.includes("(/docs/rc/api/)"))
    assert.equal(parseFrontmatter(channel).frontmatter.snapshotSchema, 1)
    assert.throws(() => materializeFiles(files, { schemaVersion: 3, sourceVersion: "1000.1.0-rc.1", path: "rc" }), /Unsupported/)
    assert.throws(() => materializeFiles(files, { schemaVersion: 2, sourceVersion: "1000.1.0-rc.1", path: "../escape" }), /Unsafe/)
})

test("Markdown transforms refuse snapshot schemas they do not read", () => {
    for (const [transform, schemas] of Object.entries(transformSchemas)) {
        for (const schema of schemas) requireTransformSchema(transform, schema)
        assert.throws(() => requireTransformSchema(transform, Math.max(...schemas) + 1), /cannot read snapshot schema/)
    }
    assert.throws(() => requireTransformSchema("unknown", 1), /Unknown snapshot transform/)
})
