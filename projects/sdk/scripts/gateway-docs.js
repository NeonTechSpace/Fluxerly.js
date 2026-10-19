// @ts-check
// The fields Fluxer's gateway documentation lists for each Dispatch event, read from the documents at the reviewed
// upstream pin and written to a committed fixture. The gateway field check compares them with what the SDK exposes, so
// `pnpm check` stays offline while covering every documented field, not only the ones a recorded sample carried.
// Run from projects/ after moving the pin with `node release/upstream.js --update`: node sdk/scripts/gateway-docs.js
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { format, resolveConfig } from "prettier"
import { documentsHash, githubSource, readGatewayDocs, validateManifest } from "../../release/upstream.js"

const manifestPath = fileURLToPath(new URL("../../release/upstream/manifest.json", import.meta.url))
const fixturePath = fileURLToPath(new URL("../tests/contract/fixtures/gateway-docs.json", import.meta.url))
// Documents whose Dispatch event sections are read. The other gateway documents describe commands, limits and codes
const documentNames = ["events.md", "threads.md"]
// Regenerating fails above this size, so growth of the committed fixture is reviewed rather than silent
const maximumFixtureBytes = 256 * 1024

/**
 * One parsed type. `ref` names a field table in these documents, `rest` an object the HTTP API documents, and `named`
 * an object the documents mention without a table or link
 * @typedef {{ kind: "snowflake" | "string" | "integer" | "number" | "boolean" | "timestamp" | "object" | "any" }
 *     | { kind: "ref", object: string }
 *     | { kind: "rest", name: string, link: string }
 *     | { kind: "named", name: string }
 *     | { kind: "array", item: Shape }
 *     | { kind: "map", key: Shape, value: Shape }} Kind
 * @typedef {Kind & { nullable?: true }} Shape
 * @typedef {{ name: string, optional: boolean, type: string, shape: Shape }} Field
 * @typedef {{ file: string, scope: string, prose: string, fields: Field[] }} EventSection
 * @typedef {{ title: string, file: string, fields: Field[] }} ObjectSection
 */

const scalars = new Set(["snowflake", "string", "integer", "number", "boolean", "object", "any"])
const gatewayLink = /^(?:\/gateway\/(?:events|threads)\/)?#([a-z0-9-]+)$/

/** Link text and target pairs reduced to their text, and superscript footnote markers removed */
const plain = (/** @type {string} */ text) =>
    text
        .replace(/<sup>.*?<\/sup>/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\s+/g, " ")
        .trim()

/**
 * Reads the type column. A type this reader does not know fails generation, so a moved pin is reviewed
 * @param {string} cell
 * @param {string} where
 * @returns {Shape}
 */
export function parseType(cell, where) {
    let text = cell.trim()
    const nullable = text.startsWith("?")
    if (nullable) text = text.slice(1).trim()
    /** @type {Kind} */
    let kind
    let match
    if ((match = /^array\[(.+)\]$/.exec(text))) kind = { kind: "array", item: parseType(match[1], where) }
    else if ((match = /^map\[(\w+),\s*(\w+)\]$/.exec(text)))
        kind = { kind: "map", key: parseType(match[1], where), value: parseType(match[2], where) }
    else if ((match = /^\[([^\]]+)\]\(([^)]+)\)(?:\s+object)?$/.exec(text))) {
        const local = gatewayLink.exec(match[2])
        kind = local
            ? { kind: "ref", object: local[1] }
            : { kind: "rest", name: match[1].toLowerCase(), link: match[2] }
    } else if (text === "ISO8601 timestamp") kind = { kind: "timestamp" }
    else if (scalars.has(text)) kind = /** @type {Kind} */ ({ kind: text })
    else if ((match = /^([A-Za-z0-9][A-Za-z0-9 ]*) object$/.exec(text))) kind = { kind: "named", name: match[1] }
    else throw new Error(`Unsupported gateway documentation type "${cell.trim()}" at ${where}`)
    return nullable ? { ...kind, nullable: true } : kind
}

/**
 * The rows of every `Field | Type | Description` table in the lines. Other tables, such as a value list, are skipped
 * @param {string[]} lines
 * @param {string} where
 * @returns {Field[]}
 */
function fieldRows(lines, where) {
    /** @type {Field[]} */
    const fields = []
    let inside = false
    let started = false
    for (const line of lines) {
        if (!line.startsWith("|")) {
            inside = false
            started = false
            continue
        }
        const cells = line.split("|").slice(1, -1)
        if (!started) {
            started = true
            inside = cells.length === 3 && cells.map((cell) => cell.trim()).join(",") === "Field,Type,Description"
            continue
        }
        if (!inside || /^\s*:?-{3,}/.test(cells[0])) continue
        const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\?)?(?:<sup>[^<]*<\/sup>)?\s*$/.exec(cells[0])
        if (!name) throw new Error(`Unsupported gateway documentation field name "${cells[0].trim()}" at ${where}`)
        if (fields.some((field) => field.name === name[1])) throw new Error(`Field ${name[1]} repeats at ${where}`)
        fields.push({
            name: name[1],
            optional: name[2] === "?",
            type: plain(cells[1]),
            shape: parseType(cells[1], `${where} ${name[1]}`),
        })
    }
    return fields
}

/** The heading anchor GitHub-style renderers give a title, which the documents link to */
const anchor = (/** @type {string} */ title) =>
    title
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .replace(/ /g, "-")

/**
 * Reads the Dispatch event sections (`### NAME`) and the object sections below them (`#### Title` with a field table)
 * @param {string} file
 * @param {string} markdown
 */
export function readSections(file, markdown) {
    /** @type {Map<string, EventSection>} */
    const events = new Map()
    /** @type {Map<string, ObjectSection>} */
    const objects = new Map()
    /** The scope column of the event index table, by the anchor each row links to
     * @type {Map<string, string>} */
    const scopes = new Map()
    /** @type {{ kind: "event", name: string, lines: string[] } | { kind: "object", title: string, lines: string[] } | undefined} */
    let current
    /** @type {typeof current[]} */
    const finished = []
    let fenced = false
    for (const line of markdown.split(/\r?\n/)) {
        if (/^\s*```/.test(line)) fenced = !fenced
        if (fenced) continue
        const event = /^###\s+(?:<span[^>]*><\/span>\s*)?([A-Z][A-Z0-9_]*)\s*$/.exec(line)
        const object = /^####\s+(.+?)\s*$/.exec(line)
        const row = /^\|\s*\[[^\]]+\]\([^)#]*#([^)]+)\)\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*$/.exec(line)
        if (row) scopes.set(row[1], row[2])
        if (event || object || /^#{1,4}\s/.test(line)) {
            finished.push(current)
            current = event
                ? { kind: "event", name: event[1], lines: [] }
                : object
                  ? { kind: "object", title: object[1], lines: [] }
                  : undefined
        } else current?.lines.push(line)
    }
    finished.push(current)
    for (const section of finished) {
        if (!section) continue
        if (section.kind === "event") {
            if (events.has(section.name)) throw new Error(`${section.name} is described twice in ${file}`)
            events.set(section.name, {
                file,
                scope: "",
                // Everything the section says outside its tables, footnotes included, for checks of prose-derived fields
                prose: plain(section.lines.filter((line) => !line.startsWith("|")).join(" ")),
                fields: fieldRows(section.lines, `${file} ${section.name}`),
            })
        } else {
            const fields = fieldRows(section.lines, `${file} ${section.title}`)
            if (fields.length === 0) continue
            const key = anchor(section.title)
            if (objects.has(key)) throw new Error(`The anchor ${key} is used twice in ${file}`)
            objects.set(key, { title: section.title, file, fields })
        }
    }
    return { events, objects, scopes }
}

/**
 * Every reference to a field table must reach a table that exists, so a renamed object fails generation
 * @param {Iterable<[string, { fields: Field[] }]>} owners
 * @param {ReadonlyMap<string, ObjectSection>} objects
 */
function checkReferences(owners, objects) {
    /** @param {Shape} shape @returns {string[]} */
    const refs = (shape) =>
        shape.kind === "ref"
            ? [shape.object]
            : shape.kind === "array"
              ? refs(shape.item)
              : shape.kind === "map"
                ? [...refs(shape.key), ...refs(shape.value)]
                : []
    for (const [owner, { fields }] of owners)
        for (const field of fields)
            for (const object of refs(field.shape))
                if (!objects.has(object))
                    throw new Error(`${owner} ${field.name} refers to the missing object ${object}`)
}

/**
 * Reads the gateway documents at the pinned commit, checks them against the pinned hash and writes the formatted fixture
 * @param {{ source?: import("../../release/upstream.js").Source, manifestFile?: string, fixtureFile?: string }} [options]
 */
export async function writeGatewayDocs({
    source = githubSource,
    manifestFile = manifestPath,
    fixtureFile = fixturePath,
} = {}) {
    const manifest = validateManifest(JSON.parse(await readFile(manifestFile, "utf8")))
    const documents = await readGatewayDocs(manifest, source, manifest.commit)
    const hash = documentsHash(documents)
    if (hash !== manifest.gatewayDocs.sha256)
        throw new Error("The upstream gateway documents do not match the pinned hash")
    /** @type {Map<string, EventSection>} */
    const events = new Map()
    /** @type {Map<string, ObjectSection>} */
    const objects = new Map()
    /** @type {Map<string, string>} */
    const scopes = new Map()
    for (const name of documentNames) {
        const document = documents.find(({ path }) => path === `${manifest.gatewayDocs.path}/${name}`)
        if (!document) throw new Error(`The pinned gateway documents have no ${name}`)
        const found = readSections(name, document.text)
        for (const [key, value] of found.events) {
            if (events.has(key)) throw new Error(`${key} is described in ${events.get(key)?.file} and ${name}`)
            events.set(key, value)
        }
        for (const [key, value] of found.objects) {
            if (objects.has(key)) throw new Error(`The anchor ${key} is used in ${objects.get(key)?.file} and ${name}`)
            objects.set(key, value)
        }
        for (const [key, value] of found.scopes) scopes.set(key, value)
    }
    for (const [name, event] of events) {
        const scope = scopes.get(name.toLowerCase().replaceAll("_", "-"))
        if (scope === undefined) throw new Error(`${name} has no row in the event index table`)
        event.scope = scope
    }
    checkReferences(events, objects)
    checkReferences(objects, objects)
    const sorted = (/** @type {Map<string, any>} */ map) =>
        Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    const fixture = {
        source: {
            repository: manifest.repository,
            commit: manifest.commit,
            path: manifest.gatewayDocs.path,
            sha256: hash,
        },
        events: sorted(events),
        objects: sorted(objects),
    }
    const options = await resolveConfig(fixtureFile)
    const text = await format(JSON.stringify(fixture), { ...options, filepath: fixtureFile })
    const size = Buffer.byteLength(text)
    if (size > maximumFixtureBytes)
        throw new Error(`The fixture would be ${size} bytes, above the ${maximumFixtureBytes} limit`)
    await writeFile(fixtureFile, text)
    return { file: fixtureFile, bytes: size, events: events.size, objects: objects.size }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    writeGatewayDocs().then(
        ({ file, bytes, events, objects }) =>
            console.log(`Wrote ${events} events and ${objects} objects (${bytes} bytes) to ${file}`),
        (error) => {
            console.error(error instanceof Error ? error.message : "Gateway documentation generation failed")
            process.exitCode = 1
        },
    )
