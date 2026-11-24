// Failure-mapping lint for SDK source, run by the lint script.
// Since Effect 4.0.6 a typed failure beside a defect becomes a defect that keeps its value, which Effect.mapError and
// Cause.map never see, so an internal failure type could reach callers. SDK source maps failures only through
// mapFailureCause or mapCause in src/internal/effect-failures.ts. The scanner checks its own samples first, so a broken
// scanner cannot pass the source by finding nothing
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
// Vitest bundles an ESTree parser that reads TypeScript
import { parseAst } from "vitest/node"

const forbiddenMembers = new Map([
    ["Effect", new Set(["mapError"])],
    ["Cause", new Set(["map"])],
])
const effectModules = new Map([
    ["effect/Effect", new Set(["mapError"])],
    ["effect/Cause", new Set(["map"])],
])
const exempt = "internal/effect-failures.ts"

function isNode(value) {
    return typeof value === "object" && value !== null && typeof value.type === "string"
}

/** Collects Effect and Cause namespace aliases and named/destructured forbidden bindings */
function collectBindings(program) {
    const namespaces = new Map([
        ["Effect", "Effect"],
        ["Cause", "Cause"],
    ])
    const direct = new Map()
    for (const statement of program.body ?? []) {
        if (statement.type === "ImportDeclaration" && typeof statement.source?.value === "string") {
            const mod = statement.source.value
            const names = effectModules.get(mod)
            if (!names) continue
            const kind = mod === "effect/Effect" ? "Effect" : "Cause"
            for (const spec of statement.specifiers ?? []) {
                if (spec.type === "ImportNamespaceSpecifier") namespaces.set(spec.local.name, kind)
                if (
                    spec.type === "ImportSpecifier" &&
                    spec.imported.type === "Identifier" &&
                    names.has(spec.imported.name)
                )
                    direct.set(spec.local.name, `${kind}.${spec.imported.name}`)
            }
        }
    }
    const findDestructured = (node) => {
        if (
            node.type === "VariableDeclarator" &&
            node.id?.type === "ObjectPattern" &&
            node.init?.type === "Identifier" &&
            namespaces.has(node.init.name)
        ) {
            const kind = namespaces.get(node.init.name)
            const names = forbiddenMembers.get(kind)
            for (const prop of node.id.properties ?? []) {
                if (
                    prop.type === "Property" &&
                    !prop.computed &&
                    prop.key?.type === "Identifier" &&
                    prop.value?.type === "Identifier" &&
                    names?.has(prop.key.name)
                )
                    direct.set(prop.value.name, `${kind}.${prop.key.name}`)
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === "start" || key === "end") continue
            if (Array.isArray(value)) {
                for (const item of value) if (isNode(item)) findDestructured(item)
            } else if (isNode(value)) findDestructured(value)
        }
    }
    findDestructured(program)
    return { namespaces, direct }
}

/** Every forbidden failure mapping in one source text, as line-numbered descriptions */
function scan(source, file = "sample.ts") {
    const program = parseAst(source, { lang: "ts" })
    const { namespaces, direct } = collectBindings(program)
    const results = []
    const visit = (node) => {
        if (
            node.type === "MemberExpression" &&
            node.computed !== true &&
            node.object.type === "Identifier" &&
            node.property.type === "Identifier"
        ) {
            const kind = namespaces.get(node.object.name)
            if (kind && forbiddenMembers.get(kind)?.has(node.property.name)) {
                const line = source.slice(0, node.start).split("\n").length
                results.push(`${file}:${line} ${kind}.${node.property.name}`)
            }
        } else if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
            const mapped = direct.get(node.callee.name)
            if (mapped) {
                const line = source.slice(0, node.start).split("\n").length
                results.push(`${file}:${line} ${mapped}`)
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === "start" || key === "end") continue
            if (Array.isArray(value)) {
                for (const item of value) if (isNode(item)) visit(item)
            } else if (isNode(value)) visit(value)
        }
    }
    visit(program)
    return results
}

/** Scanner samples: each flagged sample must report exactly one mapping and each accepted one none */
const flagged = [
    "effect.pipe(Effect.mapError((error) => wrap(error)))",
    "Effect.mapError(effect, (error) => wrap(error))",
    "const mapped = Cause.map(cause, (error) => wrap(error))",
    "effect.pipe(\n    Effect.mapError(\n        (error) => wrap(error),\n    ),\n)",
    'import * as E from "effect/Effect"\nE.mapError(effect, wrap)',
    'import { mapError } from "effect/Effect"\nmapError(effect, wrap)',
    'import { map as mapCauseRaw } from "effect/Cause"\nmapCauseRaw(cause, wrap)',
    "const { mapError } = Effect\nmapError(effect, wrap)",
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
