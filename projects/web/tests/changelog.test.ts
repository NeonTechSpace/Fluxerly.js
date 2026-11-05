import assert from "node:assert/strict"
import { test } from "node:test"
import { changelogMarkdown, markChangelog } from "../src/lib/changelog.ts"

const repository = "https://github.com/NeonTechSpace/Fluxerly.js"

test("a change's commit moves to a link after its first line, and its written lines stay apart", () => {
    const source = ["### Major Changes", "", "- 37106cd: Breaking changes:", "", "    - A change", "      Affected: Some code", "      Migration: Do this", "", "- abc1234: One line"].join("\n")
    assert.equal(
        changelogMarkdown(source, repository),
        [
            "### Major Changes",
            "",
            `- Breaking changes: [37106cd](${repository}/commit/37106cd)`,
            "",
            "    - A change\\",
            "      Affected: Some code\\",
            "      Migration: Do this",
            "",
            `- One line [abc1234](${repository}/commit/abc1234)`,
        ].join("\n"),
    )
})

test("a list item or a code block that follows a line is not joined to it", () => {
    assert.equal(changelogMarkdown("Some records:\n- A record\n```\nx\ny\n```", repository), "Some records:\n- A record\n```\nx\ny\n```")
})

test("a label opens a paragraph or a list item too, and a sentence that only ends in a colon is no label", () => {
    assert.equal(markChangelog("<p>Migration: Update</p><li>API reference: Fixes</li><p>Test kit records:</p>"), '<p><span class="change-label">Migration:</span> Update</p><li><span class="change-label">API reference:</span> Fixes</li><p>Test kit records:</p>')
    assert.equal(markChangelog("<p>Since Effect 4.0.6, a failure: kept</p>"), "<p>Since Effect 4.0.6, a failure: kept</p>")
    assert.equal(markChangelog('<li class="text-item">Affected: Code</li>'), '<li class="text-item"><span class="change-label">Affected:</span> Code</li>')
})

test("the rendered changelog marks its commit links and line labels", () => {
    const html = `<li><p>Text <a href="${repository}/commit/37106cd" target="_blank" rel="noopener">37106cd</a><br>\nAffected: Code<br>\nMigration: Steps</p></li>`
    assert.equal(
        markChangelog(html),
        `<li><p>Text <a class="change-commit" href="${repository}/commit/37106cd" aria-label="Commit 37106cd" target="_blank" rel="noopener">37106cd</a><br>\n<span class="change-label">Affected:</span> Code<br>\n<span class="change-label">Migration:</span> Steps</p></li>`,
    )
})
