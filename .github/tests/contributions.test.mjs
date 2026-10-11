import assert from "node:assert/strict"
import test from "node:test"
import { GitHubError, linkedIssues, parseCommand, parseModels, runContributionEvent } from "../scripts/contributions.mjs"

const repository = "NeonTechSpace/Fluxerly.js"
const base = `repos/${repository}`
const owner = { id: 118444485, login: "Neonsy" }
const writer = { id: 41898282, login: "github-actions[bot]" }
const contributor = { id: 700001, login: "sample-contributor" }
const stranger = { id: 700002, login: "sample-stranger" }
const mainSha = "a".repeat(40)
const nextSha = "b".repeat(40)
const fileSha = "c".repeat(40)
const repo = { full_name: repository, id: 1370449818, default_branch: "main" }
const permissionMarker = "<!-- fluxerly-contribution-permissions:v1 -->"
const modelMarker = "<!-- fluxerly-contribution-model-result:v1 -->"
const allowedLine = "- Model: example-model-1 | Reasoning: high | Harness: example-cli"
const clone = (value) => structuredClone(value)
const file = (value) => ({
    sha: fileSha,
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value)).toString("base64"),
})
const grant = (user) => ({ ...user, issuerId: owner.id, commandId: 900 })
const grantComment = (grants, user = writer) => ({
    id: 901,
    user,
    body: `${permissionMarker}\n\`\`\`json\n${JSON.stringify({ version: 1, grants }, null, 2)}\n\`\`\``,
})
const issue = (number = 42) => ({ number, state: "open", url: `https://api.github.com/${base}/issues/${number}` })
const issuePath = new RegExp(`^${base.replaceAll(".", "\\.")}/issues/(\\d+)$`)

// The fake models GitHub's external state, including writes and fresh reads, rather than internal helpers
function fixture() {
    const state = {
        policy: {
            version: 1,
            enabled: true,
            repository,
            repositoryId: repo.id,
            maintainerIds: [owner.id],
            automationIds: [writer.id, 49699333],
            permissionWriterId: writer.id,
            commitIdentity: { name: "Neonsy", email: "118444485+Neonsy@users.noreply.github.com" },
            allowedModels: [
                { id: "example-model-1", name: "Example Model 1", aliases: ["Model One"] },
                { id: "example-model-0", name: "Example Model 0", allowedUntil: "2026-10-11" },
            ],
        },
        trust: { version: 1, users: [] },
        sha: mainSha,
        pr: { number: 81, state: "open", body: "", user: contributor },
        issues: new Map([[42, issue()]]),
        comments: new Map(),
        labels: new Map(),
        commands: new Map(),
        users: new Map([
            [contributor.login, contributor],
            [stranger.login, stranger],
        ]),
        refs: new Map(),
        branchFiles: new Map(),
        changePrs: [],
        requests: [],
        lists: [],
        writes: [],
        beforeRequest: undefined,
    }
    const api = {
        async request(method, path, body) {
            state.requests.push({ method, path, body: clone(body) })
            await state.beforeRequest?.({ method, path, body, state })
            if (method === "GET") {
                if (path === base) return clone(repo)
                if (path === `${base}/git/ref/heads/main`) return { object: { sha: state.sha } }
                if (path.startsWith(`${base}/contents/.github/contribution-policy.json?ref=`)) return file(state.policy)
                if (path.startsWith(`${base}/contents/.github/VOUCHED.json?ref=`)) {
                    const ref = path.split("?ref=")[1]
                    return clone(state.branchFiles.get(ref) ?? file(state.trust))
                }
                // Like GitHub, PR and issue reads include their current labels
                if (path === `${base}/pulls/81`) return clone({ ...state.pr, labels: state.labels.get(81) ?? [] })
                const issueMatch = issuePath.exec(path)
                // The issues API also serves PRs
                if (issueMatch?.[1] === "81" && !state.issues.has(81))
                    return clone({ ...issue(81), ...state.pr, pull_request: {}, labels: state.labels.get(81) ?? [] })
                if (issueMatch) {
                    const found = state.issues.get(Number(issueMatch[1]))
                    if (!found) throw new GitHubError(404)
                    return clone({ ...found, labels: state.labels.get(found.number) ?? [] })
                }
                if (path.startsWith(`${base}/issues/comments/`)) {
                    const comment = state.commands.get(Number(path.split("/").at(-1)))
                    if (!comment) throw new GitHubError(404)
                    return clone(comment)
                }
                if (path.startsWith("users/")) {
                    const user = state.users.get(path.slice(6))
                    if (!user) throw new GitHubError(404)
                    return clone(user)
                }
                if (path.startsWith(`${base}/git/ref/heads/`)) {
                    const found = state.refs.get(path.slice(`${base}/git/ref/heads/`.length))
                    if (!found) throw new GitHubError(404)
                    return clone(found)
                }
            } else {
                state.writes.push({ method, path, body: clone(body) })
                if (method === "POST" && path === `${base}/actions/workflows/ci.yml/dispatches`) return undefined
                if (method === "POST" && path === `${base}/git/refs`) {
                    const branch = body.ref.slice("refs/heads/".length)
                    state.refs.set(branch, { object: { sha: body.sha } })
                    state.branchFiles.set(branch, file(state.trust))
                    return {}
                }
                if (method === "PUT" && path === `${base}/contents/.github/VOUCHED.json`) {
                    state.branchFiles.set(body.branch, { sha: fileSha, encoding: "base64", content: body.content })
                    return {}
                }
                if (method === "POST" && path === `${base}/pulls`) {
                    state.changePrs.push({ ...clone(body), number: 82 })
                    return { number: 82 }
                }
                // Every write comes from the workflow token, so its closures name the writer
                const closer = body?.state === "closed" ? { closed_by: writer } : {}
                if (method === "PATCH" && path === `${base}/pulls/81`) {
                    Object.assign(state.pr, clone(body), closer)
                    return clone(state.pr)
                }
                const issuePatch = issuePath.exec(path)
                if (method === "PATCH" && issuePatch) {
                    const found = state.issues.get(Number(issuePatch[1]))
                    Object.assign(found, clone(body), closer)
                    return clone(found)
                }
                const commentPost = /\/issues\/(\d+)\/comments$/.exec(path)
                if (method === "POST" && commentPost) {
                    const number = Number(commentPost[1])
                    const comments = state.comments.get(number) ?? []
                    const comment = { id: 1000 + comments.length, user: writer, body: body.body }
                    comments.push(comment)
                    state.comments.set(number, comments)
                    return clone(comment)
                }
                if (method === "PATCH" && path.startsWith(`${base}/issues/comments/`)) {
                    const id = Number(path.split("/").at(-1))
                    for (const comments of state.comments.values()) {
                        const comment = comments.find((entry) => entry.id === id)
                        if (comment) {
                            Object.assign(comment, clone(body))
                            return clone(comment)
                        }
                    }
                }
                const labelsPost = /\/issues\/(\d+)\/labels$/.exec(path)
                if (method === "POST" && labelsPost) {
                    const number = Number(labelsPost[1])
                    const labels = state.labels.get(number) ?? []
                    for (const name of body.labels)
                        if (!labels.some((label) => label.name === name)) labels.push({ name })
                    state.labels.set(number, labels)
                    return clone(labels)
                }
                const labelsDelete = /\/issues\/(\d+)\/labels\/(.+)$/.exec(path)
                if (method === "DELETE" && labelsDelete) {
                    const number = Number(labelsDelete[1])
                    state.labels.set(
                        number,
                        (state.labels.get(number) ?? []).filter(
                            (label) => label.name !== decodeURIComponent(labelsDelete[2]),
                        ),
                    )
                    return undefined
                }
            }
            throw new Error(`Unexpected fake API request: ${method} ${path}`)
        },
        async list(path) {
            state.lists.push(path)
            const comments = /\/issues\/(\d+)\/comments\?per_page=100$/.exec(path)
            if (comments) return clone(state.comments.get(Number(comments[1])) ?? [])
            const labels = /\/issues\/(\d+)\/labels\?per_page=100$/.exec(path)
            if (labels) return clone(state.labels.get(Number(labels[1])) ?? [])
            if (path === `${base}/pulls?state=open&per_page=100`)
                return state.pr.state === "open" ? [clone(state.pr)] : []
            if (path.startsWith(`${base}/pulls?state=all&head=NeonTechSpace:`)) {
                const branch = path.split("head=NeonTechSpace:")[1].split("&")[0]
                return clone(state.changePrs.filter((pr) => pr.head === branch))
            }
            throw new Error(`Unexpected fake API list: ${path}`)
        },
    }
    return {
        state,
        api,
        async check(options = {}) {
            await runContributionEvent({
                api,
                event: { repository: repo, pull_request: { number: 81 } },
                eventName: "pull_request_target",
                ...options,
            })
        },
        async command(body, user = owner, options = {}) {
            const comment = {
                id: 900,
                body,
                user,
                issue_url: `https://api.github.com/${base}/issues/42`,
                html_url: `https://github.com/${repository}/issues/42#issuecomment-900`,
            }
            state.commands.set(comment.id, clone(comment))
            await runContributionEvent({
                api,
                event: { repository: repo, issue: issue(), comment },
                eventName: "issue_comment",
                ...options,
            })
        },
    }
}

const labels = (state) => (state.labels.get(81) ?? []).map((label) => label.name).sort()
const closures = (state) =>
    state.writes.filter((write) => write.path === `${base}/pulls/81` && write.body?.state === "closed")
const permissionComments = (state) =>
    (state.comments.get(42) ?? []).filter((comment) => comment.body.startsWith(permissionMarker))

test("command syntax accepts a single exact command and rejects prose, quoting, and extra arguments", () => {
    assert.deepEqual(parseCommand(" /allow-pr @sample-contributor\n"), { name: "allow-pr", login: contributor.login })
    assert.deepEqual(parseCommand("/recheck"), { name: "recheck" })
    for (const body of [
        "> /vouch @sample-contributor",
        "Please /vouch @sample-contributor",
        "/vouch @sample-contributor extra",
        "/vouch @sample-contributor\n/recheck",
        "`/vouch @sample-contributor`",
        "/allow-pr @github-actions[bot]",
    ]) {
        assert.equal(parseCommand(body), undefined, body)
    }
})

test("issue references require an explicit same-repository line and ignore instructions and examples", () => {
    const body = [
        "Issue: #42",
        "Fixes https://github.com/NeonTechSpace/Fluxerly.js/issues/43",
        "Issue: #42",
        "<!--\nIssue: #44\n-->",
        "```markdown\nIssue: #45\n```",
        "> Issue: #46",
        "Issue: https://github.com/another/project/issues/47",
        "Mention #48 in prose",
        "Issue: `#49`",
    ].join("\n")
    assert.deepEqual(linkedIssues(body), [42, 43])
})

test("examples and foreign references in a PR body cannot activate a real issue grant", async () => {
    for (const body of [
        "Issue: https://github.com/another/project/issues/42",
        "<!--\nIssue: #42\n-->",
        "```markdown\nIssue: #42\n```",
        "~~~markdown\nIssue: #42\n~~~",
        "> Issue: #42",
        "Issue: `#42`",
        "    Issue: #42",
        "```markdown\nIssue: #42",
    ]) {
        const f = fixture()
        f.state.pr.body = body
        f.state.comments.set(42, [grantComment([grant(contributor)])])
        await f.check()
        assert.equal(f.state.pr.state, "closed", body)
        assert.deepEqual(labels(f.state), ["vouch:unvouched"], body)
    }
})

for (const command of ["vouch", "unvouch", "allow-pr", "revoke-pr"]) {
    test(`an unauthorized commenter cannot execute /${command}`, async () => {
        const f = fixture()
        await f.command(`/${command} @${stranger.login}`, stranger)
        assert.deepEqual(f.state.writes, [])
        assert.deepEqual(f.state.trust.users, [])
        assert.deepEqual(permissionComments(f.state), [])
    })
}

test("maintainer, allowlisted automation, and trusted users are admitted by numeric identity", async () => {
    for (const user of [
        owner,
        writer,
        { id: 49699333, login: "dependabot[bot]" },
        { ...contributor, login: "renamed-contributor" },
    ]) {
        const f = fixture()
        f.state.trust.users = [contributor]
        f.state.pr.user = user
        await f.check()
        assert.equal(f.state.pr.state, "open", user.login)
        assert.deepEqual(labels(f.state), ["vouch:trusted"])
    }
})

test("a reused trusted login and an arbitrary bot do not acquire general permission", async () => {
    for (const user of [
        { ...stranger, login: contributor.login },
        { id: 700003, login: "third-party[bot]", type: "Bot" },
    ]) {
        const f = fixture()
        f.state.trust.users = [contributor]
        f.state.pr.user = user
        await f.check()
        assert.equal(f.state.pr.state, "closed")
        assert.deepEqual(labels(f.state), ["vouch:unvouched"])
    }
})

test("policy and trust are read from the same resolved upstream main revision", async () => {
    const f = fixture()
    f.state.pr.user = owner
    await f.check()
    const contentReads = f.state.requests.filter((request) => request.path.includes("/contents/"))
    assert.ok(contentReads.length >= 2)
    assert.ok(contentReads.every((request) => request.path.endsWith(`?ref=${mainSha}`)))
    for (let index = 0; index < contentReads.length; index += 2) {
        assert.ok(contentReads[index].path.includes("contribution-policy.json"))
        assert.ok(contentReads[index + 1].path.includes("VOUCHED.json"))
    }
})

for (const broken of [
    "missing trust",
    "malformed trust",
    "duplicate trust identities",
    "missing main revision",
    "wrong repository identity",
]) {
    test(`unverifiable ${broken} does not mutate or close a PR`, async () => {
        const f = fixture()
        if (broken === "malformed trust") f.state.trust = { version: 1, users: "invalid" }
        if (broken === "duplicate trust identities") f.state.trust.users = [contributor, contributor]
        f.state.beforeRequest = ({ path }) => {
            if (broken === "missing trust" && path.includes("/contents/.github/VOUCHED.json"))
                throw new GitHubError(404)
            if (broken === "missing main revision" && path === `${base}/git/ref/heads/main`) f.state.sha = "invalid"
            if (broken === "wrong repository identity" && path === base) throw new GitHubError(404)
        }
        await assert.rejects(f.check())
        assert.deepEqual(f.state.writes, [])
        assert.equal(f.state.pr.state, "open")
    })
}

test("an open linked issue grants permission only to the matching numeric author", async () => {
    const f = fixture()
    f.state.pr.body = "Issue: #42"
    f.state.pr.user = { ...contributor, login: "renamed-contributor" }
    f.state.comments.set(42, [grantComment([grant(contributor)])])
    await f.check()
    assert.equal(f.state.pr.state, "open")
    assert.deepEqual(labels(f.state), ["permission:issue", "vouch:unvouched"])
    f.state.pr.user = stranger
    await f.check()
    assert.equal(f.state.pr.state, "closed")
    assert.deepEqual(labels(f.state), ["vouch:unvouched"])
})

test("stranger-authored records and manually applied labels do not authorize a PR", async () => {
    const f = fixture()
    f.state.pr.body = "Issue: #42"
    f.state.comments.set(42, [grantComment([grant(contributor)], stranger)])
    f.state.labels.set(81, [{ name: "vouch:trusted" }, { name: "permission:issue" }, { name: "bug" }])
    f.state.labels.set(42, [{ name: "pr:allowed" }])
    await f.check()
    assert.equal(f.state.pr.state, "closed")
    assert.deepEqual(labels(f.state), ["bug", "vouch:unvouched"])
})

for (const record of ["malformed", "ambiguous", "unauthorized issuer", "duplicate grants"]) {
    test(`${record[0].toUpperCase() + record.slice(1)} permission records prevent closure instead of guessing`, async () => {
        const f = fixture()
        f.state.pr.body = "Issue: #42"
        let records = [grantComment([grant(contributor)])]
        if (record === "malformed") records[0].body = `${permissionMarker}\nnot JSON`
        if (record === "ambiguous") records.push({ ...records[0], id: 902 })
        if (record === "unauthorized issuer")
            records = [grantComment([{ ...grant(contributor), issuerId: stranger.id }])]
        if (record === "duplicate grants") records = [grantComment([grant(contributor), grant(contributor)])]
        f.state.comments.set(42, records)
        await assert.rejects(f.check())
        assert.deepEqual(f.state.writes, [])
        assert.equal(f.state.pr.state, "open")
    })
}

for (const invalid of ["closed", "pull request", "missing"]) {
    test(`a ${invalid} linked issue cannot grant contribution permission`, async () => {
        const f = fixture()
        f.state.pr.body = "Issue: #42"
        f.state.comments.set(42, [grantComment([grant(contributor)])])
        if (invalid === "closed") f.state.issues.get(42).state = "closed"
        if (invalid === "pull request")
            f.state.issues.get(42).pull_request = { url: `https://api.github.com/${base}/pulls/42` }
        if (invalid === "missing") f.state.issues.delete(42)
        await f.check()
        assert.equal(f.state.pr.state, "closed")
        assert.deepEqual(labels(f.state), ["vouch:unvouched"])
    })
}

test("an issue response from another repository is not trusted as a permission source", async () => {
    const f = fixture()
    f.state.pr.body = "Issue: #42"
    f.state.issues.get(42).url = "https://api.github.com/repos/another/project/issues/42"
    f.state.comments.set(42, [grantComment([grant(contributor)])])
    await assert.rejects(f.check())
    assert.deepEqual(f.state.writes, [])
})

test("an unavailable issue or comments list leaves the decision unresolved without writes", async () => {
    for (const boundary of ["issue", "comments"]) {
        const f = fixture()
        f.state.pr.body = "Issue: #42"
        if (boundary === "issue")
            f.state.beforeRequest = ({ path }) => {
                if (path === `${base}/issues/42`) throw new GitHubError(503)
            }
        else {
            const original = f.api.list.bind(f.api)
            f.api.list = (path) =>
                path === `${base}/issues/42/comments?per_page=100`
                    ? Promise.reject(new GitHubError(503))
                    : original(path)
        }
        await assert.rejects(f.check())
        assert.deepEqual(f.state.writes, [])
    }
})

test("repeated unauthorized submissions are closed without duplicate explanation comments", async () => {
    const f = fixture()
    await f.check()
    f.state.pr.state = "open"
    await f.check()
    assert.equal(closures(f.state).length, 2)
    assert.equal((f.state.comments.get(81) ?? []).length, 1)
})

test("a PR body corrected during evaluation is reread before closing", async () => {
    const f = fixture()
    f.state.comments.set(42, [grantComment([grant(contributor)])])
    let reads = 0
    f.state.beforeRequest = ({ path }) => {
        if (path === `${base}/pulls/81` && ++reads === 2) f.state.pr.body = "Issue: #42"
    }
    await f.check()
    assert.equal(f.state.pr.state, "open")
    assert.deepEqual(labels(f.state), ["permission:issue", "vouch:unvouched"])
})

test("a trust change merged during evaluation is reread before closing", async () => {
    const f = fixture()
    let reads = 0
    f.state.beforeRequest = ({ path }) => {
        if (path === `${base}/pulls/81` && ++reads === 2) {
            f.state.sha = nextSha
            f.state.trust.users = [contributor]
        }
    }
    await f.check()
    assert.equal(f.state.pr.state, "open")
    assert.deepEqual(labels(f.state), ["vouch:trusted"])
    const readsAtNext = f.state.requests.filter((request) => request.path.endsWith(`?ref=${nextSha}`))
    assert.equal(readsAtNext.length, 2)
})

test("disabling the contribution gate during evaluation prevents closure and labeling", async () => {
    const f = fixture()
    let reads = 0
    f.state.beforeRequest = ({ path }) => {
        if (path === `${base}/pulls/81` && ++reads === 2) f.state.policy.enabled = false
    }
    await f.check()
    assert.equal(f.state.pr.state, "open")
    assert.deepEqual(f.state.writes, [])
})

test("an issue grant is recorded, displayed, and applied without repository commits", async () => {
    const f = fixture()
    f.state.pr.body = "Issue: #42"
    await f.command(`/allow-pr @${contributor.login}`)
    const record = permissionComments(f.state)
    assert.equal(record.length, 1)
    assert.ok(record[0].body.includes(`"id": ${contributor.id}`))
    assert.ok(record[0].body.includes(`"issuerId": ${owner.id}`))
    assert.deepEqual(f.state.labels.get(42), [{ name: "pr:allowed" }])
    assert.deepEqual(labels(f.state), ["permission:issue", "vouch:unvouched"])
    assert.ok(f.state.writes.every((write) => !write.path.includes("/contents/") && !write.path.includes("/git/")))
})

test("revoking a grant removes special permission and rechecks existing PRs", async () => {
    const f = fixture()
    f.state.pr.body = "Issue: #42"
    f.state.comments.set(42, [grantComment([grant(contributor)])])
    f.state.labels.set(42, [{ name: "pr:allowed" }])
    f.state.labels.set(81, [{ name: "vouch:unvouched" }, { name: "permission:issue" }])
    await f.command(`/revoke-pr @${contributor.login}`)
    assert.equal(f.state.pr.state, "closed")
    assert.deepEqual(f.state.labels.get(42), [])
    assert.deepEqual(labels(f.state), ["vouch:unvouched"])
    assert.deepEqual(JSON.parse(permissionComments(f.state)[0].body.split("```json\n")[1].split("\n```")[0]).grants, [])
})

test("closing the source issue removes its invitation label and rechecks existing PRs", async () => {
    const f = fixture()
    f.state.pr.body = "Issue: #42"
    f.state.issues.get(42).state = "closed"
    f.state.comments.set(42, [grantComment([grant(contributor)])])
    f.state.labels.set(42, [{ name: "pr:allowed" }])
    f.state.labels.set(81, [{ name: "vouch:unvouched" }, { name: "permission:issue" }])
    await runContributionEvent({
        api: f.api,
        event: { repository: repo, action: "closed", issue: issue() },
        eventName: "issues",
    })
    assert.equal(f.state.pr.state, "closed")
    assert.deepEqual(f.state.labels.get(42), [])
    assert.deepEqual(labels(f.state), ["vouch:unvouched"])
})

test("trust commands prepare one review PR with configured human commit identity", async () => {
    const f = fixture()
    await f.command(`/vouch @${contributor.login}`)
    await f.command(`/vouch @${contributor.login}`)
    assert.equal(f.state.changePrs.length, 1)
    const changes = f.state.writes.filter((write) => write.method === "PUT")
    assert.equal(changes.length, 1)
    assert.deepEqual(changes[0].body.author, f.state.policy.commitIdentity)
    assert.deepEqual(changes[0].body.committer, f.state.policy.commitIdentity)
    assert.deepEqual(JSON.parse(Buffer.from(changes[0].body.content, "base64").toString("utf8")), {
        version: 1,
        users: [contributor],
    })
    assert.deepEqual(f.state.trust.users, [])
    assert.equal(f.state.changePrs[0].base, "main")
    assert.equal(f.state.changePrs[0].head, `contributions/vouch-${contributor.id}-900`)
    const checks = f.state.writes.filter((write) => write.path === `${base}/actions/workflows/ci.yml/dispatches`)
    assert.equal(checks.length, 2)
    assert.ok(checks.every((write) => write.body.ref === f.state.changePrs[0].head))
})

test("unvouch prepares revocation rather than granting a user or modifying main directly", async () => {
    const f = fixture()
    f.state.trust.users = [contributor, stranger]
    await f.command(`/unvouch @${contributor.login}`)
    const write = f.state.writes.find((entry) => entry.method === "PUT")
    assert.deepEqual(JSON.parse(Buffer.from(write.body.content, "base64").toString("utf8")).users, [stranger])
    assert.ok(write.body.branch.startsWith("contributions/unvouch-"))
    assert.deepEqual(f.state.trust.users, [contributor, stranger])
})

test("already satisfied general trust commands create no branch, commit, or PR", async () => {
    for (const command of ["vouch", "unvouch"]) {
        const f = fixture()
        if (command === "vouch") f.state.trust.users = [contributor]
        await f.command(`/${command} @${contributor.login}`)
        assert.deepEqual(f.state.writes, [])
        assert.deepEqual(f.state.changePrs, [])
    }
})

test("dry-run performs no writes for PR checks, issue grants, revocations, and trust changes", async () => {
    for (const operation of ["check", "allow-pr", "revoke-pr", "vouch", "unvouch"]) {
        const f = fixture()
        if (operation === "unvouch") f.state.trust.users = [contributor]
        if (operation === "revoke-pr") f.state.comments.set(42, [grantComment([grant(contributor)])])
        const before = clone({
            trust: f.state.trust,
            pr: f.state.pr,
            comments: f.state.comments,
            labels: f.state.labels,
        })
        if (operation === "check") await f.check({ dryRun: true })
        else await f.command(`/${operation} @${contributor.login}`, owner, { dryRun: true })
        assert.deepEqual(f.state.writes, [], operation)
        assert.deepEqual(
            { trust: f.state.trust, pr: f.state.pr, comments: f.state.comments, labels: f.state.labels },
            before,
            operation,
        )
        assert.equal(f.state.changePrs.length, 0, operation)
    }
})

test("a changed command is rejected before permissions are changed", async () => {
    const f = fixture()
    f.state.beforeRequest = ({ path }) => {
        if (path === `${base}/issues/comments/900`) f.state.commands.get(900).body = `/allow-pr @${stranger.login}`
    }
    await assert.rejects(f.command(`/allow-pr @${contributor.login}`))
    assert.deepEqual(f.state.writes, [])
})

test("a command copied from another issue cannot mutate this issue", async () => {
    const f = fixture()
    f.state.beforeRequest = ({ path }) => {
        if (path === `${base}/issues/comments/900`)
            f.state.commands.get(900).issue_url = `https://api.github.com/${base}/issues/43`
    }
    await assert.rejects(f.command(`/allow-pr @${contributor.login}`))
    assert.deepEqual(f.state.writes, [])
})

test("a command targeting a closed issue or PR cannot create grants", async () => {
    for (const target of [
        { ...issue(), state: "closed" },
        { ...issue(), pull_request: {} },
    ]) {
        const f = fixture()
        f.state.issues.set(42, target)
        await f.command(`/allow-pr @${contributor.login}`)
        assert.deepEqual(f.state.writes, [])
        assert.deepEqual(permissionComments(f.state), [])
    }
})

test("events for a different numeric repository identity are rejected", async () => {
    const f = fixture()
    await assert.rejects(
        runContributionEvent({
            api: f.api,
            event: { repository: { ...repo, id: 700004 }, pull_request: { number: 81 } },
            eventName: "pull_request_target",
        }),
    )
    assert.deepEqual(f.state.requests, [])
    assert.deepEqual(f.state.writes, [])
})

test("the disabled preparation policy makes all supported event paths read-only", async () => {
    for (const eventName of ["pull_request_target", "issue_comment", "issues", "push", "workflow_dispatch"]) {
        const f = fixture()
        f.state.policy.enabled = false
        const comment = {
            id: 900,
            body: `/vouch @${contributor.login}`,
            user: owner,
            issue_url: `https://api.github.com/${base}/issues/42`,
        }
        f.state.commands.set(900, comment)
        await runContributionEvent({
            api: f.api,
            eventName,
            event: { repository: repo, action: "reopened", pull_request: { number: 81 }, issue: issue(), comment },
        })
        assert.deepEqual(f.state.writes, [], eventName)
        assert.equal(f.state.pr.state, "open", eventName)
        assert.deepEqual(f.state.trust.users, [], eventName)
        assert.deepEqual(f.state.changePrs, [], eventName)
    }
})

test("freshly disabled command and issue policies prevent mutation after the initial phase read", async () => {
    for (const eventName of ["issue_comment", "issues"]) {
        const f = fixture()
        f.state.comments.set(42, [grantComment([grant(contributor)])])
        let mainReads = 0
        f.state.beforeRequest = ({ path }) => {
            if (path === `${base}/git/ref/heads/main` && ++mainReads === 2) f.state.policy.enabled = false
        }
        if (eventName === "issue_comment") await f.command(`/vouch @${contributor.login}`)
        else
            await runContributionEvent({
                api: f.api,
                event: { repository: repo, action: "closed", issue: issue() },
                eventName,
            })
        assert.deepEqual(f.state.writes, [], eventName)
        assert.deepEqual(f.state.changePrs, [], eventName)
    }
})

const prEvent = (action) => ({ repository: repo, action, pull_request: { number: 81 } })
const modelComments = (state, number) =>
    (state.comments.get(number) ?? []).filter((comment) => comment.body.startsWith(modelMarker))
const grantedPr = (f, section) => {
    f.state.pr.body = `Issue: #42\n\n${section}`
    f.state.comments.set(42, [grantComment([grant(contributor)])])
}
const models = (...lines) => `## Models used\n\n${lines.join("\n")}`
const issueEvent = (f, action, number = 50, options = {}) =>
    runContributionEvent({
        api: f.api,
        event: { repository: repo, action, issue: { number } },
        eventName: "issues",
        ...options,
    })
const authoredIssue = (f, body, user = contributor, number = 50) =>
    f.state.issues.set(number, { ...issue(number), user, body })

test("model declarations need visible, filled lines with a known reasoning setting", () => {
    const parsed = parseModels(
        `${models(allowedLine, "* Model: Model One | Reasoning: low | Harness: other")}\n\n## Contributor confirmation\n\n- unrelated`,
    )
    assert.deepEqual(
        parsed.models.map((entry) => entry.model),
        ["example-model-1", "Model One"],
    )
    assert.deepEqual(parseModels("### Models used\n\nNone"), { models: [] })
    assert.deepEqual(parseModels(models("- None")), { models: [] })
    for (const [body, error] of [
        ["## Change\n\nText", "missing"],
        ["### Models used\n\n_No response_\n\n### Prose attribution", "missing"],
        [models(`<!--\n${allowedLine}\n-->`), "missing"],
        [models("```text", allowedLine, "```"), "missing"],
        [`> ## Models used\n> ${allowedLine}`, "missing"],
        [models("- Model: (model id) | Reasoning: (setting) | Harness: (harness)"), "malformed"],
        [models("- Model: example-model-1 | Reasoning: Unknown | Harness: example-cli"), "malformed"],
        [models("- Model: example-model-1 | Reasoning: high"), "malformed"],
        [models("Model: example-model-1 | Reasoning: high | Harness: example-cli"), "malformed"],
        [models("None", allowedLine), "malformed"],
    ]) {
        assert.equal(parseModels(body).error, error, body)
    }
})

test("an unvouched PR's own event closes a missing, malformed, or unlisted model declaration", async () => {
    for (const section of [
        "",
        models("- Model: (model id) | Reasoning: (setting) | Harness: (harness)"),
        models(allowedLine, "- Model: unlisted-model | Reasoning: high | Harness: example-cli"),
    ]) {
        const f = fixture()
        grantedPr(f, section)
        await f.check({ event: prEvent("opened") })
        assert.equal(f.state.pr.state, "closed", section)
        assert.deepEqual(labels(f.state), ["permission:issue", "vouch:unvouched"])
        const comments = f.state.comments.get(81)
        assert.equal(comments.length, 1)
        assert.ok(comments[0].body.startsWith(modelMarker))
        assert.ok(comments[0].body.includes("/docs/CONTRIBUTING.md#disclose-models-used"))
        // Reopening without a correction closes again without repeating the explanation
        f.state.pr.state = "open"
        await f.check({ event: prEvent("reopened") })
        assert.equal(closures(f.state).length, 2)
        assert.equal(f.state.comments.get(81).length, 1)
    }
})

test("allowed models match by id, name, or alias regardless of case and separators", async () => {
    for (const declared of ["example-model-1", "Example Model 1", "model_one", "EXAMPLE MODEL-1"]) {
        const f = fixture()
        grantedPr(f, models(`- Model: ${declared} | Reasoning: high | Harness: example-cli`))
        await f.check({ event: prEvent("edited") })
        assert.equal(f.state.pr.state, "open", declared)
        assert.deepEqual(modelComments(f.state, 81), [])
    }
    const f = fixture()
    grantedPr(f, models("None"))
    await f.check({ event: prEvent("synchronize") })
    assert.equal(f.state.pr.state, "open")
})

test("a replaced model keeps passing through its allowedUntil date and fails after it", async () => {
    for (const [today, state] of [
        ["2026-10-11", "open"],
        ["2026-10-12", "closed"],
    ]) {
        const f = fixture()
        grantedPr(f, models("- Model: example-model-0 | Reasoning: high | Harness: example-cli"))
        await f.check({ event: prEvent("ready_for_review"), today })
        assert.equal(f.state.pr.state, state, today)
    }
})

test("maintainers and vouched contributors need no model declaration", async () => {
    for (const user of [owner, contributor]) {
        const f = fixture()
        f.state.trust.users = [contributor]
        f.state.pr.user = user
        await f.check({ event: prEvent("opened") })
        assert.equal(f.state.pr.state, "open", user.login)
        authoredIssue(f, "### Problem\n\nText", user)
        await issueEvent(f, "opened")
        assert.equal(f.state.issues.get(50).state, "open", user.login)
        assert.deepEqual(modelComments(f.state, 50), [])
    }
})

test("keep-open stops both the permission closure and the model closure", async () => {
    for (const granted of [false, true]) {
        const f = fixture()
        if (granted) grantedPr(f, "")
        f.state.labels.set(81, [{ name: "keep-open" }])
        await f.check({ event: prEvent("opened") })
        assert.equal(f.state.pr.state, "open")
        assert.equal(f.state.comments.get(81), undefined)
    }
    const f = fixture()
    authoredIssue(f, "### Problem\n\nText")
    f.state.labels.set(50, [{ name: "keep-open" }])
    await issueEvent(f, "opened")
    assert.equal(f.state.issues.get(50).state, "open")
    assert.deepEqual(f.state.writes, [])
})

test("a model list change never closes open PRs, while /recheck and a single-PR dispatch apply it", async () => {
    const changed = () => {
        const f = fixture()
        grantedPr(f, models(allowedLine))
        f.state.policy.allowedModels = [{ id: "example-model-2", name: "Example Model 2" }]
        return f
    }
    for (const run of [
        (f) => runContributionEvent({ api: f.api, event: { repository: repo }, eventName: "push" }),
        (f) => runContributionEvent({ api: f.api, event: { repository: repo }, eventName: "workflow_dispatch" }),
        (f) => f.check({ event: prEvent("converted_to_draft") }),
        (f) => f.command(`/allow-pr @${stranger.login}`),
    ]) {
        const f = changed()
        await run(f)
        assert.equal(f.state.pr.state, "open")
        assert.deepEqual(modelComments(f.state, 81), [])
    }
    for (const run of [
        (f) => {
            const comment = {
                id: 900,
                body: "/recheck",
                user: contributor,
                issue_url: `https://api.github.com/${base}/issues/81`,
            }
            f.state.commands.set(comment.id, clone(comment))
            return runContributionEvent({
                api: f.api,
                event: { repository: repo, issue: { number: 81, pull_request: {} }, comment },
                eventName: "issue_comment",
            })
        },
        (f) =>
            runContributionEvent({
                api: f.api,
                event: { repository: repo },
                eventName: "workflow_dispatch",
                prNumber: 81,
            }),
    ]) {
        const f = changed()
        await run(f)
        assert.equal(f.state.pr.state, "closed")
        assert.equal(modelComments(f.state, 81).length, 1)
    }
})

for (const [name, allowedModels] of [
    ["a missing", undefined],
    ["an empty", []],
    ["a nameless entry in the", [{ id: "example-model-1" }]],
    ["a non-text alias in the", [{ id: "example-model-1", name: "Example Model 1", aliases: [1] }]],
    ["an impossible date in the", [{ id: "example-model-1", name: "Example Model 1", allowedUntil: "2026-02-30" }]],
]) {
    test(`${name[0].toUpperCase() + name.slice(1)} model list fails the run without closing anything`, async () => {
        for (const run of [
            (f) => f.check({ event: prEvent("opened") }),
            (f) => runContributionEvent({ api: f.api, event: { repository: repo }, eventName: "push" }),
            (f) => issueEvent(f, "opened"),
        ]) {
            const f = fixture()
            authoredIssue(f, "")
            f.state.policy.allowedModels = allowedModels
            await assert.rejects(run(f), /Allowed model list is malformed/)
            assert.deepEqual(f.state.writes, [])
        }
    })
}

test("a declaration corrected or a keep-open label added during evaluation is reread before closing", async () => {
    for (const late of [
        (state) => (state.pr.body = `Issue: #42\n\n${models(allowedLine)}`),
        (state) => state.labels.set(81, [{ name: "keep-open" }]),
    ]) {
        const f = fixture()
        grantedPr(f, "")
        let reads = 0
        f.state.beforeRequest = ({ path, state }) => {
            if (path === `${base}/pulls/81` && ++reads === 2) late(state)
        }
        await f.check({ event: prEvent("opened") })
        assert.equal(f.state.pr.state, "open")
        assert.deepEqual(modelComments(f.state, 81), [])
    }
    const f = fixture()
    authoredIssue(f, "")
    let reads = 0
    f.state.beforeRequest = ({ path, state }) => {
        if (path === `${base}/issues/50` && ++reads === 2) state.issues.get(50).body = models(allowedLine)
    }
    await issueEvent(f, "edited")
    assert.equal(f.state.issues.get(50).state, "open")
    assert.deepEqual(f.state.writes, [])
})

test("an unvouched issue is checked when opened, edited, or reopened, and not when closed", async () => {
    for (const action of ["opened", "edited", "reopened"]) {
        const f = fixture()
        authoredIssue(f, "### Problem\n\nText\n\n### Models used\n\n_No response_")
        await issueEvent(f, action)
        assert.equal(f.state.issues.get(50).state, "closed", action)
        assert.equal(f.state.issues.get(50).state_reason, "not_planned")
        const comments = modelComments(f.state, 50)
        assert.equal(comments.length, 1)
        assert.ok(comments[0].body.includes("This issue needs"))
    }
    const valid = fixture()
    authoredIssue(valid, `### Problem\n\nText\n\n### Models used\n\n${allowedLine}`)
    await issueEvent(valid, "opened")
    assert.equal(valid.state.issues.get(50).state, "open")
    assert.deepEqual(valid.state.writes, [])
    const closed = fixture()
    authoredIssue(closed, "")
    closed.state.issues.get(50).state = "closed"
    await issueEvent(closed, "closed")
    assert.deepEqual(modelComments(closed.state, 50), [])
})

test("closing an issue for its declaration withdraws grants that depended on it being open", async () => {
    const f = fixture()
    grantedPr(f, models(allowedLine))
    authoredIssue(f, "", contributor, 42)
    f.state.labels.set(42, [{ name: "pr:allowed" }])
    await issueEvent(f, "edited", 42)
    assert.equal(f.state.issues.get(42).state, "closed")
    assert.deepEqual(f.state.labels.get(42), [])
    assert.equal(f.state.pr.state, "closed")
    assert.deepEqual(labels(f.state), ["vouch:unvouched"])
})

test("dry-run reports model closures without writing", async () => {
    const f = fixture()
    grantedPr(f, "")
    authoredIssue(f, "")
    const logged = []
    const log = (line) => logged.push(line)
    await f.check({ event: prEvent("opened"), dryRun: true, log })
    await issueEvent(f, "opened", 50, { dryRun: true, log })
    assert.deepEqual(f.state.writes, [])
    assert.equal(f.state.pr.state, "open")
    assert.equal(f.state.issues.get(50).state, "open")
    assert.ok(logged.includes(`Would perform PATCH ${base}/pulls/81`))
    assert.ok(logged.includes(`Would perform PATCH ${base}/issues/50`))
})

test("a corrected edit reopens what the workflow closed, since the author cannot reopen it", async () => {
    const declared = fixture()
    grantedPr(declared, "")
    await declared.check({ event: prEvent("opened") })
    assert.equal(declared.state.pr.state, "closed")
    declared.state.pr.body = `Issue: #42\n\n${models(allowedLine)}`
    await declared.check({ event: prEvent("edited") })
    assert.equal(declared.state.pr.state, "open")
    assert.deepEqual(labels(declared.state), ["permission:issue", "vouch:unvouched"])

    const permitted = fixture()
    await permitted.check({ event: prEvent("opened") })
    assert.equal(permitted.state.pr.state, "closed")
    grantedPr(permitted, models(allowedLine))
    await permitted.check({ event: prEvent("edited") })
    assert.equal(permitted.state.pr.state, "open")

    const reported = fixture()
    authoredIssue(reported, "")
    await issueEvent(reported, "opened")
    assert.equal(reported.state.issues.get(50).state, "closed")
    reported.state.issues.get(50).body = models(allowedLine)
    await issueEvent(reported, "edited")
    assert.equal(reported.state.issues.get(50).state, "open")
})

test("an edit does not reopen a still failing item, a maintainer's closure, or a merged PR", async () => {
    for (const setup of [
        () => {},
        (state) => (state.pr.closed_by = owner),
        (state) => state.comments.set(81, []),
        (state) => (state.pr.merged_at = "2026-10-11T00:00:00Z"),
    ]) {
        const f = fixture()
        grantedPr(f, "")
        await f.check({ event: prEvent("opened") })
        if (setup.length) f.state.pr.body = `Issue: #42\n\n${models(allowedLine)}`
        setup(f.state)
        const writes = f.state.writes.length
        await f.check({ event: prEvent("edited") })
        assert.equal(f.state.pr.state, "closed", String(setup))
        assert.equal(f.state.writes.length, writes, String(setup))
    }
})

test("reopening a corrected issue restores the grants that its closure withdrew", async () => {
    const f = fixture()
    grantedPr(f, models(allowedLine))
    authoredIssue(f, "", contributor, 42)
    f.state.labels.set(42, [{ name: "pr:allowed" }])
    await issueEvent(f, "edited", 42)
    assert.deepEqual(f.state.labels.get(42), [])
    f.state.issues.get(42).body = models(allowedLine)
    await issueEvent(f, "edited", 42)
    assert.equal(f.state.issues.get(42).state, "open")
    assert.deepEqual(f.state.labels.get(42), [{ name: "pr:allowed" }])
})

test("a PR GitHub refuses to reopen is reported without failing the run", async () => {
    const f = fixture()
    grantedPr(f, "")
    await f.check({ event: prEvent("opened") })
    f.state.pr.body = `Issue: #42\n\n${models(allowedLine)}`
    f.state.beforeRequest = ({ method, body }) => {
        if (method === "PATCH" && body?.state === "open") throw new GitHubError(422)
    }
    const logged = []
    await f.check({ event: prEvent("edited"), log: (line) => logged.push(line) })
    assert.equal(f.state.pr.state, "closed")
    assert.ok(logged.includes("PR #81: corrected, but GitHub refused to reopen it"))
})
