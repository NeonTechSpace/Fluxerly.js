import assert from "node:assert/strict"
import test from "node:test"
import { docsAliasFiles, rebaseAliasMarkdown } from "../scripts/docs-alias.js"
import { defaultVersion } from "../scripts/versions.js"

test("Latest source selection respects readiness before numerical version order", () => {
    for (const [versions, expected] of [
        [[], null],
        [["1000.2.0-canary.9", "1000.2.0-canary.10"], "1000.2.0-canary.10"],
        [["1000.1.0-rc.9", "1000.2.0-canary.10", "1000.1.0-rc.10"], "1000.1.0-rc.10"],
        [["1000.0.9", "1000.1.0-rc.10", "1000.2.0-canary.10", "1000.0.10"], "1000.0.10"],
    ]) assert.equal(defaultVersion(versions), expected)
})

test("Latest alias rebases its documentation links without changing examples or external URLs", () => {
    const source = `---
title: "Alias fixture"
---

[Root](/docs/1000.1.0) [Guide](/docs/1000.1.0/guide/#start) [Relative](other/)
[External](https://example.test/docs/1000.1.0/guide/) and \`[inline](/docs/1000.1.0/private/)\`
<a href="/docs/1000.1.0/api/">API</a>
[reference]: /docs/1000.1.0/changelog/

\`\`\`command
{"documentation":"/docs/1000.1.0/guide/","version":"1000.1.0"}
\`\`\`still-code
[Also code](/docs/1000.1.0/guide/)
\`\`\`
`
    const rebased = rebaseAliasMarkdown(source, "1000.1.0", "latest")
    assert.match(rebased, /\[Root\]\(\/docs\/latest\)/)
    assert.match(rebased, /\[Guide\]\(\/docs\/latest\/guide\/#start\)/)
    assert.match(rebased, /\[Relative\]\(other\/\)/)
    assert.match(rebased, /https:\/\/example\.test\/docs\/1000\.1\.0\/guide\//)
    assert.match(rebased, /`\[inline\]\(\/docs\/1000\.1\.0\/private\/\)`/)
    assert.match(rebased, /href="\/docs\/latest\/api\/"/)
    assert.match(rebased, /\[reference\]: \/docs\/latest\/changelog\//)
    assert.match(rebased, /"documentation":"\/docs\/1000\.1\.0\/guide\/"/)
    assert.match(rebased, /\[Also code\]\(\/docs\/1000\.1\.0\/guide\/\)/)
})

test("Latest alias clones the selected content and leaves the exact source untouched", () => {
    const files = [
        {
            path: "index.md",
            content: '---\ntitle: "Selected release"\n---\n\n[Guide](/docs/1000.1.0/guide/)\n',
        },
        {
            path: "guide.md",
            content: '---\ntitle: "Guide"\n---\n\n[Home](./)\n',
        },
        {
            path: "meta.json",
            content: JSON.stringify({ title: "RC · 1000.1.0", root: "version", pages: ["index", "guide"] }),
        },
    ]
    const original = structuredClone(files)
    const alias = docsAliasFiles(files, "1000.1.0", "latest")

    assert.deepEqual(files, original)
    assert.deepEqual(alias.map((file) => file.path), files.map((file) => file.path))
    assert.match(alias[0].content, /\/docs\/latest\/guide\//)
    assert.equal(alias[1].content, files[1].content)
    assert.deepEqual(JSON.parse(alias[2].content), {
        title: "Latest",
        root: "version",
        pages: ["index", "guide"],
    })
})

for (const channel of ["canary", "rc"]) {
    test(`The ${channel} alias changes link destinations, not package versions or code examples`, () => {
        const version = `1000.1.0-${channel}.2`
        const files = [
            { path: "index.md", content: `[Guide](/docs/${version}/quick-start/?from=home#install)\n` +
                `<a href="/docs/${version}/api/">API</a>\n` +
                `[ref]: /docs/${version}/changelog/\n` +
                `SDK ${version}\n\n\`/docs/${version}/example/\`\n\n` +
                `\`\`\`command\n{"version":"${version}","example":"/docs/${version}/"}\n\`\`\`\n` },
            { path: "meta.json", content: JSON.stringify({ title: version, root: "version", pages: ["index"] }) },
        ]
        const original = structuredClone(files)
        const alias = docsAliasFiles(files, version, channel)
        assert.deepEqual(files, original)
        assert.ok(alias[0].content.includes(`[Guide](/docs/${channel}/quick-start/?from=home#install)`))
        assert.ok(alias[0].content.includes(`href="/docs/${channel}/api/"`))
        assert.ok(alias[0].content.includes(`[ref]: /docs/${channel}/changelog/`))
        assert.ok(alias[0].content.includes(`SDK ${version}`))
        assert.ok(alias[0].content.includes(`\`/docs/${version}/example/\``))
        assert.ok(alias[0].content.includes(`{"version":"${version}","example":"/docs/${version}/"}`))
        assert.equal(JSON.parse(alias[1].content).title, channel === "rc" ? "RC" : "Canary")
    })
}

test("Alias generation rejects unknown destinations and non-exact source versions", () => {
    const files = [{ path: "meta.json", content: "{}" }]
    for (const alias of ["../escape", "stable", "constructor"])
        assert.throws(() => docsAliasFiles(files, "1000.0.0", alias), /Unknown documentation alias/)
    for (const version of ["latest", "canary", "../escape"])
        assert.throws(() => docsAliasFiles(files, version, "rc"))
})
