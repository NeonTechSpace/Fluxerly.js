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
const modelMarker = "<!-- fluxerly-contribution-model-result:v1 -->"
const modelEvents = ["opened", "reopened", "edited", "synchronize", "ready_for_review"]
const overrideLabel = "keep-open"
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

function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const date = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const normalizeModel = (value) => value.trim().toLowerCase().replace(/[\s_-]+/g, "-")

function validateModels(models) {
    if (!Array.isArray(models) || models.length === 0) throw new Error("Allowed model list is malformed")
    for (const model of models) {
        if (
            (model?.aliases !== undefined && !Array.isArray(model.aliases)) ||
            ![model?.id, model?.name, ...(model?.aliases ?? [])].every(
                (name) => typeof name === "string" && normalizeModel(name),
            ) ||
            (model.allowedUntil !== undefined && !validDate(model.allowedUntil))
        ) {
            throw new Error("Allowed model list is malformed")
        }
    }
    return models
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
    validateModels(policy.allowedModels)
    const trustFile = await api.request("GET", `${base}/contents/${trustPath}?ref=${sha}`)
    return { policy, trust: validateTrust(decodeFile(trustFile)), trustFile, sha }
}

export function parseCommand(body) {
    if (typeof body !== "string") return undefined
    if (body.trim() === "/recheck") return { name: "recheck" }
    const match = /^\/(vouch|unvouch|allow-pr|revoke-pr) @([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\s*$/.exec(body.trim())
    return match ? { name: match[1], login: match[2] } : undefined
}

function visibleLines(body) {
    // Examples, quoted text and hidden template instructions do not authorize or declare anything
    const text = String(body ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    const lines = []
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
        lines.push(line)
    }
    return lines
}

export function linkedIssues(body) {
    const numbers = new Set()
    for (const line of visibleLines(body)) {
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

// Reads "## Models used" in PR bodies and "### Models used" in issue form output
export function parseModels(body) {
    const lines = visibleLines(body)
    const start = lines.findIndex((line) => /^ {0,3}#{2,3}[ \t]+Models used[ \t]*$/i.test(line))
    if (start < 0) return { error: "missing" }
    const section = []
    for (const line of lines.slice(start + 1)) {
        if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) break
        if (line.trim() && line.trim() !== "_No response_") section.push(line.trim())
    }
    if (section.length === 0) return { error: "missing" }
    if (section.length === 1 && /^(?:[-*+][ \t]+)?None$/i.test(section[0])) return { models: [] }
    const models = []
    for (const line of section) {
        const match = /^[-*+][ \t]+Model:[ \t]*(.*?)[ \t]*\|[ \t]*Reasoning:[ \t]*(.*?)[ \t]*\|[ \t]*Harness:[ \t]*(.*)$/i.exec(
            line,
        )
        const values = match?.slice(1) ?? []
        // Unfilled template placeholders such as (model id) do not declare anything
        if (!match || values.some((value) => !value || /^\(.*\)$/.test(value)) || /^unknown$/i.test(values[1])) {
            return { error: "malformed" }
        }
        models.push({ model: values[0], reasoning: values[1], harness: values[2] })
    }
    return { models }
}

function hasOverride(item) {
    return Array.isArray(item.labels) && item.labels.some((label) => label?.name === overrideLabel)
}

function modelProblem(item, policy, trusted, today) {
    if (trusted || hasOverride(item)) return undefined
    const parsed = parseModels(item.body)
    if (parsed.error) return parsed.error
    const accepted = policy.allowedModels
        .filter((model) => !model.allowedUntil || model.allowedUntil >= today)
        .flatMap((model) => [model.id, model.name, ...(model.aliases ?? [])].map(normalizeModel))
    return parsed.models.every((entry) => accepted.includes(normalizeModel(entry.model))) ? undefined : "not allowed"
}

function modelComment(kind) {
    return `${modelMarker}\nThis ${kind} needs a "Models used" section, because its author does not have general vouch status. The section is missing or malformed, or names a model that is not in the allowed model list\n\nUse one line per main model in the form \`- Model: (model id) | Reasoning: (setting) | Harness: (harness)\`, or write \`None\` if no model was used. Edit the ${kind} to correct the section, and it reopens automatically\n\nSee [disclose models used](https://github.com/${repository}/blob/main/docs/CONTRIBUTING.md#disclose-models-used)`
}

function generallyTrusted(user, policy, trust) {
    const author = userRecord(user)
    return (
        policy.maintainerIds.includes(author.id) ||
        policy.automationIds.includes(author.id) ||
        trust.users.some((record) => record.id === author.id)
    )
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
    if (generallyTrusted(author, policy, trust)) return { allowed: true, trusted: true }
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

async function closeWithComment(api, number, body, path, closure, policy, dryRun, log) {
    const comments = await api.list(`${base}/issues/${number}/comments?per_page=100`)
    if (!comments.some((comment) => comment.user?.id === policy.permissionWriterId && comment.body === body)) {
        await change(api, dryRun, "POST", `${base}/issues/${number}/comments`, { body }, log)
    }
    await change(api, dryRun, "PATCH", path, closure, log)
}

function prProblem(pr, decision, policy, models, today) {
    if (hasOverride(pr)) return undefined
    if (!decision.allowed) return "permission"
    return models ? modelProblem(pr, policy, decision.trusted, today) : undefined
}

// Models are checked only for the PR's own events, so a model list change cannot close existing work
async function checkPr(api, number, dryRun, log, { models = false, today } = {}) {
    let { policy, trust } = await loadPolicy(api)
    if (!policy.enabled) return
    let pr = await api.request("GET", `${base}/pulls/${number}`)
    if (pr.state !== "open") return
    let decision = await decide(api, pr, policy, trust)
    let problem = prProblem(pr, decision, policy, models, today)
    if (problem) {
        // Re-evaluate immediately before a closure if the body, head, labels or trusted revision changed
        const latest = await api.request("GET", `${base}/pulls/${number}`)
        const trusted = await loadPolicy(api)
        if (!trusted.policy.enabled) return
        policy = trusted.policy
        if (latest.state !== "open") return
        pr = latest
        decision = await decide(api, pr, trusted.policy, trusted.trust)
        problem = prProblem(pr, decision, policy, models, today)
    }
    const labels = decision.trusted
        ? ["vouch:trusted"]
        : ["vouch:unvouched", ...(decision.issue ? ["permission:issue"] : [])]
    await syncLabels(api, number, managedPrLabels, labels, dryRun, log)
    log(
        `PR #${number}: ${decision.allowed ? (decision.trusted ? "general permission" : "issue-specific permission") : "missing permission"}${problem && problem !== "permission" ? `, models used ${problem}` : ""}${hasOverride(pr) ? `, kept open by ${overrideLabel}` : ""}`,
    )
    if (!problem) return
    const body =
        problem === "permission"
            ? `${outcomeMarker}\nThis PR has no verified contribution permission. General vouch status or a maintainer grant to this author for a linked, open issue is required\n\nFor issue-specific permission, include a line such as \`Issue: #123\` or \`Issue: https://github.com/${repository}/issues/123\` in the PR body. After receiving permission, edit the PR body so it includes the issue reference, and the PR reopens automatically\n\nSee [permission to submit a PR](https://github.com/${repository}/blob/main/docs/CONTRIBUTING.md#permission-to-submit-a-pr). Permission does not approve feature scope or merging`
            : modelComment("PR")
    await closeWithComment(api, number, body, `${base}/pulls/${number}`, { state: "closed" }, policy, dryRun, log)
}

// Authors without write access cannot reopen what the workflow closed, so a corrected edit reopens it.
// Only items whose latest closure came from this workflow are reopened, never a maintainer's own closure
async function reopenCorrected(api, number, pullRequest, dryRun, log, today) {
    const { policy, trust } = await loadPolicy(api)
    if (!policy.enabled) return false
    const issue = await api.request("GET", `${base}/issues/${number}`)
    verifyIssue(issue, number)
    if (issue.state !== "closed" || !!issue.pull_request !== pullRequest) return false
    if (issue.closed_by?.id !== policy.permissionWriterId) return false
    const comments = await api.list(`${base}/issues/${number}/comments?per_page=100`)
    const explained = comments.some(
        (comment) =>
            comment.user?.id === policy.permissionWriterId &&
            [outcomeMarker, modelMarker].some((marker) => String(comment.body ?? "").startsWith(marker)),
    )
    if (!explained) return false
    if (pullRequest) {
        const pr = await api.request("GET", `${base}/pulls/${number}`)
        if (pr.state !== "closed" || pr.merged_at) return false
        if (prProblem(pr, await decide(api, pr, policy, trust), policy, true, today)) return false
    } else if (modelProblem(issue, policy, generallyTrusted(issue.user, policy, trust), today)) {
        return false
    }
    const kind = pullRequest ? "PR" : "Issue"
    try {
        await change(api, dryRun, "PATCH", `${base}/${pullRequest ? "pulls" : "issues"}/${number}`, { state: "open" }, log)
    } catch (error) {
        // GitHub refuses to reopen a PR whose branch was deleted or force-pushed after the closure
        if (!(error instanceof GitHubError) || error.status !== 422) throw error
        log(`${kind} #${number}: corrected, but GitHub refused to reopen it`)
        return false
    }
    log(`${kind} #${number}: corrected after an automatic closure, reopened`)
    return true
}

// Returns whether the issue was closed, so the caller can refresh grants that depended on it being open
async function checkIssue(api, number, dryRun, log, today) {
    const { policy, trust } = await loadPolicy(api)
    if (!policy.enabled) return false
    const issue = await api.request("GET", `${base}/issues/${number}`)
    verifyIssue(issue, number)
    if (issue.pull_request || issue.state !== "open") return false
    if (!modelProblem(issue, policy, generallyTrusted(issue.user, policy, trust), today)) return false
    // Re-evaluate immediately before a closure if the body, labels or trusted revision changed
    const latest = await api.request("GET", `${base}/issues/${number}`)
    verifyIssue(latest, number)
    const current = await loadPolicy(api)
    if (!current.policy.enabled || latest.pull_request || latest.state !== "open") return false
    const trusted = generallyTrusted(latest.user, current.policy, current.trust)
    const problem = modelProblem(latest, current.policy, trusted, today)
    if (!problem) return false
    log(`Issue #${number}: models used ${problem}`)
    await closeWithComment(
        api,
        number,
        modelComment("issue"),
        `${base}/issues/${number}`,
        { state: "closed", state_reason: "not_planned" },
        current.policy,
        dryRun,
        log,
    )
    return true
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

export async function runContributionEvent({
    api,
    event,
    eventName,
    dryRun = false,
    prNumber,
    log = () => {},
    today = new Date().toISOString().slice(0, 10),
}) {
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
        if (event.action === "edited") await reopenCorrected(api, event.pull_request.number, true, dryRun, log, today)
        return await checkPr(api, event.pull_request.number, dryRun, log, {
            models: modelEvents.includes(event.action),
            today,
        })
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
            return await checkPr(api, event.issue.number, dryRun, log, { models: true, today })
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
        // A reopen by the workflow token starts no new run, so its grants are refreshed here
        const reopened =
            event.action === "edited" && (await reopenCorrected(api, event.issue.number, false, dryRun, log, today))
        const closedByCheck =
            ["opened", "edited", "reopened"].includes(event.action) &&
            (await checkIssue(api, event.issue.number, dryRun, log, today))
        if (!reopened && !closedByCheck && event.action !== "closed" && event.action !== "reopened") return
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
            return await checkPr(api, prNumber, dryRun, log, { models: true, today })
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
