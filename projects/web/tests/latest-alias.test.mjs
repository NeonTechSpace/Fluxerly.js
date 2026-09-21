import assert from "node:assert/strict"
import test from "node:test"
import { latestAliasFiles, rebaseLatestMarkdown } from "../scripts/latest-alias.mjs"
import { defaultVersion } from "../scripts/versions.mjs"

test("Latest source selection respects readiness before numerical version order", () => {
    for (const [versions, expected] of [
        [[], "dev"],
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
    const rebased = rebaseLatestMarkdown(source, "1000.1.0")
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
    const alias = latestAliasFiles(files, "1000.1.0")

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
