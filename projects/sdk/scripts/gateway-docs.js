// @ts-check
// The fields Fluxer's gateway documentation lists for each Dispatch event, read from the documents at the reviewed
// upstream pin and written to a committed fixture. The gateway field check compares them with what the SDK exposes, so
// `pnpm check` stays offline while covering every documented field, not only the ones a recorded sample carried.
// It also reads the HTTP API objects those events carry from the endpoint documentation pages, each checked against its
// pinned hash, and then regenerates the raw event's types with scripts/gateway-types.js.
// Run from projects/ after moving the pin with `node release/upstream.js --update <commit>`: node sdk/scripts/gateway-docs.js
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { format, resolveConfig } from "prettier"
import {
    copiesPath,
    documentsHash,
    endpointDocsDirectory,
    githubSource,
    keepingCopies,
    readGatewayDocs,
    validateManifest,
} from "../../release/upstream.js"
import { writeGatewayTypes } from "./gateway-types.js"

const manifestPath = fileURLToPath(new URL("../../release/upstream/manifest.json", import.meta.url))
const fixturePath = fileURLToPath(new URL("../tests/contract/fixtures/gateway-docs.json", import.meta.url))
// Who receives each Dispatch event, which the gateway field check uses to place unhandled events in ledger categories.
// Fluxer's event index dropped its scope column at 4e38842, so the SDK keeps this classification itself
const scopesPath = fileURLToPath(new URL("../tests/contract/fixtures/gateway-docs-scopes.json", import.meta.url))
// Documents whose Dispatch event sections are read. The other gateway documents describe commands, limits and codes
const documentNames = ["events.md", "threads.md"]
// The document whose Gateway Error section lists the fields of an opcode 12 frame
const opcodesDocument = "opcodes-and-close-codes.md"
// Regenerating fails above this size, so growth of the committed fixture is reviewed rather than silent
const maximumFixtureBytes = 384 * 1024

/**
 * One parsed type. `ref` names a field table in these documents, `rest` an object the HTTP API documents, and `named`
 * an object the documents mention without a table or link. `decimal` is a decimal string, such as a permission set
 * @typedef {{ kind: "snowflake" | "string" | "decimal" | "integer" | "number" | "boolean" | "timestamp" | "object" | "any" }
 *     | { kind: "ref", object: string }
 *     | { kind: "rest", name: string, link: string }
 *     | { kind: "named", name: string }
 *     | { kind: "array", item: Shape }
 *     | { kind: "map", key: Shape, value: Shape }} Kind
 * @typedef {Kind & { nullable?: true }} Shape
 * @typedef {{ name: string, optional: boolean, type: string, description: string, shape: Shape }} Field
 * What a prose-only payload is: A gateway object by anchor, an HTTP API object by link, another event's payload, or an
 * array of one of them. `with` names an HTTP API object whose fields the payload also has, and `like` marks a link to an
 * event before it is resolved
 * @typedef {{ object?: string, link?: string, event?: string, with?: string, array?: true, like?: true }} Payload
 * @typedef {{ file: string, anchor: string, scope: string, prose: string, payload?: Payload, fields: Field[] }} EventSection
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
    else if ((match = /^map\[(\w+),\s*(.+)\]$/.exec(text)))
        kind = { kind: "map", key: parseType(match[1], where), value: parseType(match[2], where) }
    else if ((match = /^\[([^\]]+)\]\(([^)]+)\)(?:\s+object)?$/.exec(text))) {
        const local = gatewayLink.exec(match[2])
        kind = local
            ? { kind: "ref", object: local[1] }
            : { kind: "rest", name: match[1].toLowerCase(), link: match[2] }
    } else if (text === "ISO8601 timestamp") kind = { kind: "timestamp" }
    else if (text === "decimal string") kind = { kind: "decimal" }
    else if (scalars.has(text)) kind = /** @type {Kind} */ ({ kind: text })
    else if ((match = /^([A-Za-z0-9][A-Za-z0-9 ]*) (object|value)$/.exec(text)))
        kind = { kind: "named", name: match[2] === "object" ? match[1] : text }
    else throw new Error(`Unsupported gateway documentation type "${cell.trim()}" at ${where}`)
    return nullable ? { ...kind, nullable: true } : kind
}

/**
 * The rows of every `Field | Type | Description` table in the lines. Other tables, such as a value list, are skipped.
 * On an HTTP API page, a link to an anchor of the same page is read as a link to that page's object
 * @param {string[]} lines
 * @param {string} where
 * @param {string} [page] The HTTP API page the lines come from, such as users/relationships
 * @returns {Field[]}
 */
function fieldRows(lines, where, page) {
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
        const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\?)?(?:\s*<sup>[^<]*<\/sup>)*\s*$/.exec(cells[0])
        if (!name) throw new Error(`Unsupported gateway documentation field name "${cells[0].trim()}" at ${where}`)
        if (fields.some((field) => field.name === name[1])) throw new Error(`Field ${name[1]} repeats at ${where}`)
        fields.push({
            name: name[1],
            optional: name[2] === "?",
            type: plain(cells[1]),
            // Fluxer's own meaning of the field, which the generated payload types show as each property's comment
            description: plain(cells[2] ?? "").replace(/\.$/, ""),
            shape: parseType(
                page ? cells[1].replaceAll("](#", `](/http-api/${page}/#`) : cells[1],
                `${where} ${name[1]}`,
            ),
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
 * What an event's prose says its payload is, before resolving the link: "The payload is the [message object](link)",
 * "an array of every [object](link)", "the [invite object](link) with its [invite metadata](link)" or "has the same
 * fields as [Call Create](link)". Undefined when the section says none of these
 * @param {string} text
 * @returns {{ link: string, array?: true, with?: string, like?: true } | undefined}
 */
function payloadOf(text) {
    const match =
        /[Tt]he payload (is|has the same fields as) (an array of every )?(?:the full |the |a |an |that guild's )?\[[^\]]+\]\(([^)]+)\)(?:(?: object)? with its \[[^\]]+\]\(([^)]+)\))?/.exec(
            text,
        )
    if (!match) return undefined
    return {
        link: match[3],
        ...(match[2] ? { array: /** @type {const} */ (true) } : {}),
        ...(match[4] ? { with: match[4] } : {}),
        ...(match[1] === "is" ? {} : { like: /** @type {const} */ (true) }),
    }
}

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
    /** Event names by the anchors that link to them: Each heading's own and the id of a span inside it */
    /** @type {Map<string, string>} */
    const anchors = new Map()
    /** @type {{ kind: "event", name: string, anchor: string, lines: string[] } | { kind: "object", title: string, lines: string[] } | undefined} */
    let current
    /** @type {typeof current[]} */
    const finished = []
    let fenced = false
    for (const line of markdown.split(/\r?\n/)) {
        if (/^\s*```/.test(line)) fenced = !fenced
        if (fenced) continue
        const event = /^###\s+(?:<span(?:\s+id="([^"]*)")?[^>]*><\/span>\s*)?([A-Z][A-Z0-9_]*)\s*$/.exec(line)
        const object = /^####\s+(.+?)\s*$/.exec(line)
        if (event) {
            anchors.set(event[2].toLowerCase().replace(/_/g, "-"), event[2])
            if (event[1]) anchors.set(event[1], event[2])
        }
        if (event || object || /^#{1,4}\s/.test(line)) {
            finished.push(current)
            current = event
                ? { kind: "event", name: event[2], anchor: event[1] ?? event[2].toLowerCase(), lines: [] }
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
            const text = section.lines.filter((line) => !line.startsWith("|")).join(" ")
            const payload = payloadOf(text)
            events.set(section.name, {
                file,
                anchor: section.anchor,
                scope: "",
                // Everything the section says outside its tables, footnotes included, for checks of prose-derived fields
                prose: plain(text),
                ...(payload ? { payload } : {}),
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
    return { events, objects, anchors }
}

/** An HTTP API object link in the form the fixture keys objects by, with the page and the object's anchor */
const httpLink = /^\/http-api\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)\/?#([a-z0-9-]+)$/

/** The link in the form the fixture keys HTTP API objects by, or undefined for a link to anything else */
function httpObjectLink(/** @type {string} */ link) {
    const match = httpLink.exec(link)
    return match ? `/http-api/${match[1]}/#${match[2]}` : undefined
}

/**
 * The fields of one heading's section, found by the heading's anchor: Every `Field | Type | Description` table up to
 * the next heading of the same or a higher level
 * @param {string} markdown
 * @param {string} wanted
 * @param {string} where
 * @param {string} [page]
 */
function headingSection(markdown, wanted, where, page) {
    /** @type {string[]} */
    const lines = []
    let level = 0
    let title = ""
    let fenced = false
    for (const line of markdown.split(/\r?\n/)) {
        if (/^\s*```/.test(line)) fenced = !fenced
        const heading = fenced ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line)
        if (level === 0) {
            if (heading && anchor(plain(heading[2])) === wanted) {
                level = heading[1].length
                title = plain(heading[2])
            }
            continue
        }
        if (heading && heading[1].length <= level) break
        if (!fenced) lines.push(line)
    }
    if (level === 0) throw new Error(`${where} has no section with the anchor ${wanted}`)
    // Only the object's own table. Tables further down, such as the change fields of an audit log change, describe
    // something else
    const start = lines.findIndex(
        (line, index) =>
            line.startsWith("|") &&
            (index === 0 || !lines[index - 1]?.startsWith("|")) &&
            line
                .split("|")
                .slice(1, -1)
                .map((cell) => cell.trim())
                .join(",") === "Field,Type,Description",
    )
    if (start >= 0) {
        const end = lines.findIndex((line, index) => index > start && !line.startsWith("|"))
        lines.splice(end < 0 ? lines.length : end)
        lines.splice(0, start)
    }
    const fields = fieldRows(lines, `${where} ${title}`, page)
    if (fields.length === 0) throw new Error(`${where} ${title} has no field table`)
    return { title, fields }
}

/** The HTTP API object links inside a type */
const httpLinks = (/** @type {Shape} */ shape) =>
    /** @type {string[]} */ (
        shape.kind === "rest"
            ? [shape.link]
            : shape.kind === "array"
              ? httpLinks(shape.item)
              : shape.kind === "map"
                ? [...httpLinks(shape.key), ...httpLinks(shape.value)]
                : []
    )

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
 * Reads the gateway documents at the pinned commit, checks them against the pinned hash and writes the formatted fixture.
 * The documents come from the kept upstream copies unless they changed, and those copies are never pruned here, since the
 * drift check reads more files than this generator
 * @param {{ source?: import("../../release/upstream.js").Source, copiesFolder?: string, manifestFile?: string, fixtureFile?: string, scopesFile?: string }} [options]
 */
export async function writeGatewayDocs({
    copiesFolder = copiesPath,
    source = keepingCopies(githubSource, copiesFolder),
    manifestFile = manifestPath,
    fixtureFile = fixturePath,
    scopesFile = scopesPath,
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
    const anchors = new Map()
    /** @type {Record<string, string>} */
    const scopes = JSON.parse(await readFile(scopesFile, "utf8"))
    const documentText = (/** @type {string} */ name) => {
        const document = documents.find(({ path }) => path === `${manifest.gatewayDocs.path}/${name}`)
        if (!document) throw new Error(`The pinned gateway documents have no ${name}`)
        return document.text
    }
    for (const name of documentNames) {
        const found = readSections(name, documentText(name))
        for (const [key, value] of found.anchors) anchors.set(key, value)
        for (const [key, value] of found.events) {
            if (events.has(key)) throw new Error(`${key} is described in ${events.get(key)?.file} and ${name}`)
            events.set(key, value)
        }
        for (const [key, value] of found.objects) {
            if (objects.has(key)) throw new Error(`The anchor ${key} is used in ${objects.get(key)?.file} and ${name}`)
            objects.set(key, value)
        }
    }
    for (const [name, event] of events) {
        const scope = scopes[name]
        if (typeof scope !== "string" || scope === "")
            throw new Error(`${name} has no scope in fixtures/gateway-docs-scopes.json. Add who receives it`)
        event.scope = scope
    }
    const stale = Object.keys(scopes).filter((name) => !events.has(name))
    if (stale.length)
        throw new Error(`fixtures/gateway-docs-scopes.json lists undocumented events: ${stale.join(", ")}`)
    checkReferences(events, objects)
    checkReferences(objects, objects)
    resolvePayloads(events, objects, anchors)
    const gatewayError = {
        file: opcodesDocument,
        ...headingSection(documentText(opcodesDocument), "gateway-error", opcodesDocument),
    }
    checkReferences([["Gateway Error", gatewayError]], objects)
    const httpObjects = await readHttpObjects(manifest, source, [
        ...[...events.values(), ...objects.values(), gatewayError].flatMap(({ fields }) =>
            fields.flatMap(({ shape }) => httpLinks(shape)),
        ),
        ...[...events.values()].flatMap(({ payload }) =>
            [payload?.link, payload?.with].filter((link) => link !== undefined),
        ),
    ])
    checkReferences(httpObjects, objects)
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
        gatewayError: { file: gatewayError.file, fields: gatewayError.fields },
        httpObjects: sorted(httpObjects),
    }
    const options = await resolveConfig(fixtureFile)
    const text = await format(JSON.stringify(fixture), { ...options, filepath: fixtureFile })
    const size = Buffer.byteLength(text)
    if (size > maximumFixtureBytes)
        throw new Error(`The fixture would be ${size} bytes, above the ${maximumFixtureBytes} limit`)
    await writeFile(fixtureFile, text)
    return { file: fixtureFile, bytes: size, events: events.size, objects: objects.size + httpObjects.size }
}

/**
 * Replaces each event's payload description with what its link names: A gateway object, an HTTP API object or another
 * event. A link that names none of them fails generation
 * @param {Map<string, EventSection>} events
 * @param {ReadonlyMap<string, ObjectSection>} objects
 * @param {ReadonlyMap<string, string>} anchors
 */
function resolvePayloads(events, objects, anchors) {
    for (const [name, event] of events) {
        const described = event.payload
        if (!described?.link) continue
        const local = gatewayLink.exec(described.link)
        const http = httpObjectLink(described.link)
        /** @type {Payload} */
        let payload
        if (described.like) {
            const target = local ? anchors.get(local[1]) : undefined
            if (!target || !events.has(target))
                throw new Error(`${name} has the fields of ${described.link}, which is no event`)
            payload = { event: target }
        } else if (local) {
            if (!objects.has(local[1])) throw new Error(`${name} is the missing object ${local[1]}`)
            payload = { object: local[1] }
        } else if (http) payload = { link: http }
        else throw new Error(`${name} is ${described.link}, which is neither a gateway nor an HTTP API object`)
        if (described.with) {
            const extra = httpObjectLink(described.with)
            if (!extra) throw new Error(`${name} adds ${described.with}, which is no HTTP API object`)
            payload.with = extra
        }
        if (described.array) payload.array = true
        event.payload = payload
    }
}

/**
 * Reads the HTTP API objects the links name, and every HTTP API object their fields name in turn, from the endpoint
 * documentation pages at the pin. Each page must match its pinned hash
 * @param {import("../../release/upstream.js").Manifest} manifest
 * @param {import("../../release/upstream.js").Source} source
 * @param {string[]} links
 */
async function readHttpObjects(manifest, source, links) {
    /** @type {Map<string, ObjectSection>} */
    const found = new Map()
    /** @type {Map<string, Promise<{ path: string, text: string }>>} */
    const pages = new Map()
    const pinned = new Map((manifest.endpointDocs ?? []).map(({ path, sha256 }) => [path, sha256]))
    const readPage = (/** @type {string} */ page) => {
        let read = pages.get(page)
        if (!read) {
            const path = [".mdx", ".md"]
                .map((suffix) => `${endpointDocsDirectory}/${page}${suffix}`)
                .find((candidate) => pinned.has(candidate))
            if (!path) throw new Error(`The pinned endpoint documentation has no page for /http-api/${page}/`)
            read = source.fetchFile(manifest.repository, manifest.commit, path).then((bytes) => {
                if (createHash("sha256").update(bytes).digest("hex") !== pinned.get(path))
                    throw new Error(`The upstream ${path} does not match the pinned hash`)
                return { path, text: bytes.toString("utf8") }
            })
            pages.set(page, read)
        }
        return read
    }
    const pending = [...links]
    while (pending.length > 0) {
        const link = /** @type {string} */ (pending.pop())
        const key = httpObjectLink(link)
        if (key !== link) throw new Error(`${link} is not an HTTP API object link`)
        if (found.has(key)) continue
        const [, page, wanted] = /** @type {RegExpExecArray} */ (httpLink.exec(key))
        const { path, text } = await readPage(page)
        const section = headingSection(text, wanted, `/http-api/${page}/`, page)
        found.set(key, {
            title: section.title,
            file: path.slice(endpointDocsDirectory.length + 1),
            fields: section.fields,
        })
        for (const { shape } of section.fields) pending.push(...httpLinks(shape))
    }
    return found
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    writeGatewayDocs()
        .then(async (written) => ({ ...written, types: await writeGatewayTypes() }))
        .then(
            ({ file, bytes, events, objects, types }) =>
                console.log(
                    `Wrote ${events} events and ${objects} objects (${bytes} bytes) to ${file}, and the raw event's types to ${types.files.join(" and ")}`,
                ),
            (error) => {
                console.error(error instanceof Error ? error.message : "Gateway documentation generation failed")
                process.exitCode = 1
            },
        )
