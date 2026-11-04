import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
    "contributions.yml/permissions": { actions: "write", contents: "write", issues: "write", "pull-requests": "write" },
    "dependabot-changeset.yml/note": { contents: "write", actions: "write" },
    "ci.yml/release-trigger": { actions: "write" },
    "release-prepare.yml/publish": { actions: "write" },
    "release-version.yml/pull_request": { contents: "write", "pull-requests": "write", actions: "write" },
    "release-publish.yml/publish": { "id-token": "write" },
    "release-publish.yml/reconcile": { actions: "write" },
    "upstream-drift.yml/report": { issues: "write" },
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

/**
 * Evaluates the GitHub expression subset these workflows use: Context paths, quoted strings, ==, !=, !, && and ||,
 * parentheses and the startsWith, format, cancelled and always functions. A missing context value is null, and strings
 * compare without case, as on GitHub
 * @param {string} expression
 * @param {Record<string, any>} context
 */
function evaluate(expression, context, status = { cancelled: false }) {
    const body = String(expression).trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    const tokens = [...body.matchAll(/\s*('(?:[^']|'')*'|[A-Za-z_][\w.-]*|==|!=|&&|\|\||[!(),])/gy)].map((match) => match[1])
    if (tokens.join("").length !== body.replace(/\s+/g, "").length) throw new Error(`Unsupported expression: ${body}`)
    let position = 0
    const peek = () => tokens[position]
    const take = (token) => {
        if (tokens[position] !== token) throw new Error(`Expected ${token} in ${body}`)
        position++
    }
    const text = (value) => (value == null ? "" : String(value))
    const equal = (a, b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b)
    const functions = {
        startsWith: (value, prefix) => text(value).toLowerCase().startsWith(text(prefix).toLowerCase()),
        format: (template, ...values) => template.replace(/\{(\d+)\}/g, (_, index) => text(values[Number(index)])),
        cancelled: () => status.cancelled,
        always: () => true,
    }
    const primary = () => {
        const token = tokens[position++]
        if (token === "(") {
            const value = or()
            take(")")
            return value
        }
        if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
        if (peek() === "(") {
            take("(")
            const args = []
            while (peek() !== ")") {
                args.push(or())
                if (peek() === ",") take(",")
            }
            take(")")
            return functions[token](...args)
        }
        return token.split(".").reduce((value, key) => (value == null ? null : (value[key] ?? null)), context)
    }
    const unary = () => (peek() === "!" ? (take("!"), !unary()) : primary())
    const comparison = () => {
        const left = unary()
        if (peek() !== "==" && peek() !== "!=") return left
        const negate = tokens[position++] === "!="
        return equal(left, unary()) !== negate
    }
    const and = () => {
        let value = comparison()
        while (peek() === "&&") {
            take("&&")
            const right = comparison()
            value = value ? right : value
        }
        return value
    }
    const or = () => {
        let value = and()
        while (peek() === "||") {
            take("||")
            const right = and()
            value = value ? value : right
        }
        return value
    }
    const value = or()
    if (position !== tokens.length) throw new Error(`Unparsed expression: ${body}`)
    return value
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

test("A superseded nightly publication skips the install checks, the announcement and the website deploy start", () => {
    const { jobs } = workflows["release-publish.yml"]
    assert.deepEqual(Object.keys(jobs.publish.outputs).sort(), ["superseded", "superseded_by"])
    for (const name of Object.keys(jobs.publish.outputs))
        assert.equal(jobs.publish.outputs[name], `\${{ steps.publish.outputs.${name} }}`)
    // Without a status function, the default success requirement still applies to these conditions
    for (const id of ["smoke", "reconcile"]) assert.equal(jobs[id].if, "needs.publish.outputs.superseded != 'true'", id)
    assert.equal(jobs.website, undefined, "The website deploys in its own run, started by the announcement job")
    const summary = jobs.publish.steps.find((step) => step.name === "Summarize npm publication")
    assert.match(summary.with.next, /steps\.publish\.outputs\.superseded == 'true'.*steps\.publish\.outputs\.superseded_by/)
})

// Catches: A failed website deploy, or a failed start of one, turning a finished release red, or a deploy from a ref the
// website environment refuses
test("A published release starts Website on main in its own run and never waits for it", () => {
    const reconcile = workflows["release-publish.yml"].jobs.reconcile
    const ids = reconcile.steps.map((step) => step.id)
    const start = reconcile.steps.find((step) => step.id === "website")
    assert.ok(ids.indexOf("announce") < ids.indexOf("website"), "The website starts only after the release is announced")
    for (const step of reconcile.steps.slice(ids.indexOf("website") + 1)) assert.equal(step.if, "always()", "Only the summary follows the start")
    assert.equal(start.run, 'gh workflow run website.yml --repo "$GITHUB_REPOSITORY" --ref main')
    assert.doesNotMatch(start.run, /watch|--wait/)
    assert.equal(start.env.GH_TOKEN, "${{ github.token }}")
    assert.equal(start["continue-on-error"], true)
    assert.equal(reconcile.permissions.actions, "write")
    const summary = reconcile.steps.at(-1)
    assert.equal(JSON.parse(summary.with.checks)["Website deploy started on main"], "website", "The summary lists the start")
    const website = workflows["website.yml"]
    assert.ok(Object.hasOwn(website.on, "workflow_dispatch"))
    assert.equal(website.on.workflow_call, undefined, "No workflow calls Website, so a release failure can't come from it")
    for (const [file, workflow] of Object.entries(workflows))
        for (const [id, job] of Object.entries(workflow.jobs)) assert.doesNotMatch(String(job.uses), /website\.yml/, `${file}/${id}`)
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
        for (const trigger of ["pull_request_target", "workflow_run"]) {
            const reviewedCallback = (file === "dependabot-changeset.yml" && trigger === "workflow_run") ||
                (file === "contributions.yml" && trigger === "pull_request_target")
            if (!reviewedCallback) assert.equal(workflow.on[trigger], undefined, `${file} must not use ${trigger}`)
        }
        for (const [id, job] of Object.entries(workflow.jobs)) assert.notEqual(job.secrets, "inherit", `${file}/${id} inherits secrets`)
    }
})

test("Contribution callbacks execute only trusted main code with no install or PR artifacts", () => {
    const workflow = workflows["contributions.yml"]
    assert.equal(workflow["cache-mode"], "none")
    assertSerialized(workflow.concurrency, "contributions.yml")
    assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true)
    const job = workflow.jobs.permissions
    const checkout = job.steps.find((step) => String(step.uses).startsWith("actions/checkout@"))
    assert.equal(checkout.with.ref, "${{ github.event.repository.default_branch }}")
    assert.deepEqual(job.steps.filter((step) => step.run).map((step) => step.run), ["node .github/scripts/contributions.mjs"])
    const setup = job.steps.find((step) => String(step.uses).startsWith("pnpm/setup@"))
    assert.equal(setup.with.install, false)
    assert.equal(setup.with.cache, false)
    assert.deepEqual(job.steps.filter((step) => step.uses).map((step) => step.uses), [checkout.uses, setup.uses])
    assert.equal(job.steps.at(-1).env.GH_TOKEN, "${{ github.token }}")
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

// Catches: A pull request or push that tested no screen because its checkout compared HEAD with itself, or a CI run that
// still ran the full screen check, which belongs to the Screens workflow
test("CI tests only the screens the changed files reach, compared with the pull request base or the push's start", () => {
    const steps = workflows["ci.yml"].jobs["browser"].steps
    assert.equal(steps.find((step) => String(step.uses).startsWith("actions/checkout@")).with["fetch-depth"], 0)
    const browser = steps.find((step) => step.id === "browser")
    const folder = mkdtempSync(join(tmpdir(), "browser-base-"))
    try {
        // A stand-in pnpm prints the commands the step runs
        writeFileSync(join(folder, "pnpm"), '#!/bin/sh\necho "pnpm $*"\n', { mode: 0o755 })
        const commands = (/** @type {Record<string, string>} */ event) =>
            spawnSync("bash", ["-e", "-c", browser.run], {
                encoding: "utf8",
                env: { PATH: `${folder}:${process.env.PATH}`, EVENT_NAME: "", PULL_REQUEST_BASE: "", PUSH_BEFORE: "", ...event },
            }).stdout.trim().split("\n")
        const screens = (/** @type {string} */ base) => [`pnpm --filter fluxerly-docs test:browser --changed --base=${base}`, "pnpm --filter fluxerly-docs test:versions"]
        assert.deepEqual(commands({ EVENT_NAME: "pull_request", PULL_REQUEST_BASE: "a".repeat(40) }), screens("a".repeat(40)))
        assert.deepEqual(commands({ EVENT_NAME: "push", PUSH_BEFORE: "b".repeat(40) }), screens("b".repeat(40)))
        // A new branch's push starts from all zeros
        assert.deepEqual(commands({ EVENT_NAME: "push", PUSH_BEFORE: "0".repeat(40) }), screens("origin/main"))
        assert.deepEqual(commands({ EVENT_NAME: "workflow_dispatch" }), screens("origin/main"))
    } finally {
        rmSync(folder, { recursive: true, force: true })
    }
    assert.equal(browser.env.PULL_REQUEST_BASE, "${{ github.event.pull_request.base.sha }}")
    assert.equal(browser.env.PUSH_BEFORE, "${{ github.event.before }}")
    assert.equal(browser.env.EVENT_NAME, "${{ github.event_name }}")
})

// Catches: A release preparation without a reusable Check that still ran the full screen check, which belongs to the
// Screens workflow, or that dropped the multi-version documentation check the package's docs snapshot depends on
test("Release preparation without a reusable Check runs only the multi-version documentation browser check", () => {
    const browser = workflows["release-prepare.yml"].jobs.prepare.steps.find((step) => step.id === "browser")
    assert.equal(browser.run.trim(), "pnpm --filter fluxerly-docs test:versions")
    assert.equal(browser.if, "steps.ci.outputs.reused == 'false'")
})

// Catches: A deploy delayed by the full screen check, or a push to main that changes what the website builds from
// without any run testing every screen
test("Screens tests every screen after pushes to main that change the website's inputs, and Website deploys without it", () => {
    const screens = workflows["screens.yml"]
    assert.deepEqual(screens.on.push.branches, ["main"])
    for (const input of [
        "projects/web/**",
        "projects/sdk/src/**",
        "projects/sdk/examples/**",
        "projects/sdk/package.json",
        "projects/sdk/CHANGELOG.md",
        "projects/release/upstream/**",
        "projects/pnpm-lock.yaml",
    ])
        assert.ok(screens.on.push.paths.includes(input), input)
    assert.ok(Object.hasOwn(screens.on, "workflow_dispatch"))
    const runs = Object.values(screens.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ""))
    assert.ok(runs.includes("pnpm build"), "Screens tests the site built from this commit")
    assert.ok(runs.includes("pnpm --filter fluxerly-docs test:browser"), "Screens tests every screen")
    // A version-only push skips the screen check, and a failed or skipped detection still runs it
    const check = screens.jobs.screens
    assert.equal(check.needs, "changes")
    for (const [versionOnly, runsCheck] of [["true", false], ["false", true], ["", true]])
        assert.equal(evaluate(check.if, { needs: { changes: { outputs: { version_only: versionOnly } } } }), runsCheck, versionOnly)
    const detect = screens.jobs.changes.steps.find((step) => step.id === "detect")
    assert.equal(detect.run, 'node projects/release/version-change.js detect --parent "$PUSH_BEFORE"')
    assert.equal(detect.env.PUSH_BEFORE, "${{ github.event.before }}")
    assert.equal(detect.if, "github.event_name == 'push'")
    assert.equal(screens.jobs.changes.outputs.version_only, "${{ steps.detect.outputs.version_only }}")
    assert.equal(screens.jobs.changes.steps.find((step) => step.id === "checkout").with["fetch-depth"], 2)
    for (const { where, step } of steps())
        if (where.startsWith("website.yml/"))
            assert.doesNotMatch(String(step.run ?? "") + String(step.uses ?? ""), /test:browser|playwright/i, `${where} runs no screen check`)
    assert.equal(workflows["website.yml"].jobs.deploy["timeout-minutes"], 30)
})

test("Nightly preparation runs at midnight and midday and starts only Release publish from main for an unskipped candidate", () => {
    const workflow = workflows["release-prepare.yml"]
    const [schedule] = workflow.on.schedule
    assert.equal(schedule.cron, "0 0,12 * * *")
    // GitHub reads schedules as UTC unless a timezone is named, so this keeps the runs at the same Berlin times all year
    assert.equal(schedule.timezone, "Europe/Berlin")
    assert.deepEqual(
        [workflow.on.workflow_dispatch.inputs.nightly.type, workflow.on.workflow_dispatch.inputs.nightly.default],
        ["boolean", false],
    )
    // Scheduled runs have no inputs, so the event alone must select nightly preparation and its shared queue
    const nightly = "github.event_name == 'schedule' || inputs.nightly"
    const candidate = workflow.jobs.prepare.steps.find((step) => step.id === "candidate")
    assert.equal(candidate.env.RELEASE_NIGHTLY, `\${{ ${nightly} }}`)
    // The github context has no run start time, so the step dates the version with its own UTC clock, read once for
    // both planning and preparation. The helper loads only for a nightly, so the step itself still runs for an older RC or
    // Stable source, which must include dated nightly support once a dated nightly is published
    assert.equal(candidate.env.RELEASE_NIGHTLY_STARTED_AT, undefined)
    assert.ok(!candidate.run.includes("run_started_at"), "The github context has no run_started_at")
    assert.ok(!/^\s*import \{[^}]*nightlyDateOf/m.test(candidate.run), "nightlyDateOf must not be a static import")
    assert.equal(candidate.run.match(/nightlyDateOf\(new Date\(\)\.toISOString\(\)\)/g)?.length, 1)
    // Its number is the run number
    assert.equal(candidate.env.RELEASE_NIGHTLY_NUMBER, "${{ github.run_number }}")
    // An unreviewed nightly must build the workflow commit that Release publish checks against main, never source_ref
    const checkout = workflow.jobs.prepare.steps.find((step) => step.id === "checkout")
    assert.equal(checkout.with.ref, `\${{ (${nightly}) && github.sha || inputs.source_ref }}`)
    assert.ok(workflow.concurrency.group.includes(`(${nightly}) && 'nightly'`), workflow.concurrency.group)
    const outputs = workflow.jobs.prepare.outputs
    assert.deepEqual(Object.keys(outputs).sort(), ["checksum", "skipped"])
    for (const key of ["skipped", "checksum"])
        assert.equal(outputs[key], `\${{ steps.candidate.outputs.${key} }}`, key)
    const job = workflow.jobs.publish
    assert.equal(job.needs, "prepare")
    // Both channels publish after successful preparation. A skipped run has no candidate
    assert.equal(job.if, "needs.prepare.outputs.skipped == 'false'")
    // Node is set up only for the job summary, without installing the workspace
    assert.equal(job.steps.find((step) => step.id === "setup").with.install, false)
    const runs = job.steps.filter((step) => step.run)
    assert.equal(runs.length, 1, "The publish job runs only its dispatch")
    const [dispatch] = runs
    assert.doesNotMatch(dispatch.run, /\b(install|pnpm|npm|node)\b/)
    assert.deepEqual(dispatch.env, {
        GH_TOKEN: "${{ github.token }}",
        PREPARATION_RUN_ID: "${{ github.run_id }}",
        CANDIDATE_CHECKSUM: "${{ needs.prepare.outputs.checksum }}",
    })
    // Run the dispatch against a fake gh to read the exact arguments it receives
    const checksum = "c".repeat(64)
    const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", 'gh() { printf "%s\\n" "$@"; }\n' + dispatch.run], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        env: { ...process.env, GITHUB_REPOSITORY: "owner/repo", PREPARATION_RUN_ID: "30", CANDIDATE_CHECKSUM: checksum },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
        "workflow", "run", "release-publish.yml", "--repo", "owner/repo", "--ref", "main",
        "-f", "preparation_run_id=30", "-f", `candidate_checksum=${checksum}`,
    ])
    // The dispatched fields are exactly the inputs Release publish accepts
    assert.deepEqual(Object.keys(workflows["release-publish.yml"].on.workflow_dispatch.inputs).sort(), [
        "candidate_checksum",
        "preparation_run_id",
    ])
})

// Catches: Stable losing its automatic dispatch, or a checksum being replaced between preparation and gh
test("Stable and nightly dispatch their own preparation run and the checksum read from the candidate", () => {
    const workflow = workflows["release-prepare.yml"]
    const prepare = workflow.jobs.prepare
    const publish = workflow.jobs.publish
    assert.deepEqual(publish.permissions, { contents: "read", actions: "write" })
    const candidate = prepare.steps.find((step) => step.id === "candidate")
    const dispatch = publish.steps.find((step) => step.id === "dispatch")
    const script = candidate.run.match(/node --input-type=module <<'NODE'\n([\s\S]*)\nNODE/)[1]
        .replace(/^import .*\n/gm, "")
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-auto-publish-"))
    try {
        for (const [index, [event, nightly, channel]] of [
            ["workflow_dispatch", false, "stable"],
            ["workflow_dispatch", true, "nightly"],
            ["schedule", false, "nightly"],
        ].entries()) {
            const source = "a".repeat(40)
            const checksum = String(index + 1).repeat(64)
            const output = join(directory, `outputs-${index}`)
            // External commands and candidate reading are fixtures. Execute the workflow's actual output-writing code
            // Nightly planning's dynamic import reads its real date helper, without calling a registry
            const fixtures = `
                import { appendFileSync } from 'node:fs'
                import { join } from 'node:path'
                const execFileSync = (command, args) => {
                    if (command === 'git') return '${source}'
                    if (args[0] === 'release:plan') return JSON.stringify({ version: '1001.0.0-nightly.20261104.1' })
                    return JSON.stringify({ skipped: false })
                }
                const readCandidate = async () => ({ sourceCommit: '${source}', docs: {}, version: '1001.0.0', channel: '${channel}', checksum: '${checksum}' })
            `
            const prepared = spawnSync(process.execPath, ["--input-type=module"], {
                cwd: join(repository, "projects"), input: fixtures + script, encoding: "utf8", timeout: 10_000,
                env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "41", RELEASE_NIGHTLY: String(channel === "nightly"), RELEASE_LINE: "", RELEASE_NIGHTLY_NUMBER: "1" },
            })
            assert.ifError(prepared.error)
            assert.equal(prepared.status, 0, prepared.stderr)
            const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
                const split = line.indexOf("=")
                return [line.slice(0, split), line.slice(split + 1)]
            }))
            const context = { github: { event_name: event, run_id: "41", token: "synthetic" }, inputs: { nightly }, steps: { candidate: { outputs: values } } }
            const outputs = Object.fromEntries(Object.entries(prepare.outputs).map(([key, value]) => [key, evaluate(value, context)]))
            context.needs = { prepare: { outputs } }
            assert.equal(evaluate(publish.if, context), true, `${channel} must start publication`)
            const env = Object.fromEntries(Object.entries(dispatch.env).map(([key, value]) => [key, evaluate(value, context)]))
            const sent = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", 'gh() { printf "%s\\n" "$@"; }\n' + dispatch.run], {
                encoding: "utf8", timeout: 10_000, windowsHide: true,
                env: { ...process.env, ...env, GITHUB_REPOSITORY: "owner/repo" },
            })
            assert.ifError(sent.error)
            assert.equal(sent.status, 0, sent.stderr)
            assert.deepEqual(sent.stdout.trim().split(/\r?\n/), [
                "workflow", "run", "release-publish.yml", "--repo", "owner/repo", "--ref", "main",
                "-f", "preparation_run_id=41", "-f", `candidate_checksum=${checksum}`,
            ])
            assert.match(values.publish_command, new RegExp(`-f preparation_run_id=41 -f candidate_checksum=${checksum}$`))
            for (const skipped of ["true", ""]) {
                outputs.skipped = skipped
                assert.equal(evaluate(publish.if, context), false, "No candidate must not dispatch")
            }
        }
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("Version pull requests have no channel input and derive readiness from the epoch", () => {
    const workflow = workflows["release-version.yml"]
    assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ["epoch", "line", "source_ref"])
    const version = workflow.jobs.version.steps.find((step) => step.id === "version")
    assert.equal(version.env.RELEASE_CHANNEL, "${{ inputs.epoch && 'nightly' || 'stable' }}")
    assert.equal(version.env.RELEASE_EPOCH, "${{ inputs.epoch }}")
})


test("Release and website work is serialized with read-only caches and never cancelled mid-run", () => {
    for (const file of ["release-prepare.yml", "release-version.yml", "release-publish.yml", "website.yml", "screens.yml"])
        assert.equal(workflows[file]["cache-mode"], "read", `${file} cache access`)
    for (const file of ["release-prepare.yml", "release-version.yml", "website.yml"])
        assert.equal(workflows[file].concurrency["cancel-in-progress"], false, file)
    assertSerialized(workflows["release-publish.yml"].jobs.reconcile.concurrency, "release-publish.yml/reconcile")
})

// Catches: A merged version pull request whose Check runs keep going, a version branch whose runs share no group with
// Version PR closed, a fork branch that can cancel them, or a manual dispatch that a later run cancels
test("Check runs of a version branch share one group, which a newer run or a closed version PR cancels", () => {
    const { concurrency } = workflows["ci.yml"]
    const closed = workflows["version-pr-closed.yml"]
    const repository = "owner/repo"
    const pull = (head, repo = repository, action = "synchronize") => ({
        github: {
            event_name: "pull_request", repository, head_ref: head, ref: "refs/pull/7/merge", ref_name: "7/merge", run_id: 11,
            event: { action, pull_request: { head: { repo: { full_name: repo } } } },
        },
    })
    const dispatch = (branch) => ({
        github: { event_name: "workflow_dispatch", repository, head_ref: "", ref: `refs/heads/${branch}`, ref_name: branch, run_id: 12, event: {} },
    })
    const push = { github: { event_name: "push", repository, head_ref: "", ref: "refs/heads/main", ref_name: "main", run_id: 13, event: {} } }
    const group = (context) => evaluate(concurrency.group, context)
    const cancels = (context) => evaluate(concurrency["cancel-in-progress"], context)
    const version = "check-version-release/version-1001.0.0"
    assert.equal(group(pull("release/version-1001.0.0")), version)
    assert.equal(group(dispatch("release/version-1001.0.0")), version)
    assert.equal(evaluate(closed.concurrency.group, pull("release/version-1001.0.0", repository, "closed")), version)
    assert.equal(closed.concurrency["cancel-in-progress"], true)
    assert.deepEqual(closed.on, { pull_request: { types: ["closed"] } })
    assert.equal(cancels(dispatch("release/version-1001.0.0")), true)
    assert.equal(evaluate(closed.jobs.cancel.if, pull("release/version-1001.0.0", repository, "closed")), true)
    // A fork's branch of the same name joins no group of this repository's version branch
    assert.notEqual(group(pull("release/version-1001.0.0", "fork/repo")), version)
    assert.notEqual(evaluate(closed.concurrency.group, pull("release/version-1001.0.0", "fork/repo", "closed")), version)
    assert.equal(evaluate(closed.jobs.cancel.if, pull("release/version-1001.0.0", "fork/repo", "closed")), false)
    assert.notEqual(evaluate(closed.concurrency.group, pull("feature", repository, "closed")), group(pull("feature")))
    // Other runs keep their groups, and other manual dispatches are never cancelled by a later run
    assert.equal(group(pull("feature")), "check-pull_request-refs/pull/7/merge")
    assert.equal(group(push), "check-push-refs/heads/main")
    assert.equal(cancels(push), true)
    assert.equal(group(dispatch("main")), "check-workflow_dispatch-12")
    assert.equal(cancels(dispatch("main")), false)
})

test("Release and website workflows only restore Fluxer's pinned files that CI saves, under the same key", () => {
    const fluxerCache = (/** @type {any} */ step) => step.with?.path === "projects/web/.cache/fluxer"
    const saved = [...steps()].filter(({ where, step }) => where.startsWith("ci.yml/") && fluxerCache(step))
    assert.ok(saved.length >= 1)
    const key = saved[0].step.with.key
    assert.equal(key, "fluxer-source-${{ hashFiles('projects/release/upstream/manifest.json') }}")
    for (const file of ["release-prepare.yml", "release-version.yml", "release-publish.yml", "website.yml", "screens.yml"])
        for (const { where, step } of steps())
            if (where.startsWith(`${file}/`) && String(step.uses).startsWith("actions/cache"))
                assert.match(step.uses, /^actions\/cache\/restore@/, `${where} may restore a cache but never save one`)
    for (const file of ["release-prepare.yml", "website.yml", "screens.yml"]) {
        const restored = [...steps()].filter(({ where, step }) => where.startsWith(`${file}/`) && fluxerCache(step))
        assert.equal(restored.length, 1, file)
        assert.equal(restored[0].step.with.key, key, `${file} restores what CI saves`)
    }
})

test("GitHub downloads that repeat are kept: release snapshots by CI for the website, upstream files by the drift job", () => {
    const releases = (/** @type {any} */ step) => step.with?.path === "projects/web/.cache/releases"
    const website = workflows["website.yml"].jobs.deploy.steps
    const restore = website.find(releases)
    assert.match(restore.uses, /^actions\/cache\/restore@/, "The website workflow only restores")
    assert.equal(restore.with["restore-keys"], "release-snapshots-")
    assert.ok(website.indexOf(restore) < website.findIndex((step) => step.id === "snapshots"), "Restored before the import")
    const browser = workflows["ci.yml"].jobs.browser.steps
    const kept = browser.filter(releases)
    assert.deepEqual(kept.map((step) => step.uses.split("@")[0]), ["actions/cache/restore", "actions/cache/save"])
    const fill = browser.find((step) => step.id === "release_snapshots")
    assert.equal(fill.run, "node web/scripts/fetch-releases.js --cache-only")
    assert.equal(fill["continue-on-error"], true, "A failed read costs a deploy downloads, not the Check")
    assert.ok(browser.indexOf(kept[0]) < browser.indexOf(fill) && browser.indexOf(fill) < browser.indexOf(kept[1]))
    assert.match(kept[1].with.key, /^release-snapshots-\$\{\{ hashFiles\('projects\/web\/\.cache\/releases\/\*\.json'\) \}\}$/)

    const drift = workflows["upstream-drift.yml"].jobs.drift.steps
    const upstream = drift.filter((/** @type {any} */ step) => step.with?.path === "projects/release/.cache/upstream" && String(step.uses).startsWith("actions/cache"))
    assert.deepEqual(upstream.map((step) => step.uses.split("@")[0]), ["actions/cache/restore", "actions/cache/save"])
    const compare = drift.findIndex((step) => step.id === "drift")
    assert.ok(drift.indexOf(upstream[0]) < compare && compare < drift.indexOf(upstream[1]))
    // The cache drops an entry unused for seven days or when the cache space fills up. The trusted run that set the baseline
    // retained the same files for 90 days, and only a cache miss reads them
    const fallback = drift.find((step) => step.id === "upstream_artifact")
    assert.equal(fallback.if, "steps.upstream_cache.outputs.cache-matched-key == '' && steps.baseline.outputs.run_id != ''")
    assert.equal(fallback.env.RUN_ID, "${{ steps.baseline.outputs.run_id }}")
    assert.ok(drift.indexOf(upstream[0]) < drift.indexOf(fallback) && drift.indexOf(fallback) < compare)
    const retained = drift.find((step) => step.with?.name === "upstream-source")
    assert.match(retained.uses, /^actions\/upload-artifact@/)
    assert.equal(retained.with.path, "projects/release/.cache/upstream")
    assert.equal(retained.with["retention-days"], 90)
    assert.ok(compare < drift.indexOf(retained))
    assert.equal(workflows["upstream-drift.yml"].jobs.report.steps.some((step) => step.with?.name === "upstream-source"), false, "The posting job never handles source files")

    // Workflow lint tools: actionlint's release archive, checked against its checksum on every use, and zizmor's wheel,
    // which pip checks against the action's pinned hashes
    const lint = workflows["ci.yml"].jobs.workflows.steps
    const actionlintCache = lint.find((step) => step.id === "actionlint_cache")
    const actionlint = lint.find((step) => step.id === "actionlint")
    assert.match(actionlintCache.uses, /^actions\/cache@/)
    assert.equal(actionlintCache.with.path, "${{ runner.temp }}/actionlint")
    const [, version, checksum] = actionlintCache.with.key.match(/^actionlint-([\d.]+)-linux-amd64-([a-f0-9]{64})$/)
    assert.ok(actionlint.run.includes(`releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz`))
    assert.equal(actionlint.run.match(new RegExp(checksum, "g"))?.length, 1)
    assert.ok(lint.indexOf(actionlintCache) < lint.indexOf(actionlint))
    const zizmorCache = lint.find((step) => step.id === "zizmor_cache")
    const zizmor = lint.find((step) => step.id === "zizmor")
    assert.equal(zizmorCache.with.path, "~/.cache/pip")
    assert.equal(zizmorCache.with.key, `zizmor-pip-\${{ runner.os }}-${zizmor.with.version}`)
    assert.ok(lint.indexOf(zizmorCache) < lint.indexOf(zizmor))

    // Release preparation restores Check's browser download under the same key, and installs Chromium only on a miss
    const browserKey = (/** @type {any[]} */ list) => list.find((step) => step.id === "browser_cache")
    const prepare = workflows["release-prepare.yml"].jobs.prepare.steps
    assert.match(browserKey(prepare).uses, /^actions\/cache\/restore@/)
    assert.equal(browserKey(prepare).with.key, browserKey(browser).with.key)
    assert.equal(browserKey(prepare).with.path, browserKey(browser).with.path)
    assert.equal(prepare.find((step) => step.id === "playwright").run, browser.find((step) => step.id === "playwright").run)
    assert.equal(prepare.find((step) => step.id === "browser_install").run, browser.find((step) => step.id === "browser_install").run)
    assert.ok(prepare.findIndex((step) => step.id === "browser_cache") < prepare.findIndex((step) => step.id === "browser_install"))
    for (const id of ["playwright", "browser_cache", "browser_install"]) assert.equal(prepare.find((step) => step.id === id).if, "steps.ci.outputs.reused == 'false'", id)
})

// Catches: A preparation without a Check that skipped a floor Node guard CI runs, or a reused preparation that built the
// website it never reads
test("Release preparation builds only the SDK it reads and its fallback runs every floor Node check CI runs", () => {
    const prepare = workflows["release-prepare.yml"].jobs.prepare.steps
    assert.equal(prepare.find((step) => step.id === "build").run, "pnpm --filter @neontechspace/fluxerly build")
    const floor = prepare.find((step) => step.id === "floor").run
    const ci = workflows["ci.yml"].jobs.consumers.steps.filter((step) => step.if === "matrix.runtime" && step.run)
    assert.ok(ci.length >= 3)
    for (const step of ci) assert.ok(floor.includes(step.run), `The fallback runs ${step.run}`)
})

test("A lint run uses a kept actionlint archive only when it matches the pinned checksum, and downloads and checks it otherwise", () => {
    const actionlint = workflows["ci.yml"].jobs.workflows.steps.find((step) => step.id === "actionlint")
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-actionlint-"))
    const [, checksum] = actionlint.run.match(/checksum="([a-f0-9]{64}) /)
    // A fake curl that writes the bytes in FAKE_BYTES, and a sha256sum that accepts only those named in GOOD_BYTES
    const fakes = `
      curl() { printf 'curl\n' >> "$CALLS"; while [[ "$1" != "--output" ]]; do shift; done; printf '%s' "$FAKE_BYTES" > "$2"; }
      sha256sum() { local line; read -r line; local file="\${line#*  }"; [[ -f "$file" && "$(cat "$file")" == "$GOOD_BYTES" && "\${line%%  *}" == "${checksum}" ]]; }
      tar() { printf 'tar %s\n' "$4" >> "$CALLS"; }
      ./actionlint() { printf 'lint\n' >> "$CALLS"; }
    `
    const run = ({ kept, fetched }) => {
        const temporary = join(directory, `${kept ?? "none"}-${fetched}`)
        const calls = join(temporary, "calls")
        mkdirSync(join(temporary, "actionlint"), { recursive: true })
        const archive = join(temporary, "actionlint/actionlint_1.7.12_linux_amd64.tar.gz")
        if (kept) writeFileSync(archive, kept)
        const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", fakes + actionlint.run.replace("./actionlint -color", "./actionlint")], {
            cwd: temporary,
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
            env: { ...process.env, RUNNER_TEMP: temporary, CALLS: calls, FAKE_BYTES: fetched, GOOD_BYTES: "release" },
        })
        assert.ifError(result.error)
        return { status: result.status, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [], archive: readFileSync(archive, "utf8") }
    }
    try {
        assert.deepEqual(run({ kept: "release", fetched: "unused" }), { status: 0, calls: [`tar ${join(directory, "release-unused/actionlint/actionlint_1.7.12_linux_amd64.tar.gz")}`, "lint"], archive: "release" })
        const damaged = run({ kept: "damaged", fetched: "release" })
        assert.equal(damaged.status, 0)
        assert.deepEqual(damaged.calls.map((call) => call.split(" ")[0]), ["curl", "tar", "lint"])
        assert.equal(damaged.archive, "release")
        assert.deepEqual(run({ fetched: "release" }).calls.map((call) => call.split(" ")[0]), ["curl", "tar", "lint"])
        const tampered = run({ fetched: "tampered" })
        assert.notEqual(tampered.status, 0, "A download that fails its checksum never runs")
        assert.deepEqual(tampered.calls, ["curl"])
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("A cache miss in the drift job reads the trusted run's kept files, and a failed read is reported and downloads instead", () => {
    const fallback = workflows["upstream-drift.yml"].jobs.drift.steps.find((step) => step.id === "upstream_artifact")
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-drift source-"))
    const fakeGh = `gh() {
      [[ "$1 $2 $3 $4 $5 $6 $7 $8" == "run download 10 --repo owner/repo --name upstream-source --dir" ]] || return 1
      [[ "$GH_FAIL" != 1 ]] || return 1
      printf 'kept' > "$9/${"a".repeat(40)}"
    }\n`
    try {
        for (const fail of ["", "1"]) {
            const temporary = join(directory, fail ? "failed" : "read")
            mkdirSync(temporary)
            const summary = join(temporary, "summary.md")
            const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", fakeGh + fallback.run], {
                cwd: temporary,
                encoding: "utf8",
                timeout: 10_000,
                windowsHide: true,
                env: { ...process.env, RUN_ID: "10", GITHUB_REPOSITORY: "owner/repo", GITHUB_STEP_SUMMARY: summary, GH_FAIL: fail },
            })
            assert.ifError(result.error)
            assert.equal(result.status, 0, result.stderr)
            assert.equal(existsSync(join(temporary, "projects/release/.cache/upstream", "a".repeat(40))), !fail)
            assert.equal(existsSync(summary), Boolean(fail), "Only a failed read is reported")
            if (fail) assert.match(readFileSync(summary, "utf8"), /downloaded again/)
        }
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

// Catches: A gate that passes with a skipped required job, or a version-only pass with only some jobs skipped for it
test("The required CI gate needs every job and rejects failed, cancelled, skipped and missing results", () => {
    const ci = workflows["ci.yml"]
    const check = ci.jobs.check
    const gated = Object.keys(ci.jobs).filter((id) => !["check", "release-trigger"].includes(id))
    assert.deepEqual([...check.needs].sort(), gated.sort())
    assert.equal(check.if, "always()")
    const groups = Object.keys(check.steps[0].env).filter((key) => key.endsWith("_RESULT") && key !== "REUSE_RESULT")
    assert.equal(groups.length, gated.length - 1, "Every check job result reaches the gate")
    // Check jobs skip for a reused result, and all but the tooling job for a version-only change. A failed lookup, which
    // reports neither, still runs them
    const outputs = (reused, versionOnly) => ({ needs: { reuse: { outputs: { reused, version_only: versionOnly } } } })
    for (const id of gated.filter((id) => id !== "reuse")) {
        const job = ci.jobs[id]
        assert.equal(job.needs, "reuse", id)
        assert.equal(evaluate(job.if, outputs("", "")), true, id)
        assert.equal(evaluate(job.if, outputs("false", "false")), true, id)
        assert.equal(evaluate(job.if, outputs("true", "false")), false, id)
        assert.equal(evaluate(job.if, outputs("false", "true")), id === "tooling", id)
        assert.equal(evaluate(job.if, outputs("", ""), { cancelled: true }), false, id)
    }
    // The lookup compares with the parent commit and hands both results to the jobs and the gate
    const reuse = ci.jobs.reuse
    assert.equal(reuse.steps.find((step) => step.id === "checkout").with["fetch-depth"], 2)
    assert.equal(reuse.outputs.version_only, "${{ steps.reuse.outputs.version_only }}")
    assert.equal(reuse.outputs.parent_run_url, "${{ steps.reuse.outputs.parent_run_url }}")
    assert.equal(check.steps[0].env.VERSION_ONLY, "${{ needs.reuse.outputs.version_only }}")
    assert.equal(check.steps[0].env.PARENT_RUN_URL, "${{ needs.reuse.outputs.parent_run_url }}")
    // The version-only steps run only for a version-only change
    for (const id of ["version", "format"]) {
        const step = ci.jobs.tooling.steps.find((step) => step.id === id)
        assert.equal(evaluate(step.if, outputs("false", "true")), true, id)
        assert.equal(evaluate(step.if, outputs("false", "false")), false, id)
    }
    // Those skipped jobs make the implicit success() condition false, so the release trigger reads check's own result
    assert.match(ci.jobs["release-trigger"].if, /^\$\{\{ !cancelled\(\) && needs\.check\.result == 'success' && /)
    const passed = { ...Object.fromEntries(groups.map((key) => [key, "success"])), REUSE_RESULT: "success", REUSED_RUN_URL: "" }
    const skipped = Object.fromEntries(groups.map((key) => [key, "skipped"]))
    const reused = { REUSE_RESULT: "success", REUSED_RUN_URL: "https://github.com/owner/repo/actions/runs/1" }
    const versionOnly = {
        ...skipped,
        TOOLING_RESULT: "success",
        REUSE_RESULT: "success",
        REUSED_RUN_URL: "",
        VERSION_ONLY: "true",
        PARENT_RUN_URL: "https://github.com/owner/repo/actions/runs/2",
    }
    // [results, expected exit status]
    const cases = [
        [passed, 0],
        // A failed reuse lookup is harmless once the full check jobs passed
        [{ ...passed, REUSE_RESULT: "failure" }, 0],
        [{ ...skipped, ...reused }, 0],
        [{ ...skipped, ...reused, REUSE_RESULT: "failure" }, 1],
        [{ ...skipped, REUSE_RESULT: "success", REUSED_RUN_URL: "" }, 1],
        [versionOnly, 0],
        // A version-only claim from a failed lookup job or without the parent's passing Check is not trusted
        [{ ...versionOnly, REUSE_RESULT: "failure" }, 1],
        [{ ...versionOnly, PARENT_RUN_URL: "" }, 1],
        [{ ...versionOnly, VERSION_ONLY: "false" }, 1],
    ]
    for (const key of groups)
        for (const result of ["failure", "cancelled", "skipped", ""]) cases.push([{ ...passed, [key]: result }, 1])
    for (const result of ["failure", "cancelled", "skipped", ""]) cases.push([{ ...versionOnly, TOOLING_RESULT: result }, 1])
    // Every other job must have been skipped for the version-only change
    for (const key of groups.filter((key) => key !== "TOOLING_RESULT"))
        for (const result of ["success", "failure", "cancelled", ""]) cases.push([{ ...versionOnly, [key]: result }, 1])
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

test("Upstream drift runs on Monday, Wednesday and Friday, compares read-only and retains the observation only after a small job posts it", () => {
    const workflow = workflows["upstream-drift.yml"]
    const [schedule] = workflow.on.schedule
    assert.equal(schedule.cron, "0 0 * * 1,3,5")
    // Midnight in Berlin all year, as the nightly schedule keeps its Berlin times
    assert.equal(schedule.timezone, "Europe/Berlin")
    assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"))
    assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" })
    assertSerialized(workflow.concurrency, "upstream-drift.yml")
    assert.deepEqual(Object.keys(workflow.jobs), ["drift", "report"])
    const job = workflow.jobs.drift
    assert.equal(job.permissions, undefined, "The comparison runs package tooling, so it stays read-only")
    const restore = job.steps.find((step) => step.id === "baseline")
    const compare = job.steps.find((step) => step.id === "drift")
    const handoff = job.steps.find((step) => String(step.uses).startsWith("actions/upload-artifact@"))
    assert.equal(restore.shell, "bash")
    assert.equal(restore.env.GH_TOKEN, "${{ github.token }}")
    assert.equal(compare.shell, "bash")
    assert.equal(compare["working-directory"], "projects")
    assert.equal(compare.env.GITHUB_TOKEN, "${{ github.token }}")
    assert.equal(handoff.if, undefined, "A broken check must not reach the posting job")
    assert.notEqual(handoff.with.name, "upstream-baseline", "A report that was not posted must not become the next baseline")
    assert.ok(job.steps.indexOf(restore) < job.steps.indexOf(compare))
    assert.ok(job.steps.indexOf(compare) < job.steps.indexOf(handoff))

    const report = workflow.jobs.report
    assert.equal(report.needs, "drift")
    assert.deepEqual(report.permissions, { issues: "write" })
    // Nothing from the repository or a package manager runs beside the write token
    assert.ok(report.steps.filter((step) => step.uses).every((step) => /^actions\/(download|upload)-artifact@/.test(step.uses)))
    const download = report.steps.find((step) => String(step.uses).startsWith("actions/download-artifact@"))
    const post = report.steps.find((step) => step.id === "post")
    const retain = report.steps.find((step) => String(step.uses).startsWith("actions/upload-artifact@"))
    assert.equal(download.with.name, handoff.with.name)
    assert.equal(download.with.path, handoff.with.path)
    assert.ok(report.steps.indexOf(download) < report.steps.indexOf(post))
    assert.ok(report.steps.indexOf(post) < report.steps.indexOf(retain))
    assert.equal(post.if, undefined)
    assert.equal(retain.if, undefined, "A failed post must keep the old baseline, so the next run repeats its changes")
    assert.equal(retain.with.name, "upstream-baseline")
    assert.equal(retain.with.path, `${download.with.path}/baseline.json`)
    assert.equal(retain.with["retention-days"], 90)
    assert.equal(retain.with["if-no-files-found"], "error")
    assert.equal(retain.with.overwrite, true, "A rerun renews its observation instead of leaving stale bytes")
    const existingUpload = workflows["release-prepare.yml"].jobs.prepare.steps.find((step) => String(step.uses).startsWith("actions/upload-artifact@"))
    assert.equal(retain.uses, existingUpload.uses)
    assert.equal(handoff.uses, existingUpload.uses)
})

test("Upstream posting comments on the open bot issue, opens an explained one when none is open, skips an empty week and fails on a failed post", () => {
    const post = workflows["upstream-drift.yml"].jobs.report.steps.find((step) => step.id === "post")
    assert.equal(post.shell, "bash")
    assert.equal(post.env.GH_TOKEN, "${{ github.token }}")
    assert.equal(post.env.TITLE, "Fluxer upstream changes to review")
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-drift post-"))
    const comment = join(directory, "upstream-current/comment.md")
    const body = join(directory, "upstream-current/issue.md")
    const calls = join(directory, "calls")
    // The lookup prints the open issue's number, or nothing. GH_FAIL names the call kind that fails
    const fakeGh = `gh() {
      printf '%s\\n' "$@" >> "$GH_CALLS"
      if [[ "$2" != "--method" ]]; then [[ "$GH_FAIL" != lookup ]] || return 1; printf '%s' "$GH_FOUND"; return 0; fi
      [[ "$GH_FAIL" != post ]]
    }\n`
    const run = ({ found = "", fail = "" } = {}) => {
        rmSync(calls, { force: true })
        const output = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", fakeGh + post.run], {
            cwd: directory,
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
            env: {
                ...process.env,
                TITLE: post.env.TITLE,
                RUNNER_TEMP: directory,
                GITHUB_REPOSITORY: "owner/repo",
                GITHUB_SERVER_URL: "https://github.com",
                GITHUB_STEP_SUMMARY: join(directory, "posting-summary.md"),
                GH_CALLS: calls,
                GH_FOUND: found,
                GH_FAIL: fail,
            },
        })
        assert.ifError(output.error)
        return output
    }
    const lookup = [
        "api", "repos/owner/repo/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100",
        "--jq", "[.[] | select(.pull_request == null and .title == $ENV.TITLE)][0].number // empty",
    ]
    try {
        mkdirSync(join(directory, "upstream-current"))
        assert.equal(run().status, 0)
        assert.equal(existsSync(calls), false, "A week with nothing new posts nothing")
        writeFileSync(comment, "## Upstream Fluxer drift\n\nReport\n")
        assert.equal(run({ found: "7" }).status, 0)
        assert.deepEqual(readFileSync(calls, "utf8").trim().split(/\r?\n/), [
            ...lookup, "api", "--method", "POST", "repos/owner/repo/issues/7/comments", "--silent", "-F", `body=@${comment}`,
        ])
        assert.equal(run().status, 0)
        assert.deepEqual(readFileSync(calls, "utf8").trim().split(/\r?\n/), [
            ...lookup, "api", "--method", "POST", "repos/owner/repo/issues", "--silent", "-f", "title=Fluxer upstream changes to review", "-F", `body=@${body}`,
        ])
        const opened = readFileSync(body, "utf8")
        assert.match(opened, /^This issue collects the reports of the \[upstream drift check\]\(https:\/\/github\.com\/owner\/repo\/actions\/workflows\/upstream-drift\.yml\)/)
        assert.match(opened, /then close this issue\. The next report opens a new one\n\n## Upstream Fluxer drift\n\nReport\n$/)
        assert.notEqual(run({ fail: "lookup" }).status, 0, "A failed lookup stops the job before the observation is retained")
        assert.notEqual(run({ found: "7", fail: "post" }).status, 0, "A failed comment stops the job before the observation is retained")
        assert.notEqual(run({ fail: "post" }).status, 0, "A failed new issue stops the job before the observation is retained")
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("Upstream artifact restoration selects the newest earlier trusted run of this workflow and reports every retrieval fallback", () => {
    const restore = workflows["upstream-drift.yml"].jobs.drift.steps.find((step) => step.id === "baseline")
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-artifacts-"))
    // Run fields are path, event, branch, source repository and conclusion, joined by unit separators as the step reads
    // them. Runs 21 to 25 have newer artifacts from this workflow file, but none may set the baseline
    const fakeGh = `
      run() { local IFS=$'\\x1f'; printf '%s\\n' "$*"; }
      drift=.github/workflows/upstream-drift.yml
      gh() {
        if [[ "$1" == "api" && "$2" == "--paginate" ]]; then
          [[ "$3" == "repos/owner/repo/actions/artifacts?name=upstream-baseline&per_page=100" && "$4" == "--jq" ]] || return 1
          case "$SCENARIO" in
            lookup-failure) return 1 ;;
            no-artifact) return 0 ;;
            invalid-run) printf '2026-10-03T00:00:00Z\\t100\\tnull\\n' ;;
            *)
              printf '2026-10-01T00:00:00Z\\t90\\t9\\n2026-10-03T00:00:00Z\\t300\\t30\\n2026-10-02T00:00:00Z\\t200\\t10\\n2026-10-03T00:00:00Z\\t250\\t20\\n'
              for run in 21 22 23 24 25; do printf '2026-10-02T12:00:00Z\\t2%s\\t%s\\n' "$run" "$run"; done ;;
          esac
        elif [[ "$1" == "api" && "$2" == "repos/owner/repo" ]]; then
          [[ "$SCENARIO" != "branch-failure" ]] && printf 'main\\n'
        elif [[ "$1" == "api" ]]; then
          case "\${2##*/}" in
            20) run .github/workflows/other.yml schedule main owner/repo success ;;
            21) run "$drift" pull_request main owner/repo success ;;
            22) run "$drift" workflow_dispatch feature owner/repo success ;;
            23) run "$drift" schedule main fork/repo success ;;
            24) run "$drift" schedule main owner/repo failure ;;
            25) run "$drift" schedule main "" success ;;
            10)
              case "$SCENARIO" in
                verification-failure) return 1 ;;
                missing-path) run "" schedule main owner/repo success ;;
                *) run "$drift" schedule main owner/repo success ;;
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
        for (const scenario of ["available", "lookup-failure", "branch-failure", "no-artifact", "invalid-run", "verification-failure", "missing-path", "download-failure", "missing-file"]) {
            const temporary = join(directory, scenario)
            const summary = join(directory, `${scenario}.md`)
            const output = join(directory, `${scenario}.output`)
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
                    GITHUB_OUTPUT: output,
                },
            })
            assert.ifError(result.error)
            assert.equal(result.status, 0, `${scenario}: ${result.stderr}`)
            // The trusted run also names the kept upstream files a cache miss restores
            const trusted = ["available", "download-failure", "missing-file"].includes(scenario)
            assert.equal(existsSync(output) ? readFileSync(output, "utf8") : "", trusted ? "run_id=10\n" : "", scenario)
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

test("Upstream comparison passes distinct baseline, record and comment paths to the CLI without shell splitting", () => {
    const compare = workflows["upstream-drift.yml"].jobs.drift.steps.find((step) => step.id === "drift")
    const handoff = workflows["upstream-drift.yml"].jobs.drift.steps.find((step) => String(step.uses).startsWith("actions/upload-artifact@"))
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-drift args-"))
    const output = handoff.with.path.replace("${{ runner.temp }}", directory)
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
            "release/upstream.js",
            "--baseline", `${directory}/upstream-previous/baseline.json`,
            "--record", `${output}/baseline.json`,
            "--comment", `${output}/comment.md`,
        ])
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("Effect drift checks the SDK only with a newer release that pnpm resolves from the peer range", () => {
    const workflow = workflows["effect-drift.yml"]
    const [minute, hour, day, month, weekday] = workflow.on.schedule[0].cron.split(" ")
    assert.deepEqual([day, month, weekday], ["*", "*", "*"])
    assert.ok(Number(minute) > 0 && Number(minute) < 60 && Number(minute) !== 30)
    assert.ok(Number(hour) >= 0 && Number(hour) < 24)
    assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"))
    assert.deepEqual(workflow.permissions, { contents: "read" })
    assert.equal(workflow["cache-mode"], "read", "The unreviewed Effect upgrade must not reach a shared cache")
    assertSerialized(workflow.concurrency, "effect-drift.yml")
    const { steps } = workflow.jobs.drift
    assert.equal(steps.find((step) => step.id === "setup").with["require-lockfile"], true)
    for (const id of ["build", "types", "test"])
        assert.equal(steps.find((step) => step.id === id).if, "steps.resolve.outputs.changed == 'true'", id)
    const resolve = steps.find((step) => step.id === "resolve")
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-effect-drift-"))
    // The fake pnpm records its arguments and installs the version the registry would resolve
    const fakePnpm = `
      pnpm() {
        printf '%s\\n' "$@" > "$PNPM_ARGS"
        mkdir -p sdk/node_modules/effect
        printf '{"version": %s}\\n' "$RESOLVED" > sdk/node_modules/effect/package.json
      }
    `
    try {
        // [resolved package.json version, expected changed output or undefined for a refused version]
        const cases = [['"4.1.0"', "false"], ['"4.2.0"', "true"], ['"4.2.0\\nchanged=false"', undefined], ['"5.0.0-beta.1"', undefined]]
        for (const [index, [resolved, changed]] of cases.entries()) {
            const workspace = join(directory, String(index))
            mkdirSync(join(workspace, "sdk"), { recursive: true })
            writeFileSync(
                join(workspace, "sdk/package.json"),
                JSON.stringify({ peerDependencies: { effect: "^4.1.0" }, devDependencies: { effect: "4.1.0" } }),
            )
            const output = join(workspace, "output")
            writeFileSync(output, "")
            const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", fakePnpm + resolve.run], {
                cwd: workspace,
                encoding: "utf8",
                timeout: 10_000,
                windowsHide: true,
                env: { ...process.env, RESOLVED: resolved, PNPM_ARGS: join(workspace, "args"), GITHUB_OUTPUT: output },
            })
            assert.ifError(result.error)
            assert.deepEqual(readFileSync(join(workspace, "args"), "utf8").trim().split(/\r?\n/), [
                "--filter", "@neontechspace/fluxerly", "update", "effect@^4.1.0", "--ignore-scripts",
            ])
            if (changed === undefined) {
                assert.notEqual(result.status, 0, `case ${index} accepts ${resolved}`)
                assert.equal(readFileSync(output, "utf8"), "", `case ${index} writes no outputs`)
            } else {
                assert.equal(result.status, 0, `case ${index}: ${result.stderr}`)
                assert.equal(
                    readFileSync(output, "utf8"),
                    `pinned=4.1.0\nrange=^4.1.0\nresolved=${JSON.parse(resolved)}\nchanged=${changed}\n`,
                )
            }
        }
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

test("Every job that runs Node sets up the pinned version first", () => {
    const runsNode = (step) => step.uses === "$/.github/actions/summary" || /(^|[\s;&|(])node\s/m.test(step.run ?? "")
    for (const { file, id, job } of jobs()) {
        const steps = job.steps ?? []
        const first = steps.findIndex(runsNode)
        if (first === -1) continue
        // Otherwise the step runs the runner image's Node instead of projects/.node-version or the SDK floor
        const setup = steps.findIndex((step) => String(step.uses).startsWith("pnpm/setup@"))
        assert.ok(setup !== -1 && setup < first, `${file}/${id} runs Node before pnpm/setup`)
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
