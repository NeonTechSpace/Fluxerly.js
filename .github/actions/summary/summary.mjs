import { appendFileSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const outcomes = ["success", "failure", "cancelled", "skipped"]
const words = { success: "passed", failure: "failed", cancelled: "cancelled", skipped: "skipped" }
// Follow-up commands are rendered in a code block, so only plain command characters are accepted
const commandPattern = /^[A-Za-z0-9 ._/=:@-]+$/
// A long list of failures hides the first one, which is the one to open
const namedLimit = 5

function text(value) {
    return String(value === undefined || value === null || value === "" ? "Unavailable" : value)
        .slice(0, 2000)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/&/g, "&amp;")
        .replace(/[<>|`*_[\]\\]/g, (character) => `&#${character.charCodeAt(0)};`)
}

const blank = (value) => value === undefined || value === null || value === ""

function outcome(step) {
    return outcomes.includes(step?.outcome) ? step.outcome : "not reported"
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`

const seconds = (ms) => (ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`)

/**
 * Reads the result file that scripts/check.mjs writes. Anything that does not have the expected shape is ignored, so a
 * damaged file never hides the step outcomes
 */
export function readResults(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"))
        const valid = (entry) =>
            entry &&
            typeof entry.name === "string" &&
            ["passed", "failed", "skipped"].includes(entry.result) &&
            Number.isFinite(entry.ms)
        if (!Array.isArray(parsed?.checks) || !parsed.checks.every(valid)) return undefined
        return parsed
    } catch {
        return undefined
    }
}

// One row per check: A step named in checks is one row, or one row per check when its runner results are present
function collectRows(steps, checks, results) {
    const rows = []
    const listed = new Set(Object.values(checks))
    for (const [label, id] of Object.entries(checks)) {
        const runner = results[id]
        if (runner)
            for (const entry of runner.checks)
                rows.push({
                    label: entry.name,
                    step: label,
                    result: entry.result === "passed" ? "success" : entry.result === "failed" ? "failure" : "skipped",
                    time: entry.result === "skipped" ? "" : seconds(entry.ms),
                    note: entry.result === "skipped" && entry.blockedBy ? `needs ${entry.blockedBy}` : "",
                    entry,
                })
        else rows.push({ label, step: label, result: outcome(steps[id]), time: "", note: "" })
    }
    // A step that is not listed appears only when it broke the job
    for (const [id, step] of Object.entries(steps))
        if (!listed.has(id) && ["failure", "cancelled"].includes(outcome(step)))
            rows.push({ label: id, step: id, result: outcome(step), time: "", note: "" })
    return rows
}

function named(names) {
    const shown = names.slice(0, namedLimit).map(text).join(", ")
    return names.length > namedLimit ? `${shown} and ${names.length - namedLimit} more` : shown
}

function commandLines(value) {
    return String(value || "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && commandPattern.test(line))
}

export function renderSummary({
    title,
    steps = {},
    details = {},
    next = "",
    failure = "",
    command = "",
    reproduce = "",
    checks = {},
    results = {},
}) {
    if (!title) throw new Error("A summary title is required")
    const rows = collectRows(steps, checks, results)
    const failed = rows.filter((row) => ["failure", "cancelled"].includes(row.result))
    const skipped = rows.filter((row) => row.result === "skipped")
    const total = Object.values(results).reduce((sum, runner) => sum + (Number.isFinite(runner.total) ? runner.total : 0), 0)
    const lines = [
        `## ${text(title)}`,
        "",
        failed.length
            ? `Failed or cancelled: ${named(failed.map((row) => row.label))}. Later steps and downstream work are not confirmed`
            : skipped.length
              ? `${plural(rows.length - skipped.length, "check")} passed, ${skipped.length} skipped. Skipped checks did not run and establish nothing`
              : rows.length > 1
                ? `All ${rows.length} checks passed${total ? ` in ${seconds(total)}` : ""}`
                : "Passed",
        "",
    ]
    if (rows.length) {
        const timed = rows.some((row) => row.time)
        lines.push(timed ? "| Check | Result | Time |" : "| Check | Result |", timed ? "| --- | --- | --- |" : "| --- | --- |")
        for (const row of rows) {
            const result = `${words[row.result] ?? row.result}${row.note ? ` (${text(row.note)})` : ""}`
            lines.push(`| ${text(row.label)} | ${result} |${timed ? ` ${row.time} |` : ""}`)
        }
        lines.push("")
    }
    const errors = failed.filter((row) => row.entry?.error)
    if (errors.length) {
        lines.push("### Failures", "")
        for (const row of errors) lines.push(`- ${text(row.label)}: ${text(row.entry.error)}`)
        lines.push("")
    }
    const facts = Object.entries(details).filter(([, value]) => !blank(value))
    if (facts.length) lines.push(...facts.map(([label, value]) => `- ${text(label)}: ${text(value)}`), "")
    lines.push("### Next action", "")
    if (failed.length) {
        lines.push(
            failure
                ? text(failure)
                : `Open the log of the ${text(failed[0].step)} step for the full output. Failed steps do not establish their checked behavior`,
            "",
        )
        const repeat = [
            ...failed.flatMap((row) => (commandPattern.test(row.entry?.command ?? "") ? [row.entry.command] : [])),
            ...commandLines(reproduce),
        ]
        if (repeat.length) {
            const fromProjects = failed.some((row) => row.entry?.command)
            lines.push(
                `Reproduce locally${fromProjects ? " from the repository root" : ""}:`,
                "",
                "```sh",
                ...(fromProjects ? ["cd projects"] : []),
                ...repeat,
                "```",
                "",
            )
        }
    } else {
        if (next) lines.push(text(next), "")
        if (command && commandPattern.test(command)) lines.push("```sh", command, "```", "")
    }
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
    const files = json(process.env.SUMMARY_RESULTS, "{}")
    const results = {}
    for (const [id, file] of Object.entries(files)) {
        const read = typeof file === "string" ? readResults(file) : undefined
        if (read) results[id] = read
    }
    appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        renderSummary({
            title: process.env.SUMMARY_TITLE,
            steps: json(process.env.SUMMARY_STEPS, "{}"),
            details: json(process.env.SUMMARY_DETAILS, "{}"),
            checks: json(process.env.SUMMARY_CHECKS, "{}"),
            results,
            next: process.env.SUMMARY_NEXT,
            failure: process.env.SUMMARY_FAILURE,
            command: process.env.SUMMARY_COMMAND,
            reproduce: process.env.SUMMARY_REPRODUCE,
        }),
    )
}
