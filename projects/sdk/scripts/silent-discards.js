// Silent-discard lint for SDK source, run by the lint script.
// Source structure is the only place a discarded error can be found before it happens, so this is a structural check.
// It parses each source file and finds every construct that drops an error value, however it is laid out across lines.
// Each one must carry an "allow-silent: <reason>" comment inside the construct, or on one of the three lines above it
// within its statement, naming where the failure is observed instead. The scanner checks its own samples first, so a
// broken scanner cannot pass the source by finding nothing
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
// Vitest bundles an ESTree parser that reads TypeScript
import { parseAst } from "vitest/node"

const marker = /(?:\/\/[^\n]*|\/\*[\s\S]*?)allow-silent:[ \t]*\S/

function isNode(value) {
    return typeof value === "object" && value !== null && typeof value.type === "string"
}

/** A function that declares no parameters, so it cannot look at the error it receives */
function ignoresArgument(value) {
    return (
        isNode(value) &&
        (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") &&
        Array.isArray(value.params) &&
        value.params.length === 0
    )
}

function propertyName(value) {
    if (!isNode(value) || value.type !== "MemberExpression" || value.computed === true) return undefined
    const property = value.property
    return isNode(property) && property.type === "Identifier" ? property.name : undefined
}

/** The discard form a node represents, if any */
function discardForm(node) {
    if (node.type === "CatchClause") {
        const param = node.param
        if (param === null || param === undefined) return "catch without a binding"
        if (isNode(param) && param.type === "Identifier" && param.name.startsWith("_"))
            return "catch with an unused underscore binding"
        return undefined
    }
    if (node.type === "MemberExpression") {
        const object = node.object
        const name = propertyName(node)
        if (isNode(object) && object.type === "Identifier" && object.name === "Effect" && name?.startsWith("ignore"))
            return `Effect.${name}`
        return undefined
    }
    if (node.type !== "CallExpression") return undefined
    const args = node.arguments
    const method = propertyName(node.callee)
    if (method === "catchCause" && ignoresArgument(args.at(-1))) return "catchCause that ignores its cause"
    if (method === "catch" && ignoresArgument(args[0])) return "promise catch that ignores its reason"
    if (method === "then" && ignoresArgument(args[1])) return "promise rejection handler that ignores its reason"
    if (method === "call" && propertyName(node.callee.object) === "then" && ignoresArgument(args[2]))
        return "promise rejection handler that ignores its reason"
    return undefined
}

function isStatement(node) {
    return /(?:Statement|Declaration)$/.test(node.type) || node.type === "PropertyDefinition"
}

/** Every unannotated discard in one source text, as line-numbered descriptions */
function scan(source, file = "sample.ts") {
    const lineStarts = [0]
    for (let index = 0; index < source.length; index++) if (source[index] === "\n") lineStarts.push(index + 1)
    const lineOf = (offset) => {
        let low = 0
        let high = lineStarts.length - 1
        while (low < high) {
            const middle = Math.ceil((low + high) / 2)
            if (lineStarts[middle] <= offset) low = middle
            else high = middle - 1
        }
        return low
    }
    const results = []
    const visit = (node, statement) => {
        const enclosing = isStatement(node) ? node : statement
        const form = discardForm(node)
        if (form !== undefined) {
            const line = lineOf(node.start)
            // Allow the comment on up to three lines above the construct, but not above its own statement's line before
            const earliest = Math.max(line - 3, enclosing === undefined ? 0 : lineOf(enclosing.start) - 1, 0)
            if (!marker.test(source.slice(lineStarts[earliest], node.end))) results.push(`${file}:${line + 1} ${form}`)
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === "start" || key === "end") continue
            if (Array.isArray(value)) {
                for (const item of value) if (isNode(item)) visit(item, enclosing)
            } else if (isNode(value)) visit(value, enclosing)
        }
    }
    visit(parseAst(source, { lang: "ts" }), undefined)
    return results
}

/** Scanner samples: each flagged sample must report exactly one discard and each accepted one none */
const flagged = [
    "try { x() } catch { }",
    "try { x() } catch (_error) { }",
    "effect.pipe(Effect.catchCause(() => Effect.void))",
    "effect.pipe(Effect.catchCause(() => Effect.succeed(1)))",
    "effect.pipe(Effect.ignore)",
    "effect.pipe(Effect.ignoreCause)",
    "promise.catch(() => undefined)",
    "promise.then(() => 1, () => undefined)",
    // Split across lines, which a line-based scan missed
    "state.settled = request.then(\n    () => undefined,\n    () => undefined,\n)",
    "void Promise.prototype.then.call(\n    value,\n    () => undefined,\n    () => undefined,\n)",
    "void Promise.resolve()\n    .then(() => value)\n    .catch(\n        () => undefined,\n    )",
    // A marker far above, or one without a reason, does not cover a discard
    "// allow-silent: unrelated\na()\nb()\nc()\nd()\npromise.catch(() => undefined)",
    "try { x() } catch {\n    // allow-silent:\n}",
]
const accepted = [
    "try { x() } catch (error) { report(error) }",
    "try { x() } catch {\n    // allow-silent: the caller retains the outcome\n}",
    "// allow-silent: settlement is observed by the owning request\nstate.settled = request.then(\n    () => undefined,\n    () => undefined,\n)",
    "promise.catch((error) => log(error))",
    "promise.then(() => 1, (error) => log(error))",
]

const problems = [
    ...flagged
        .filter((sample) => scan(sample).length !== 1)
        .map((sample) => `Scanner sample not reported exactly once: ${JSON.stringify(sample)}`),
    ...accepted
        .filter((sample) => scan(sample).length !== 0)
        .map((sample) => `Scanner sample wrongly reported: ${JSON.stringify(sample)}`),
]
const root = fileURLToPath(new URL("../src/", import.meta.url))
const files = globSync("**/*.ts", { cwd: root })
if (files.length === 0) problems.push(`No source files found under ${root}`)
for (const file of files) problems.push(...scan(readFileSync(`${root}${file}`, "utf8"), file.replaceAll("\\", "/")))

if (problems.length) {
    console.error(
        `Silent discards need an "allow-silent: <reason>" comment naming where the failure is observed:\n${problems.join("\n")}`,
    )
    process.exitCode = 1
} else console.log(`No unannotated silent discards in ${files.length} source files`)
