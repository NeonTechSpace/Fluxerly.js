import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repository = "NeonTechSpace/Fluxerly.js"
const base = `repos/${repository}`
const trustPath = ".github/VOUCHED.json"
const policyPath = ".github/contribution-policy.json"
const permissionMarker = "<!-- fluxerly-contribution-permissions:v1 -->"
const outcomeMarker = "<!-- fluxerly-contribution-permission-result:v1 -->"
const managedPrLabels = ["vouch:trusted", "vouch:unvouched", "permission:issue"]
const loginPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})(?:\[bot\])?$/

export class GitHubError extends Error {
    constructor(status) {
        super(`GitHub request failed${status ? ` (HTTP ${status})` : ""}`)
        this.status = status
    }
}

export class GitHub {
    request(method, path, body) {
        return this.call(
            [
                "api",
                "--hostname",
                "github.com",
                "--method",
                method,
                path,
                ...(body === undefined ? [] : ["--input", "-"]),
            ],
            body,
        )
    }

    list(path) {
        const pages = this.call(["api", "--hostname", "github.com", "--paginate", "--slurp", path])
        if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
            throw new Error("GitHub returned an incomplete list")
        }
        return pages.flat()
    }

    call(args, body) {
        let output
        try {
            output = execFileSync("gh", args, {
                input: body === undefined ? undefined : JSON.stringify(body),
                encoding: "utf8",
                stdio: ["pipe", "pipe", "pipe"],
                maxBuffer: 16 * 1024 * 1024,
                timeout: 60_000,
            })
        } catch (error) {
            // CLI diagnostics can contain private response data, so only the HTTP status is retained
            const status = Number(/HTTP (\d{3})/.exec(String(error.stderr ?? ""))?.[1]) || undefined
            throw new GitHubError(status)
        }
        if (!output.trim()) return undefined
        try {
            return JSON.parse(output)
        } catch {
            throw new Error("GitHub returned invalid JSON")
        }
    }
}

function numericId(value) {
    return Number.isSafeInteger(value) && value > 0
}

function userRecord(user) {
    if (!numericId(user?.id) || typeof user.login !== "string" || !loginPattern.test(user.login)) {
        throw new Error("GitHub user identity is unavailable")
    }
    return { id: user.id, login: user.login }
}

function decodeFile(file) {
    if (file?.encoding !== "base64" || typeof file.content !== "string" || !/^[a-f0-9]{40}$/.test(file.sha)) {
        throw new Error("Trusted contribution file is unavailable or incomplete")
    }
    try {
        return JSON.parse(Buffer.from(file.content, "base64").toString("utf8"))
    } catch {
        throw new Error("Trusted contribution file is malformed")
    }
}

function validateTrust(trust) {
    if (trust?.version !== 1 || !Array.isArray(trust.users)) throw new Error("Contribution trust list is malformed")
    const ids = new Set()
    for (const user of trust.users) {
        userRecord(user)
        if (ids.has(user.id)) throw new Error("Contribution trust list contains duplicate identities")
        ids.add(user.id)
    }
    return trust
}

async function loadPolicy(api) {
    const repo = await api.request("GET", base)
    if (repo?.full_name !== repository || repo.default_branch !== "main") {
        throw new Error("Contribution repository identity or default branch changed")
    }
    const ref = await api.request("GET", `${base}/git/ref/heads/main`)
    const sha = ref?.object?.sha
    if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Trusted main revision is unavailable")
    const policy = decodeFile(await api.request("GET", `${base}/contents/${policyPath}?ref=${sha}`))
    if (
        policy?.version !== 1 ||
        typeof policy.enabled !== "boolean" ||
        policy.repository !== repository ||
        policy.repositoryId !== repo.id ||
        !Array.isArray(policy.maintainerIds) ||
        policy.maintainerIds.length === 0 ||
        !policy.maintainerIds.every(numericId) ||
        !Array.isArray(policy.automationIds) ||
        !policy.automationIds.every(numericId) ||
        !numericId(policy.permissionWriterId) ||
        typeof policy.commitIdentity?.name !== "string" ||
        typeof policy.commitIdentity?.email !== "string"
    ) {
        throw new Error("Contribution policy is malformed")
    }
    const trustFile = await api.request("GET", `${base}/contents/${trustPath}?ref=${sha}`)
    return { policy, trust: validateTrust(decodeFile(trustFile)), trustFile, sha }
}

export function parseCommand(body) {
    if (typeof body !== "string") return undefined
    if (body.trim() === "/recheck") return { name: "recheck" }
    const match = /^\/(vouch|unvouch|allow-pr|revoke-pr) @([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\s*$/.exec(body.trim())
    return match ? { name: match[1], login: match[2] } : undefined
}

export function linkedIssues(body) {
    // Examples, quoted text and hidden template instructions do not authorize a submission
    const text = String(body ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    const numbers = new Set()
    let fence
    for (const line of text.split(/\r?\n/)) {
        const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
        if (fence) {
            if (boundary && boundary[1][0] === fence[0] && boundary[1].length >= fence.length && !boundary[2].trim())
                fence = undefined
            continue
        }
        if (boundary) {
            fence = boundary[1]
            continue
        }
        if (/^(?: {4}| *\t| {0,3}>)/.test(line)) continue
        const match =
            /^ {0,3}(?:Issue|Fixes|Closes|Resolves):?\s+(?:#([1-9]\d*)|https:\/\/github\.com\/NeonTechSpace\/Fluxerly\.js\/issues\/([1-9]\d*))\s*$/i.exec(
                line,
            )
        if (match) {
            const number = Number(match[1] ?? match[2])
            if (numericId(number)) numbers.add(number)
        }
    }
    return [...numbers]
}

function readGrants(comments, policy) {
    const records = comments.filter(
        (comment) =>
            comment.user?.id === policy.permissionWriterId && String(comment.body ?? "").startsWith(permissionMarker),
    )
    if (records.length > 1) throw new Error("Issue permission record is ambiguous")
    if (records.length === 0) return { grants: [], comment: undefined }
    const match = /^<!-- fluxerly-contribution-permissions:v1 -->\n```json\n([\s\S]*?)\n```\s*$/.exec(records[0].body)
    let record
    try {
        record = JSON.parse(match?.[1] ?? "")
    } catch {
        throw new Error("Issue permission record is malformed")
    }
    if (record?.version !== 1 || !Array.isArray(record.grants)) throw new Error("Issue permission record is malformed")
    const ids = new Set()
    for (const grant of record.grants) {
        userRecord(grant)
        if (!policy.maintainerIds.includes(grant.issuerId) || !numericId(grant.commandId) || ids.has(grant.id)) {
            throw new Error("Issue permission record contains an invalid grant")
        }
        ids.add(grant.id)
    }
    return { grants: record.grants, comment: records[0] }
}

async function optionalGet(api, path) {
    try {
        return await api.request("GET", path)
    } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return undefined
        throw error
    }
}

function verifyIssue(issue, number) {
    if (issue?.number !== number || issue.url !== `https://api.github.com/${base}/issues/${number}`) {
        throw new Error("Linked issue belongs to another repository or has an invalid identity")
    }
}

async function change(api, dryRun, method, path, body, log) {
    if (dryRun) {
        log(`Would perform ${method} ${path}`)
        return undefined
    }
    return await api.request(method, path, body)
}

async function syncLabels(api, number, managed, wanted, dryRun, log) {
    const current = await api.list(`${base}/issues/${number}/labels?per_page=100`)
    for (const label of current) {
        if (managed.includes(label.name) && !wanted.includes(label.name)) {
            await change(
                api,
                dryRun,
                "DELETE",
                `${base}/issues/${number}/labels/${encodeURIComponent(label.name)}`,
                undefined,
                log,
            )
        }
    }
    const missing = wanted.filter((name) => !current.some((label) => label.name === name))
    if (missing.length) await change(api, dryRun, "POST", `${base}/issues/${number}/labels`, { labels: missing }, log)
}

async function decide(api, pr, policy, trust) {
    const author = userRecord(pr.user)
    if (
        policy.maintainerIds.includes(author.id) ||
        policy.automationIds.includes(author.id) ||
        trust.users.some((user) => user.id === author.id)
    )
        return { allowed: true, trusted: true }
    for (const number of linkedIssues(pr.body)) {
        const issue = await optionalGet(api, `${base}/issues/${number}`)
        if (!issue) continue
        verifyIssue(issue, number)
        if (issue.pull_request || issue.state !== "open") continue
        const comments = await api.list(`${base}/issues/${number}/comments?per_page=100`)
        const { grants } = readGrants(comments, policy)
        if (grants.some((grant) => grant.id === author.id)) return { allowed: true, trusted: false, issue: number }
    }
    return { allowed: false, trusted: false }
}

async function checkPr(api, number, dryRun, log) {
    let { policy, trust } = await loadPolicy(api)
    if (!policy.enabled) return
    let pr = await api.request("GET", `${base}/pulls/${number}`)
    if (pr.state !== "open") return
    let decision = await decide(api, pr, policy, trust)
    if (!decision.allowed) {
        // Re-evaluate immediately before a closure if the body, head or trusted revision changed
        const latest = await api.request("GET", `${base}/pulls/${number}`)
        const trusted = await loadPolicy(api)
        if (!trusted.policy.enabled) return
        policy = trusted.policy
        if (latest.state !== "open") return
        pr = latest
        decision = await decide(api, pr, trusted.policy, trusted.trust)
    }
    const labels = decision.trusted
        ? ["vouch:trusted"]
        : ["vouch:unvouched", ...(decision.issue ? ["permission:issue"] : [])]
    await syncLabels(api, number, managedPrLabels, labels, dryRun, log)
    log(
        `PR #${number}: ${decision.allowed ? (decision.trusted ? "general permission" : "issue-specific permission") : "missing permission"}`,
    )
    if (decision.allowed) return
    const comments = await api.list(`${base}/issues/${number}/comments?per_page=100`)
    const body = `${outcomeMarker}\nThis PR has no verified contribution permission. General vouch status or a maintainer grant to this author for a linked, open issue is required\n\nFor issue-specific permission, include a line such as \`Issue: #123\` or \`Issue: https://github.com/${repository}/issues/123\` in the PR body. Reopen the PR after correcting the issue reference and receiving permission\n\nSee [permission to submit a PR](https://github.com/${repository}/blob/main/docs/CONTRIBUTING.md#permission-to-submit-a-pr). Permission does not approve feature scope or merging`
    if (!comments.some((comment) => comment.user?.id === policy.permissionWriterId && comment.body === body)) {
        await change(api, dryRun, "POST", `${base}/issues/${number}/comments`, { body }, log)
    }
    await change(api, dryRun, "PATCH", `${base}/pulls/${number}`, { state: "closed" }, log)
}

async function recheckOpen(api, dryRun, log) {
    const pulls = await api.list(`${base}/pulls?state=open&per_page=100`)
    for (const pr of pulls) await checkPr(api, pr.number, dryRun, log)
}

async function trustChange(api, event, command, current, dryRun, log) {
    const user = userRecord(await api.request("GET", `users/${command.login}`))
    const existing = current.trust.users.find((record) => record.id === user.id)
    if (command.name === "vouch" ? !!existing : !existing) {
        log("General permission already matches the command")
        return
    }
    const users = current.trust.users.filter((record) => record.id !== user.id)
    if (command.name === "vouch") users.push(user)
    users.sort((a, b) => a.login.localeCompare(b.login))
    const action = command.name === "vouch" ? "Grant" : "Revoke"
    const branch = `contributions/${command.name}-${user.id}-${event.comment.id}`
    const refPath = `${base}/git/ref/heads/${branch}`
    if (!(await optionalGet(api, refPath))) {
        await change(api, dryRun, "POST", `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: current.sha }, log)
    }
    const expectedContent = JSON.stringify({ version: 1, users }, null, 2) + "\n"
    const branchFile = dryRun
        ? current.trustFile
        : await api.request("GET", `${base}/contents/${trustPath}?ref=${branch}`)
    if (Buffer.from(branchFile.content, "base64").toString("utf8") !== expectedContent) {
        await change(
            api,
            dryRun,
            "PUT",
            `${base}/contents/${trustPath}`,
            {
                message: `${action} general contribution permission for ${user.login}`,
                content: Buffer.from(expectedContent).toString("base64"),
                sha: branchFile.sha,
                branch,
                author: current.policy.commitIdentity,
                committer: current.policy.commitIdentity,
            },
            log,
        )
    }
    const existingPr = await api.list(`${base}/pulls?state=all&head=NeonTechSpace:${branch}&per_page=100`)
    if (!existingPr.length) {
        await change(
            api,
            dryRun,
            "POST",
            `${base}/pulls`,
            {
                head: branch,
                base: "main",
                title: `${action} general contribution permission for ${user.login}`,
                body: `## Problem\n\nA maintainer requested a general contribution permission change for @${user.login}.\n\n## Change\n\n${action} the trust-list entry for GitHub user ID ${user.id}.\n\n## Related issue and permission\n\nRequested by [this maintainer command](${event.comment.html_url}).\n\n## Verification\n\nThe command issuer and target user were resolved through GitHub. The change affects only the contribution trust list. Normal review and checks still apply. The permission changes only after this PR merges.\n\n## Models used\n\nThis trust-list update is produced by the deterministic contribution workflow.`,
            },
            log,
        )
    }
    // Token-authored PRs do not trigger pull_request workflows, so request the normal Check explicitly
    await change(api, dryRun, "POST", `${base}/actions/workflows/ci.yml/dispatches`, { ref: branch }, log)
    log(`General permission change prepared for review on ${branch}`)
}

async function issueChange(api, event, command, current, dryRun, log) {
    const issue = await api.request("GET", `${base}/issues/${event.issue.number}`)
    verifyIssue(issue, event.issue.number)
    if (issue.pull_request || issue.state !== "open") {
        log("Issue grants require an open issue rather than a PR")
        return
    }
    const user = userRecord(await api.request("GET", `users/${command.login}`))
    const comments = await api.list(`${base}/issues/${issue.number}/comments?per_page=100`)
    const record = readGrants(comments, current.policy)
    const grants = record.grants.filter((grant) => grant.id !== user.id)
    if (command.name === "allow-pr")
        grants.push({ ...user, issuerId: event.comment.user.id, commandId: event.comment.id })
    grants.sort((a, b) => a.id - b.id)
    const body = `${permissionMarker}\n\`\`\`json\n${JSON.stringify({ version: 1, grants }, null, 2)}\n\`\`\``
    if (record.comment?.body !== body) {
        await change(
            api,
            dryRun,
            record.comment ? "PATCH" : "POST",
            record.comment ? `${base}/issues/comments/${record.comment.id}` : `${base}/issues/${issue.number}/comments`,
            { body },
            log,
        )
    }
    await syncLabels(api, issue.number, ["pr:allowed"], grants.length ? ["pr:allowed"] : [], dryRun, log)
    log(`Issue #${issue.number}: ${command.name === "allow-pr" ? "grant" : "revocation"} for ${user.login}`)
    if (!dryRun) await recheckOpen(api, false, log)
}

export async function runContributionEvent({ api, event, eventName, dryRun = false, prNumber, log = () => {} }) {
    if (event.repository?.full_name !== repository || event.repository?.id !== 1370449818) {
        throw new Error("Contribution event targets the wrong repository")
    }
    const phase = await loadPolicy(api)
    if (!phase.policy.enabled) {
        log("Preparation only: Contribution permission automation is disabled")
        return
    }
    if (eventName === "pull_request_target") {
        if (!numericId(event.pull_request?.number)) throw new Error("PR event number is invalid")
        return await checkPr(api, event.pull_request.number, dryRun, log)
    }
    if (eventName === "issue_comment") {
        const command = parseCommand(event.comment?.body)
        if (!command) return
        if (!numericId(event.comment?.id) || !numericId(event.issue?.number))
            throw new Error("Command event is incomplete")
        const comment = await api.request("GET", `${base}/issues/comments/${event.comment.id}`)
        if (
            comment.body !== event.comment.body ||
            comment.user?.id !== event.comment.user?.id ||
            comment.issue_url !== `https://api.github.com/${base}/issues/${event.issue.number}`
        ) {
            throw new Error("The command changed or belongs to another issue")
        }
        if (command.name === "recheck") {
            if (!event.issue.pull_request) return
            return await checkPr(api, event.issue.number, dryRun, log)
        }
        const current = await loadPolicy(api)
        if (!current.policy.enabled) return
        if (!current.policy.maintainerIds.includes(comment.user.id)) {
            log("Command ignored: Issuer is not an authorized maintainer")
            return
        }
        if (command.name === "vouch" || command.name === "unvouch") {
            return await trustChange(api, event, command, current, dryRun, log)
        }
        return await issueChange(api, event, command, current, dryRun, log)
    }
    if (eventName === "issues") {
        if (!numericId(event.issue?.number) || event.issue.pull_request) return
        const { policy } = await loadPolicy(api)
        if (!policy.enabled) return
        const issue = await api.request("GET", `${base}/issues/${event.issue.number}`)
        verifyIssue(issue, event.issue.number)
        const comments = await api.list(`${base}/issues/${issue.number}/comments?per_page=100`)
        const { grants } = readGrants(comments, policy)
        await syncLabels(
            api,
            issue.number,
            ["pr:allowed"],
            issue.state === "open" && grants.length ? ["pr:allowed"] : [],
            dryRun,
            log,
        )
        return await recheckOpen(api, dryRun, log)
    }
    if (eventName === "push" || eventName === "workflow_dispatch") {
        await loadPolicy(api)
        if (prNumber !== undefined) {
            if (!numericId(prNumber)) throw new Error("Requested PR number is invalid")
            return await checkPr(api, prNumber, dryRun, log)
        }
        return await recheckOpen(api, dryRun, log)
    }
    throw new Error("Unsupported contribution event")
}

async function main() {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
    const input = process.env.CONTRIBUTION_PR_NUMBER
    await runContributionEvent({
        api: new GitHub(),
        event,
        eventName: process.env.GITHUB_EVENT_NAME,
        dryRun: process.env.CONTRIBUTION_DRY_RUN === "true",
        prNumber: input ? Number(input) : undefined,
        log: (message) => process.stdout.write(`${message}\n`),
    })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(
            `${error instanceof GitHubError ? error.message : "Contribution permissions could not be verified. No unresolved decision should be treated as permission."}\n`,
        )
        process.exitCode = 1
    })
}
