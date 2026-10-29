// Failure-mapping lint for SDK source, run by the lint script.
// Since Effect 4.0.6 a typed failure beside a defect becomes a defect that keeps its value, which Effect.mapError and
// Cause.map never see, so an internal failure type could reach callers. SDK source maps failures only through
// mapFailureCause or mapCause in src/internal/effect-failures.ts. The scanner checks its own samples first, so a broken
// scanner cannot pass the source by finding nothing
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
// Vitest bundles an ESTree parser that reads TypeScript
import { parseAst } from "vitest/node"

const forbidden = new Set(["Effect.mapError", "Cause.map"])
const exempt = "internal/effect-failures.ts"

function isNode(value) {
    return typeof value === "object" && value !== null && typeof value.type === "string"
}

/** Every forbidden failure mapping in one source text, as line-numbered descriptions */
function scan(source, file = "sample.ts") {
    const results = []
    const visit = (node) => {
        if (
            node.type === "MemberExpression" &&
            node.computed !== true &&
            node.object.type === "Identifier" &&
            node.property.type === "Identifier"
        ) {
            const name = `${node.object.name}.${node.property.name}`
            if (forbidden.has(name)) {
                const line = source.slice(0, node.start).split("\n").length
                results.push(`${file}:${line} ${name}`)
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === "start" || key === "end") continue
            if (Array.isArray(value)) {
                for (const item of value) if (isNode(item)) visit(item)
            } else if (isNode(value)) visit(value)
        }
    }
    visit(parseAst(source, { lang: "ts" }))
    return results
}

/** Scanner samples: each flagged sample must report exactly one mapping and each accepted one none */
const flagged = [
    "effect.pipe(Effect.mapError((error) => wrap(error)))",
    "Effect.mapError(effect, (error) => wrap(error))",
    "const mapped = Cause.map(cause, (error) => wrap(error))",
    "effect.pipe(\n    Effect.mapError(\n        (error) => wrap(error),\n    ),\n)",
]
const accepted = [
    "effect.pipe(mapFailureCause(failures(RestFailure), (error) => wrap(error)))",
    "const mapped = mapCause(cause, failures(RestFailure), (error) => wrap(error))",
    "items.map((item) => item.id)",
    "Effect.map(effect, (value) => value + 1)",
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
const files = globSync("**/*.ts", { cwd: root }).map((file) => file.replaceAll("\\", "/"))
if (files.length === 0) problems.push(`No source files found under ${root}`)
if (!files.includes(exempt)) problems.push(`The exempt helper file ${exempt} no longer exists`)
for (const file of files) if (file !== exempt) problems.push(...scan(readFileSync(`${root}${file}`, "utf8"), file))

if (problems.length) {
    console.error(
        `Map failures with mapFailureCause or mapCause from src/internal/effect-failures.ts, so failures Effect turned into defects are mapped too:\n${problems.join("\n")}`,
    )
    process.exitCode = 1
} else console.log(`No Effect.mapError or Cause.map in ${files.length - 1} source files`)
