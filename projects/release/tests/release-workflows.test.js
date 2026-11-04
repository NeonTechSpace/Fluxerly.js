import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
    assertSerialized, bash, checkout, evaluate, jobsOf, loadActions, loadWorkflows, localActionNames, repository, runScript, stepsOf,
} from "../../../.github/test-support/workflows.mjs"

// The npm release contract: What a published package needs from Check, Release prepare, Release publish and Release version
// PR. Only those four workflows and the local actions they run are read here, so a failure of the website, Screens, the
// drift jobs or the contribution workflows cannot fail this suite. The repository-wide invariants, the website and the
// other workflows are owned by .github/tests/workflows.test.mjs
const releaseFiles = ["ci.yml", "release-prepare.yml", "release-publish.yml", "release-version.yml"]
const workflows = loadWorkflows(releaseFiles)
const actions = loadActions(localActionNames(workflows))

// The only jobs of these workflows allowed to hold write scopes, and exactly which scopes they hold
const writers = {
    "ci.yml/release-trigger": { actions: "write" },
    "release-prepare.yml/publish": { actions: "write" },
    "release-version.yml/pull_request": { contents: "write", "pull-requests": "write", actions: "write" },
    "release-publish.yml/publish": { "id-token": "write" },
    "release-publish.yml/reconcile": { actions: "write" },
}

const jobs = () => jobsOf(workflows)
const steps = () => stepsOf(workflows, actions)
const sdkPackage = JSON.parse(readFileSync(join(repository, "projects/sdk/package.json"), "utf8"))
const floor = `node@${sdkPackage.engines.node.replace(/^>=/, "")}`

test("This suite reads only the npm release workflows and the local actions they run", () => {
    assert.deepEqual(Object.keys(workflows), releaseFiles)
    assert.deepEqual(Object.keys(actions), ["summary"])
})

// Catches: A release workflow that is unpinned, writes with a broad token, keeps credentials or runs a privileged trigger.
// The repository-wide suite checks the same rules for every workflow, so a broken release workflow fails this one too
test("The release workflows default to read-only tokens, pin every action and keep credentials out of checkouts", () => {
    for (const [file, workflow] of Object.entries(workflows)) {
        assert.ok(workflow.permissions, `${file} must declare top-level permissions`)
        for (const [scope, level] of Object.entries(workflow.permissions))
            assert.equal(level, "read", `${file} grants ${scope}: ${level} to every job`)
        for (const trigger of ["pull_request_target", "workflow_run"]) assert.equal(workflow.on[trigger], undefined, `${file} must not use ${trigger}`)
    }
    for (const { file, id, job } of jobs()) {
        const granted = Object.fromEntries(Object.entries(job.permissions ?? {}).filter(([, level]) => level === "write"))
        assert.deepEqual(granted, writers[`${file}/${id}`] ?? {}, `${file}/${id} write permissions`)
        assert.notEqual(job.secrets, "inherit", `${file}/${id} inherits secrets`)
        if (job.uses) assert.match(job.uses, /^\$\//, `${file}/${id} calls only same-repository workflows`)
    }
    for (const { where, step } of steps()) {
        if (step.uses && !step.uses.startsWith("$/")) assert.match(step.uses, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/, `${where}: ${step.uses}`)
        if (String(step.uses).startsWith("actions/checkout@"))
            assert.equal(step.with?.["persist-credentials"], false, `${where} must not persist checkout credentials`)
        if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, `${where} must pass values through env`)
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
                cwd: join(checkout, "projects"), input: fixtures + script, encoding: "utf8", timeout: 10_000,
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
    for (const [file, workflow] of Object.entries(workflows))
        for (const [id, job] of Object.entries(workflow.jobs)) assert.doesNotMatch(String(job.uses), /website\.yml/, `${file}/${id}`)
})
test("Release preparation, version and publication workflows read caches without saving them and never cancel a run mid-way", () => {
    for (const file of ["release-prepare.yml", "release-version.yml", "release-publish.yml"])
        assert.equal(workflows[file]["cache-mode"], "read", `${file} cache access`)
    for (const file of ["release-prepare.yml", "release-version.yml"])
        assert.equal(workflows[file].concurrency["cancel-in-progress"], false, file)
    assertSerialized(workflows["release-publish.yml"].jobs.reconcile.concurrency, "release-publish.yml/reconcile")
    for (const file of ["release-prepare.yml", "release-version.yml", "release-publish.yml"])
        for (const { where, step } of steps())
            if (where.startsWith(`${file}/`) && String(step.uses).startsWith("actions/cache"))
                assert.match(step.uses, /^actions\/cache\/restore@/, `${where} may restore a cache but never save one`)
})

// Catches: A published candidate that skipped its second inspection, or an announcement before both Node versions installed
// the package from the registry
test("Publication reinspects the reviewed candidate inside the protected environment and announces only after both registry installs", () => {
    const { jobs: publication } = workflows["release-publish.yml"]
    const order = (job) => job.steps.map((step) => step.id)
    const inspect = publication.inspect.steps.find((step) => step.id === "inspect")
    assert.equal(inspect.run, "node projects/release/github.js inspect")
    assert.equal(inspect.env.CANDIDATE_CHECKSUM, "${{ inputs.candidate_checksum }}")
    assert.equal(inspect.env.CANDIDATE_SOURCE_COMMIT, "${{ steps.preparation.outputs.sourceCommit }}")
    assert.ok(order(publication.inspect).indexOf("preparation") < order(publication.inspect).indexOf("download") && order(publication.inspect).indexOf("download") < order(publication.inspect).indexOf("inspect"))
    // The protected job downloads the inspected artifact and inspects it again with the same externally reviewed checksum
    const protectedJob = publication.publish
    assert.equal(protectedJob.environment, "package")
    assert.deepEqual(order(protectedJob).filter((id) => ["download", "inspect", "publish"].includes(id)), ["download", "inspect", "publish"])
    const reinspect = protectedJob.steps.find((step) => step.id === "inspect")
    assert.equal(reinspect.run, inspect.run)
    assert.equal(reinspect.env.CANDIDATE_CHECKSUM, "${{ inputs.candidate_checksum }}")
    assert.equal(reinspect.env.CANDIDATE_SOURCE_COMMIT, "${{ needs.inspect.outputs.source_commit }}")
    assert.equal(protectedJob.steps.find((step) => step.id === "download").with["artifact-ids"], "${{ needs.inspect.outputs.artifact_id }}")
    assert.equal(protectedJob.steps.find((step) => step.id === "publish").env.CANDIDATE_CHECKSUM, "${{ inputs.candidate_checksum }}")
    // Registry installs of the published version on the development Node version and the declared floor
    const { smoke } = publication
    assert.deepEqual(smoke.needs, ["inspect", "publish"])
    assert.equal(smoke.strategy["fail-fast"], false)
    assert.deepEqual(smoke.strategy.matrix.include, [
        { name: "Registry install on the development Node version" },
        { name: "Registry install on the declared Node floor", runtime: floor },
    ])
    assert.equal(smoke.steps.find((step) => step.id === "smoke").run, 'node release/smoke.js --version "$RELEASE_VERSION"')
    assert.equal(smoke.steps.find((step) => step.id === "smoke").env.RELEASE_VERSION, "${{ needs.inspect.outputs.version }}")
    // The announcement waits for both installs, inspects again, verifies the served bytes and only then asks for the token
    const reconcile = publication.reconcile
    assert.deepEqual(reconcile.needs, ["inspect", "publish", "smoke"])
    assert.deepEqual(order(reconcile).filter((id) => ["download", "inspect", "verify", "release_token", "announce", "website"].includes(id)),
        ["download", "inspect", "verify", "release_token", "announce", "website"])
})

// ----- Check: the npm release certificate, the required check and the Stable start -----

const ci = workflows["ci.yml"]
const needsOf = (id) => [ci.jobs[id].needs ?? []].flat().sort()
const ancestorsOf = (id, seen = new Set()) => {
    for (const need of needsOf(id)) {
        if (seen.has(need)) continue
        seen.add(need)
        ancestorsOf(need, seen)
    }
    return seen
}
const consumerLegs = ["SDK consumers on the development Node version", "SDK consumers on the declared Node floor"]

// The coverage an npm release certificate must carry: Every producer, both consumer legs and the checks behind each. Run on
// the real workflow, and on copies with one piece removed, which it must refuse
function assertNpmCoverage(workflow) {
    const { jobs: all } = workflow
    const certificate = all["npm-check"]
    assert.equal(certificate.name, "npm release checks")
    assert.equal(certificate.if, "always()")
    assert.deepEqual([certificate.needs].flat().sort(), ["consumers", "release", "release-reuse", "sdk"])
    const env = certificate.steps[0].env
    assert.deepEqual([env.SDK_RESULT, env.RELEASE_RESULT, env.CONSUMERS_RESULT],
        ["${{ needs.sdk.result }}", "${{ needs.release.result }}", "${{ needs.consumers.result }}"])
    assert.equal(all.sdk.name, "SDK checks")
    assert.ok(all.sdk.steps.some((step) => step.run === "pnpm --filter @neontechspace/fluxerly check"), "The SDK aggregate runs")
    assert.equal(all.release.name, "Release tooling checks")
    const run = (id) => all.release.steps.find((step) => step.id === id)
    assert.equal(run("tooling").run, "node scripts/check.mjs release")
    assert.equal(run("scripts").run, "pnpm lint:scripts")
    for (const id of ["version", "format"])
        assert.equal(run(id).if, "needs.release-reuse.result == 'success' && needs.release-reuse.outputs.version_only == 'true'", id)
    assert.equal(run("version").run, "node release/version-change.js check")
    assert.match(run("format").run, /prettier --check CHANGELOG\.md package\.json\n.*lint:dashes/)
    assert.equal(all.consumers.name, "${{ matrix.name }}")
    const legs = all.consumers.strategy.matrix.include
    assert.deepEqual(legs.map((leg) => leg.name), consumerLegs, "Both consumer legs report to the certificate")
    assert.deepEqual(legs.map((leg) => leg.runtime), [undefined, floor])
    const consumerRuns = all.consumers.steps.filter((step) => step.run).map((step) => [step.run, step.if])
    assert.deepEqual(consumerRuns, [
        ["pnpm --filter @neontechspace/fluxerly build", undefined],
        ["pnpm --filter @neontechspace/fluxerly test", "matrix.runtime"],
        ["pnpm --filter @neontechspace/fluxerly test:examples", "matrix.runtime"],
        ["pnpm --filter @neontechspace/fluxerly test:package", "matrix.runtime"],
        ["pnpm --filter @neontechspace/fluxerly test:npm", undefined],
    ])
}

test("The npm release certificate covers the SDK checks, the release tooling and both consumer legs, and refuses a copy that drops any", () => {
    assertNpmCoverage(ci)
    const without = (change) => {
        const copy = structuredClone(ci)
        change(copy.jobs)
        return copy
    }
    for (const [what, change] of [
        ["the development consumer leg", (all) => all.consumers.strategy.matrix.include.splice(0, 1)],
        ["the declared floor consumer leg", (all) => all.consumers.strategy.matrix.include.splice(1, 1)],
        ["a renamed floor leg", (all) => (all.consumers.strategy.matrix.include[1].name = "SDK consumers")],
        ["the floor runtime", (all) => delete all.consumers.strategy.matrix.include[1].runtime],
        ["the consumer job from the certificate", (all) => (all["npm-check"].needs = ["release-reuse", "sdk", "release"])],
        ["the release job from the certificate", (all) => (all["npm-check"].needs = ["release-reuse", "sdk", "consumers"])],
        ["the SDK job from the certificate", (all) => (all["npm-check"].needs = ["release-reuse", "release", "consumers"])],
        ["the consumer result", (all) => delete all["npm-check"].steps[0].env.CONSUMERS_RESULT],
        ["the SDK aggregate", (all) => (all.sdk.steps = all.sdk.steps.filter((step) => !step.run?.endsWith(" check")))],
        ["the release tooling run", (all) => (all.release.steps = all.release.steps.filter((step) => step.id !== "tooling"))],
        ["the scripts lint", (all) => (all.release.steps = all.release.steps.filter((step) => step.id !== "scripts"))],
        ["the version-only state check", (all) => delete all.release.steps.find((step) => step.id === "version").if],
        ["the always condition", (all) => (all["npm-check"].if = "success()")],
    ])
        assert.throws(() => assertNpmCoverage(without(change)), undefined, `A certificate without ${String(what)} must be refused`)
})

// Catches: A website, workflow lint or browser job that npm evidence or the Stable start waits for, and a full-Check reuse
// that can stand in for the npm lookup
test("The npm producers, the certificate and the Stable start depend on no website job and no full-Check reuse", () => {
    assert.deepEqual(needsOf("release-reuse"), [])
    assert.deepEqual(needsOf("reuse"), [])
    for (const id of ["sdk", "release", "consumers"]) assert.deepEqual(needsOf(id), ["release-reuse"], id)
    assert.deepEqual(needsOf("npm-check"), ["consumers", "release", "release-reuse", "sdk"])
    assert.deepEqual(needsOf("release-trigger"), ["npm-check"])
    for (const id of ["tooling", "workflows", "browser"]) assert.deepEqual(needsOf(id), ["reuse"], id)
    assert.deepEqual(needsOf("check"), ["browser", "npm-check", "reuse", "tooling", "workflows"])
    for (const id of ["npm-check", "release-trigger", "sdk", "release", "consumers", "release-reuse"])
        for (const blocked of ["reuse", "tooling", "workflows", "browser", "check"])
            assert.ok(!ancestorsOf(id).has(blocked), `${id} must not wait for ${blocked}`)
    // No expression of the npm path reads the other lookup or a website job
    for (const id of ["sdk", "release", "consumers", "npm-check", "release-trigger"]) {
        const text = JSON.stringify(ci.jobs[id])
        assert.doesNotMatch(text, /needs\.(reuse|tooling|workflows|browser|check)\b/, id)
    }
    // Each lookup reads only its own certificate
    const lookup = (id) => ci.jobs[id].steps.find((step) => step.id === "reuse")
    assert.equal(lookup("reuse").run, "node projects/release/reuse.js --scope check")
    assert.equal(lookup("release-reuse").run, "node projects/release/reuse.js --scope npm")
    assert.equal(ci.jobs["release-reuse"].name, "Reuse npm release checks")
    for (const id of ["reuse", "release-reuse"]) {
        assert.deepEqual(ci.jobs[id].permissions, { contents: "read", actions: "read" }, id)
        assert.equal(ci.jobs[id].steps.find((step) => step.id === "checkout").with["fetch-depth"], 2, id)
        assert.deepEqual(Object.keys(ci.jobs[id].outputs).sort(),
            ["parent_run_attempt", "parent_run_id", "parent_run_url", "reused", "run_attempt", "run_id", "run_url", "version_only"], id)
        for (const [key, value] of Object.entries(ci.jobs[id].outputs)) assert.equal(value, `\${{ steps.reuse.outputs.${key} }}`, `${id} ${key}`)
    }
    assert.equal(workflows["release-prepare.yml"].jobs.prepare.steps.find((step) => step.id === "ci").run, "node web/scripts/checked-source.js --scope npm --allow-missing")
})

test("The producer jobs skip only for a successful lookup, and run for a failed or cancelled one whatever its outputs claim", () => {
    const lookup = (id, result, reused, versionOnly) => ({ needs: { [id]: { result, outputs: { reused, version_only: versionOnly } } } })
    // [lookup result, reused, version_only, runs for the npm producers, runs the release tooling job]
    const cases = [
        ["success", "", "", true, true], ["success", "false", "false", true, true], ["success", "true", "false", false, false],
        ["success", "false", "true", false, true], ["success", "true", "true", false, false],
    ]
    // A lookup that did not succeed can leave outputs behind. They never skip an actual check
    for (const result of ["failure", "cancelled", "skipped", ""])
        for (const [reused, versionOnly] of [["", ""], ["true", "false"], ["false", "true"], ["true", "true"]]) cases.push([result, reused, versionOnly, true, true])
    for (const [result, reused, versionOnly, producers, release] of cases) {
        const label = `${result}/${reused}/${versionOnly}`
        for (const id of ["sdk", "consumers"]) assert.equal(evaluate(ci.jobs[id].if, lookup("release-reuse", result, reused, versionOnly)), producers, `${id} ${label}`)
        assert.equal(evaluate(ci.jobs.release.if, lookup("release-reuse", result, reused, versionOnly)), release, `release ${label}`)
        // The website job also runs for a version-only change, because the website builds its changelog page from the notes
        assert.equal(evaluate(ci.jobs.tooling.if, lookup("reuse", result, reused, versionOnly)), result !== "success" || reused !== "true", `tooling ${label}`)
        for (const id of ["workflows", "browser"]) assert.equal(evaluate(ci.jobs[id].if, lookup("reuse", result, reused, versionOnly)), producers, `${id} ${label}`)
    }
    for (const id of ["sdk", "consumers", "release", "tooling", "workflows", "browser"]) {
        const lookupId = ["tooling", "workflows", "browser"].includes(id) ? "reuse" : "release-reuse"
        assert.equal(evaluate(ci.jobs[id].if, lookup(lookupId, "failure", "", ""), { cancelled: true }), false, `${id} when cancelled`)
    }
    // The version-only steps run only for a version-only change of a lookup that succeeded
    for (const id of ["version", "format"]) {
        const step = ci.jobs.release.steps.find((step) => step.id === id)
        assert.equal(evaluate(step.if, lookup("release-reuse", "success", "false", "true")), true, id)
        assert.equal(evaluate(step.if, lookup("release-reuse", "success", "false", "false")), false, id)
        assert.equal(evaluate(step.if, lookup("release-reuse", "failure", "false", "true")), false, `${id} after a failed lookup`)
    }
    assert.equal(ci.jobs.tooling.steps.some((step) => ["version", "format"].includes(step.id)), false, "The website job holds no release version check")
    assert.equal(ci.jobs.tooling.steps.find((step) => step.id === "website").run, "node scripts/check.mjs contributions web")
})

const slug = "owner/repo"
const url = (id) => `https://github.com/${slug}/actions/runs/${id}`
const reuseOutputs = { REUSED: "true", RUN_ID: "7", RUN_ATTEMPT: "1", RUN_URL: url(7) }
const parentOutputs = { VERSION_ONLY: "true", PARENT_RUN_ID: "8", PARENT_RUN_ATTEMPT: "2", PARENT_RUN_URL: url(8) }
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

// Runs the actual gate script once for each environment, in a subshell of one bash, and returns each exit status
function gateStatuses(step, cases, directory) {
    const keys = Object.keys(step.env).sort()
    const driver = [
        "gate() {", step.run, "}",
        ...cases.map((env) => {
            assert.deepEqual(Object.keys(env).sort(), keys, "A case sets exactly the variables the step declares")
            return `( export GITHUB_REPOSITORY=${slug}; ${Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join("; ")}; gate ) >/dev/null 2>&1 && echo 0 || echo $?`
        }),
    ].join("\n")
    // One script for many cases is too long for a command line argument, so bash reads it from a file
    const file = join(directory, "gate-cases.sh")
    writeFileSync(file, driver)
    const result = runScript(`source ${quote(file)}`, { env: { GITHUB_STEP_SUMMARY: join(directory, "summary.md") }, timeout: 60_000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim().split("\n").map(Number)
}

const outcomes = ["success", "failure", "cancelled", "skipped", ""]

test("The npm certificate passes only for real producer success or a verified reuse, in every mixture of results", () => {
    const gate = ci.jobs["npm-check"].steps[0]
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-npm-gate-"))
    try {
        const none = { REUSED: "", RUN_ID: "", RUN_ATTEMPT: "", RUN_URL: "", VERSION_ONLY: "", PARENT_RUN_ID: "", PARENT_RUN_ATTEMPT: "", PARENT_RUN_URL: "" }
        // The wanted [sdk, release, consumers] results for each mode
        const wanted = { ordinary: ["success", "success", "success"], reuse: ["skipped", "skipped", "skipped"], versionOnly: ["skipped", "success", "skipped"] }
        const lookups = [
            // [mode, lookup job result, lookup outputs]
            ["ordinary", "success", none],
            ["ordinary", "failure", none],
            ["ordinary", "cancelled", none],
            ["reuse", "success", { ...none, ...reuseOutputs }],
            ["versionOnly", "success", { ...none, ...parentOutputs }],
            // A failed lookup job can leave outputs behind. They never turn skipped producers into a pass
            ["ordinary", "failure", { ...none, ...reuseOutputs }],
            ["ordinary", "failure", { ...none, ...parentOutputs }],
            ["ordinary", "cancelled", { ...none, ...reuseOutputs }],
            ["ordinary", "skipped", { ...none, ...parentOutputs }],
        ]
        const cases = []
        const expected = []
        for (const [mode, result, outputs] of lookups)
            for (const sdk of outcomes.slice(0, 4))
                for (const release of outcomes.slice(0, 4))
                    for (const consumers of outcomes.slice(0, 4)) {
                        cases.push({ REUSE_RESULT: result, ...outputs, SDK_RESULT: sdk, RELEASE_RESULT: release, CONSUMERS_RESULT: consumers })
                        expected.push(wanted[mode].join() === [sdk, release, consumers].join() ? 0 : 1)
                    }
        // Results the job never reports are not a pass in any position
        for (const missing of ["SDK_RESULT", "RELEASE_RESULT", "CONSUMERS_RESULT"])
            for (const [mode, result, outputs] of lookups.slice(0, 5)) {
                const base = Object.fromEntries(["SDK_RESULT", "RELEASE_RESULT", "CONSUMERS_RESULT"].map((key, index) => [key, wanted[mode][index]]))
                cases.push({ REUSE_RESULT: result, ...outputs, ...base, [missing]: "" })
                expected.push(1)
            }
        // A reference is complete only with a numeric run and attempt and the URL of that very run in this repository
        const skipped = { SDK_RESULT: "skipped", RELEASE_RESULT: "skipped", CONSUMERS_RESULT: "skipped" }
        const versionOnly = { SDK_RESULT: "skipped", RELEASE_RESULT: "success", CONSUMERS_RESULT: "skipped" }
        for (const patch of [
            { RUN_ID: "" }, { RUN_ATTEMPT: "" }, { RUN_URL: "" }, { RUN_ID: "0" }, { RUN_ATTEMPT: "0" }, { RUN_ID: "7x" }, { RUN_ATTEMPT: "-1" },
            { RUN_URL: url(8) }, { RUN_URL: "https://github.com/other/repo/actions/runs/7" }, { RUN_URL: `${url(7)}/attempts/1` },
        ]) {
            cases.push({ REUSE_RESULT: "success", ...none, ...reuseOutputs, ...patch, ...skipped })
            expected.push(1)
        }
        for (const patch of [
            { PARENT_RUN_ID: "" }, { PARENT_RUN_ATTEMPT: "" }, { PARENT_RUN_URL: "" }, { PARENT_RUN_ID: "0" }, { PARENT_RUN_URL: url(7) }, { VERSION_ONLY: "false" }, { VERSION_ONLY: "" },
        ]) {
            cases.push({ REUSE_RESULT: "success", ...none, ...parentOutputs, ...patch, ...versionOnly })
            expected.push(1)
        }
        assert.ok(cases.length > 600)
        const statuses = gateStatuses(gate, cases, directory)
        statuses.forEach((status, index) => assert.equal(status, expected[index], JSON.stringify(cases[index])))
        // Both reuse kinds pass, and so does a failed lookup whose checks really ran
        assert.deepEqual(gateStatuses(gate, [
            { REUSE_RESULT: "failure", ...none, SDK_RESULT: "success", RELEASE_RESULT: "success", CONSUMERS_RESULT: "success" },
            { REUSE_RESULT: "success", ...none, ...reuseOutputs, ...skipped },
            { REUSE_RESULT: "success", ...none, ...parentOutputs, ...versionOnly },
        ], directory), [0, 0, 0])
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("The npm certificate names the reuse it relied on and the jobs that failed, and reports no success for a failure", () => {
    const gate = ci.jobs["npm-check"].steps[0]
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-npm-summary-"))
    try {
        const base = Object.fromEntries(Object.keys(gate.env).map((key) => [key, ""]))
        const run = (env) => {
            const summary = join(directory, "step-summary.md")
            writeFileSync(summary, "")
            const result = runScript(gate.run, { cwd: directory, env: { ...base, ...env, GITHUB_REPOSITORY: slug, GITHUB_STEP_SUMMARY: summary } })
            return { status: result.status, summary: readFileSync(summary, "utf8") }
        }
        const reused = run({ REUSE_RESULT: "success", ...reuseOutputs, SDK_RESULT: "skipped", RELEASE_RESULT: "skipped", CONSUMERS_RESULT: "skipped" })
        assert.equal(reused.status, 0)
        assert.match(reused.summary, /^## npm release checks\n\nPassed by reuse\./)
        assert.ok(reused.summary.includes(`Reused run: ${url(7)}`))
        const parent = run({ REUSE_RESULT: "success", ...parentOutputs, SDK_RESULT: "skipped", RELEASE_RESULT: "success", CONSUMERS_RESULT: "skipped" })
        assert.equal(parent.status, 0)
        assert.ok(parent.summary.includes(`Parent commit run: ${url(8)}`))
        const failed = run({ REUSE_RESULT: "success", SDK_RESULT: "success", RELEASE_RESULT: "failure", CONSUMERS_RESULT: "cancelled" })
        assert.equal(failed.status, 1)
        assert.match(failed.summary, /Did not pass: Release tooling checks, SDK consumers on both Node versions/)
        assert.doesNotMatch(failed.summary, /Nothing to fix|Passed/)
        assert.match(failed.summary, /\| Release tooling checks \| failed \|/)
        assert.match(failed.summary, /\| SDK consumers on both Node versions \| cancelled \|/)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("The required check needs the npm certificate in every mode and rejects every other mixture of results", () => {
    const gate = ci.jobs.check.steps[0]
    assert.equal(ci.jobs.check.name, "check")
    assert.equal(ci.jobs.check.if, "always()")
    assert.deepEqual(needsOf("check"), ["browser", "npm-check", "reuse", "tooling", "workflows"])
    assert.equal(gate.env.NPM_RESULT, "${{ needs.npm-check.result }}")
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-check-gate-"))
    try {
        const none = { REUSED: "", RUN_ID: "", RUN_ATTEMPT: "", RUN_URL: "", VERSION_ONLY: "", PARENT_RUN_ID: "", PARENT_RUN_ATTEMPT: "", PARENT_RUN_URL: "" }
        // The wanted [tooling, workflows, browser] results for each mode. The npm certificate must pass in all of them
        const wanted = { ordinary: ["success", "success", "success"], reuse: ["skipped", "skipped", "skipped"], versionOnly: ["success", "skipped", "skipped"] }
        const lookups = [
            ["ordinary", "success", none],
            ["ordinary", "failure", none],
            ["reuse", "success", { ...none, ...reuseOutputs }],
            ["versionOnly", "success", { ...none, ...parentOutputs }],
            ["ordinary", "failure", { ...none, ...reuseOutputs }],
            ["ordinary", "failure", { ...none, ...parentOutputs }],
            ["ordinary", "cancelled", { ...none, ...reuseOutputs }],
        ]
        const cases = []
        const expected = []
        for (const [mode, result, outputs] of lookups)
            for (const npm of outcomes)
                for (const tooling of outcomes.slice(0, 4))
                    for (const workflowLint of outcomes.slice(0, 4))
                        for (const browser of outcomes.slice(0, 4)) {
                            cases.push({ REUSE_RESULT: result, ...outputs, NPM_RESULT: npm, TOOLING_RESULT: tooling, WORKFLOWS_RESULT: workflowLint, BROWSER_RESULT: browser })
                            expected.push(npm === "success" && wanted[mode].join() === [tooling, workflowLint, browser].join() ? 0 : 1)
                        }
        const skipped = { TOOLING_RESULT: "skipped", WORKFLOWS_RESULT: "skipped", BROWSER_RESULT: "skipped" }
        for (const patch of [{ RUN_ID: "" }, { RUN_ATTEMPT: "" }, { RUN_URL: "" }, { RUN_URL: url(8) }, { RUN_ID: "0" }]) {
            cases.push({ REUSE_RESULT: "success", ...none, ...reuseOutputs, ...patch, NPM_RESULT: "success", ...skipped })
            expected.push(1)
        }
        for (const patch of [{ PARENT_RUN_ID: "" }, { PARENT_RUN_ATTEMPT: "" }, { PARENT_RUN_URL: "" }, { PARENT_RUN_URL: url(7) }, { VERSION_ONLY: "false" }]) {
            cases.push({ REUSE_RESULT: "success", ...none, ...parentOutputs, ...patch, NPM_RESULT: "success", TOOLING_RESULT: "success", WORKFLOWS_RESULT: "skipped", BROWSER_RESULT: "skipped" })
            expected.push(1)
        }
        const statuses = gateStatuses(gate, cases, directory)
        statuses.forEach((status, index) => assert.equal(status, expected[index], JSON.stringify(cases[index])))
        assert.ok(expected.includes(0) && expected.includes(1))
        // A full-Check reuse cannot suppress a failed npm certificate, and a failed lookup with passed work is harmless
        assert.deepEqual(gateStatuses(gate, [
            { REUSE_RESULT: "success", ...none, ...reuseOutputs, NPM_RESULT: "failure", ...skipped },
            { REUSE_RESULT: "success", ...none, ...reuseOutputs, NPM_RESULT: "skipped", ...skipped },
            { REUSE_RESULT: "failure", ...none, NPM_RESULT: "success", TOOLING_RESULT: "success", WORKFLOWS_RESULT: "success", BROWSER_RESULT: "success" },
        ], directory), [1, 1, 0])
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

// The environment of each gate step, bound to the lookup job and the jobs it judges
const lookupOf = { "npm-check": "release-reuse", check: "reuse" }
const judged = {
    "npm-check": { SDK_RESULT: "sdk", RELEASE_RESULT: "release", CONSUMERS_RESULT: "consumers" },
    check: { NPM_RESULT: "npm-check", TOOLING_RESULT: "tooling", WORKFLOWS_RESULT: "workflows", BROWSER_RESULT: "browser" },
}
function expectedBindings(id) {
    const lookup = lookupOf[id]
    return {
        REUSE_RESULT: `\${{ needs.${lookup}.result }}`,
        ...Object.fromEntries(
            [["REUSED", "reused"], ["RUN_ID", "run_id"], ["RUN_ATTEMPT", "run_attempt"], ["RUN_URL", "run_url"], ["VERSION_ONLY", "version_only"],
                ["PARENT_RUN_ID", "parent_run_id"], ["PARENT_RUN_ATTEMPT", "parent_run_attempt"], ["PARENT_RUN_URL", "parent_run_url"]]
                .map(([name, output]) => [name, `\${{ needs.${lookup}.outputs.${output} }}`]),
        ),
        ...Object.fromEntries(Object.entries(judged[id]).map(([name, job]) => [name, `\${{ needs.${job}.result }}`])),
    }
}

// Evaluates the step's environment expressions from a needs fixture, as the runner does, then runs the real script with them
function runBoundGate(id, { lookup, jobs }) {
    const step = ci.jobs[id].steps[0]
    const needs = { [lookupOf[id]]: lookup, ...Object.fromEntries(Object.entries(jobs).map(([job, result]) => [job, { result }])) }
    const env = Object.fromEntries(Object.entries(step.env).map(([name, expression]) => [name, evaluate(expression, { needs }) ?? ""]))
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-bound-gate-"))
    try {
        const result = runScript(step.run, { cwd: directory, env: { ...env, GITHUB_REPOSITORY: slug, GITHUB_STEP_SUMMARY: join(directory, "summary.md") } })
        return { status: result.status, env }
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}
const claims = {
    reuse: { reused: "true", run_id: "7", run_attempt: "1", run_url: url(7), version_only: "false", parent_run_id: "", parent_run_attempt: "", parent_run_url: "" },
    versionOnly: { reused: "false", run_id: "", run_attempt: "", run_url: "", version_only: "true", parent_run_id: "8", parent_run_attempt: "2", parent_run_url: url(8) },
    none: { reused: "false", run_id: "", run_attempt: "", run_url: "", version_only: "false", parent_run_id: "", parent_run_attempt: "", parent_run_url: "" },
}

// Catches: A gate input bound to the wrong lookup output, which the shell tests cannot see because they supply the values
test("Each gate reads exactly its own lookup job and the jobs it judges, and works through those bindings", () => {
    for (const id of ["npm-check", "check"]) assert.deepEqual(ci.jobs[id].steps[0].env, expectedBindings(id), `${id} environment`)
    assert.equal(ci.jobs.check.steps[0].env.VERSION_ONLY, "${{ needs.reuse.outputs.version_only }}")
    assert.equal(ci.jobs.check.steps[0].env.PARENT_RUN_URL, "${{ needs.reuse.outputs.parent_run_url }}")
    // The bound environments are evaluated from a needs fixture and run through the real scripts
    const npm = (lookup, jobs) => runBoundGate("npm-check", { lookup, jobs })
    const full = (lookup, jobs) => runBoundGate("check", { lookup, jobs })
    const done = (...ids) => Object.fromEntries(ids.map((id) => [id, "success"]))
    const skipped = (...ids) => Object.fromEntries(ids.map((id) => [id, "skipped"]))
    const reuse = { result: "success", outputs: claims.reuse }
    const parent = { result: "success", outputs: claims.versionOnly }
    const ordinary = { result: "success", outputs: claims.none }
    assert.equal(npm(ordinary, done("sdk", "release", "consumers")).status, 0)
    assert.equal(npm(reuse, skipped("sdk", "release", "consumers")).status, 0)
    const bound = npm(parent, { sdk: "skipped", release: "success", consumers: "skipped" })
    assert.equal(bound.status, 0)
    assert.equal(bound.env.VERSION_ONLY, "true")
    assert.equal(bound.env.PARENT_RUN_URL, url(8))
    assert.equal(full(ordinary, done("npm-check", "tooling", "workflows", "browser")).status, 0)
    assert.equal(full(reuse, { "npm-check": "success", ...skipped("tooling", "workflows", "browser") }).status, 0)
    const versionOnly = full(parent, { "npm-check": "success", tooling: "success", workflows: "skipped", browser: "skipped" })
    assert.equal(versionOnly.status, 0, "A genuine version-only run passes its required status")
    assert.equal(versionOnly.env.VERSION_ONLY, "true")
    assert.equal(versionOnly.env.PARENT_RUN_URL, url(8))
    assert.equal(full(parent, { "npm-check": "failure", tooling: "success", workflows: "skipped", browser: "skipped" }).status, 1)
})

// Catches: A failed lookup whose leftover outputs skip the actual checks, so the required status fails without any check failing
test("A failed or cancelled lookup runs the actual checks, and the gates then pass on their results", () => {
    const lookup = (id, result, outputs) => ({ needs: { [id]: { result, outputs } } })
    const ran = (id, context) => (evaluate(ci.jobs[id].if, context) ? "success" : "skipped")
    for (const result of ["failure", "cancelled"])
        for (const outputs of [claims.reuse, claims.versionOnly]) {
            const npmContext = lookup("release-reuse", result, outputs)
            const jobs = Object.fromEntries(["sdk", "release", "consumers"].map((id) => [id, ran(id, npmContext)]))
            assert.deepEqual(jobs, { sdk: "success", release: "success", consumers: "success" }, `${result} lookup runs the npm producers`)
            const npm = runBoundGate("npm-check", { lookup: { result, outputs }, jobs })
            assert.equal(npm.status, 0, `${result}: the npm certificate passes on the producers that really ran`)
            const websiteContext = lookup("reuse", result, outputs)
            const website = Object.fromEntries(["tooling", "workflows", "browser"].map((id) => [id, ran(id, websiteContext)]))
            assert.deepEqual(website, { tooling: "success", workflows: "success", browser: "success" })
            assert.equal(runBoundGate("check", { lookup: { result, outputs }, jobs: { "npm-check": "success", ...website } }).status, 0)
            // Skipped producers would have been red, so only the jobs that ran decide
            assert.equal(runBoundGate("npm-check", { lookup: { result, outputs }, jobs: { sdk: "skipped", release: "skipped", consumers: "skipped" } }).status, 1)
        }
})

test("The Stable start follows the npm certificate alone, with its permissions and dispatch arguments unchanged", () => {
    const trigger = ci.jobs["release-trigger"]
    assert.equal(trigger.needs, "npm-check")
    assert.deepEqual(trigger.permissions, { contents: "read", actions: "write" })
    const context = (result, github = {}, extra = {}) => ({ needs: { "npm-check": { result } }, github: { event_name: "push", ref: "refs/heads/main", ...github }, ...extra })
    // Website, workflow lint and browser results are not even visible to this job, so no failure of them can stop it
    assert.equal(evaluate(trigger.if, context("success")), true)
    for (const result of ["failure", "cancelled", "skipped", ""]) assert.equal(evaluate(trigger.if, context(result)), false, result)
    assert.equal(evaluate(trigger.if, context("success"), { cancelled: true }), false)
    for (const github of [{ event_name: "pull_request" }, { event_name: "workflow_dispatch" }, { ref: "refs/heads/release/version-1" }, { ref: "refs/pull/7/merge" }])
        assert.equal(evaluate(trigger.if, context("success", github)), false, JSON.stringify(github))
    assert.doesNotMatch(trigger.if, /needs\.(check|reuse|tooling|workflows|browser)/)
    const detect = trigger.steps.find((step) => step.id === "trigger")
    assert.equal(detect.run, "node projects/release/github.js prepare-trigger")
    assert.deepEqual(detect.env, { GH_TOKEN: "${{ github.token }}", BEFORE_SHA: "${{ github.event.before }}", AFTER_SHA: "${{ github.sha }}" })
    const dispatch = trigger.steps.find((step) => step.id === "dispatch")
    assert.equal(dispatch.if, "steps.trigger.outputs.prepare == 'true'")
    assert.deepEqual(dispatch.env, { GH_TOKEN: "${{ github.token }}", SOURCE_COMMIT: "${{ github.sha }}" })
    const sent = runScript('gh() { printf "%s\\n" "$@"; }\n' + dispatch.run, { env: { GITHUB_REPOSITORY: slug, SOURCE_COMMIT: "c".repeat(40) } })
    assert.equal(sent.status, 0, sent.stderr)
    assert.deepEqual(sent.stdout.trim().split(/\r?\n/), ["workflow", "run", "release-prepare.yml", "--repo", slug, "--ref", "main", "-f", `source_ref=${"c".repeat(40)}`])
})

// Catches: A preparation without a passed npm certificate that still needs a browser, skips a check the certificate covers,
// or installs the candidate on only one path
test("Release preparation without the npm certificate runs the SDK, release tooling and script checks, with no browser, and installs the exact candidate on both paths", () => {
    const prepare = workflows["release-prepare.yml"].jobs.prepare
    const runner = "/runner"
    const candidate = `pnpm --filter @neontechspace/fluxerly test:npm --candidate ${runner}/release-candidate`
    const floorChecks = [
        "pnpm --filter @neontechspace/fluxerly test",
        "pnpm --filter @neontechspace/fluxerly test:examples",
        "pnpm --filter @neontechspace/fluxerly test:package",
        candidate,
    ]
    // Fake pnpm and node print their arguments, so the run shows exactly which commands the selected steps would start
    const prelude = 'pnpm() { printf "pnpm %s\\n" "$*"; }\nnode() { printf "node %s\\n" "$*"; }\n'
    const commands = (reused, skipped) => {
        const context = { steps: { ci: { outputs: { reused } }, candidate: { outputs: { skipped } } } }
        const selected = prepare.steps.filter((step) => step.run && (step.if === undefined || evaluate(step.if, context)))
        const result = runScript(prelude + selected.map((step) => step.run).join("\n"), { env: { RUNNER_TEMP: runner } })
        assert.equal(result.status, 0, result.stderr)
        return { lines: result.stdout.trim().split("\n"), uses: prepare.steps.filter((step) => step.uses && (step.if === undefined || evaluate(step.if, context))).map((step) => step.id) }
    }
    const lookup = "node web/scripts/checked-source.js --scope npm --allow-missing"
    const module = "node --input-type=module"
    const missing = commands("false", "false")
    assert.deepEqual(missing.lines, [lookup, "node scripts/check.mjs sdk release", "pnpm lint:scripts", module, candidate, ...floorChecks])
    assert.ok(missing.uses.includes("floor_setup") && missing.uses.includes("artifact"), "The floor Node setup and the retained candidate")
    const reused = commands("true", "false")
    assert.deepEqual(reused.lines, [lookup, "pnpm --filter @neontechspace/fluxerly build", module, candidate])
    assert.ok(!reused.uses.includes("floor_setup") && reused.uses.includes("artifact"))
    // An unchanged nightly retains and installs nothing
    assert.deepEqual(commands("false", "true").lines, [lookup, "node scripts/check.mjs sdk release", "pnpm lint:scripts", module])
    assert.deepEqual(commands("true", "true").lines, [lookup, "pnpm --filter @neontechspace/fluxerly build", module])
    // No browser, screen or website check is a prerequisite of a package
    for (const step of prepare.steps) {
        assert.doesNotMatch(`${step.id} ${step.name} ${step.uses ?? ""} ${step.run ?? ""} ${JSON.stringify(step.with ?? {})}`, /playwright|browser|test:versions|test:browser|ms-playwright/i, `${step.id}`)
    }
    // The fallback runs exactly what the certificate covers outside the matrix, and the floor suite runs after the candidate exists
    const ids = prepare.steps.map((step) => step.id)
    assert.ok(ids.indexOf("workspace") < ids.indexOf("candidate") && ids.indexOf("candidate") < ids.indexOf("npm") && ids.indexOf("npm") < ids.indexOf("floor"))
    assert.ok(ids.indexOf("scripts") < ids.indexOf("candidate"))
    const summary = prepare.steps.find((step) => step.name === "Summarize candidate preparation")
    const labels = JSON.parse(summary.with.checks)
    assert.deepEqual(Object.values(labels), ["workspace", "scripts", "build", "candidate", "npm", "floor", "artifact"])
    assert.ok(Object.values(labels).every((id) => ids.includes(id)), "Every summarized step exists")
})

// Catches: A claim that a source from before the scoped certificates can be prepared. Release prepare runs the helper of the
// source it checks out, so the arguments it passes must be understood by that helper
test("A source whose helper predates the scope option is rejected before any evidence is read, and the current helper accepts the same arguments", async () => {
    const lookup = workflows["release-prepare.yml"].jobs.prepare.steps.find((step) => step.id === "ci")
    const [command, script, ...args] = lookup.run.split(" ")
    assert.deepEqual([command, script], ["node", "web/scripts/checked-source.js"])
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-legacy-helper-"))
    try {
        // The command line of the helper as it was at 189fd5e, before the scope option: One flag, nothing else, and a failure
        // before any request is made
        const legacy = join(directory, "checked-source.mjs")
        writeFileSync(legacy, `const args = process.argv.slice(2)
try {
    if (args.length && (args.length !== 1 || args[0] !== "--allow-missing")) throw new Error("Only --allow-missing is supported")
    console.log("would read evidence")
} catch (error) {
    console.error(error.message)
    process.exitCode = 1
}
`)
        const run = (...given) => spawnSync(process.execPath, [legacy, ...given], { encoding: "utf8", timeout: 10_000 })
        const old = run(...args)
        assert.equal(old.status, 1)
        assert.equal(old.stderr.trim(), "Only --allow-missing is supported")
        assert.equal(old.stdout, "", "No evidence is read")
        assert.equal(run("--allow-missing").status, 0, "The fixture accepts what the old workflow passed")
        const { parseArguments } = await import(new URL("../../web/scripts/checked-source.js", import.meta.url).href)
        assert.deepEqual(parseArguments(args), { scope: "npm", allowMissing: true })
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
    // The consequence is documented, so no one expects an older source to be prepared
    assert.match(readFileSync(join(checkout, "docs/RELEASING.md"), "utf8"), /Prepare a reviewed descendant that contains the certificates/)
})
