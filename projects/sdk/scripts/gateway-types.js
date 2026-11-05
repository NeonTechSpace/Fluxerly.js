// @ts-check
// The types of the raw gateway event: Each dispatch type Fluxer's documentation describes, with the payload shape and
// field names that documentation gives, and the data of an opcode 12 Gateway Error frame. Read offline from the
// committed gateway documentation fixture and its overlay, which scripts/gateway-docs.js writes from the documents at the
// reviewed upstream pin, so regenerating never downloads anything. A contract test fails when the written files differ
// from what this script renders.
// Fluxer's documents are wrong in places, so scripts/gateway-types-corrections.json lists the reviewed fixes, each with
// the reason and the Fluxer source lines at the pin that show what the server sends. A correction that names something
// the fixture lacks, or that changes nothing, fails generation, so a Fluxer fix shows when the pin moves. The corrections
// are part of the generated header's stamp, so editing them without regenerating fails the contract test
// Run from projects/ after regenerating the fixture: node sdk/scripts/gateway-types.js
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { format, resolveConfig } from "prettier"

const fixturePath = fileURLToPath(new URL("../tests/contract/fixtures/gateway-docs.json", import.meta.url))
const overlayPath = fileURLToPath(new URL("../tests/contract/fixtures/gateway-docs-overlay.json", import.meta.url))
const correctionsPath = fileURLToPath(new URL("./gateway-types-corrections.json", import.meta.url))
export const payloadsPath = fileURLToPath(new URL("../src/gateway-payloads.ts", import.meta.url))
export const namesPath = fileURLToPath(new URL("../src/internal/gateway/documented-dispatches.ts", import.meta.url))
const docsOrigin = "https://docs.fluxer.com"

/**
 * @typedef {import("./gateway-docs.js").Shape} Shape
 * @typedef {{ name: string, optional: boolean, description?: string, shape: Shape }} Field
 * @typedef {{ object?: string, link?: string, event?: string, with?: string, array?: true }} Payload
 * @typedef {{ file: string, anchor: string, prose: string, payload?: Payload, fields: Field[], undocumented?: true }} Event
 * @typedef {{ title: string, file: string, fields: Field[] }} ObjectSection
 * @typedef {{
 *     source: { commit: string },
 *     events: Record<string, Event>,
 *     objects: Record<string, ObjectSection>,
 *     httpObjects: Record<string, ObjectSection>,
 *     gatewayError: { fields: Field[] },
 * }} Fixture
 * @typedef {{ object?: string, like?: string, without?: string[], fields?: Field[], within?: Record<string, Field[]> }} Overlay
 * What a correction does to the fields of an object or an event. `optional` and `nullable` name existing fields,
 * `replaceFields` swaps a field of the same name for a different one, `addFields` adds new ones and `addFieldsFrom`
 * puts the fields of another object first. Shapes may also be a `union` of shapes, a `struct` of fields, `true`, a
 * `partial` of a shape that still `require`s some fields, or a `rest` or `ref` shape with `with` fields that add to or
 * replace the object's own
 * @typedef {{ reason: string, evidence: string[], optional?: string[], nullable?: string[], replaceFields?: Field[], addFields?: Field[], addFieldsFrom?: string }} FieldCorrection
 * @typedef {FieldCorrection & { object: string }} ObjectCorrection
 * @typedef {Omit<FieldCorrection, "nullable"> & { event: string, nullable?: Record<string, string[]> }} EventCorrection
 * @typedef {{ event: string, reason: string, evidence: string[], scope: string, fields: Field[] }} NewEvent
 * @typedef {{ objects: ObjectCorrection[], events: EventCorrection[], newEvents: NewEvent[] }} Corrections
 */

/**
 * Payloads the documents describe in words that name no object, each with the type it gets and the words that must
 * still describe it. A changed description fails rendering, so the type is reviewed again
 * @type {Readonly<Record<string, { type: string, words: string }>>}
 */
const described = {
    USER_PINNED_DMS_UPDATE: { type: "readonly string[]", words: "array of every pinned channel ID" },
}

const quote = (/** @type {string} */ text) => JSON.stringify(text)
const gatewayObjectLink = (/** @type {Fixture} */ fixture, /** @type {string} */ object) => {
    const section = fixture.objects[object]
    if (!section) throw new Error(`The fixture has no gateway object ${object}`)
    return `/gateway/${section.file.replace(/\.md$/, "")}/#${object}`
}
/** A type name from a documentation anchor or dispatch type, such as message-object to MessageObject */
const pascal = (/** @type {string} */ text) =>
    text
        .toLowerCase()
        .split(/[-_]/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join("")
/** A field's documented meaning as a comment, or nothing when the documents give none */
const comment = (/** @type {string | undefined} */ text) => (text ? `/** ${text.replaceAll("*/", "* /")} */\n` : "")

// A correction cites Fluxer source files at the pin by line, such as fluxer_gateway/src/session/session_ready_dispatch.erl:195-197
const citation = /^[\w./@-]+\.(?:ts|erl|rs):\d+(-\d+)?$/

/** @param {{ reason?: unknown, evidence?: unknown }} correction @param {string} label */
function checkEvidence(correction, label) {
    const { reason, evidence } = correction
    if (typeof reason !== "string" || reason === "") throw new Error(`The correction ${label} must give a reason`)
    if (
        !Array.isArray(evidence) ||
        evidence.length === 0 ||
        !evidence.every((item) => typeof item === "string" && citation.test(item))
    )
        throw new Error(`The correction ${label} must cite Fluxer source files by line`)
}

/**
 * Applies the corrections of one field list and returns the new list. A name the list lacks, a field it already has
 * and a change that leaves a field as it was fail, so no correction can stay once the fixture agrees with the server
 * @param {Field[]} fields
 * @param {FieldCorrection & { nullable?: string[] }} correction
 * @param {string} label
 * @param {(link: string) => Field[]} fieldsOf
 */
function correctFields(fields, correction, label, fieldsOf) {
    /** @type {Field[]} */
    let result = structuredClone(fields)
    const find = (/** @type {string} */ name) => {
        const field = result.find((item) => item.name === name)
        if (!field) throw new Error(`The correction names ${label} ${name}, which the fixture lacks`)
        return field
    }
    let changes = 0
    for (const name of correction.optional ?? []) {
        const field = find(name)
        if (field.optional) throw new Error(`The fixture already makes ${label} ${name} optional`)
        field.optional = true
        changes++
    }
    for (const name of correction.nullable ?? []) {
        const field = find(name)
        if (field.shape.nullable) throw new Error(`The fixture already makes ${label} ${name} nullable`)
        field.shape = { ...field.shape, nullable: true }
        changes++
    }
    for (const field of correction.replaceFields ?? []) {
        const index = result.findIndex((item) => item.name === field.name)
        if (index < 0) throw new Error(`The correction names ${label} ${field.name}, which the fixture lacks`)
        if (JSON.stringify(result[index]) === JSON.stringify(field))
            throw new Error(`The correction of ${label} ${field.name} changes nothing`)
        result[index] = field
        changes++
    }
    for (const field of correction.addFields ?? []) {
        if (result.some((item) => item.name === field.name))
            throw new Error(`The fixture already has ${label} ${field.name}`)
        result.push(field)
        changes++
    }
    if (correction.addFieldsFrom) {
        const added = fieldsOf(correction.addFieldsFrom)
        for (const field of added)
            if (result.some((item) => item.name === field.name))
                throw new Error(`The fixture already has ${label} ${field.name}`)
        if (added.length === 0) throw new Error(`The correction adds no fields to ${label}`)
        result = [...structuredClone(added), ...result]
        changes++
    }
    if (changes === 0) throw new Error(`The correction of ${label} changes nothing`)
    return result
}

/**
 * Returns the fixture and overlay with the reviewed corrections applied. The inputs stay as they are
 * @param {{ fixture: Fixture, overlay: Record<string, Overlay>, corrections: Corrections }} input
 */
function applyCorrections({ fixture, overlay: original, corrections }) {
    const known = ["objects", "events", "newEvents"]
    for (const key of Object.keys(corrections))
        if (!known.includes(key)) throw new Error(`The corrections have the unknown list ${key}`)
    const fixed = /** @type {Fixture} */ (structuredClone(fixture))
    const overlay = /** @type {Record<string, Overlay>} */ (structuredClone(original))
    // A gateway object is named by its anchor and an HTTP API object by its link
    const section = (/** @type {string} */ name) => {
        const found = name.startsWith("/") ? fixed.httpObjects[name] : fixed.objects[name]
        if (!found) throw new Error(`The correction names the object ${name}, which the fixture lacks`)
        return found
    }
    const originalSection = (/** @type {string} */ name) =>
        (name.startsWith("/") ? fixture.httpObjects : fixture.objects)[name]
    const seen = new Set()
    for (const correction of corrections.objects ?? []) {
        checkEvidence(correction, correction.object)
        if (seen.has(correction.object)) throw new Error(`The corrections list ${correction.object} twice`)
        seen.add(correction.object)
        const target = section(correction.object)
        target.fields = correctFields(
            /** @type {ObjectSection} */ (originalSection(correction.object)).fields,
            correction,
            correction.object,
            (link) => section(link).fields,
        )
    }
    for (const correction of corrections.events ?? []) {
        checkEvidence(correction, correction.event)
        if (seen.has(correction.event)) throw new Error(`The corrections list ${correction.event} twice`)
        seen.add(correction.event)
        const event = fixed.events[correction.event]
        if (!event) throw new Error(`The correction names the event ${correction.event}, which the fixture lacks`)
        const { nullable = {}, event: name, ...own } = correction
        const hasOwn = ["optional", "replaceFields", "addFields", "addFieldsFrom"].some((key) => key in own)
        if (hasOwn) event.fields = correctFields(event.fields, own, name, (link) => section(link).fields)
        else if (Object.keys(nullable).length === 0) throw new Error(`The correction of ${name} changes nothing`)
        // A field the overlay adds inside a field of the event, such as the member of an added thread member
        for (const [key, names] of Object.entries(nullable)) {
            const within = overlay[name]?.within?.[key]
            if (!within) throw new Error(`The correction names ${name} ${key}, which the overlay lacks`)
            overlay[name].within = {
                ...overlay[name].within,
                [key]: correctFields(
                    within,
                    { reason: own.reason, evidence: own.evidence, nullable: names },
                    `${name} ${key}`,
                    () => [],
                ),
            }
        }
    }
    for (const correction of corrections.newEvents ?? []) {
        checkEvidence(correction, correction.event)
        if (fixed.events[correction.event])
            throw new Error(`Fluxer's documents now list ${correction.event}, so its correction is no longer needed`)
        if (correction.fields.length === 0 || typeof correction.scope !== "string")
            throw new Error(`The correction ${correction.event} must give a scope and fields`)
        fixed.events[correction.event] = {
            file: "",
            anchor: "",
            scope: correction.scope,
            prose: correction.reason,
            fields: correction.fields,
            undocumented: true,
        }
    }
    return {
        fixture: fixed,
        overlay,
        stamp: createHash("sha256").update(JSON.stringify(corrections)).digest("hex").slice(0, 16),
    }
}

/**
 * Renders both generated files from the fixture, overlay and corrections, formatted as the repository formats them
 * @param {{ fixture: Fixture, overlay: Record<string, Overlay>, corrections: Corrections }} input
 */
export async function renderGatewayTypes(input) {
    const { fixture, overlay, stamp } = applyCorrections(input)
    // Every documented object becomes one unexported interface named after its anchor, which GatewayPayloadObjects
    // exposes by documentation address. A gateway object whose name an HTTP API object also has gets a Gateway prefix
    /** @type {Map<string, string>} */
    const objectNames = new Map()
    const httpNames = new Set(Object.keys(fixture.httpObjects).map((link) => pascal(link.split("#")[1] ?? "")))
    for (const link of Object.keys(fixture.httpObjects)) objectNames.set(link, pascal(link.split("#")[1] ?? ""))
    for (const object of Object.keys(fixture.objects)) {
        const name = pascal(object)
        objectNames.set(gatewayObjectLink(fixture, object), httpNames.has(name) ? `Gateway${name}` : name)
    }
    if (new Set(objectNames.values()).size !== objectNames.size)
        throw new Error("Two documented objects share a type name")
    const objectType = (/** @type {string} */ link) => {
        const name = objectNames.get(link)
        if (!name) throw new Error(`The fixture has no object ${link}`)
        return name
    }
    /**
     * @param {any} shape A documented shape, or one of the shapes a correction adds
     * @param {Field[]} [extra]
     * @param {string} [omit] A field the description says the object arrives without, such as user on a message's member
     * @returns {string}
     */
    const typeOf = (shape, extra, omit) => {
        /** @type {string} */
        let type
        switch (shape.kind) {
            case "snowflake":
            case "string":
            case "decimal":
            case "timestamp":
                type = "string"
                break
            case "integer":
            case "number":
                type = "number"
                break
            case "boolean":
                type = "boolean"
                break
            case "true":
                type = "true"
                break
            case "struct":
                type = literal(shape.fields)
                break
            case "union":
                type = shape.members.map((member) => typeOf(member)).join(" | ")
                break
            case "partial": {
                const whole = typeOf(shape.of)
                type = `Pick<${whole}, ${shape.require.map(quote).join(" | ")}> & Partial<${whole}>`
                break
            }
            case "object":
                type = "{ readonly [field: string]: unknown }"
                break
            case "any":
            case "named":
                type = "unknown"
                break
            case "ref":
            case "rest": {
                const section = shape.kind === "ref" ? fixture.objects[shape.object] : fixture.httpObjects[shape.link]
                if (!section)
                    throw new Error(`The fixture has no object ${shape.kind === "ref" ? shape.object : shape.link}`)
                type = objectType(shape.kind === "ref" ? gatewayObjectLink(fixture, shape.object) : shape.link)
                if (shape.with) {
                    // Fields a correction gives the object replace its own of the same name
                    const replaced = shape.with
                        .map(({ name }) => name)
                        .filter((name) => section.fields.some((field) => field.name === name))
                    if (replaced.length > 0) type = `Omit<${type}, ${replaced.map(quote).join(" | ")}>`
                    type = `${type} & ${literal(shape.with)}`
                }
                if (omit) {
                    if (!section.fields.some((field) => field.name === omit))
                        throw new Error(`A description leaves ${omit} out of ${type}, which has no such field`)
                    type = `Omit<${type}, ${quote(omit)}>`
                }
                break
            }
            case "array": {
                const item = typeOf(shape.item, extra, omit)
                type = /[|&]/.test(item) ? `readonly (${item})[]` : `readonly ${item}[]`
                return shape.nullable ? `${type} | null` : type
            }
            case "map":
                type = `{ readonly [key: string]: ${typeOf(shape.value)} }`
                break
            default:
                throw new Error(`No type for the documented kind ${shape.kind}`)
        }
        if (extra) type = `${type} & ${literal(extra)}`
        return shape.nullable ? `${type} | null` : type
    }
    /** @param {Field[]} fields @param {Record<string, Field[]>} [within] */
    const literal = (fields, within = {}) => {
        const names = new Set()
        for (const { name } of fields) {
            if (names.has(name)) throw new Error(`The field ${name} is listed twice`)
            names.add(name)
        }
        return `{\n${fields
            .map(
                ({ name, optional, description, shape }) =>
                    `${comment(description)}readonly ${/^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name)}${optional ? "?" : ""}: ${typeOf(shape, within[name], /without `(\w+)`/.exec(description ?? "")?.[1])}`,
            )
            .join("\n")}\n}`
    }

    /** The field names of an event's payload, for leaving out the base fields a table replaces */
    /** @param {string} name @returns {Set<string>} */
    const eventFieldNames = (name) => {
        const event = fixture.events[name]
        const names = new Set([...event.fields, ...(overlay[name]?.fields ?? [])].map((field) => field.name))
        const payload = event.payload
        const base = payload?.event
            ? [...eventFieldNames(payload.event)]
            : payload?.object
              ? fixture.objects[payload.object].fields.map((field) => field.name)
              : payload?.link
                ? fixture.httpObjects[payload.link].fields.map((field) => field.name)
                : []
        for (const field of base) names.add(field)
        for (const field of payload?.with ? fixture.httpObjects[payload.with].fields : []) names.add(field.name)
        return names
    }

    /** @param {string} name */
    const eventType = (name) => {
        const event = fixture.events[name]
        const added = overlay[name] ?? {}
        const payload = event.payload
        if (added.object && added.object !== payload?.object)
            throw new Error(`The overlay gives ${name} the object ${added.object}, which its prose does not name`)
        if (added.like && added.like !== payload?.event)
            throw new Error(`The overlay gives ${name} the fields of ${added.like}, which its prose does not name`)
        const words = described[name]
        if (words) {
            if (payload || event.fields.length > 0 || !event.prose.includes(words.words))
                throw new Error(`${name} is no longer described as an ${words.words}. Review its type`)
            return words.type
        }
        /** @type {string | undefined} */
        let base
        /** @type {string[]} */
        let baseNames = []
        if (payload?.event) {
            if (!fixture.events[payload.event])
                throw new Error(`${name} has the fields of the missing ${payload.event}`)
            const without = added.without ?? []
            base = without.length
                ? `Omit<GatewayDispatchPayloads[${quote(payload.event)}], ${without.map(quote).join(" | ")}>`
                : `GatewayDispatchPayloads[${quote(payload.event)}]`
            baseNames = [...eventFieldNames(payload.event)].filter((field) => !without.includes(field))
        } else if (payload?.object) {
            base = objectType(gatewayObjectLink(fixture, payload.object))
            baseNames = fixture.objects[payload.object].fields.map((field) => field.name)
        } else if (payload?.link) {
            if (!fixture.httpObjects[payload.link])
                throw new Error(`The fixture has no HTTP API object ${payload.link}`)
            base = objectType(payload.link)
            baseNames = fixture.httpObjects[payload.link].fields.map((field) => field.name)
        }
        if (payload?.with) {
            if (!base || !fixture.httpObjects[payload.with]) throw new Error(`${name} adds the missing ${payload.with}`)
            base = `${base} & ${objectType(payload.with)}`
            baseNames.push(...fixture.httpObjects[payload.with].fields.map((field) => field.name))
        }
        // A field the prose adds "as in" another event, such as member on Message Update, has that event's description
        const like = /as in ([A-Z][a-z]*(?: [A-Z][a-z]*)*)/.exec(event.prose)?.[1]?.toUpperCase().replaceAll(" ", "_")
        const borrowed = (/** @type {Field} */ field) =>
            field.description || !like
                ? field
                : {
                      ...field,
                      description: fixture.events[like]?.fields.find(({ name }) => name === field.name)?.description,
                  }
        const fields = [...event.fields, ...(added.fields ?? []).map(borrowed)]
        if (payload?.array) {
            if (fields.length > 0) throw new Error(`${name} is an array and also lists fields`)
            return `readonly (${base})[]`
        }
        if (!base && fields.length === 0)
            throw new Error(`${name} has no documented payload. Describe it in gateway-types.js`)
        for (const key of Object.keys(added.within ?? {}))
            if (!fields.some((field) => field.name === key))
                throw new Error(`The overlay adds fields inside ${name} ${key}, which it does not list`)
        const own = literal(fields, added.within)
        if (!base) return own
        if (fields.length === 0) return base
        // A field the event lists replaces the base object's field of the same name
        const replaced = fields.map((field) => field.name).filter((field) => baseNames.includes(field))
        return replaced.length ? `Omit<${base}, ${replaced.map(quote).join(" | ")}> & ${own}` : `${base} & ${own}`
    }

    const commit = fixture.source.commit
    const header = `// Generated by scripts/gateway-types.js from Fluxer's gateway and HTTP API documentation at commit
// ${commit} through tests/contract/fixtures/gateway-docs.json and the reviewed corrections in
// scripts/gateway-types-corrections.json (stamp ${stamp}),
// so edit the generator, the fixture or the corrections rather than this file`
    const eventNames = Object.keys(fixture.events).sort()
    const objectLinks = [...objectNames.keys()].sort()
    const objectSection = (/** @type {string} */ link) =>
        link.startsWith("/gateway/")
            ? fixture.objects[/** @type {string} */ (link.split("#")[1])]
            : fixture.httpObjects[link]
    // An event the documents never list says so, and its type follows Fluxer's source
    const eventSource = (/** @type {string} */ name) => {
        const event = fixture.events[name]
        return event.undocumented
            ? "Fluxer's documentation does not list it, so the type follows Fluxer's gateway source"
            : `Fluxer's documentation: ${docsOrigin}/gateway/${event.file.replace(/\.md$/, "")}/#${event.anchor}`
    }
    // A payload that is more than one named type gets an unexported alias of its own, so the reference shows one name per
    // dispatch type and the field lists stay in these generated declarations
    /** @type {string[]} */
    const aliases = []
    const payloadTypes = eventNames.map((name) => {
        const type = eventType(name)
        if (/^[A-Z]\w*$/.test(type) || /^GatewayDispatchPayloads\["[A-Z_]+"\]$/.test(type)) return [name, type]
        const alias = `${pascal(name)}Payload`
        if (objectLinks.some((link) => objectNames.get(link) === alias)) throw new Error(`${alias} names an object too`)
        aliases.push(`/** The data of ${name}. ${eventSource(name)} */
type ${alias} = ${type}`)
        return [name, alias]
    })
    const payloads = `${header}

/**
 * The data of each gateway dispatch type that Fluxer's documentation describes, or that Fluxer's source shows it sends,
 * keyed by its dispatch type, with Fluxer's own field names. Read it through a raw event whose documented is true,
 * where t selects the entry. These types come from the documentation at the SDK's reviewed Fluxer commit, with
 * reviewed corrections where Fluxer's source sends something else, and check nothing at runtime. Fluxer can
 * send fields added after that commit, leave out fields its documentation lists or change a shape, so check a value
 * before relying on it. Editors show each field with Fluxer's own description, and each entry links its documentation
 *
 * @category Events and collectors
 */
export interface GatewayDispatchPayloads {
${payloadTypes
    .map(
        ([name, type]) => `    /** ${eventSource(/** @type {string} */ (name))} */
    readonly ${name}: ${type}`,
    )
    .join("\n")}
}

/**
 * The objects that documented gateway dispatches carry, keyed by the address of their documentation on Fluxer's
 * documentation site, such as "/http-api/messages/#message-object". Field names are Fluxer's own. Like
 * GatewayDispatchPayloads, they describe the documentation at the SDK's reviewed Fluxer commit and check nothing at
 * runtime
 *
 * @category Events and collectors
 */
export interface GatewayPayloadObjects {
${objectLinks
    .map((link) => {
        const section = objectSection(link)
        return `    /** ${section.title.replace(/^./, (first) => first.toUpperCase())}. Fluxer's documentation: ${docsOrigin}${link} */
    readonly ${quote(link)}: ${objectType(link)}`
    })
    .join("\n")}
}

/**
 * The data of an opcode 12 Gateway Error frame, with Fluxer's own field names, from the documentation at the SDK's
 * reviewed Fluxer commit. Fluxer's documentation: ${docsOrigin}/gateway/opcodes-and-close-codes/#gateway-error
 *
 * @category Events and collectors
 */
export interface GatewayErrorData ${literal(fixture.gatewayError.fields)}

${aliases.join("\n\n")}

${objectLinks
    .map((link) => {
        const section = objectSection(link)
        return `/** ${section.title.replace(/^./, (first) => first.toUpperCase())}. Fluxer's documentation: ${docsOrigin}${link} */
interface ${objectType(link)} ${literal(section.fields)}`
    })
    .join("\n\n")}
`
    const names = `${header}

/** Dispatch types that GatewayDispatchPayloads describes, so a raw event of one of them reports documented as true */
export const documentedDispatchTypes: ReadonlySet<string> = new Set([
${eventNames.map((name) => `    ${quote(name)},`).join("\n")}
])
`
    const formatted = async (/** @type {string} */ text, /** @type {string} */ file) =>
        format(text, { ...(await resolveConfig(file)), filepath: file })
    return { payloads: await formatted(payloads, payloadsPath), names: await formatted(names, namesPath) }
}

/** Reads the committed fixture, overlay and corrections */
export async function readGatewayTypeSources() {
    return {
        fixture: /** @type {Fixture} */ (JSON.parse(await readFile(fixturePath, "utf8"))),
        overlay: /** @type {Record<string, Overlay>} */ (JSON.parse(await readFile(overlayPath, "utf8"))),
        corrections: /** @type {Corrections} */ (JSON.parse(await readFile(correctionsPath, "utf8"))),
    }
}

/** Renders the generated files and writes them */
export async function writeGatewayTypes() {
    const { payloads, names } = await renderGatewayTypes(await readGatewayTypeSources())
    await writeFile(payloadsPath, payloads)
    await writeFile(namesPath, names)
    return { files: [payloadsPath, namesPath] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    writeGatewayTypes().then(
        ({ files }) => console.log(`Wrote ${files.join(" and ")}`),
        (error) => {
            console.error(error instanceof Error ? error.message : "Gateway type generation failed")
            process.exitCode = 1
        },
    )
