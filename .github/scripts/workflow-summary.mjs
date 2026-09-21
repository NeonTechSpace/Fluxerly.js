import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const common = [
    ["checkout", "Selected source checkout"],
    ["setup", "Selected Node runtime, pnpm and locked dependencies"],
]
const browser = [
    ["browser_install", "Chromium and browser system dependencies"],
    ["browser", "Rendered documentation and version archive checks"],
]
export const summaryProfiles = {
    workspace: {
        title: "Workspace checks",
        checks: [
            ...common,
            ["workspace", "SDK, release tooling and documentation aggregate check"],
        ],
        scope: "Workspace checks do not establish browser behavior, registry publication or live sandbox recovery",
        next: "Check the browser and Node consumer jobs too. The check job combines their required results",
    },
    browser: {
        title: "Documentation browser checks",
        checks: [
            ...common,
            ["build", "SDK and documentation build for the browser checks"],
            ...browser,
            ["browser_evidence", "Failing browser evidence upload (only when files exist)"],
        ],
        scope: "Local CI checks do not establish live sandbox recovery, registry publication or deployed Preview health",
        next: "Merge only after required checks pass. Live sandbox checks remain opt-in and separate",
    },
    consumers: {
        title: "SDK consumer compatibility",
        checks: [
            ...common,
            ["build", "SDK build on the selected Node version"],
            ["package", "Packed JavaScript, TypeScript and native Effect consumers"],
            ["npm", "npm-installed consumers on the selected Node version"],
        ],
        scope: "This matrix job checks one selected Node version, not publication or other runtimes",
        next: "Both development and consumer-floor matrix jobs must pass before merging",
    },
    preview: {
        title: "Documentation Preview delivery",
        checks: [
            ...common,
            ["snapshots", "Verified exact-source release snapshots"],
            ["build", "SDK declarations built for documentation"],
            ["workspace", "Full Preview documentation build, types and content checks"],
            ["ci", "Successful Check reused for the exact main checkout"],
            ["source", "Checked checkout recorded in deployment.json"],
            ["deploy", "Exact Cloudflare deployment verification and custom-domain access check"],
        ],
        scope: "Preview-only delivery, not production deployment. A successful exact deployment check does not establish custom-domain access when Cloudflare challenges that request",
        next: "Inspect the verified deployment URL and custom-domain status before sharing the Preview",
    },
    prepare: {
        title: "Immutable release candidate preparation",
        checks: [
            ...common,
            ["support", "Registry publication contract gate"],
            ["workspace", "Aggregate workspace check"],
            ["npm", "npm-installed consumers"],
            ...browser,
            ["candidate", "Checked documentation snapshot and immutable candidate"],
            ["artifact", "Immutable candidate artifact upload"],
        ],
        scope: "Preparation does not publish packages. The registry support gate remains enforced",
        next: "Review the candidate checksum externally, then pass this preparation run ID and checksum to Release publish",
    },
    inspect: {
        title: "Release provenance and candidate inspection",
        checks: [
            ...common,
            ["support", "Registry publication contract gate before protected credentials"],
            ["preparation", "Successful preparation run and selected-source provenance"],
            ["download", "Only the verified preparation artifact downloaded"],
            ["inspect", "Exact candidate checksum, source and contents inspected"],
        ],
        scope: "Inspection does not publish or enter the protected package environment",
        next: "Protected publication may proceed only after this inspection succeeds and environment approval is granted",
    },
    "publish-npm": {
        title: "npm version publication",
        checks: [
            ...common,
            ["download", "Verified preparation artifact downloaded"],
            ["inspect", "Externally reviewed checksum and source reinspected"],
            ["publish", "npm version publication"],
            ["verify", "npm version availability confirmed"],
        ],
        scope: "This job confirms npm version availability. Candidate checksum and contents are inspected locally, and registry files are not compared",
        next: "Use the same reviewed candidate for recovery. Final reconciliation announces only after npm reports the version as published",
    },
    reconcile: {
        title: "npm status and GitHub release reconciliation",
        checks: [
            ...common,
            ["download", "Verified preparation artifact downloaded"],
            ["inspect", "Externally reviewed checksum and source reinspected"],
            ["status", "npm version availability read"],
            ["release_token", "Repository-scoped GitHub release App token created"],
            ["announce", "Exact-source GitHub release reconciled with final readback"],
        ],
        scope: "Final status reads npm version availability. GitHub release and Documentation Preview effects require the npm version to be published",
        next: "Check the called Docs preview job separately. Registry publication does not establish Preview delivery",
    },
    version: {
        title: "Source version pull request",
        checks: [
            ...common,
            ["support", "Registry publication contract gate before source effects"],
            ["build", "Prospective publishable SDK content built"],
            ["version", "Content guard and source version preparation"],
            ["format", "Generated SDK changelog formatting"],
            ["pull_request", "Version pull request creation or reconciliation"],
        ],
        scope: "A version PR is reviewable source, not a package release. The registry support gate remains enforced",
        next: "Review the version, changelog and consumed Changesets before merging, then prepare the merged source",
    },
}

function text(value) {
    return String(value === undefined || value === null || value === "" ? "Unavailable" : value)
        .slice(0, 2000)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/&/g, "&amp;")
        .replace(/[<>|`*_[\]\\]/g, (character) => `&#${character.charCodeAt(0)};`)
}

function outcome(step) {
    const value = step?.outcome
    return ["success", "failure", "cancelled", "skipped"].includes(value) ? value : "not reported"
}

export function renderSummary({ kind, steps = {}, details = {}, runId, workflowCommit }) {
    const profile = summaryProfiles[kind]
    if (!profile) throw new Error("Unknown workflow summary profile")
    const output = (id, key) => steps[id]?.outputs?.[key]
    const unpublished =
        kind === "reconcile" &&
        outcome(steps.status) === "success" &&
        (details.complete === false || details.complete === "false") &&
        outcome(steps.announce) === "skipped"
    const recoveredComplete =
        kind === "reconcile" &&
        outcome(steps.status) === "success" &&
        (details.complete === true || details.complete === "true") &&
        details.publishResult === "failure" &&
        outcome(steps.announce) === "success"
    const previewDomainStatus = kind === "preview" ? output("deploy", "custom_domain_status") : undefined
    const previewDeploymentUrl = kind === "preview" ? output("deploy", "deployment_url") : undefined
    const previewChallenged =
        kind === "preview" && outcome(steps.deploy) === "success" && previewDomainStatus === "challenged"
    const previewEvidenceMissing =
        kind === "preview" &&
        outcome(steps.deploy) === "success" &&
        (!previewDeploymentUrl || !["verified", "challenged"].includes(previewDomainStatus))
    const required = profile.checks.filter(
        ([id]) => id !== "browser_evidence" && !(unpublished && ["release_token", "announce"].includes(id)),
    )
    const failed = profile.checks.filter(([id]) => ["failure", "cancelled"].includes(outcome(steps[id])))
    const skipped = required.filter(([id]) => ["skipped", "not reported"].includes(outcome(steps[id])))
    const noChange =
        (kind === "version" && steps.version?.outputs?.skipped === "true") ||
        (kind === "prepare" && steps.candidate?.outputs?.skipped === "true")
    const status = failed.length
        ? "Failed or cancelled, downstream work is not confirmed"
        : noChange
          ? "No release content change, no new release artifact or version PR requested"
          : unpublished
            ? "The npm version is missing. The GitHub announcement is deliberately skipped"
            : recoveredComplete
              ? "The npm version is published after the publication job failed. Final reconciliation proceeds from current npm status"
              : previewEvidenceMissing
                ? "Incomplete, exact deployment verification details were not reported"
                : previewChallenged
                  ? "Exact deployment verified. The configured custom domain was challenged, so public access is not verified"
                  : skipped.length
                    ? "Incomplete, some checks or effects were skipped or not reported"
                    : "Listed checks and effects succeeded"
    const lines = [
        `## ${profile.title}`,
        "",
        status,
        "",
        `Run ID: ${text(runId)}`,
        "",
        `Workflow commit (not necessarily the selected source): ${text(workflowCommit)}`,
        "",
        "| Checked surface or effect | Step outcome |",
        "| --- | --- |",
        ...profile.checks.map(([id, label]) => `| ${label} | ${outcome(steps[id])} |`),
        "",
    ]
    const values = []
    if (kind === "consumers") values.push(["Node runtime policy", details.runtimePolicy])
    if (kind === "browser") {
        values.push([
            "Browser evidence artifact",
            output("browser_evidence", "artifact-id") ? "browser-failure" : "No artifact ID reported",
        ])
        values.push(["Browser evidence artifact ID", output("browser_evidence", "artifact-id")])
        values.push(["Browser evidence retention", "7 days, upload ignores missing evidence files"])
    }
    if (["prepare", "inspect", "publish-npm", "reconcile"].includes(kind)) {
        values.push(["Preparation run ID", kind === "prepare" ? runId : details.preparationRunId])
        values.push([
            "Selected candidate source",
            output("candidate", "source") ?? output("preparation", "sourceCommit") ?? details.sourceCommit,
        ])
        values.push([
            kind === "prepare" ? "Candidate SHA256" : "Reviewed checksum input (verified only if inspection succeeded)",
            output("candidate", "checksum") ?? details.checksum,
        ])
        values.push(["Candidate artifact name", output("candidate", "name") ?? output("preparation", "artifactName")])
        values.push([
            "Candidate artifact ID",
            output("artifact", "artifact-id") ?? output("preparation", "artifactId") ?? details.artifactId,
        ])
    }
    if (kind === "prepare")
        values.push(
            ["Candidate version", output("candidate", "version")],
            ["Candidate channel", output("candidate", "channel")],
            ["Candidate retention", "90 days after upload"],
        )
    if (kind === "version")
        values.push(
            ["Source manifest version", output("version", "version")],
            ["PR operation", output("pull_request", "pull-request-operation")],
            ["PR number", output("pull_request", "pull-request-number")],
            ["PR URL", output("pull_request", "pull-request-url")],
        )
    if (kind === "preview")
        values.push(
            ["Checked source commit", details.sourceCommit],
            ["Reused Check run", output("ci", "run_url")],
            ["Exact deployment URL", previewDeploymentUrl],
            [
                "Exact deployment verification",
                previewDeploymentUrl && ["verified", "challenged"].includes(previewDomainStatus)
                    ? "Verified source marker and documentation response"
                    : "Unconfirmed, inspect deployment verification",
            ],
            ["Configured custom domain", details.previewUrl],
            [
                "Custom-domain access",
                previewDomainStatus === "verified"
                    ? "Verified"
                    : previewDomainStatus === "challenged"
                      ? "Cloudflare challenge, public access not verified"
                      : "Unconfirmed, inspect deployment verification",
            ],
        )
    if (kind === "publish-npm")
        values.push(
            [
                "npm version availability",
                outcome(steps.verify) === "success" ? "published" : "Unconfirmed, inspect npm verification",
            ],
            ["GitHub release availability", "Unconfirmed until final reconciliation succeeds"],
        )
    if (kind === "reconcile")
        values.push(
            ["Requested operation", details.operation],
            ["npm publication job result", details.publishResult],
            ["npm version availability", details.npm],
            ["npm version confirmed", details.complete],
        )
    for (const [label, value] of values) lines.push(`${label}: ${text(value)}`, "")
    if (noChange) {
        try {
            lines.push(
                `No-change reason: ${text(JSON.parse(output(kind === "version" ? "version" : "candidate", "reason_json")))}`,
                "",
            )
        } catch {
            lines.push("No-change reason: Unavailable, inspect the preparation logs", "")
        }
    }
    lines.push(profile.scope, "", "### Next action", "")
    if (failed.length || (!noChange && skipped.length && !unpublished)) {
        const first = failed[0] ?? skipped[0]
        lines.push(
            `Inspect the ${text(first[1])} step log first. Skipped steps do not establish their checked behavior`,
            "",
        )
        if (outcome(steps.support) === "failure")
            lines.push(
                "Restore the exact npm Effect peer prerequisite before retrying. Do not bypass the support gate",
                "",
            )
        if (["publish-npm", "reconcile"].includes(kind))
            lines.push(
                "Check npm status before retrying the same reviewed candidate. Use the reconcile operation if the version is already published, since publication rejects duplicates",
                "",
            )
        if (kind === "preview")
            lines.push(
                "Inspect Cloudflare deployment state and the deployment.json source marker before retrying the checked source",
                "",
            )
    } else if (previewEvidenceMissing)
        lines.push(
            "Inspect the deployment step log first. Missing verification outputs do not establish the exact deployment or custom-domain access",
            "",
        )
    else if (previewChallenged)
        lines.push(
            "Use the exact verified deployment URL for inspection. Treat custom-domain access as unverified until a separate check passes without weakening Cloudflare protection",
            "",
        )
    else if (unpublished)
        lines.push(
            "The GitHub release and Docs Preview remain unannounced until the npm version is published and reconciliation is rerun with the same reviewed candidate",
            "",
        )
    else if (recoveredComplete)
        lines.push(
            "Inspect the npm publication failure before another retry. Final reconciliation uses the current published-version status, not the failed request result",
            "",
            profile.next,
            "",
        )
    else if (noChange)
        lines.push(
            "No publication follow-up is needed for this run. Add a real content change before preparing another release",
            "",
        )
    else lines.push(profile.next, "")
    lines.push("Raw command output remains in the individual step logs", "")
    return lines.join("\n")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        renderSummary({
            kind: process.env.SUMMARY_KIND,
            steps: JSON.parse(process.env.SUMMARY_STEPS ?? "{}"),
            details: JSON.parse(process.env.SUMMARY_DETAILS ?? "{}"),
            runId: process.env.GITHUB_RUN_ID,
            workflowCommit: process.env.GITHUB_SHA,
        }),
    )
}
