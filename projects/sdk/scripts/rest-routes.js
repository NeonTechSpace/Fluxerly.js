// @ts-check
// Route types for client.rest.call, generated from Fluxer's OpenAPI document and HTTP API docs at the reviewed upstream
// pin and written to the committed src/rest-routes.ts. Each route that accepts a bot token, and each public route a route
// correction adds, gets its path parameters,
// query, JSON body and success response with Fluxer's official field names, and a link to the section of Fluxer's docs
// that the website's endpoint map links. The reviewed corrections in rest-routes-corrections.json fix places where the
// document is wrong or incomplete, each citing Fluxer's source at the pin.
// The files are read through the website's pinned copy in web/.cache/fluxer, which checks each file against the pinned
// hash and downloads from GitHub only when the pin changed. No request goes to a Fluxer host.
// node release/upstream.js --update <commit> runs it after moving the pin. Run it alone from projects/ with:
// node sdk/scripts/rest-routes.js
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { format, resolveConfig } from "prettier"
import { validateManifest } from "../../release/upstream.js"
import { readDocs, routeKey, specOperations } from "../../web/scripts/docs/endpoints.mjs"
import { fluxerSource } from "../../web/scripts/docs/fluxer-source.mjs"

const manifestPath = fileURLToPath(new URL("../../release/upstream/manifest.json", import.meta.url))
const correctionsPath = fileURLToPath(new URL("./rest-routes-corrections.json", import.meta.url))
const generatorPath = fileURLToPath(import.meta.url)
const outputPath = fileURLToPath(new URL("../src/rest-routes.ts", import.meta.url))
const cachePath = fileURLToPath(new URL("../../web/.cache/fluxer", import.meta.url))
const docsOrigin = "https://docs.fluxer.com"
const schemaPrefix = "#/components/schemas/"
const methodOrder = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const identifier = /^[A-Za-z_$][\w$]*$/
// Public prose uses none, so Fluxer text with one needs review before it reaches a comment
const emDash = String.fromCharCode(0x2014)
// Keywords that only constrain or describe a value, which TypeScript types cannot express and the generator ignores
const ignoredKeywords = new Set([
    "description",
    "title",
    "default",
    "examples",
    "example",
    "deprecated",
    "format",
    "pattern",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
    "contentEncoding",
    "contentMediaType",
    "propertyNames",
    "readOnly",
    "writeOnly",
])
const structuralKeywords = new Set([
    "$ref",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "anyOf",
    "oneOf",
])

/**
 * @typedef {{ route: string, reason?: string, evidence: string[] }} RouteCorrection
 * @typedef {{ route: string, name: string, type: "integer" | "boolean", evidence: string[] }} QueryCorrection
 * @typedef {{ schema: string | string[], property?: string, values?: unknown[], branches?: unknown[], required?: string[], remove?: string[], reason?: string, evidence: string[] }} SchemaCorrection
 * @typedef {{ routes: RouteCorrection[], query: QueryCorrection[], schemas: SchemaCorrection[] }} Corrections
 * @typedef {{ sections: Map<string, { page: string, anchor: string }> }} Docs
 */

const sha256 = (/** @type {string} */ value) => createHash("sha256").update(value).digest("hex")

/**
 * One hash of everything generation reads, recorded in the generated file. tests/contract/rest-routes.test.ts computes
 * it the same way and fails when the pin, the pinned docs files, the corrections or this generator changed without
 * regenerating. Line endings are normalized so a checkout that converts them does not change it
 * @param {{ repository: string, commit: string, files: { openapi: { path: string, sha256: string } }, endpointDocs?: readonly { path: string, sha256: string }[] }} manifest
 * @param {string} corrections
 * @param {string} generator
 */
export const restRoutesStamp = (manifest, corrections, generator) =>
    sha256(
        JSON.stringify({
            repository: manifest.repository,
            commit: manifest.commit,
            openapi: manifest.files.openapi,
            endpointDocs: manifest.endpointDocs ?? [],
            corrections: sha256(corrections.replaceAll("\r\n", "\n")),
            generator: sha256(generator.replaceAll("\r\n", "\n")),
        }),
    )

/** @param {unknown} value */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
/** @param {string} name */
const propertyKey = (name) => (identifier.test(name) ? name : JSON.stringify(name))
/** @param {string} text */
const pascal = (text) =>
    text
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join("")

/**
 * A comment from text Fluxer wrote, kept as written apart from a final period, which the SDK's public prose leaves out.
 * Text that would end the comment or needs review under the SDK's prose rules fails generation
 * @param {string} text
 * @param {string} where
 */
function quoted(text, where) {
    const trimmed = text.trim().replace(/\s+/g, " ").replace(/\.$/, "")
    if (trimmed.includes("*/") || trimmed.includes(emDash))
        throw new Error(`${where}: The description needs review: ${trimmed}`)
    return trimmed
}

/** @param {Record<string, any>} schemas @param {any} schema @returns {any} */
const resolveSchema = (schemas, schema) =>
    typeof schema?.$ref === "string" ? resolveSchema(schemas, schemas[schema.$ref.slice(schemaPrefix.length)]) : schema

/**
 * Whether a schema allows only strings, numbers, booleans or literals of them
 * @param {Record<string, any>} schemas
 * @param {any} schema
 * @returns {boolean}
 */
function scalar(schemas, schema) {
    const resolved = resolveSchema(schemas, schema)
    if (!isObject(resolved)) return false
    if (resolved.const !== undefined) return ["string", "number", "boolean"].includes(typeof resolved.const)
    if (Array.isArray(resolved.enum))
        return resolved.enum.every((/** @type {unknown} */ value) =>
            ["string", "number", "boolean"].includes(typeof value),
        )
    const union = resolved.anyOf ?? resolved.oneOf
    if (Array.isArray(union)) return union.every((branch) => scalar(schemas, branch))
    const types = [resolved.type].flat()
    return types.length > 0 && types.every((type) => ["string", "integer", "number", "boolean"].includes(type))
}

/** @param {string[]} lines */
const comment = (lines) =>
    lines.length === 1
        ? `/** ${lines[0]} */`
        : `/**\n${lines.map((line) => (line ? ` * ${line}` : " *")).join("\n")}\n */`

// A correction cites Fluxer source files at the pin by line, such as fluxer_api/src/api/gateway/GatewayController.ts:11
const citation = /^[\w./@-]+\.ts:\d+(-\d+)?$/

/** @param {{ evidence?: unknown }} correction @param {string} label */
function checkEvidence(correction, label) {
    const evidence = correction.evidence
    if (
        !Array.isArray(evidence) ||
        evidence.length === 0 ||
        !evidence.every((item) => typeof item === "string" && citation.test(item))
    )
        throw new Error(`The correction ${label} must cite Fluxer source files by line`)
}

/**
 * Checks each correction against the document and returns the component schemas with the schema corrections applied.
 * A correction that names something the document lacks, or that changes nothing, fails generation, so a moved pin
 * shows which corrections Fluxer has fixed or invalidated
 * @param {any} spec
 * @param {Corrections} corrections
 */
function correctedSchemas(spec, corrections) {
    const schemas = structuredClone(spec?.components?.schemas ?? {})
    /** @param {any} schema */
    const resolveRef = (schema) =>
        typeof schema?.$ref === "string" ? schemas[schema.$ref.slice(schemaPrefix.length)] : schema
    for (const correction of corrections.schemas) {
        checkEvidence(correction, `for ${[correction.schema].flat().join(", ")}`)
        for (const name of [correction.schema].flat()) {
            const schema = schemas[name]
            if (!isObject(schema) || !isObject(schema.properties))
                throw new Error(`The correction names ${name}, which is not an object schema`)
            if (correction.values) {
                const property = correction.property
                if (!property || !Object.hasOwn(schema.properties, property))
                    throw new Error(`The correction names ${name}.${property}, which the document lacks`)
                const current = resolveRef(schema.properties[property])
                if (!Array.isArray(current?.enum) || !correction.values.every((value) => current.enum.includes(value)))
                    throw new Error(`The correction narrows ${name}.${property} to values its enum does not list`)
                if (current.enum.length === correction.values.length)
                    throw new Error(`The correction of ${name}.${property} changes nothing`)
                const { description } = schema.properties[property]
                schema.properties[property] = {
                    ...(description ? { description } : {}),
                    type: current.type,
                    enum: correction.values,
                }
            }
            if (correction.branches) {
                // Union branches the server also sends, added to the property's anyOf
                const property = correction.property
                if (!property || !Object.hasOwn(schema.properties, property))
                    throw new Error(`The correction names ${name}.${property}, which the document lacks`)
                const current = schema.properties[property]
                if (!Array.isArray(current?.anyOf))
                    throw new Error(`The correction adds branches to ${name}.${property}, which is not an anyOf union`)
                const known = new Set(current.anyOf.map((/** @type {unknown} */ branch) => JSON.stringify(branch)))
                for (const branch of correction.branches)
                    if (known.has(JSON.stringify(branch)))
                        throw new Error(`The document already lists the added branch of ${name}.${property}`)
                schema.properties[property] = { ...current, anyOf: [...current.anyOf, ...correction.branches] }
            }
            if (correction.remove) {
                // Properties the document offers but the server always refuses
                for (const property of correction.remove) {
                    if (!Object.hasOwn(schema.properties, property))
                        throw new Error(`The correction removes ${name}.${property}, which the document lacks`)
                    delete schema.properties[property]
                    if (Array.isArray(schema.required))
                        schema.required = schema.required.filter((/** @type {string} */ item) => item !== property)
                }
            }
            if (correction.required) {
                const required = new Set(schema.required ?? [])
                for (const property of correction.required) {
                    if (!Object.hasOwn(schema.properties, property))
                        throw new Error(`The correction requires ${name}.${property}, which the document lacks`)
                    if (required.has(property)) throw new Error(`The document already requires ${name}.${property}`)
                    required.add(property)
                }
                schema.required = [...required]
            }
        }
    }
    return schemas
}

/**
 * Builds the TypeScript type text of schemas, collecting each named schema it reaches so the file declares only those
 * @param {Record<string, any>} schemas
 */
function typeWriter(schemas) {
    /** @type {Set<string>} */
    const reached = new Set()
    /** @param {string} ref @param {string} where */
    const reference = (ref, where) => {
        const name = ref.startsWith(schemaPrefix) ? ref.slice(schemaPrefix.length) : undefined
        if (name === undefined || !Object.hasOwn(schemas, name))
            throw new Error(`${where}: Unresolvable schema reference ${ref}`)
        if (!identifier.test(name)) throw new Error(`${where}: The schema name ${name} is not a TypeScript name`)
        reached.add(name)
        return name
    }
    /** @param {string} text */
    const grouped = (text) => (/^[\w$."]+$/.test(text) ? text : `(${text})`)
    /** @param {unknown} value @param {string} where */
    const literal = (value, where) => {
        if (value === null || ["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value)
        throw new Error(`${where}: Unsupported literal ${JSON.stringify(value)}`)
    }
    /**
     * @param {any} schema
     * @param {string} where
     * @returns {string}
     */
    const write = (schema, where) => {
        if (
            schema === true ||
            (isObject(schema) && Object.keys(schema).every((key) => ignoredKeywords.has(key) || key.startsWith("x-")))
        )
            return "unknown"
        if (!isObject(schema)) throw new Error(`${where}: Unsupported schema`)
        const unknown = Object.keys(schema).find(
            (key) => !ignoredKeywords.has(key) && !structuralKeywords.has(key) && !key.startsWith("x-"),
        )
        if (unknown !== undefined) throw new Error(`${where}: Unsupported schema keyword ${unknown}`)
        if (typeof schema.$ref === "string") return reference(schema.$ref, where)
        if (schema.const !== undefined) return literal(schema.const, where)
        if (Array.isArray(schema.enum)) return schema.enum.map((value) => literal(value, where)).join(" | ")
        const union = schema.anyOf ?? schema.oneOf
        if (Array.isArray(union)) {
            // A union whose siblings add structure would need merging, which no schema at the pin needs
            if (Object.keys(schema).some((key) => structuralKeywords.has(key) && key !== "anyOf" && key !== "oneOf"))
                throw new Error(`${where}: A union with structural siblings is not supported`)
            return [...new Set(union.map((branch, index) => write(branch, `${where}|${index}`)))].join(" | ")
        }
        if (Array.isArray(schema.type))
            return [...new Set(schema.type.map((type) => write({ ...schema, type }, where)))].join(" | ")
        switch (schema.type) {
            case "string":
                return "string"
            case "integer":
            case "number":
                return "number"
            case "boolean":
                return "boolean"
            case "null":
                return "null"
            case "array":
                return `readonly ${grouped(schema.items === undefined ? "unknown" : write(schema.items, `${where}[]`))}[]`
            case "object":
                return object(schema, where)
            case undefined:
                if (schema.properties !== undefined || schema.additionalProperties !== undefined)
                    return object(schema, where)
                if (schema.items !== undefined) return write({ ...schema, type: "array" }, where)
                return "unknown"
            default:
                throw new Error(`${where}: Unsupported type ${schema.type}`)
        }
    }
    /** @param {any} schema @param {string} where */
    const object = (schema, where) => {
        const required = new Set(schema.required ?? [])
        const properties = Object.entries(schema.properties ?? {}).map(
            ([name, property]) =>
                `readonly ${propertyKey(name)}${required.has(name) ? "" : "?"}: ${write(property, `${where}.${name}`)}`,
        )
        for (const name of required)
            if (!Object.hasOwn(schema.properties ?? {}, name))
                throw new Error(`${where}: Required ${name} has no schema`)
        const extra = schema.additionalProperties
        const map =
            extra === undefined || extra === true
                ? properties.length
                    ? undefined
                    : "unknown"
                : extra === false
                  ? undefined
                  : write(extra, `${where}.*`)
        const literalType = properties.length ? `{ ${properties.join("; ")} }` : undefined
        const mapType = map === undefined ? undefined : `{ readonly [key: string]: ${map} }`
        if (literalType && mapType) return `${literalType} & ${mapType}`
        return literalType ?? mapType ?? "{ readonly [key: string]: never }"
    }
    return { write, reached }
}

/**
 * @typedef {{ writer: ReturnType<typeof typeWriter>, schemas: Record<string, any>, hoisted: Map<string, string>, byText: Map<string, string>, shapes: Set<keyof typeof sharedShapes>, queryCorrections: Map<string, QueryCorrection>, usedQueryCorrections: Set<string>, files: boolean }} Context
 */

/**
 * A type for an inline object schema gets a name of its own, so the route's members stay readable
 * @param {Context} context
 * @param {any} schema
 * @param {string} name
 * @param {string} where
 */
function namedType(context, schema, name, where) {
    const type = context.writer.write(schema, where)
    if (typeof schema?.$ref === "string" || !type.startsWith("{")) return type
    if (Object.hasOwn(context.schemas, name) || context.hoisted.has(name)) throw new Error(`${where}: ${name} is taken`)
    context.hoisted.set(name, type)
    return name
}

/** @param {any} parameter @param {string} kind @param {string} where */
const parameterComment = (parameter, kind, where) =>
    comment([
        parameter.description || parameter.schema?.description
            ? quoted(parameter.description ?? parameter.schema.description, `${where} ${parameter.name}`)
            : `The ${parameter.name} ${kind}`,
    ])

// Shapes every route shares, declared once and named by RestRoutes members, so their comments are not repeated per route
const sharedShapes = {
    Route: [
        "/** One route: The fields its request takes and the body of a successful response */",
        "interface Route<Input, Response> {",
        "/** Route-specific fields of the request */",
        "readonly input: Input",
        "/** The parsed JSON body of a successful response, or undefined when Fluxer answers without a body */",
        "readonly response: Response",
        "}",
    ],
    PathParameters: [
        "interface PathParameters<P> {",
        "/** Path parameters, each sent percent-encoded as one path segment */",
        "readonly params: P",
        "}",
    ],
    QueryParameters: [
        "interface QueryParameters<Q> {",
        "/** Query parameters, sent in this order. An array sends its parameter once per item */",
        "readonly query?: Q",
        "}",
    ],
    RequiredQueryParameters: [
        "interface RequiredQueryParameters<Q> {",
        "/** Query parameters, sent in this order. An array sends its parameter once per item */",
        "readonly query: Q",
        "}",
    ],
    JsonBody: [
        "interface JsonBody<B> {",
        "/** The JSON body, sent as given with Fluxer's field names */",
        "readonly body: B",
        "}",
    ],
    OptionalJsonBody: [
        "interface OptionalJsonBody<B> {",
        "/** The JSON body, sent as given with Fluxer's field names */",
        "readonly body?: B",
        "}",
    ],
    MessageFiles: [
        "interface MessageFiles {",
        "/** Files sent inline as multipart/form-data, with the body as payload_json. Existing attachments listed in the body's attachments stay, and each file's metadata follows them */",
        "readonly files?: readonly AttachmentInput[]",
        "}",
    ],
}

/**
 * Names a shared shape, recording that the file must declare it
 * @param {Context} context
 * @param {keyof typeof sharedShapes} name
 */
const shape = (context, name) => {
    context.shapes.add(name)
    return name
}

/**
 * Declares an object type under a name, once per distinct text, so routes with the same path parameters share one type
 * @param {Context} context
 * @param {string} base
 * @param {string} type
 */
function sharedType(context, base, type) {
    const existing = context.byText.get(type)
    if (existing) return existing
    let name = base
    for (let index = 2; Object.hasOwn(context.schemas, name) || context.hoisted.has(name); index++)
        name = `${base}${index}`
    context.hoisted.set(name, type)
    context.byText.set(type, name)
    return name
}

/**
 * The path parameters part of a route's input, in path order, or nothing for a path without parameters
 * @param {Context} context
 * @param {string} path
 * @param {any[]} parameters
 * @param {string} where
 */
function pathPart(context, path, parameters, where) {
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
    const declared = parameters.filter((parameter) => parameter.in === "path")
    const fields = placeholders.map((placeholder) => {
        const parameter = declared.find((item) => item.name === placeholder && item.required)
        if (!parameter) throw new Error(`${where}: The path parameter ${placeholder} is not declared as required`)
        return `${parameterComment(parameter, "path parameter", where)}\nreadonly ${propertyKey(placeholder)}: ${context.writer.write(parameter.schema, `${where} ${placeholder}`)}`
    })
    if (declared.length !== placeholders.length)
        throw new Error(`${where}: The path parameters do not match the path template`)
    if (!fields.length) return []
    const type = sharedType(context, `${pascal(placeholders.join(" "))}Path`, `{\n${fields.join("\n")}\n}`)
    return [`${shape(context, "PathParameters")}<${type}>`]
}

/**
 * The query part of a route's input. client.rest.request encodes strings, numbers and booleans, and arrays of them as
 * a repeated parameter, so any other parameter fails generation. A query correction replaces a string that Fluxer's
 * server parses as an integer or a boolean with that type
 * @param {Context} context
 * @param {string} name
 * @param {any[]} parameters
 */
function queryPart(context, name, parameters) {
    const query = parameters.filter((parameter) => parameter.in === "query")
    if (!query.length) return []
    const fields = query.map((parameter) => {
        const key = `${name} ${parameter.name}`
        const correction = context.queryCorrections.get(key)
        let type
        if (correction) {
            if (parameter.schema?.type !== "string")
                throw new Error(`${name}: The query correction for ${parameter.name} expects a string parameter`)
            context.usedQueryCorrections.add(key)
            type = correction.type === "integer" ? "number" : "boolean"
        } else {
            const resolved = resolveSchema(context.schemas, parameter.schema)
            if (
                !scalar(context.schemas, resolved) &&
                !(resolved?.type === "array" && scalar(context.schemas, resolved.items))
            )
                throw new Error(`${name}: The query parameter ${parameter.name} is not a scalar or an array of scalars`)
            type = context.writer.write(parameter.schema, `${name} ?${parameter.name}`)
        }
        const optional = parameter.required ? "" : "?"
        return `${parameterComment(parameter, "query parameter", name)}\nreadonly ${propertyKey(parameter.name)}${optional}: ${type}${optional ? " | undefined" : ""}`
    })
    // Each route's query is its own, so it stays inline, where the reference shows each parameter's description
    const required = query.some((parameter) => parameter.required)
    return [`${shape(context, required ? "RequiredQueryParameters" : "QueryParameters")}<{\n${fields.join("\n")}\n}>`]
}

/**
 * The body and files parts of a route's input. Files are offered only for message-style multipart, whose form
 * carries the same JSON as payload_json beside files[n], which is what client.rest.request sends with files
 * @param {Context} context
 * @param {any} operation
 * @param {string} id
 * @param {string} where
 */
function bodyParts(context, operation, id, where) {
    const content = operation.requestBody?.content ?? {}
    const mediaTypes = Object.keys(content)
    if (mediaTypes.some((type) => type !== "application/json" && type !== "multipart/form-data"))
        throw new Error(`${where}: Unsupported request media type ${mediaTypes.join(", ")}`)
    if (!operation.requestBody) return []
    const schema = content["application/json"]?.schema
    if (!schema) throw new Error(`${where}: The request body has no JSON form`)
    const body = shape(context, operation.requestBody.required === true ? "JsonBody" : "OptionalJsonBody")
    const parts = [`${body}<${namedType(context, schema, `${id}Body`, `${where} body`)}>`]
    const multipart = content["multipart/form-data"]?.schema
    if (typeof multipart?.$ref === "string" && multipart.$ref === schema.$ref) {
        context.files = true
        parts.push(shape(context, "MessageFiles"))
    }
    return parts
}

/**
 * The response type: The JSON body of each success status, or undefined for one Fluxer answers without a body
 * @param {Context} context
 * @param {any} operation
 * @param {string} id
 * @param {string} where
 */
function responseType(context, operation, id, where) {
    const successes = Object.entries(operation.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status))
    if (!successes.length) throw new Error(`${where}: No success response`)
    const types = new Set()
    for (const [status, response] of successes) {
        const others = Object.keys(response?.content ?? {}).filter((type) => type !== "application/json")
        if (others.length) throw new Error(`${where}: Unsupported ${status} response media type ${others.join(", ")}`)
        const schema = response?.content?.["application/json"]?.schema
        const name = `${id}Response${successes.length > 1 ? status : ""}`
        types.add(schema === undefined ? "undefined" : namedType(context, schema, name, `${where} ${status}`))
    }
    return [...types].join(" | ")
}

/**
 * One member of RestRoutes: The route's summary and docs link, then its input and response as a shared Route shape
 * @param {Context} context
 * @param {any} spec
 * @param {Docs} docs
 * @param {{ method: string, path: string, key: string, summary: string }} route
 */
function routeMember(context, spec, docs, route) {
    const name = `${route.method} ${route.path}`
    const operation = spec.paths[route.path][route.method.toLowerCase()]
    const id = pascal(String(operation.operationId ?? name))
    /** @type {any[]} */
    const parameters = operation.parameters ?? []
    for (const parameter of parameters) {
        if (typeof parameter?.$ref === "string") throw new Error(`${name}: Parameter references are not supported`)
        if (parameter.in !== "path" && parameter.in !== "query")
            throw new Error(`${name}: Unsupported ${parameter.in} parameter ${parameter.name}`)
    }
    const input = [
        ...pathPart(context, route.path, parameters, name),
        ...queryPart(context, name, parameters),
        ...bodyParts(context, operation, id, name),
    ]
    const section = docs.sections.get(route.key)
    const lines = [quoted(route.summary || name, `${name} summary`)]
    if (section) lines.push("", `Described in [Fluxer's documentation](${docsOrigin}${section.page}#${section.anchor})`)
    if (operation.deprecated) lines.push("", "@deprecated Fluxer's API description marks this route as deprecated")
    const routeShape = shape(context, "Route")
    return `${comment(lines)}\nreadonly ${JSON.stringify(name)}: ${routeShape}<${input.length ? input.join(" & ") : "{}"}, ${responseType(context, operation, id, name)}>`
}

/**
 * The routes a bot token reaches: Those whose document lists botToken, and the route corrections' additions, such as
 * public reads the document lists with no token
 * @param {ReturnType<typeof specOperations>} operations
 * @param {RouteCorrection[]} corrections
 */
function botRoutes(operations, corrections) {
    const byKey = new Map(operations.map((operation) => [operation.key, operation]))
    const added = new Set()
    for (const correction of corrections) {
        checkEvidence(correction, correction.route)
        const [method = "", path = ""] = correction.route.split(" ")
        const operation = byKey.get(routeKey(method, path))
        if (!operation || operation.path !== path)
            throw new Error(`The route correction names ${correction.route}, which the document lacks`)
        if (operation.tokens.includes("botToken"))
            throw new Error(`The document already lists a bot token for ${correction.route}`)
        added.add(operation.key)
    }
    return operations
        .filter((operation) => operation.tokens.includes("botToken") || added.has(operation.key))
        .sort((a, b) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : methodOrder.indexOf(a.method) - methodOrder.indexOf(b.method),
        )
}

/**
 * The route types file for one OpenAPI document and its docs sections, before formatting
 * @param {{ spec: any, docs: Docs, corrections: Corrections, source: { repository: string, commit: string }, stamp: string }} input
 */
export function restRoutesSource({ spec, docs, corrections, source, stamp }) {
    const schemas = correctedSchemas(spec, corrections)
    /** @type {Context} */
    const context = {
        writer: typeWriter(schemas),
        schemas,
        hoisted: new Map(),
        byText: new Map(),
        shapes: new Set(),
        queryCorrections: new Map(),
        usedQueryCorrections: new Set(),
        files: false,
    }
    const { writer, queryCorrections, usedQueryCorrections } = context
    for (const correction of corrections.query) {
        checkEvidence(correction, `${correction.route} ${correction.name}`)
        if (correction.type !== "integer" && correction.type !== "boolean")
            throw new Error(`The query correction ${correction.route} ${correction.name} has an unknown type`)
        queryCorrections.set(`${correction.route} ${correction.name}`, correction)
    }
    const routes = botRoutes(specOperations(spec), corrections.routes)
    const members = routes.map((route) => routeMember(context, spec, docs, route))
    const unused = [...queryCorrections.keys()].filter((key) => !usedQueryCorrections.has(key))
    if (unused.length) throw new Error(`Query corrections name parameters the typed routes lack: ${unused.join(", ")}`)

    // Each named schema the routes reach, including those reached through other schemas
    /** @type {string[]} */
    const declarations = []
    const declared = new Set()
    for (
        let pending = [...writer.reached];
        pending.length;
        pending = [...writer.reached].filter((name) => !declared.has(name))
    )
        for (const name of pending.sort()) {
            declared.add(name)
            declarations.push(`type ${name} = ${writer.write(schemas[name], name)}`)
        }
    const hoisted = [...context.hoisted].map(([name, type]) => `type ${name} = ${type}`)
    const shapes = Object.entries(sharedShapes)
        .filter(([name]) => context.shapes.has(/** @type {keyof typeof sharedShapes} */ (name)))
        .map(([, lines]) => lines.join("\n"))
    const names = new Set([...declared, ...context.hoisted.keys()])
    for (const reserved of ["AttachmentInput", "RestRoutes", ...Object.keys(sharedShapes)])
        if (names.has(reserved)) throw new Error(`A generated type would shadow ${reserved}`)

    const header = [
        `// Generated by sdk/scripts/rest-routes.js from Fluxer's API description and HTTP API docs at ${source.repository}@${source.commit},`,
        "// with the reviewed corrections in sdk/scripts/rest-routes-corrections.json. Do not edit by hand. Regenerate from projects/",
        "// with node sdk/scripts/rest-routes.js, which node release/upstream.js --update runs after moving the pin",
        `// Inputs: ${stamp}`,
    ]
    const routesComment = comment([
        "Every Fluxer API route that client.rest.call checks at compile time, keyed by its method and path template as",
        "Fluxer's documentation writes them, such as `POST /channels/{channel_id}/messages`. Generated from Fluxer's API",
        `description at commit ${source.commit.slice(0, 12)} of ${source.repository}, the commit the SDK release pins,`,
        "with Fluxer's official field names and a few reviewed corrections where the description is wrong or incomplete.",
        "Each input lists the route's path parameters, query and JSON body. Each response is the parsed JSON body of a",
        "successful answer, which the SDK does not check at runtime. Routes Fluxer adds after the pin, and fields the",
        "description leaves out, need client.rest.request",
        "",
        "@category REST routes",
    ])
    return {
        text: [
            ...header,
            ...(context.files ? ['import type { AttachmentInput } from "./attachments.js"'] : []),
            "",
            `${routesComment}\nexport interface RestRoutes {\n${members.join("\n")}\n}`,
            "",
            ...shapes,
            ...hoisted,
            ...declarations,
            "",
        ].join("\n"),
        routes: routes.length,
        schemas: declarations.length + hoisted.length,
    }
}

/**
 * Reads the pinned OpenAPI document and docs files, checks them against the pin and writes the formatted route types
 * @param {{ manifestFile?: string, correctionsFile?: string, outputFile?: string, cacheDir?: string, fetchFile?: (repository: string, commit: string, path: string) => Promise<Buffer>, log?: (line: string) => void }} [options]
 */
export async function writeRestRoutes({
    manifestFile = manifestPath,
    correctionsFile = correctionsPath,
    outputFile = outputPath,
    cacheDir = cachePath,
    fetchFile,
    log = console.log,
} = {}) {
    const manifest = validateManifest(JSON.parse(await readFile(manifestFile, "utf8")))
    const correctionsText = await readFile(correctionsFile, "utf8")
    const generatorText = await readFile(generatorPath, "utf8")
    const source = await fluxerSource(manifest, { cacheDir, log, ...(fetchFile ? { fetchFile } : {}) })
    const spec = JSON.parse(source.openapi.toString("utf8"))
    const { text, routes, schemas } = restRoutesSource({
        spec,
        docs: readDocs(source),
        corrections: JSON.parse(correctionsText),
        source: manifest,
        stamp: restRoutesStamp(manifest, correctionsText, generatorText),
    })
    const options = await resolveConfig(outputFile)
    await writeFile(outputFile, await format(text, { ...options, filepath: outputFile }))
    return { file: outputFile, routes, schemas }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    writeRestRoutes().then(
        ({ file, routes, schemas }) => console.log(`Wrote ${routes} routes and ${schemas} schema types to ${file}`),
        (error) => {
            console.error(error instanceof Error ? error.message : "REST route type generation failed")
            process.exitCode = 1
        },
    )
