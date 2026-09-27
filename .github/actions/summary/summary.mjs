import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const outcomes = ["success", "failure", "cancelled", "skipped"]
// Follow-up commands are rendered in a code block, so only plain command characters are accepted
const commandPattern = /^[A-Za-z0-9 ._/=:@-]+$/

function text(value) {
    return String(value === undefined || value === null || value === "" ? "Unavailable" : value)
        .slice(0, 2000)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/&/g, "&amp;")
        .replace(/[<>|`*_[\]\\]/g, (character) => `&#${character.charCodeAt(0)};`)
}

function outcome(step) {
    return outcomes.includes(step?.outcome) ? step.outcome : "not reported"
}

export function renderSummary({ title, steps = {}, details = {}, next = "", command = "", runId, workflowCommit }) {
    if (!title) throw new Error("A summary title is required")
    const entries = Object.entries(steps)
    const failed = entries.filter(([, step]) => ["failure", "cancelled"].includes(outcome(step)))
    const skipped = entries.filter(([, step]) => outcome(step) === "skipped")
    const lines = [
        `## ${text(title)}`,
        "",
        failed.length
            ? "Failed or cancelled. Later steps and downstream work are not confirmed"
            : skipped.length
              ? "Completed. Skipped steps did not run and establish nothing"
              : "All listed steps succeeded",
        "",
        `Run ID: ${text(runId)}`,
        "",
        `Workflow commit: ${text(workflowCommit)}`,
        "",
        "| Step | Outcome |",
        "| --- | --- |",
        ...entries.map(([id, step]) => `| ${text(id)} | ${outcome(step)} |`),
        "",
    ]
    for (const [label, value] of Object.entries(details)) lines.push(`${text(label)}: ${text(value)}`, "")
    lines.push("### Next action", "")
    if (failed.length)
        lines.push(`Inspect the ${text(failed[0][0])} step log first. Failed steps do not establish their checked behavior`, "")
    else {
        if (next) lines.push(text(next), "")
        if (command && commandPattern.test(command)) lines.push("```sh", command, "```", "")
    }
    lines.push("Raw command output remains in the individual step logs", "")
    return lines.join("\n")
}

function json(value, fallback) {
    try {
        const parsed = JSON.parse(value || fallback)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : JSON.parse(fallback)
    } catch {
        return JSON.parse(fallback)
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        renderSummary({
            title: process.env.SUMMARY_TITLE,
            steps: json(process.env.SUMMARY_STEPS, "{}"),
            details: json(process.env.SUMMARY_DETAILS, "{}"),
            next: process.env.SUMMARY_NEXT,
            command: process.env.SUMMARY_COMMAND,
            runId: process.env.GITHUB_RUN_ID,
            workflowCommit: process.env.GITHUB_SHA,
        }),
    )
}
