// Shared by the general workflow suite (.github/tests/workflows.test.mjs) and the release suite
// (projects/release/tests/release-workflows.test.js). Nothing here reads a workflow when it loads, so a suite parses only the
// files it names

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const { parse } = createRequire(new URL("../../projects/release/package.json", import.meta.url))("yaml")

/** The checkout whose code the tests run */
export const checkout = fileURLToPath(new URL("../../", import.meta.url))
/**
 * The tree whose workflows, local actions and manifest the tests read. It is this checkout, unless the ownership regression
 * points a suite at a copy with a deliberately broken workflow
 */
export const repository = process.env.FLUXERLY_WORKFLOW_ROOT ?? checkout

/** @param {string} path */
export const read = (path) => parse(readFileSync(join(repository, path), "utf8"))

/**
 * The named workflows, or every workflow when no names are given
 * @param {string[]} [names] File names in .github/workflows
 * @returns {Record<string, any>}
 */
export function loadWorkflows(names) {
    const files = names ?? readdirSync(join(repository, ".github/workflows")).filter((name) => name.endsWith(".yml"))
    return Object.fromEntries(files.map((name) => [name, read(`.github/workflows/${name}`)]))
}

/**
 * The names of the local actions the workflows use, as `$/.github/actions/NAME`
 * @param {Record<string, any>} workflows
 */
export function localActionNames(workflows) {
    const names = new Set()
    for (const workflow of Object.values(workflows))
        for (const job of Object.values(workflow.jobs))
            for (const step of /** @type {any[]} */ (job.steps ?? [])) {
                const match = /^\$\/\.github\/actions\/([\w-]+)$/.exec(String(step.uses))
                if (match) names.add(match[1])
            }
    return [...names].sort()
}

/**
 * The named local actions, or every local action when no names are given
 * @param {string[]} [names]
 * @returns {Record<string, any>}
 */
export function loadActions(names) {
    const folders = names ?? readdirSync(join(repository, ".github/actions"))
    return Object.fromEntries(folders.map((name) => [name, read(`.github/actions/${name}/action.yml`)]))
}

/** @param {Record<string, any>} workflows */
export function* jobsOf(workflows) {
    for (const [file, workflow] of Object.entries(workflows))
        for (const [id, job] of Object.entries(workflow.jobs)) yield { file, workflow, id, job }
}

/**
 * @param {Record<string, any>} workflows
 * @param {Record<string, any>} actions
 */
export function* stepsOf(workflows, actions) {
    for (const { file, id, job } of jobsOf(workflows)) for (const step of job.steps ?? []) yield { where: `${file}/${id}`, step }
    for (const [name, action] of Object.entries(actions))
        for (const step of action.runs.steps ?? []) yield { where: `actions/${name}`, step }
}

// A static group queues every run behind the previous one, and a queued run is never cancelled
export function assertSerialized(/** @type {any} */ concurrency, /** @type {string} */ where) {
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
export const bash = process.platform === "win32" ? windowsGitBash() : "bash"

/**
 * Runs a workflow's shell script the way a job step does, with a bounded run. The environment holds only what the test names
 * @param {string} script
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, timeout?: number }} [options]
 */
export function runScript(script, { cwd, env = {}, timeout = 10_000 } = {}) {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
        cwd, encoding: "utf8", timeout, windowsHide: true, env: { ...process.env, ...env },
    })
    assert.ifError(result.error)
    return result
}

/**
 * Evaluates the GitHub expression subset these workflows use: Context paths, quoted strings, ==, !=, !, && and ||,
 * parentheses and the startsWith, format, cancelled and always functions. A missing context value is null, and strings
 * compare without case, as on GitHub
 * @param {string} expression
 * @param {Record<string, any>} context
 */
export function evaluate(expression, context, status = { cancelled: false }) {
    const body = String(expression).trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    const tokens = [...body.matchAll(/\s*('(?:[^']|'')*'|[A-Za-z_][\w.-]*|==|!=|&&|\|\||[!(),])/gy)].map((match) => match[1])
    if (tokens.join("").length !== body.replace(/\s+/g, "").length) throw new Error(`Unsupported expression: ${body}`)
    let position = 0
    const peek = () => tokens[position]
    const take = (/** @type {string} */ token) => {
        if (tokens[position] !== token) throw new Error(`Expected ${token} in ${body}`)
        position++
    }
    const text = (/** @type {unknown} */ value) => (value == null ? "" : String(value))
    const equal = (/** @type {any} */ a, /** @type {any} */ b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b)
    /** @type {Record<string, (...args: any[]) => any>} */
    const functions = {
        startsWith: (value, prefix) => text(value).toLowerCase().startsWith(text(prefix).toLowerCase()),
        format: (template, ...values) => template.replace(/\{(\d+)\}/g, (/** @type {string} */ _, /** @type {string} */ index) => text(values[Number(index)])),
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
        return token.split(".").reduce((/** @type {any} */ value, key) => (value == null ? null : (value[key] ?? null)), context)
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
