import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { parse } from "yaml"
import { readResults, renderSummary } from "../../../.github/actions/summary/summary.mjs"
import { failureLine } from "../../scripts/check.mjs"

const repository = fileURLToPath(new URL("../../../", import.meta.url))

const check = (name, result, ms, extra = {}) => ({ name, result, ms, command: `pnpm --dir sdk run ${name}`, ...extra })
const run = {
    total: 95_400,
    checks: [
        check("format", "passed", 3_100),
        check("lint", "failed", 9_400, { error: "x no-unused-vars: 'a' is never used (src/a.ts:1)", command: "pnpm --dir sdk run lint" }),
        check("build", "failed", 31_000, { error: "error TS2322: Type 'a' is not assignable (src/b.ts:4)" }),
        check("types", "skipped", 0, { blockedBy: "build" }),
    ],
}
const render = (overrides = {}) =>
    renderSummary({ title: "SDK checks", steps: { sdk: { outcome: "failure" } }, checks: { "SDK checks": "sdk" }, results: { sdk: run }, ...overrides })

test("A runner's checks become rows with their times, and failures name the first error and the command that reproduces it", () => {
    const summary = render({ failure: "Fix the failed checks and push" })
    assert.match(summary, /\| format \| passed \| 3s \|/)
    assert.match(summary, /\| lint \| failed \| 9s \|/)
    assert.match(summary, /\| types \| skipped \(needs build\) \| {2}\|/)
    assert.match(summary, /^Failed or cancelled: lint, build\./m)
    assert.match(summary, /- lint: x no-unused-vars/)
    assert.match(summary, /- build: error TS2322/)
    assert.match(summary, /Fix the failed checks and push/)
    assert.match(summary, /```sh\ncd projects\npnpm --dir sdk run lint\npnpm --dir sdk run build\n```/)
    // The runner's own step is replaced by its checks, and the generic run facts are gone
    assert.doesNotMatch(summary, /\| SDK checks \|/)
    assert.doesNotMatch(summary, /Run ID|Workflow commit|All listed steps succeeded|Raw command output/)
})

test("A passing runner reports how many checks passed and in how long, and reproduction commands stay out", () => {
    const passed = { total: 95_400, checks: run.checks.map((entry) => ({ ...entry, result: "passed", ms: 2_000 })) }
    const summary = renderSummary({
        title: "SDK checks",
        steps: { sdk: { outcome: "success" } },
        checks: { "SDK checks": "sdk" },
        results: { sdk: passed },
        next: "Nothing to fix",
        failure: "Fix it",
        reproduce: "pnpm run build",
    })
    assert.match(summary, /^All 4 checks passed in 95s$/m)
    assert.match(summary, /Nothing to fix/)
    assert.doesNotMatch(summary, /Fix it|Reproduce|pnpm run build|### Failures/)
})

test("A step without a readable result file stays one row, and any other failed step is named by its id", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-summary-"))
    try {
        const damaged = join(directory, "damaged.json")
        writeFileSync(damaged, '{"checks": [{"name": 1}]}')
        assert.equal(readResults(damaged), undefined)
        assert.equal(readResults(join(directory, "missing.json")), undefined)
        const summary = renderSummary({
            title: "SDK checks",
            steps: { setup: { outcome: "failure" }, sdk: { outcome: "skipped" } },
            checks: { "SDK checks": "sdk" },
        })
        assert.match(summary, /\| SDK checks \| skipped \|/)
        assert.match(summary, /\| setup \| failed \|/)
        assert.match(summary, /^Failed or cancelled: setup\./m)
        assert.match(summary, /Open the log of the setup step/)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("Result files, labels and details cannot inject Markdown, and a command with shell characters is never shown", () => {
    const hostile = { total: 1000, checks: [check("a|b", "failed", 1000, { error: "<script>x</script> `code` [link](https://example.invalid)\n| row", command: "pnpm run a; curl https://example.invalid" })] }
    const summary = renderSummary({
        title: "Checks",
        steps: { one: { outcome: "failure" } },
        checks: { "<b>One</b>": "one" },
        results: { one: hostile },
        details: { "A|B": "`value` <i>", Empty: "", Missing: undefined },
        reproduce: "pnpm run ok\nrm -rf /tmp/x; echo hi",
    })
    assert.doesNotMatch(summary, /<script>|<b>|<i>|`code`|\[link\]|curl/)
    assert.match(summary, /\| a&#124;b \| failed \| 1s \|/)
    assert.match(summary, /pnpm run ok/)
    assert.doesNotMatch(summary, /rm -rf|echo hi/)
    assert.match(summary, /- A&#124;B: &#96;value&#96; &#60;i&#62;/)
    assert.doesNotMatch(summary, /Empty|Missing|Unavailable/)
})

test("Skipped checks are counted without being treated as passes", () => {
    const summary = renderSummary({
        title: "Prepare",
        steps: { a: { outcome: "success" }, b: { outcome: "skipped" } },
        checks: { "Check A": "a", "Check B": "b" },
        next: "Review the candidate",
    })
    assert.match(summary, /^1 check passed, 1 skipped\. Skipped checks did not run and establish nothing$/m)
    assert.match(summary, /\| Check B \| skipped \|/)
    assert.doesNotMatch(summary, /\| Time \|/, "Rows without a time have no time column")
})

test("The first useful error line of a failed step skips exit reports, colors and passed lines", () => {
    const color = (text) => `\u001b[31m${text}\u001b[39m`
    const cases = [
        [["> pkg@1 test", "> vitest run", "✓ tests/error-mapping.test.ts 12ms", color(" FAIL  tests/a.test.ts > reconnects"), "AssertionError: expected 1 to be 2", " ELIFECYCLE  Command failed with exit code 1."], "FAIL  tests/a.test.ts > reconnects"],
        [["src/a.ts(3,5): error TS2322: Type 'x' is not assignable", "Found 1 error"], "src/a.ts(3,5): error TS2322: Type 'x' is not assignable"],
        [["", "  x eslint(no-unused-vars): Variable 'a' is never used", "Found 0 warnings and 1 error."], "x eslint(no-unused-vars): Variable 'a' is never used"],
        [["not ok 3 - parses a file", "# fail 1"], "not ok 3 - parses a file"],
        [["Building", "Something stopped the build", " ELIFECYCLE  Command failed with exit code 1."], "Something stopped the build"],
        [[""], "No output"],
    ]
    for (const [lines, expected] of cases) assert.equal(failureLine(lines.join("\n")), expected)
    assert.equal(failureLine(`error ${"x".repeat(400)}`).length, 300)
})

test("Every summary step names real step ids, and each result file is the one its step writes", () => {
    const workflows = readdirSync(join(repository, ".github/workflows")).filter((name) => name.endsWith(".yml"))
    let summaries = 0
    for (const file of workflows) {
        const workflow = parse(readFileSync(join(repository, ".github/workflows", file), "utf8"))
        for (const [id, job] of Object.entries(workflow.jobs)) {
            const ids = new Set((job.steps ?? []).map((step) => step.id).filter(Boolean))
            for (const step of (job.steps ?? []).filter((candidate) => candidate.uses === "$/.github/actions/summary")) {
                summaries++
                const where = `${file}/${id}`
                // The checks input may be a JSON literal or an expression that picks between literals
                const listed = [...String(step.with.checks ?? "").matchAll(/"[^"]+": "([a-z_]+)"/g)].map((match) => match[1])
                assert.ok(listed.length > 0, `${where} lists the checks it ran`)
                for (const stepId of listed) assert.ok(ids.has(stepId), `${where} lists the unknown step ${stepId}`)
                assert.ok(String(step.with.next).length > 0 && String(step.with.failure).length > 0, `${where} has a next action for both results`)
                for (const [stepId, path] of Object.entries(JSON.parse(step.with.results ?? "{}"))) {
                    assert.ok(listed.includes(stepId), `${where} lists the step whose results it reads`)
                    assert.equal(job.steps.find((candidate) => candidate.id === stepId).env.CHECK_RESULTS_FILE, path, where)
                }
            }
        }
    }
    assert.ok(summaries >= 15, "The summary steps were found")
})
