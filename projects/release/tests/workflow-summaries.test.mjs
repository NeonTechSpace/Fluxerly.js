import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { renderSummary, summaryProfiles } from "../../../.github/scripts/workflow-summary.mjs"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const helper = join(repository, ".github/scripts/workflow-summary.mjs")
const workflows = {
    "ci.yml": ["workspace", "browser", "consumers", "check"],
    "docs-preview.yml": ["preview"],
    "release-prepare.yml": ["prepare"],
    "release-publish.yml": ["inspect", "publish", "reconcile", "docs-preview"],
    "release-version.yml": ["version"],
}

function successfulSteps(kind) {
    return Object.fromEntries(
        summaryProfiles[kind].checks.map(([id]) => [
            id,
            { outcome: id === "browser_evidence" ? "skipped" : "success", outputs: {} },
        ]),
    )
}

function withTemporaryDirectory(check) {
    const tempRoot = realpathSync(tmpdir())
    const directory = mkdtempSync(join(tempRoot, "fluxerly-summary-"))
    try {
        check(directory)
    } finally {
        const target = realpathSync(directory)
        const child = relative(tempRoot, target)
        assert.ok(
            child && !child.startsWith("..") && !isAbsolute(child),
            "Summary cleanup must stay inside its temp root",
        )
        rmSync(target, { recursive: true, force: true })
    }
}

test("Every workflow job with steps ends in an always-run summary covering its step IDs", () => {
    let summaries = 0
    let calledJobs = 0
    for (const [file, expectedJobs] of Object.entries(workflows)) {
        const source = readFileSync(join(repository, ".github/workflows", file), "utf8").split(/^jobs:\r?\n/m)[1]
        const jobs = [...source.matchAll(/^  ([a-z][a-z-]*):\r?\n/gm)]
        assert.deepEqual(
            jobs.map((match) => match[1]),
            expectedJobs,
            file,
        )
        for (let index = 0; index < jobs.length; index++) {
            const body = source.slice(jobs[index].index, jobs[index + 1]?.index ?? source.length)
            if (file === "ci.yml" && jobs[index][1] === "check") {
                assert.match(body, /needs: \[workspace, browser, consumers\]/)
                assert.match(body, /if: always\(\)/)
                continue
            }
            if (!body.includes("    steps:")) {
                assert.match(body, /uses: \.\/\.github\/workflows\/docs-preview\.yml/)
                assert.match(body, /needs: reconcile/)
                assert.match(body, /if: \$\{\{ !cancelled\(\) && needs\.reconcile\.result == 'success' && needs\.reconcile\.outputs\.complete == 'true' \}\}/)
                calledJobs++
                continue
            }
            const steps = body.split(/^      - /m).slice(1)
            const summary = steps.pop()
            assert.match(summary, /^name: Summarize/)
            assert.match(summary, /if: always\(\)/)
            assert.match(summary, /SUMMARY_STEPS: \$\{\{ toJSON\(steps\) \}\}/)
            assert.match(summary, /if \[ -f \.github\/scripts\/workflow-summary\.mjs \]; then/)
            assert.match(summary, />> "\$GITHUB_STEP_SUMMARY"/)
            assert.doesNotMatch(summary.split("        run: |")[1], /\$\{\{/)
            const kind = summary.match(/SUMMARY_KIND: ([a-z-]+)/)[1]
            const ids = steps.map((step) => step.match(/^        id: ([a-z_]+)/m)?.[1])
            assert.ok(ids.every(Boolean), `${file}: Every checked step must have an outcome ID`)
            assert.deepEqual(
                ids,
                summaryProfiles[kind].checks.map(([id]) => id),
                file,
            )
            summaries++
        }
    }
    assert.equal(summaries, 9)
    assert.equal(calledJobs, 1)
})

test("Preview credentials are read from the website environment", () => {
    const source = readFileSync(join(repository, ".github/workflows/docs-preview.yml"), "utf8")
    assert.match(source, /environment:\r?\n      name: website\r?\n      url: \$\{\{ vars\.CLOUDFLARE_PREVIEW_URL \}\}/)
    assert.match(source, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/)
})

test("Successful summaries describe each checked surface and retain their proof boundaries", () => {
    for (const kind of Object.keys(summaryProfiles)) {
        const summary = renderSummary({
            kind,
            steps: successfulSteps(kind),
            runId: "123",
            workflowCommit: "a".repeat(40),
        })
        for (const [id, label] of summaryProfiles[kind].checks)
            assert.ok(summary.includes(`| ${label} | ${successfulSteps(kind)[id].outcome} |`))
        assert.ok(summary.includes(summaryProfiles[kind].scope))
        assert.ok(summary.includes(summaryProfiles[kind].next))
    }
})

test("Summary tables preserve failure, cancellation and missing step outcomes", () => {
    for (const kind of Object.keys(summaryProfiles)) {
        for (const failure of ["failure", "cancelled"]) {
            const steps = Object.fromEntries(
                summaryProfiles[kind].checks.map(([id]) => [
                    id,
                    { outcome: id === "checkout" ? "success" : id === "setup" ? failure : "skipped" },
                ]),
            )
            const summary = renderSummary({ kind, steps })
            for (const [id, label] of summaryProfiles[kind].checks)
                assert.ok(summary.includes(`| ${label} | ${steps[id].outcome} |`))
            assert.ok(!summary.includes(summaryProfiles[kind].next))
        }
        const missing = renderSummary({ kind })
        for (const [, label] of summaryProfiles[kind].checks)
            assert.ok(missing.includes(`| ${label} | not reported |`))
    }
})

test("No-change decisions are distinct from prepared candidates and created PRs", () => {
    for (const [kind, owner, skipped] of [
        ["prepare", "candidate", "artifact"],
        ["version", "version", "pull_request"],
    ]) {
        const steps = successfulSteps(kind)
        steps[owner].outputs = { skipped: "true", reason_json: JSON.stringify("Content is unchanged") }
        steps[skipped].outcome = "skipped"
        const summary = renderSummary({ kind, steps })
        assert.match(summary, /No-change reason: Content is unchanged/)
        const label = summaryProfiles[kind].checks.find(([id]) => id === skipped)[1]
        assert.ok(summary.includes(`| ${label} | skipped |`))
        assert.ok(!summary.includes(summaryProfiles[kind].next))
    }
})

test("Final reconciliation leaves GitHub unannounced while the npm version is missing", () => {
    const steps = successfulSteps("reconcile")
    steps.release_token.outcome = "skipped"
    steps.announce.outcome = "skipped"
    const summary = renderSummary({
        kind: "reconcile",
        steps,
        details: { operation: "reconcile", npm: "missing", complete: "false" },
    })
    assert.match(summary, /The npm version is missing/)
    assert.match(summary, /npm version availability: missing/)
    assert.match(summary, /GitHub announcement is deliberately skipped/)
    assert.doesNotMatch(summary, /Incomplete, some checks or effects were skipped or not reported/)
    assert.ok(!summary.includes(summaryProfiles.reconcile.next))
})

test("Final reconciliation can complete an existing registry release after a duplicate publish request fails", () => {
    const steps = successfulSteps("reconcile")
    steps.release_token.outputs.token = "test-only-token-must-not-be-rendered"
    const summary = renderSummary({
        kind: "reconcile",
        steps,
        details: { operation: "publish", publishResult: "failure", npm: "published", complete: "true" },
    })
    assert.match(summary, /The npm version is published after the publication job failed/)
    assert.match(summary, /npm publication job result: failure/)
    assert.match(summary, /npm version availability: published/)
    assert.match(summary, /Final reconciliation uses the current published-version status, not the failed request result/)
    assert.ok(summary.includes(summaryProfiles.reconcile.next))
    assert.ok(!summary.includes(steps.release_token.outputs.token))
})

test("Recovered registry availability is incomplete when the required GitHub announcement does not run", () => {
    const steps = successfulSteps("reconcile")
    steps.announce.outcome = "skipped"
    const summary = renderSummary({
        kind: "reconcile",
        steps,
        details: { operation: "publish", publishResult: "failure", npm: "published", complete: "true" },
    })
    assert.match(summary, /Incomplete, some checks or effects were skipped or not reported/)
    assert.doesNotMatch(summary, /Final reconciliation proceeds from current npm status/)
})

test("Manual npm publication can be reconciled without claiming the skipped publication job ran", () => {
    const summary = renderSummary({
        kind: "reconcile",
        steps: successfulSteps("reconcile"),
        details: { operation: "reconcile", publishResult: "skipped", npm: "published", complete: "true" },
    })
    assert.match(summary, /Requested operation: reconcile/)
    assert.match(summary, /npm publication job result: skipped/)
    assert.match(summary, /npm version availability: published/)
    assert.ok(summary.includes(summaryProfiles.reconcile.next))
    assert.doesNotMatch(summary, /Incomplete, some checks|publication job failed/)
})

test("The workflow derives announcement eligibility from validated npm availability", () => {
    const source = readFileSync(join(repository, ".github/workflows/release-publish.yml"), "utf8")
    const script = source.match(/node --input-type=module --eval '([\s\S]*?)' "\$status"/)[1]
    for (const [status, expected] of [
        [{ npm: "published", complete: true }, "complete=true\nnpm=published\n"],
        [{ npm: "missing", complete: false }, "complete=false\nnpm=missing\n"],
        [{ npm: "missing", complete: true }, null],
        [{ npm: "published", complete: false }, null],
        [{ npm: "unknown", complete: false }, null],
        [{}, null],
    ]) {
        const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script, JSON.stringify(status)], {
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
        })
        assert.ifError(result.error)
        assert.equal(result.status, expected === null ? 1 : 0, result.stderr)
        assert.equal(result.stdout, expected ?? "")
    }
})

test("npm publication summaries do not claim a GitHub release", () => {
    const summary = renderSummary({
        kind: "publish-npm",
        steps: successfulSteps("publish-npm"),
    })
    assert.match(summary, /npm version availability: published/)
    assert.match(summary, /GitHub release availability: Unconfirmed until final reconciliation succeeds/)
})

test("Candidate, artifact and PR identities come from reported outputs, not upload step success alone", () => {
    const steps = successfulSteps("prepare")
    steps.candidate.outputs = {
        name: "release-candidate-abc",
        source: "abc",
        checksum: "def",
        version: "1000.0.0",
        channel: "stable",
    }
    steps.artifact.outputs = { "artifact-id": "456" }
    const summary = renderSummary({ kind: "prepare", steps, runId: "123" })
    for (const detail of [
        "Candidate artifact name: release-candidate-abc",
        "Candidate artifact ID: 456",
        "Candidate SHA256: def",
        "Preparation run ID: 123",
    ])
        assert.ok(summary.includes(detail))
    const browser = successfulSteps("browser")
    browser.browser_evidence.outcome = "success"
    assert.match(renderSummary({ kind: "browser", steps: browser }), /No artifact ID reported/)
    browser.browser_evidence.outputs = { "artifact-id": "789" }
    assert.match(renderSummary({ kind: "browser", steps: browser }), /Browser evidence artifact: browser-failure/)
    browser.browser_evidence.outcome = "failure"
    assert.match(renderSummary({ kind: "browser", steps: browser }), /Failed or cancelled/)
    const version = successfulSteps("version")
    version.pull_request.outputs = {
        "pull-request-number": "12",
        "pull-request-url": "https://github.com/example/repo/pull/12",
        "pull-request-operation": "updated",
    }
    assert.match(renderSummary({ kind: "version", steps: version }), /PR operation: updated/)
})

test("Untrusted display values cannot inject Markdown, HTML, extra lines or unrelated output data", () => {
    const steps = successfulSteps("version")
    steps.version.outputs = { version: "<script>bad</script>\n| injected | `code` [link](https://example.invalid)" }
    steps.pull_request.outputs = { "private-body": "test-private-sentinel" }
    const summary = renderSummary({ kind: "version", steps })
    assert.doesNotMatch(summary, /<script>|\n\| injected|`code`|\[link\]|test-private-sentinel/)
    assert.match(summary, /&#60;script&#62;/)
    assert.throws(() => renderSummary({ kind: "unknown" }), /Unknown workflow summary profile/)
})

test("The runner entry point writes the rendered summary to the GitHub summary file", () => {
    withTemporaryDirectory((directory) => {
        const summaryFile = join(directory, "summary.md")
        const input = {
            kind: "preview",
            steps: successfulSteps("preview"),
            details: { sourceCommit: "b".repeat(40), previewUrl: "https://preview.example.invalid" },
            runId: "321",
            workflowCommit: "a".repeat(40),
        }
        const result = spawnSync(process.execPath, [helper], {
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
            env: {
                ...process.env,
                GITHUB_STEP_SUMMARY: summaryFile,
                SUMMARY_KIND: input.kind,
                SUMMARY_STEPS: JSON.stringify(input.steps),
                SUMMARY_DETAILS: JSON.stringify(input.details),
                GITHUB_RUN_ID: input.runId,
                GITHUB_SHA: input.workflowCommit,
            },
        })
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, "")
        assert.equal(readFileSync(summaryFile, "utf8"), renderSummary(input))
    })
})

test("The workflow shell writes an honest fallback when checkout did not provide the helper", () => {
    const userGitBash = join(process.env.LOCALAPPDATA ?? "", "Programs/Git/bin/bash.exe")
    const bash = process.platform === "win32" && existsSync(userGitBash) ? userGitBash : "bash"
    const source = readFileSync(join(repository, ".github/workflows/ci.yml"), "utf8")
    const summary = source.split("      - name: Summarize workspace checks")[1].split(/^  browser:/m)[0]
    const script = summary.split("        run: |")[1].replace(/^          /gm, "")
    withTemporaryDirectory((directory) => {
        const summaryFile = join(directory, "fallback.md")
        const result = spawnSync(bash, ["--noprofile", "--norc", "-c", script], {
            cwd: directory,
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
            env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
        })
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        const fallback = readFileSync(summaryFile, "utf8")
        assert.match(fallback, /\S/)
        assert.doesNotMatch(fallback, /\| success \|/)
    })
})

test("The required CI gate rejects failed, cancelled, skipped and missing job results", () => {
    const userGitBash = join(process.env.LOCALAPPDATA ?? "", "Programs/Git/bin/bash.exe")
    const bash = process.platform === "win32" && existsSync(userGitBash) ? userGitBash : "bash"
    const source = readFileSync(join(repository, ".github/workflows/ci.yml"), "utf8")
    const script = source
        .split(/^  check:\r?\n/m)[1]
        .split("        run: |")[1]
        .replace(/^          /gm, "")
    const keys = ["WORKSPACE_RESULT", "BROWSER_RESULT", "CONSUMERS_RESULT"]
    const cases = [Object.fromEntries(keys.map((key) => [key, "success"]))]
    for (const key of keys) {
        for (const result of ["failure", "cancelled", "skipped", ""]) cases.push({ ...cases[0], [key]: result })
    }
    withTemporaryDirectory((directory) => {
        for (const [index, results] of cases.entries()) {
            const summaryFile = join(directory, `gate-${index}.md`)
            const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
                cwd: directory,
                encoding: "utf8",
                timeout: 10_000,
                windowsHide: true,
                env: { ...process.env, ...results, GITHUB_STEP_SUMMARY: summaryFile },
            })
            assert.ifError(result.error)
            assert.equal(result.status, index === 0 ? 0 : 1, result.stderr)
            const summary = readFileSync(summaryFile, "utf8")
            for (const [key, value] of Object.entries(results))
                assert.ok(summary.includes(`| ${key.replace("_RESULT", "")} | ${value} |`))
        }
    })
})

test("Workflow orchestration keeps independent checks observable and release effects serialized", () => {
    const read = (name) => readFileSync(join(repository, ".github/workflows", name), "utf8")
    const ci = read("ci.yml")
    assert.match(ci, /fail-fast: false/)
    assert.match(ci, /max-parallel: 2/)
    assert.match(ci, /runtime-policy: development/)
    assert.match(ci, /runtime-policy: consumer-floor/)
    assert.match(ci, /name: SDK consumers on the declared Node floor/)
    assert.match(ci, /runtime-policy: \$\{\{ matrix.runtime-policy \}\}/)
    assert.match(ci, /cancel-in-progress: \$\{\{ github.event_name != 'workflow_dispatch' \}\}/)
    assert.match(ci, /github.event_name == 'workflow_dispatch' && github.run_id \|\| github.ref/)
    const prepare = read("release-prepare.yml")
    assert.match(
        prepare,
        /group: release-prepare-\$\{\{ inputs.source_ref \}\}-\$\{\{ inputs.line \}\}-\$\{\{ inputs.bootstrap \}\}/,
    )
    assert.doesNotMatch(prepare, /strategy:|matrix:/)
    assert.ok(prepare.indexOf("run: pnpm check") < prepare.indexOf("id: candidate"))
    assert.match(prepare, /candidate.sourceCommit !== source/)
    const version = read("release-version.yml")
    assert.match(version, /group: release-version\r?\n/)
    for (const workflow of [prepare, version]) {
        assert.match(workflow, /^cache-mode: read\r?$/m)
        for (const [, mode] of workflow.matchAll(/^ +cache-mode: (\S+)\r?$/gm)) {
            assert.ok(mode === "read" || mode === "none", "Job cache access must not permit writes")
        }
    }
    const publish = read("release-publish.yml")
    assert.doesNotMatch(publish.split(/^jobs:/m)[0], /concurrency:/)
    assert.match(publish, /operation:\r?\n\s+description: [^\n]+\r?\n\s+required: true\r?\n\s+default: publish\r?\n\s+type: choice\r?\n\s+options: \[publish, reconcile\]/)
    const publisher = publish.split(/^  publish:\r?\n/m)[1].split(/^  reconcile:/m)[0]
    const reconcile = publish.split(/^  reconcile:\r?\n/m)[1].split(/^  docs-preview:/m)[0]
    assert.match(publisher, /needs: inspect/)
    assert.match(publisher, /if: inputs\.operation == 'publish'/)
    assert.doesNotMatch(publisher, /strategy:|matrix:/)
    assert.match(publisher, /group: package-release-publish-npm/)
    assert.match(publisher, /environment: package\r?\n/)
    assert.ok(publisher.indexOf("id: publish") < publisher.indexOf("id: verify"))
    assert.match(publisher, /pnpm release:publish "\$CANDIDATE_DIRECTORY" --checksum "\$CANDIDATE_CHECKSUM"/)
    assert.match(publisher, /pnpm release:verify "\$CANDIDATE_DIRECTORY" --checksum "\$CANDIDATE_CHECKSUM"/)
    assert.doesNotMatch(publisher, /NPM_TOKEN/)
    assert.match(reconcile, /needs: \[inspect, publish\]/)
    assert.match(reconcile, /if: \$\{\{ always\(\) && !cancelled\(\) && needs\.inspect\.result == 'success' \}\}/)
    assert.match(reconcile, /group: package-release-reconcile/)
    assert.match(reconcile, /environment: package\r?\n/)
    assert.match(reconcile, /complete: \$\{\{ steps\.status\.outputs\.complete \}\}/)
    assert.match(reconcile, /pnpm release:status/)
    assert.match(reconcile, /if: steps\.status\.outputs\.complete == 'true'/)
    assert.match(reconcile, /permissions:\r?\n      contents: read\r?\n      actions: read/)
    assert.doesNotMatch(reconcile, /id-token: write|release:publish/)
    const token = reconcile.split(/      - name: /).find((step) => step.includes("id: release_token"))
    assert.match(token, /if: steps.status.outputs.complete == 'true'/)
    assert.match(token, /uses: actions\/create-github-app-token@[a-f0-9]{40}/)
    assert.match(token, /client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/)
    assert.match(token, /private-key: \$\{\{ secrets\.RELEASE_APP_PRIVATE_KEY \}\}/)
    assert.match(token, /owner: \$\{\{ github\.repository_owner \}\}/)
    assert.match(token, /repositories: \$\{\{ github\.event\.repository\.name \}\}/)
    assert.match(token, /permission-contents: write/)
    assert.doesNotMatch(token, /skip-token-revoke: true/)
    assert.match(reconcile, /GH_TOKEN: \$\{\{ steps\.release_token\.outputs\.token \}\}/)
    assert.doesNotMatch(publisher, /RELEASE_APP_|release_token|contents: write/)
    assert.equal((publish.match(/secrets\.RELEASE_APP_PRIVATE_KEY/g) ?? []).length, 1)
    assert.equal((publish.match(/steps\.release_token\.outputs\.token/g) ?? []).length, 1)
    assert.ok(reconcile.indexOf("id: status") < reconcile.indexOf("id: release_token"))
    assert.ok(reconcile.indexOf("id: release_token") < reconcile.indexOf("id: announce"))
    assert.match(publish, /docs-preview:\r?\n    needs: reconcile\r?\n    if: \$\{\{ !cancelled\(\) && needs\.reconcile\.result == 'success' && needs\.reconcile\.outputs\.complete == 'true' \}\}/)
    for (const file of [prepare, version, publisher, reconcile, read("docs-preview.yml")]) {
        assert.match(file, /cancel-in-progress: false\r?\n\s+queue: max/)
    }
})

test("Consumer summaries identify the selected matrix runtime", () => {
    for (const runtimePolicy of ["development", "consumer-floor"]) {
        const summary = renderSummary({
            kind: "consumers",
            steps: successfulSteps("consumers"),
            details: { runtimePolicy },
        })
        assert.ok(summary.includes(`Node runtime policy: ${runtimePolicy}`))
    }
})
