import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// Which suite owns which workflow, shown by what each suite does with a broken copy of the repository's workflows: A
// website-only workflow that breaks fails the repository-wide suite and leaves npm validation passing, and a broken release
// workflow fails npm validation. The suites read the copy through FLUXERLY_WORKFLOW_ROOT, so nothing here edits a real file
const repository = fileURLToPath(new URL("../../../", import.meta.url))
const suites = {
    general: ".github/tests/workflows.test.mjs",
    release: "projects/release/tests/release-workflows.test.js",
}
const pinned = /uses: (actions\/checkout)@[a-f0-9]{40}/

// A copy of the files the suites read, with one workflow changed by the callback
function copyWith(root, file, change) {
    cpSync(join(repository, ".github/workflows"), join(root, ".github/workflows"), { recursive: true })
    cpSync(join(repository, ".github/actions"), join(root, ".github/actions"), { recursive: true })
    mkdirSync(join(root, "projects/sdk"), { recursive: true })
    cpSync(join(repository, "projects/sdk/package.json"), join(root, "projects/sdk/package.json"))
    const path = join(root, ".github/workflows", file)
    const before = readFileSync(path, "utf8")
    const after = change(before)
    assert.notEqual(after, before, `${file} was changed`)
    writeFileSync(path, after)
}

// Runs one suite in its own process, against the copy. A bounded run, not a timing check of the suite
function run(suite, root, only) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, FLUXERLY_WORKFLOW_ROOT: root }
        // A test child of this runner would otherwise report to it instead of running as a runner of its own
        delete env.NODE_TEST_CONTEXT
        const child = spawn(process.execPath, ["--import", join(repository, "projects/scripts/no-fluxer-network.mjs"), "--test", ...(only ? [`--test-name-pattern=${only}`] : []), join(repository, suites[suite])], {
            cwd: join(repository, "projects"), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        })
        const output = []
        const timer = setTimeout(() => child.kill(), 120_000)
        child.stdout.on("data", (chunk) => output.push(chunk))
        child.stderr.on("data", (chunk) => output.push(chunk))
        child.on("error", reject)
        child.on("close", (status) => {
            clearTimeout(timer)
            resolve({ status, output: Buffer.concat(output).toString() })
        })
    })
}

test("A broken website workflow fails the repository suite but not npm validation, and a broken release workflow fails npm validation", { timeout: 300_000 }, async () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-ownership-"))
    try {
        const website = join(directory, "website")
        const release = join(directory, "release")
        const matrix = join(directory, "matrix")
        // An unpinned action in a workflow that only the website uses
        copyWith(website, "website.yml", (text) => text.replace(pinned, "uses: $1@v7"))
        // The same break in a workflow that publishes to npm
        copyWith(release, "release-prepare.yml", (text) => text.replace(pinned, "uses: $1@v7"))
        // A Check that no longer certifies the declared Node floor consumers
        copyWith(matrix, "ci.yml", (text) => text.replace("          - name: SDK consumers on the declared Node floor\n            runtime: node@24.15.0\n", ""))
        const [websiteGeneral, websiteRelease, releaseGeneral, releaseRelease, matrixRelease] = await Promise.all([
            run("general", website), run("release", website), run("general", release), run("release", release), run("release", matrix),
        ])
        assert.notEqual(websiteGeneral.status, 0, "The repository suite must reject an unpinned website workflow")
        assert.match(websiteGeneral.output, /pinned to an immutable digest/)
        assert.equal(websiteRelease.status, 0, `npm validation must not depend on the website workflow:\n${websiteRelease.output.slice(-2000)}`)
        assert.notEqual(releaseRelease.status, 0, "npm validation must reject an unpinned release workflow")
        assert.match(releaseRelease.output, /pin every action/)
        assert.notEqual(releaseGeneral.status, 0, "The repository suite also rejects it")
        assert.notEqual(matrixRelease.status, 0, "npm validation must reject a Check without the floor consumer leg")
        assert.match(matrixRelease.output, /declared floor consumer leg|Both consumer legs|consumer legs/i)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

// A binding that the shell tests cannot see, because they supply the values themselves, and a producer that a failed lookup
// can still skip. Each broken copy must fail the release suite, in the test that owns the contract
test("A misbound gate input or a producer that trusts a failed lookup fails npm validation", { timeout: 300_000 }, async () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-bindings-"))
    try {
        const cases = [
            ["required check VERSION_ONLY", "          VERSION_ONLY: ${{ needs.reuse.outputs.version_only }}", "          VERSION_ONLY: 'false'", /Each gate reads exactly its own lookup job/],
            ["required check PARENT_RUN_URL", "          PARENT_RUN_URL: ${{ needs.reuse.outputs.parent_run_url }}", "          PARENT_RUN_URL: missing", /Each gate reads exactly its own lookup job/],
            ["npm certificate VERSION_ONLY", "          VERSION_ONLY: ${{ needs.release-reuse.outputs.version_only }}", "          VERSION_ONLY: 'false'", /Each gate reads exactly its own lookup job/],
            ["npm certificate PARENT_RUN_URL", "          PARENT_RUN_URL: ${{ needs.release-reuse.outputs.parent_run_url }}", "          PARENT_RUN_URL: missing", /Each gate reads exactly its own lookup job/],
            ["SDK job after a failed lookup", "if: ${{ !cancelled() && (needs.release-reuse.result != 'success' || (needs.release-reuse.outputs.reused != 'true' && needs.release-reuse.outputs.version_only != 'true')) }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 30",
                "if: ${{ !cancelled() && needs.release-reuse.outputs.reused != 'true' && needs.release-reuse.outputs.version_only != 'true' }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 30", /producer jobs skip only for a successful lookup/],
            ["release job after a failed lookup", "if: ${{ !cancelled() && (needs.release-reuse.result != 'success' || needs.release-reuse.outputs.reused != 'true') }}", "if: ${{ !cancelled() && needs.release-reuse.outputs.reused != 'true' }}", /producer jobs skip only for a successful lookup/],
            ["browser job after a failed lookup", "if: ${{ !cancelled() && (needs.reuse.result != 'success' || (needs.reuse.outputs.reused != 'true' && needs.reuse.outputs.version_only != 'true')) }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 20",
                "if: ${{ !cancelled() && needs.reuse.outputs.reused != 'true' && needs.reuse.outputs.version_only != 'true' }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 20", /producer jobs skip only for a successful lookup/],
        ]
        const roots = cases.map(([name, from, to]) => {
            const root = join(directory, name.replaceAll(" ", "-"))
            copyWith(root, "ci.yml", (text) => text.replace(from, to))
            return root
        })
        const results = await Promise.all(cases.map(([, , , test], index) => run("release", roots[index], test.source)))
        results.forEach((result, index) => {
            assert.notEqual(result.status, 0, `${cases[index][0]} must fail npm validation`)
            assert.match(result.output, new RegExp(`✖ [^\\n]*${cases[index][3].source}`), `${cases[index][0]} must fail the test that owns it`)
        })
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
