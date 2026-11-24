// Test-isolation lint for SDK tests, checking that fixture servers use fixtureHost() instead of hardcoded loopback binds.
// Hardcoded 127.0.0.1 or localhost server binds defeat the 127.0.0.0/8 loopback isolation in tests/support/loopback.ts,
// allowing late requests from an earlier test or worker to collide with a newer fixture that reused the same port.
// Each genuine exception must carry an "allow-loopback-bind: <reason>" comment on the call or up to three lines above it
// within its statement. The scanner checks its own samples first, so a broken scanner cannot pass by finding nothing
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
// Vitest bundles an ESTree parser that reads TypeScript and JavaScript
import { parseAst } from "vitest/node"

const marker = /(?:\/\/[^\n]*|\/\*[\s\S]*?)allow-loopback-bind:[ \t]*\S/
const bannedHostPattern = /^(?:localhost|::1|\[::1\]|0\.0\.0\.0|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i
const excludedPrefixes = ["live/", "packaging/consumers/"]
const excludedFiles = new Set(["support/loopback.ts"])

function isNode(value) {
    return typeof value === "object" && value !== null && typeof value.type === "string"
}

function propertyName(value) {
    if (!isNode(value) || value.type !== "MemberExpression" || value.computed === true) return undefined
    const property = value.property
    return isNode(property) && property.type === "Identifier" ? property.name : undefined
}

function keyName(key) {
    if (!isNode(key)) return undefined
    if (key.type === "Identifier") return key.name
    if (key.type === "Literal" && typeof key.value === "string") return key.value
    return undefined
}

/** Static string value of a literal or expressionless template literal */
function staticString(node) {
    if (!isNode(node)) return undefined
    if (node.type === "Literal" && typeof node.value === "string") return node.value
    if (node.type === "TemplateLiteral" && node.expressions?.length === 0 && node.quasis?.length === 1)
        return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw
    return undefined
}

/** Collect simple string-literal const bindings so const host = "127.0.0.1" is caught when passed to listen */
function collectStringConstants(program) {
    const constants = new Map()
    const visit = (node) => {
        if (node.type === "VariableDeclaration" && node.kind === "const") {
            for (const declarator of node.declarations ?? []) {
                if (declarator.id?.type !== "Identifier") continue
                const text = staticString(declarator.init)
                if (text === undefined) continue
                const existing = constants.get(declarator.id.name)
                if (existing === undefined) constants.set(declarator.id.name, text)
                else if (existing !== text) constants.set(declarator.id.name, null)
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
    return constants
}

function resolvedString(node, constants) {
    const literal = staticString(node)
    if (literal !== undefined) return literal
    if (isNode(node) && node.type === "Identifier") {
        const bound = constants.get(node.name)
        return typeof bound === "string" ? bound : undefined
    }
    return undefined
}

function bannedHost(node, constants) {
    const text = resolvedString(node, constants)
    return text !== undefined && bannedHostPattern.test(text.trim()) ? text.trim() : undefined
}

function objectHostProperty(node, constants) {
    if (!isNode(node) || node.type !== "ObjectExpression") return undefined
    for (const prop of node.properties ?? []) {
        if (prop.type !== "Property" || prop.computed === true) continue
        if (keyName(prop.key) !== "host") continue
        const host = bannedHost(prop.value, constants)
        if (host !== undefined) return host
    }
    return undefined
}

function serverConstructorName(callee) {
    if (!isNode(callee)) return undefined
    if (callee.type === "Identifier") return callee.name
    return propertyName(callee)
}

/** Describe a hardcoded loopback bind on a CallExpression or NewExpression, or undefined when clean */
function bindViolation(node, constants) {
    if (node.type === "CallExpression" && propertyName(node.callee) === "listen") {
        for (const arg of node.arguments ?? []) {
            const direct = bannedHost(arg, constants)
            if (direct !== undefined) return `hardcoded .listen() host ${JSON.stringify(direct)}`
            const option = objectHostProperty(arg, constants)
            if (option !== undefined) return `hardcoded .listen({ host }) ${JSON.stringify(option)}`
        }
        return undefined
    }
    if (node.type === "NewExpression") {
        const name = serverConstructorName(node.callee)
        if (name === undefined || !name.endsWith("Server")) return undefined
        for (const arg of node.arguments ?? []) {
            const option = objectHostProperty(arg, constants)
            if (option !== undefined) return `hardcoded new ${name}({ host }) ${JSON.stringify(option)}`
        }
    }
    return undefined
}

function isStatement(node) {
    return /(?:Statement|Declaration)$/.test(node.type) || node.type === "PropertyDefinition"
}

/** Every unannotated hardcoded loopback server bind in one source text, as line-numbered descriptions */
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
    const lang = file.endsWith(".ts") ? "ts" : "js"
    const program = parseAst(source, { lang })
    const constants = collectStringConstants(program)
    const results = []
    const visit = (node, statement) => {
        const enclosing = isStatement(node) ? node : statement
        const violation = bindViolation(node, constants)
        if (violation !== undefined) {
            const line = lineOf(node.start)
            const earliest = Math.max(line - 3, enclosing === undefined ? 0 : lineOf(enclosing.start) - 1, 0)
            if (!marker.test(source.slice(lineStarts[earliest], node.end)))
                results.push(`${file}:${line + 1} ${violation}`)
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === "start" || key === "end") continue
            if (Array.isArray(value)) {
                for (const item of value) if (isNode(item)) visit(item, enclosing)
            } else if (isNode(value)) visit(value, enclosing)
        }
    }
    visit(program, undefined)
    return results
}

/** Scanner samples: Each flagged sample must report exactly one violation and each accepted one none */
const flagged = [
    'server.listen(0, "127.0.0.1")',
    'server.listen(0, "localhost")',
    'server.listen(0, "LOCALHOST")',
    'server.listen(0, "::1")',
    'server.listen(0, "0.0.0.0")',
    'server.listen(0, "127.0.0.2")',
    "server.listen(0, `127.0.0.1`)",
    'server.listen({ port: 0, host: "127.0.0.1" })',
    'server.listen({ port: 0, host: "localhost" })',
    'new WebSocketServer({ port: 0, host: "127.0.0.1" })',
    'new ws.WebSocketServer({ port: 0, host: "localhost" })',
    'const host = "127.0.0.1"\nserver.listen(0, host)',
    'const host = "localhost"\nnew WebSocketServer({ port: 0, host })',
    'server.listen(\n    0,\n    "127.0.0.1",\n)',
    '// allow-loopback-bind:\nserver.listen(0, "127.0.0.1")',
    '// allow-loopback-bind: unrelated\na()\nb()\nc()\nd()\nserver.listen(0, "127.0.0.1")',
]
const accepted = [
    "server.listen(0, await fixtureHost())",
    "server.listen(0, host, resolve)",
    "new WebSocketServer({ port: 0, host: await fixtureHost() })",
    "new WebSocketServer({ server })",
    'const target = new URL(request.url ?? "/", "http://127.0.0.1")',
    'const redirectUri = "http://localhost/callback"',
    'const insecure = { url: "http://127.0.0.1:3000", allowInsecure: true }',
    '// allow-loopback-bind: standalone fixture cannot import support helpers\nserver.listen(0, "127.0.0.1")',
]

const problems = [
    ...flagged
        .filter((sample) => scan(sample).length !== 1)
        .map((sample) => `Scanner sample not reported exactly once: ${JSON.stringify(sample)}`),
    ...accepted
        .filter((sample) => scan(sample).length !== 0)
        .map((sample) => `Scanner sample wrongly reported: ${JSON.stringify(sample)}`),
]

const root = fileURLToPath(new URL("../tests/", import.meta.url))
const allFiles = globSync("**/*.{ts,js,mjs}", { cwd: root }).map((file) => file.replaceAll("\\", "/"))
const files = allFiles.filter(
    (file) =>
        !file.endsWith(".d.ts") &&
        !excludedFiles.has(file) &&
        !excludedPrefixes.some((prefix) => file.startsWith(prefix)),
)
if (files.length === 0) problems.push(`No test files found under ${root}`)
for (const file of files) problems.push(...scan(readFileSync(`${root}${file}`, "utf8"), file))

if (problems.length) {
    console.error(
        `Hardcoded loopback server binds break fixtureHost() isolation. Use fixtureHost() from tests/support/loopback.ts, or add an "allow-loopback-bind: <reason>" comment:\n${problems.join("\n")}`,
    )
    process.exitCode = 1
} else console.log(`No hardcoded loopback server binds in ${files.length} test files`)
