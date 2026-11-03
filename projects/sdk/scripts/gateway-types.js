// @ts-check
// The types of the raw gateway event: Each dispatch type Fluxer's documentation describes, with the payload shape and
// field names that documentation gives, and the data of an opcode 12 Gateway Error frame. Read offline from the
// committed gateway documentation fixture and its overlay, which scripts/gateway-docs.js writes from the documents at the
// reviewed upstream pin, so regenerating never downloads anything. A contract test fails when the written files differ
// from what this script renders.
// Run from projects/ after regenerating the fixture: node sdk/scripts/gateway-types.js
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { format, resolveConfig } from "prettier"

const fixturePath = fileURLToPath(new URL("../tests/contract/fixtures/gateway-docs.json", import.meta.url))
const overlayPath = fileURLToPath(new URL("../tests/contract/fixtures/gateway-docs-overlay.json", import.meta.url))
export const payloadsPath = fileURLToPath(new URL("../src/gateway-payloads.ts", import.meta.url))
export const namesPath = fileURLToPath(new URL("../src/internal/gateway/documented-dispatches.ts", import.meta.url))
const docsOrigin = "https://docs.fluxer.com"

/**
 * @typedef {import("./gateway-docs.js").Shape} Shape
 * @typedef {{ name: string, optional: boolean, description?: string, shape: Shape }} Field
 * @typedef {{ object?: string, link?: string, event?: string, with?: string, array?: true }} Payload
 * @typedef {{ file: string, anchor: string, prose: string, payload?: Payload, fields: Field[] }} Event
 * @typedef {{ title: string, file: string, fields: Field[] }} ObjectSection
 * @typedef {{
 *     source: { commit: string },
 *     events: Record<string, Event>,
 *     objects: Record<string, ObjectSection>,
 *     httpObjects: Record<string, ObjectSection>,
 *     gatewayError: { fields: Field[] },
 * }} Fixture
 * @typedef {{ object?: string, like?: string, without?: string[], fields?: Field[], within?: Record<string, Field[]> }} Overlay
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

/**
 * Renders both generated files from the fixture and overlay, formatted as the repository formats them
 * @param {{ fixture: Fixture, overlay: Record<string, Overlay> }} input
 */
export async function renderGatewayTypes({ fixture, overlay }) {
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
     * @param {Shape} shape
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
                throw new Error(`No type for the documented kind ${/** @type {{ kind: string }} */ (shape).kind}`)
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
// ${commit} through tests/contract/fixtures/gateway-docs.json,
// so edit the generator or the fixture rather than this file`
    const eventNames = Object.keys(fixture.events).sort()
    const objectLinks = [...objectNames.keys()].sort()
    const objectSection = (/** @type {string} */ link) =>
        link.startsWith("/gateway/")
            ? fixture.objects[/** @type {string} */ (link.split("#")[1])]
            : fixture.httpObjects[link]
    const eventLink = (/** @type {string} */ name) => {
        const event = fixture.events[name]
        return `${docsOrigin}/gateway/${event.file.replace(/\.md$/, "")}/#${event.anchor}`
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
        aliases.push(`/** The data of ${name}. Fluxer's documentation: ${eventLink(name)} */
type ${alias} = ${type}`)
        return [name, alias]
    })
    const payloads = `${header}

/**
 * The data of each gateway dispatch type that Fluxer's documentation describes, keyed by its dispatch type, with
 * Fluxer's own field names. Read it through a raw event whose documented is true, where t selects the entry.
 * These types come from the documentation at the SDK's reviewed Fluxer commit and check nothing at runtime. Fluxer can
 * send fields added after that commit, leave out fields its documentation lists or change a shape, so check a value
 * before relying on it. Editors show each field with Fluxer's own description, and each entry links its documentation
 *
 * @category Events and collectors
 */
export interface GatewayDispatchPayloads {
${payloadTypes
    .map(
        ([name, type]) => `    /** Fluxer's documentation: ${eventLink(/** @type {string} */ (name))} */
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

/** Reads the committed fixture and overlay */
export async function readGatewayTypeSources() {
    return {
        fixture: /** @type {Fixture} */ (JSON.parse(await readFile(fixturePath, "utf8"))),
        overlay: /** @type {Record<string, Overlay>} */ (JSON.parse(await readFile(overlayPath, "utf8"))),
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
