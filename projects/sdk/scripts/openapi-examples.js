// @ts-check
// Example payloads for the Fluxer response schemas the SDK decodes, generated from the OpenAPI document at the reviewed
// upstream pin and written to a committed fixture. The OpenAPI conformance test feeds them through public operations,
// so `pnpm check` stays offline while proving the SDK accepts what Fluxer's API description calls valid.
// Run from projects/ after moving the pin with `node release/upstream.js --update`: node sdk/scripts/openapi-examples.js
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { format, resolveConfig } from "prettier"
import { githubSource, validateManifest } from "../../release/upstream.js"

const manifestPath = fileURLToPath(new URL("../../release/upstream/manifest.json", import.meta.url))
const fixturePath = fileURLToPath(new URL("../tests/contract/fixtures/openapi-examples.json", import.meta.url))
const factsPath = fileURLToPath(new URL("../tests/contract/fixtures/openapi-server-facts.json", import.meta.url))
const schemaPrefix = "#/components/schemas/"
// A schema may repeat once on one path, so a message carries one referenced message but no deeper chain
const maximumRepeats = 2
// Regenerating fails above this size, so growth of the committed fixture is reviewed rather than silent
const maximumFixtureBytes = 768 * 1024
const timestamp = "2026-01-01T00:00:00.000Z"
const snowflakePattern = "^(0|[1-9][0-9]*)$"
const decimalPattern = "^\\d+$"
const missing = Symbol("missing")
// Keywords the generator honours or that constrain nothing, besides x- extensions. Any other keyword or string format
// fails generation, so a new constraint in a moved pin is handled rather than producing examples the document rejects
const knownKeywords = new Set([
    "$ref",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "propertyNames",
    "items",
    "enum",
    "const",
    "anyOf",
    "format",
    "pattern",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "description",
    "title",
    "default",
    "examples",
    "example",
    "deprecated",
])
const stringFormats = new Set([undefined, "date-time", "snowflake", "uri", "int64"])

/**
 * Response schemas the SDK decodes. A root with `each` gets its own examples for every value of that enum property.
 * The conformance test maps each name to the public operation that decodes it
 * @type {Root[]}
 */
const decodedSchemas = [
    { name: "MessageResponseSchema" },
    { name: "MessageListResponse" },
    { name: "ChannelResponse", each: "type" },
    { name: "ThreadChannelResponse", each: "type" },
    { name: "StartForumThreadResponse" },
    { name: "GuildResponse" },
    { name: "GuildListResponse" },
    { name: "GuildMemberResponse" },
    { name: "GuildMemberListResponse" },
    { name: "GuildMemberSearchResponse" },
    { name: "GuildBanListResponse" },
    { name: "GuildRoleResponse" },
    { name: "GuildRoleListResponse" },
    { name: "UserPartialResponse" },
    { name: "UserPrivateResponse" },
    { name: "GuildEmojiResponse" },
    { name: "GuildEmojiWithUserListResponse" },
    { name: "GuildStickerResponse" },
    { name: "GuildStickerWithUserListResponse" },
    { name: "InviteResponseSchema" },
    { name: "InviteMetadataResponseSchema" },
    { name: "InviteMetadataListResponse" },
    { name: "WebhookResponse" },
    { name: "WebhookListResponse" },
    { name: "GuildAuditLogListResponse" },
    { name: "MessageSearchResponse" },
    { name: "ActiveThreadsResponse" },
    { name: "ArchivedThreadsResponse" },
    { name: "ThreadSearchResult" },
    { name: "ThreadMemberResponse" },
    { name: "ThreadMemberListResponse" },
    { name: "ReactionUsersPageResponse" },
    { name: "ApplicationsMeResponse" },
    { name: "ChannelPinsResponse" },
]

/**
 * @typedef {{ name: string, each?: string }} Root
 * @typedef {{ name: string, value: unknown }} Example
 * @typedef {{ schema: string | string[], property: string, when?: Record<string, unknown[]>, values?: unknown[], required?: boolean, notNull?: boolean, absent?: boolean, evidence: string }} Fact
 * @typedef {{ mode: "minimal" | "full", nulls: boolean, choices: Map<string, number>, sites: Map<string, Map<number, string>>, expanded: Set<string>, each?: { property: string, value: unknown } }} Context
 * @typedef {{ owner: string, local: string, stack: string[], name: string | undefined }} Position
 */

const sha256 = (/** @type {string | Buffer} */ value) => createHash("sha256").update(value).digest("hex")

/**
 * A decimal snowflake derived from the field name, so every field with one name, such as guild_id, carries one ID.
 * Cross-references Fluxer keeps consistent, such as a thread member's thread ID, then match
 * @param {string | undefined} name
 */
const snowflake = (name) => (BigInt(`0x${sha256(name ?? "id").slice(0, 15)}`) + 1n).toString()

/**
 * Some ID and timestamp strings carry no format in the document. Their field names say what Fluxer sends, so they get
 * an ID or a timestamp rather than arbitrary text
 * @param {string | undefined} name
 */
const namedId = (name) => name !== undefined && /(^id|_id|_ids|^roles|^mentions|^mention_roles)$/.test(name)
const namedTime = (/** @type {string | undefined} */ name) =>
    name !== undefined && /(_timestamp|_at|_time|_until)$/.test(name)

/** @param {unknown} value */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

/** @param {any} schema */
function label(schema) {
    if (typeof schema?.$ref === "string") return schema.$ref.slice(schemaPrefix.length)
    if (schema?.type === "array") return `array of ${label(schema.items)}`
    if (schema?.const !== undefined) return JSON.stringify(schema.const)
    if (typeof schema?.type === "string") return schema.type
    return "branch"
}

/** @param {Fact} fact */
const describeFact = (fact) =>
    `${[fact.schema].flat().join("/")}.${fact.property} ${["values", "required", "notNull", "absent"].filter((kind) => kind in fact).join(" ")}${fact.when ? ` when ${JSON.stringify(fact.when)}` : ""}`

/**
 * Generates the examples for one root schema: A minimal instance with only required fields, a full instance with every
 * optional field, one variant of each for every other branch of each union, and a full instance whose nullable fields
 * are all null. Minimal instances take lower bounds and first enum values, full instances upper bounds and last values.
 * Server facts narrow what the document allows to what Fluxer's server sends, wherever their schema appears
 * @param {any} spec
 * @param {Root} root
 * @param {readonly Fact[]} [facts]
 * @returns {Example[]}
 */
function schemaExamples(spec, root, facts = []) {
    const schemas = spec?.components?.schemas ?? {}
    /** @param {string} ref */
    const resolveRef = (ref) => {
        const name = ref.startsWith(schemaPrefix) ? ref.slice(schemaPrefix.length) : undefined
        if (name === undefined || !Object.hasOwn(schemas, name)) throw new Error(`Unresolvable schema reference ${ref}`)
        return /** @type {[string, any]} */ ([name, schemas[name]])
    }

    /**
     * Facts about one property of the object being built. A fact with `when` applies only within a root example
     * generated for one of the listed values of the root's `each` property
     * @param {Context} context
     * @param {Position} at
     * @param {string} key
     */
    const factsFor = (context, at, key) =>
        facts.filter(
            (fact) =>
                [fact.schema].flat().includes(at.owner) &&
                at.local === "" &&
                fact.property === key &&
                (fact.when === undefined ||
                    Object.entries(fact.when).every(
                        ([property, values]) =>
                            context.each?.property === property && values.includes(context.each.value),
                    )),
        )

    /** @param {any} schema */
    const nullable = (schema) => {
        const target = typeof schema?.$ref === "string" ? resolveRef(schema.$ref)[1] : schema
        return (
            (Array.isArray(target?.type) && target.type.includes("null")) ||
            (Array.isArray(target?.anyOf) && target.anyOf.some((/** @type {any} */ branch) => branch?.type === "null"))
        )
    }

    /**
     * Picks the union branch for a site, registering the site so other branches get their own variants
     * @param {Context} context
     * @param {string} site
     * @param {number[]} options
     * @param {(index: number) => string} describe
     */
    const choose = (context, site, options, describe) => {
        if (options.length < 2) return options[0]
        if (!context.sites.has(site)) context.sites.set(site, new Map(options.map((index) => [index, describe(index)])))
        const chosen = context.choices.get(site)
        return chosen !== undefined && options.includes(chosen) ? chosen : options[0]
    }

    /**
     * @param {any} schema
     * @param {Context} context
     * @param {Position} at
     * @param {boolean} [notNull] Keeps a value where the nulls variant would choose null
     * @returns {unknown}
     */
    const build = (schema, context, at, notNull = false) => {
        if (!isObject(schema)) throw new Error(`Unsupported schema at ${at.owner}${at.local}`)
        const unknown = Object.keys(schema).find((key) => !knownKeywords.has(key) && !key.startsWith("x-"))
        if (unknown !== undefined) throw new Error(`Unsupported schema keyword ${unknown} at ${at.owner}${at.local}`)
        if (context.each && at.stack.length === 1 && at.local === `.${context.each.property}`) return context.each.value
        if (typeof schema.$ref === "string") {
            const [name, target] = resolveRef(schema.$ref)
            if (at.stack.filter((item) => item === name).length >= maximumRepeats) return missing
            // A full instance spells out each named object schema once and repeats it minimally, bounding the fixture size
            const repeated = context.mode === "full" && target.type === "object" && context.expanded.has(name)
            context.expanded.add(name)
            const inner = repeated ? { ...context, mode: /** @type {const} */ ("minimal") } : context
            return build(target, inner, { owner: name, local: "", stack: [...at.stack, name], name: at.name }, notNull)
        }
        if (schema.const !== undefined) return schema.const
        if (Array.isArray(schema.enum)) return context.mode === "minimal" ? schema.enum[0] : schema.enum.at(-1)
        const union = schema.anyOf
        if (Array.isArray(union)) {
            const nullable = union.findIndex((branch) => branch?.type === "null")
            if (context.nulls && nullable >= 0 && !notNull) return null
            const options = union.map((_, index) => index).filter((index) => index !== nullable)
            const index = choose(context, `${at.owner}${at.local}`, options, (item) => label(union[item]))
            const { anyOf: _anyOf, ...siblings } = schema
            const value = build({ ...siblings, ...union[index] }, context, at)
            return value === missing && nullable >= 0 ? null : value
        }
        if (Array.isArray(schema.type)) {
            const nullable = schema.type.includes("null")
            if (context.nulls && nullable && !notNull) return null
            const types = schema.type.filter((/** @type {string} */ type) => type !== "null")
            if (types.length === 0) return null
            const index = choose(
                context,
                `${at.owner}${at.local}`,
                types.map((/** @type {string} */ _, /** @type {number} */ index) => index),
                (item) => types[item],
            )
            const value = build({ ...schema, type: types[index] }, context, at)
            return value === missing && nullable ? null : value
        }
        switch (schema.type) {
            case "object":
                return object(schema, context, at)
            case "array":
                return array(schema, context, at)
            case "string":
                return string(schema, context, at)
            case "integer":
                return context.mode === "minimal"
                    ? (schema.minimum ?? 0)
                    : (schema.maximum ?? (schema.minimum ?? 0) + 1)
            case "number":
                return context.mode === "minimal" ? (schema.minimum ?? 0) : (schema.maximum ?? 1.5)
            case "boolean":
                return context.mode === "full"
            case "null":
                return null
            default:
                throw new Error(`Unsupported schema at ${at.owner}${at.local}`)
        }
    }

    /**
     * @param {any} schema
     * @param {Context} context
     * @param {Position} at
     */
    const object = (schema, context, at) => {
        const required = new Set(schema.required ?? [])
        /** @type {Record<string, unknown>} */
        const value = {}
        for (const [key, property] of Object.entries(schema.properties ?? {})) {
            const known = factsFor(context, at, key)
            if (known.some((fact) => fact.absent)) continue
            const needed = required.has(key) || known.some((fact) => fact.required)
            if (context.mode === "minimal" && !needed) continue
            // The root's each property takes the value its examples are generated for, which build() supplies
            const fixed = at.stack.length === 1 && key === context.each?.property
            const values = fixed ? undefined : known.find((fact) => fact.values)?.values
            const notNull = known.some((fact) => fact.notNull)
            const position = { ...at, local: `${at.local}.${key}`, name: key }
            const item = !values
                ? build(property, context, position, notNull)
                : context.nulls && !notNull && nullable(property)
                  ? null
                  : context.mode === "minimal"
                    ? values[0]
                    : values.at(-1)
            if (item === missing) {
                if (needed) return missing
                continue
            }
            value[key] = item
        }
        for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`Required ${key} has no schema`)
        // Fluxer keys its maps by ID, such as nicknames by user ID, so a map entry gets an ID key
        if (context.mode === "full" && isObject(schema.additionalProperties)) {
            const { type = "string", pattern = snowflakePattern, description: _, ...other } = schema.propertyNames ?? {}
            if (type !== "string" || pattern !== snowflakePattern || Object.keys(other).length > 0)
                throw new Error(`Unsupported map keys at ${at.owner}${at.local}`)
            const key = snowflake(at.name)
            const item = build(schema.additionalProperties, context, { ...at, local: `${at.local}.*` })
            if (item !== missing) value[key] = item
        }
        return value
    }

    /**
     * @param {any} schema
     * @param {Context} context
     * @param {Position} at
     */
    const array = (schema, context, at) => {
        const minimum = schema.minItems ?? 0
        const count = Math.min(context.mode === "full" ? Math.max(1, minimum) : minimum, schema.maxItems ?? Infinity)
        const items = []
        for (let index = 0; index < count; index++) {
            const item = build(schema.items, context, { ...at, local: `${at.local}[]` })
            if (item === missing) return minimum === 0 ? [] : missing
            items.push(item)
        }
        return items
    }

    /**
     * @param {any} schema
     * @param {Context} context
     * @param {Position} at
     */
    const string = (schema, context, at) => {
        if (!stringFormats.has(schema.format)) throw new Error(`Unsupported string format at ${at.owner}${at.local}`)
        if (schema.format === "date-time") return timestamp
        if (schema.format === "snowflake" || schema.pattern === snowflakePattern) return snowflake(at.name)
        if (schema.pattern === decimalPattern || schema.format === "int64") {
            if (context.mode === "minimal") return "0"
            const flags = schema["x-bitflagValues"]
            return Array.isArray(flags)
                ? flags.reduce((total, flag) => total | BigInt(flag.value), 0n).toString()
                : snowflake(at.name)
        }
        if (schema.pattern !== undefined) throw new Error(`Unsupported pattern at ${at.owner}${at.local}`)
        if (schema.format === "uri") return `https://example.com/${at.name ?? "resource"}`
        if (namedId(at.name)) return snowflake(at.name)
        if (namedTime(at.name)) return timestamp
        const minimum = schema.minLength ?? 1
        const maximum = schema.maxLength ?? Infinity
        const text = at.name ?? "text"
        return text.padEnd(minimum, "x").slice(0, Math.max(minimum, Math.min(maximum, text.length)))
    }

    const [rootName, rootSchema] = resolveRef(`${schemaPrefix}${root.name}`)
    /** @param {Omit<Context, "sites" | "expanded">} context */
    const generate = (context) => {
        const full = { ...context, sites: new Map(), expanded: new Set([rootName]) }
        const value = build(rootSchema, full, { owner: rootName, local: "", stack: [rootName], name: undefined })
        if (value === missing) throw new Error(`${root.name} cannot be built within the recursion bound`)
        return { value, sites: full.sites }
    }
    const property = root.each === undefined ? undefined : rootSchema.properties?.[root.each]
    const narrowed = facts.find(
        (fact) => [fact.schema].flat().includes(root.name) && fact.property === root.each && fact.values && !fact.when,
    )
    const values =
        property === undefined
            ? [undefined]
            : (narrowed?.values ?? (typeof property.$ref === "string" ? resolveRef(property.$ref)[1] : property).enum)
    if (!Array.isArray(values)) throw new Error(`${root.name}.${root.each} is not an enum`)

    /** @type {Example[]} */
    const examples = []
    for (const value of values) {
        const prefix = root.each === undefined ? "" : `${root.each}=${JSON.stringify(value)} `
        const each = root.each === undefined ? undefined : { property: root.each, value }
        for (const mode of /** @type {const} */ (["minimal", "full"])) {
            const base = generate({ mode, nulls: false, choices: new Map(), each })
            examples.push({ name: `${prefix}${mode}`, value: base.value })
            // Variant k takes the k-th branch of every union that has one, so each branch appears in some example
            const sites = [...base.sites].map(([site, labels]) => ({ site, branches: [...labels] }))
            const variants = Math.max(0, ...sites.map(({ branches }) => branches.length - 1))
            for (let k = 1; k <= variants; k++) {
                const switched = sites.filter(({ branches }) => k < branches.length)
                const choices = new Map(switched.map(({ site, branches }) => [site, branches[k][0]]))
                const described = switched.map(({ site, branches }) => `${site || rootName} as ${branches[k][1]}`)
                const variant = generate({ mode, nulls: false, choices, each })
                examples.push({ name: `${prefix}${mode} with ${described.join(", ")}`, value: variant.value })
            }
        }
        examples.push({
            name: `${prefix}nulls`,
            value: generate({ mode: "full", nulls: true, choices: new Map(), each }).value,
        })
    }
    const seen = new Set()
    return examples.filter(({ value }) => {
        const key = JSON.stringify(value)
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

/**
 * For each server fact, the smallest example that only exists without it. The conformance test requires the SDK to
 * reject each probe, so a fact the SDK no longer needs fails there, and a fact that changes no example fails here
 * @param {any} spec
 * @param {readonly Fact[]} facts
 */
function factProbes(spec, facts) {
    const kept = new Set(
        decodedSchemas.flatMap((root) => schemaExamples(spec, root, facts).map(({ value }) => JSON.stringify(value))),
    )
    return facts.map((fact) => {
        const others = facts.filter((item) => item !== fact)
        const probes = decodedSchemas.flatMap((root) =>
            schemaExamples(spec, root, others)
                .map((example) => ({ schema: root.name, ...example, text: JSON.stringify(example.value) }))
                .filter(({ text }) => !kept.has(text)),
        )
        if (probes.length === 0) throw new Error(`The server fact ${describeFact(fact)} changes no example`)
        const { schema, name, value } = probes.reduce((smallest, probe) =>
            probe.text.length < smallest.text.length ? probe : smallest,
        )
        return { fact: describeFact(fact), schema, name, value }
    })
}

/**
 * Reads the OpenAPI document at the pinned commit, checks it against the pinned hash and writes the formatted fixture
 * @param {{ source?: import("../../release/upstream.js").Source, manifestFile?: string, factsFile?: string, fixtureFile?: string }} [options]
 */
export async function writeExamples({
    source = githubSource,
    manifestFile = manifestPath,
    factsFile = factsPath,
    fixtureFile = fixturePath,
} = {}) {
    const manifest = validateManifest(JSON.parse(await readFile(manifestFile, "utf8")))
    const factsText = await readFile(factsFile, "utf8")
    /** @type {Fact[]} */
    const facts = JSON.parse(factsText)
    const { path, sha256: pinned } = manifest.files.openapi
    const bytes = await source.fetchFile(manifest.repository, manifest.commit, path)
    if (sha256(bytes) !== pinned) throw new Error("The upstream OpenAPI document does not match the pinned hash")
    const spec = JSON.parse(bytes.toString("utf8"))
    const fixture = {
        source: { repository: manifest.repository, commit: manifest.commit, path, sha256: pinned },
        factsSha256: sha256(factsText),
        schemas: Object.fromEntries(decodedSchemas.map((root) => [root.name, schemaExamples(spec, root, facts)])),
        probes: factProbes(spec, facts),
    }
    const options = await resolveConfig(fixtureFile, { editorconfig: true })
    const text = await format(JSON.stringify(fixture), { ...options, filepath: fixtureFile })
    const size = Buffer.byteLength(text)
    if (size > maximumFixtureBytes)
        throw new Error(`The fixture would be ${size} bytes, above the ${maximumFixtureBytes} limit`)
    await writeFile(fixtureFile, text)
    return { file: fixtureFile, bytes: size, examples: Object.values(fixture.schemas).flat().length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    writeExamples().then(
        ({ file, bytes, examples }) => console.log(`Wrote ${examples} examples (${bytes} bytes) to ${file}`),
        (error) => {
            console.error(error instanceof Error ? error.message : "OpenAPI example generation failed")
            process.exitCode = 1
        },
    )
