import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

// Reuse the workspace's pinned YAML parser without adding a tooling package
const { parse } = createRequire(new URL("../../projects/release/package.json", import.meta.url))("yaml")
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
const forms = [
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/documentation.yml",
    ".github/DISCUSSION_TEMPLATE/ideas.yml",
]

test("published forms use supported inputs, unique fields, and existing label definitions", () => {
    const labels = JSON.parse(read(".github/labels.json")).map((label) => label.name)
    for (const path of forms) {
        const form = parse(read(path))
        assert.ok(form.title && Array.isArray(form.body))
        assert.ok(form.labels.every((label) => labels.includes(label)))
        const ids = new Set()
        for (const field of form.body) {
            assert.ok(["markdown", "checkboxes", "dropdown", "input", "textarea", "upload"].includes(field.type))
            assert.ok(field.attributes)
            if (field.type === "markdown") {
                assert.ok(field.attributes.value)
                continue
            }
            assert.ok(field.id && !ids.has(field.id), `Unique field required in ${path}`)
            ids.add(field.id)
            assert.ok(field.attributes.label)
            if (field.type === "dropdown" || field.type === "checkboxes") assert.ok(field.attributes.options.length)
        }
    }
})

test("both issue forms require the agreed version scope first and allow optional uploads", () => {
    for (const path of forms.slice(0, 2)) {
        const fields = parse(read(path)).body.filter((field) => field.type !== "markdown")
        assert.equal(fields[0].type, "checkboxes")
        const scope = fields[0].attributes.options[0]
        assert.equal(scope.required, true)
        assert.match(scope.label, /current major.*RC.*next release.*previous major.*Canary/)
        const upload = fields.find((field) => field.type === "upload")
        assert.ok(upload, "Report evidence must have an upload field")
        assert.equal(upload.validations.required, false)
    }
})

test("issue routing reserves feature ideas and usage questions for the planned categories", () => {
    const chooser = parse(read(".github/ISSUE_TEMPLATE/config.yml"))
    assert.equal(chooser.blank_issues_enabled, false)
    const destinations = chooser.contact_links.map((link) => link.url)
    assert.ok(destinations.includes("https://github.com/NeonTechSpace/Fluxerly.js/discussions/categories/ideas"))
    assert.ok(destinations.includes("https://github.com/NeonTechSpace/Fluxerly.js/discussions/categories/q-a"))
    assert.ok(destinations.includes("https://github.com/NeonTechSpace/Fluxerly.js/security/advisories/new"))
})
