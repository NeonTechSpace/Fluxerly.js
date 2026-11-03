// Extracts the SDK's public API and code catalogue from its emitted declarations into JSON under content/reference. It is generated,
// never committed, and a gap in the SDK's comments or exports fails it. Build the SDK first. scripts/docs/generate.mjs runs this
// DOCS_CONTENT writes it to another content folder
import { Application } from "typedoc"
import ts from "typescript"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const site = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const sdk = resolve(site, "../sdk")
const output = join(resolve(process.env.DOCS_CONTENT ?? join(site, "content")), "reference")

// Public entry points in landing and sidebar order. `old` is the segment the previous docs site used
const entryPoints = [
    { module: "index", key: "js-ts", old: "js-ts", title: "JavaScript & TypeScript", importPath: "@neontechspace/fluxerly" },
    { module: "effect", key: "effect", old: "Effect", title: "Effect API", importPath: "@neontechspace/fluxerly/effect" },
    { module: "testing", key: "testing", old: "testing", title: "Testing", importPath: "@neontechspace/fluxerly/testing" },
    { module: "effect-testing", key: "effect-testing", old: "Effect-testing", title: "Effect testing", importPath: "@neontechspace/fluxerly/effect/testing" },
]

// Effect modules whose types link to Effect's own reference
const effectModules = new Set(["Effect", "Layer", "Scope", "Stream", "Option", "Exit", "Cause", "Fiber", "Deferred", "Queue",
    "Schedule", "Logger", "LogLevel", "Redacted", "Clock"])
const effectReference = "https://effect.website/docs/v4/api/effect"

const Kind = {
    Module: 2, Variable: 32, Function: 64, Class: 128, Interface: 256, Constructor: 512, Property: 1024, Method: 2048,
    Accessor: 262144, TypeAlias: 2097152, Reference: 4194304,
}
const declarationKinds = { [Kind.Function]: "function", [Kind.Variable]: "variable", [Kind.Class]: "class", [Kind.Interface]: "interface", [Kind.TypeAlias]: "type" }

// TypeDoc's anchors: lowercased names without punctuation, so links into the previous site keep their targets
export const anchorOf = (name) => name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "")
const slugOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const fail = (heading, lines) => {
    throw new Error(`${heading}:\n  ${lines.join("\n  ")}`)
}

async function convert() {
    const files = entryPoints.map((entry) => join(sdk, "dist", `${entry.module}.d.ts`).replaceAll("\\", "/"))
    const missing = files.filter((file) => !existsSync(file))
    if (missing.length) fail("The SDK build is missing declarations. Build the SDK first", missing)
    const temporary = await mkdtemp(join(tmpdir(), "fluxerly-reference-"))
    const tsconfig = join(temporary, "tsconfig.json")
    await writeFile(tsconfig, JSON.stringify({
        compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, lib: ["ES2024", "DOM", "ESNext.Disposable"], noEmit: true },
        files,
    }))
    try {
        const app = await Application.bootstrap({
            entryPoints: files,
            tsconfig,
            excludeExternals: true,
            excludePrivate: true,
            excludeProtected: true,
            excludeInternal: true,
            disableSources: true,
            categorizeByGroup: false,
            defaultCategory: "Other",
            readme: "none",
            logLevel: "Warn",
            // Text such as "@here" in a summary reads as a block tag. It is repaired below, so it is not a warning
            blockTags: ["@remarks", "@example", "@category", "@defaultValue", "@returns", "@see", "@deprecated", "@here", "@everyone"],
            validation: { notExported: true, invalidLink: true, notDocumented: true },
        })
        const project = await app.convert()
        if (!project || app.logger.hasErrors()) throw new Error("TypeDoc could not convert the SDK declarations")
        const gaps = { undocumented: [], notExported: [], other: [] }
        // The generated REST route types name Fluxer's API schemas, which stay private to that file. Each route links
        // Fluxer's own documentation for them, so they are left out of the reference on purpose
        const routeSchema = /, defined in \S*\/(?:src\/rest-routes\.ts|dist\/rest-routes\.d\.ts), is referenced by /
        // The generated gateway payload types do the same: GatewayDispatchPayloads and GatewayPayloadObjects name private
        // payload and object types whose fields carry Fluxer's descriptions in editors, and each entry links Fluxer's docs
        const gatewaySchema = /, defined in \S*\/(?:src\/gateway-payloads\.ts|dist\/gateway-payloads\.d\.ts), is referenced by /
        app.logger.validationWarning = (message) => {
            if (message.endsWith(" does not have any documentation")) gaps.undocumented.push(message)
            else if (message.endsWith(" but not included in the documentation")) {
                if (!routeSchema.test(message) && !gatewaySchema.test(message)) gaps.notExported.push(message)
            }
            else gaps.other.push(message)
        }
        app.validate(project)
        const report = Object.entries(gaps).filter(([, list]) => list.length).flatMap(([kind, list]) => [`${kind} (${list.length}):`, ...list.map((line) => `  ${line}`)])
        if (report.length) fail("The SDK reference has source documentation gaps. Fix them in the SDK comments or exports", report)
        if (app.logger.hasErrors() || app.logger.hasWarnings()) throw new Error("TypeDoc reported warnings, see above")
        return app.serializer.projectToObject(project, sdk.replaceAll("\\", "/"))
    } finally {
        await rm(temporary, { recursive: true, force: true })
    }
}

const project = await convert()

// Index every reflection by ID, with its parent
const byId = new Map()
const parentOf = new Map()
const index = (node, parent) => {
    if (Array.isArray(node)) return node.forEach((child) => index(child, parent))
    if (!node || typeof node !== "object") return
    let next = parent
    if (typeof node.id === "number" && node.variant) {
        byId.set(node.id, node)
        if (parent) parentOf.set(node.id, parent)
        next = node
    }
    for (const [key, value] of Object.entries(node)) if (value && typeof value === "object" && key !== "symbolIdMap") index(value, next)
}
index(project.children, undefined)

const modules = entryPoints.map((entry) => {
    const module = project.children.find((child) => child.name === entry.module)
    if (!module) fail("Public SDK entry points were not found", [entry.module])
    return { ...entry, reflection: module }
})
const moduleOf = new Map()
for (const module of modules) for (const child of module.reflection.children) moduleOf.set(child.id, module)

// Categories: a re-export takes the category of the declaration it points to
const categoryOf = new Map()
for (const module of modules)
    for (const category of module.reflection.categories ?? [])
        if (category.title !== "Other") for (const id of category.children) categoryOf.set(id, category.title)
const resolveReference = (node) => {
    let target = node
    while (target?.variant === "reference") target = byId.get(target.target)
    return target
}
const titleOf = (child) => categoryOf.get(child.id) ?? (child.variant === "reference" ? categoryOf.get(resolveReference(child)?.id) : undefined)

// Classes and each entry point's Client interface get their own pages. Everything else lives on its category page
const ownsPage = (child) => child.variant === "declaration" && (child.kind === Kind.Class || (child.kind === Kind.Interface && child.name === "Client"))

// URLs for every reflection that can be linked
const urlOf = new Map()
const anchorFor = new Map()
const kindOrder = { [Kind.Function]: 0, [Kind.Variable]: 1, [Kind.Class]: 2, [Kind.Interface]: 3, [Kind.TypeAlias]: 4 }
const pageOrder = (a, b) => (a.variant === "reference") - (b.variant === "reference") || kindOrder[resolveReference(a).kind] - kindOrder[resolveReference(b).kind] || byName(a, b)
const plan = modules.map((module) => {
    const base = `/docs/api/${module.key}/`
    const categories = new Map()
    const uncategorized = []
    for (const child of module.reflection.children) {
        const title = titleOf(child)
        if (!title) {
            uncategorized.push(child)
            continue
        }
        if (!categories.has(title)) categories.set(title, [])
        categories.get(title).push(child)
    }
    const slugs = new Map()
    for (const title of categories.keys()) slugs.set(title, slugOf(title))
    for (const child of module.reflection.children.filter(ownsPage)) {
        const slug = anchorOf(child.name)
        if ([...slugs.values()].includes(slug)) fail("A page slug is used twice", [`${base}${slug}/`])
    }
    for (const [title, children] of categories) assignPage(children, `${base}${slugs.get(title)}/`, base)
    assignPage(uncategorized, base, base)
    return { module, base, categories, slugs, uncategorized }
})

// Pages list symbols by kind, then by name. Anchors follow that order, and a repeated anchor gets a number as TypeDoc's did,
// so fixtures and Fixtures on one page become fixtures and fixtures-1
function assignPage(children, page, base) {
    const used = new Set()
    for (const child of children.slice().sort(pageOrder)) {
        let anchor = anchorOf(child.name)
        for (let number = 1; used.has(anchor); number++) anchor = `${anchorOf(child.name)}-${number}`
        used.add(anchor)
        anchorFor.set(child.id, anchor)
        if (ownsPage(child)) assignUrls(child, `${base}${anchorOf(child.name)}/`, true)
        else assignUrls(child, page, false)
    }
}

function assignUrls(child, page, own) {
    if (child.variant === "reference") return
    const anchor = anchorFor.get(child.id)
    const url = own ? page : `${page}#${anchor}`
    urlOf.set(child.id, url)
    for (const member of membersOf(child)) {
        const memberUrl = own ? `${page}#${anchorOf(member.name)}` : `${page}#${anchor}-${anchorOf(member.name)}`
        urlOf.set(member.id, memberUrl)
        for (const signature of member.signatures ?? []) urlOf.set(signature.id, memberUrl)
    }
    for (const signature of child.signatures ?? []) urlOf.set(signature.id, url)
}

// Interfaces and classes list their children. Variables and type aliases list them when their type is an object literal,
// or Readonly of one
function membersOf(declaration) {
    // TypeDoc gives a type alias of an object literal the literal's children directly
    if (declaration.kind === Kind.Class || declaration.kind === Kind.Interface || declaration.children) return declaration.children ?? []
    const literal = objectLiteralOf(declaration.type)
    return literal ? literal.children : []
}

function objectLiteralOf(type) {
    const inner = type?.type === "reference" && type.name === "Readonly" && type.typeArguments?.length === 1 ? type.typeArguments[0] : type
    const literal = inner?.type === "reflection" ? inner.declaration : undefined
    return literal?.children?.length && !literal.signatures?.length ? literal : undefined
}

// Re-exports link to their home declaration
for (const module of modules)
    for (const child of module.reflection.children)
        if (child.variant === "reference") {
            const target = resolveReference(child)
            if (urlOf.has(target?.id)) urlOf.set(child.id, urlOf.get(target.id))
        }

// Comments to Markdown

const unresolved = []
const siteDocs = /https:\/\/fluxerly\.neontechspace\.com\/(docs\/)?([^\s)]*)/g

function partsToMarkdown(parts, where) {
    return (parts ?? []).map((part) => {
        if (part.kind === "code") return part.text
        if (part.kind === "text")
            return part.text
                .replaceAll("<", "&lt;")
                // Absolute links to this site become site paths
                .replace(siteDocs, (_, docs, path) => `/${docs ? "docs/" : ""}${path}`)
        if (part.kind === "inline-tag") {
            const url = typeof part.target === "number" ? urlOf.get(part.target) : undefined
            if (!url) {
                unresolved.push(`${where}: {${part.tag} ${part.text}}`)
                return part.text
            }
            const label = /^[\w.]+$/.test(part.text) ? `\`${part.text}\`` : part.text
            return `[${label}](${url})`
        }
        unresolved.push(`${where}: unsupported comment part ${part.kind}`)
        return ""
    }).join("").trim()
}

// Text such as "@everyone or @here" is parsed as block tags. Join it back to the text it interrupted
function repairComment(comment) {
    const sections = [{ tag: "summary", content: [...(comment.summary ?? [])] }]
    for (const block of comment.blockTags ?? []) {
        if (block.tag === "@here" || block.tag === "@everyone") {
            const last = sections.at(-1).content
            last.push({ kind: "text", text: ` ${block.tag} ` }, ...block.content)
        } else sections.push({ tag: block.tag, content: [...block.content] })
    }
    return sections
}

function docOf(comment, where) {
    if (!comment) return undefined
    const doc = {}
    for (const section of repairComment(comment)) {
        const markdown = partsToMarkdown(section.content, where).replace(/[ \t]+\n/g, "\n")
        if (!markdown && section.tag !== "@deprecated") continue
        if (section.tag === "summary") doc.summary = markdown
        else if (section.tag === "@remarks") doc.remarks = doc.remarks ? `${doc.remarks}\n\n${markdown}` : markdown
        else if (section.tag === "@example") (doc.examples ??= []).push(markdown)
        else if (section.tag === "@returns") doc.returns = markdown
        else if (section.tag === "@see") (doc.see ??= []).push(markdown)
        else if (section.tag === "@defaultValue") doc.defaultValue = markdown
        else if (section.tag === "@deprecated") doc.deprecated = markdown || "Deprecated"
        else if (section.tag !== "@category") unresolved.push(`${where}: unsupported block tag ${section.tag}`)
    }
    return Object.keys(doc).length ? doc : undefined
}

// The first sentence of a summary's first paragraph, even when source wrapping splits it across lines
export function firstSentence(markdown) {
    const paragraph = (markdown ?? "").split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim()
    const end = paragraph.search(/\.(?=\s+[A-Z])/)
    return (end < 0 ? paragraph : paragraph.slice(0, end)).replace(/\.$/, "")
}

// Types to a compact tree. Intrinsic and literal types are plain strings, a reference is { r: name, h?: url, a?: arguments }
// and every other node names its kind in k

function typeOf(type, where) {
    if (!type) return "unknown"
    switch (type.type) {
        case "intrinsic":
            return type.name
        case "reference": {
            const node = { r: type.name }
            if (typeof type.target === "number") {
                const url = urlOf.get(type.target)
                if (url) node.h = url
            } else if (type.target?.packageName === "effect") {
                const module = type.target.packagePath?.match(/([^/]+)\.ts$/)?.[1]
                if (effectModules.has(module)) node.h = `${effectReference}/${module}`
            } else if (type.externalUrl) node.h = type.externalUrl
            if (type.typeArguments?.length) node.a = type.typeArguments.map((argument) => typeOf(argument, where))
            return node
        }
        case "literal":
            return literalText(type.value)
        case "union":
            return { k: "union", t: type.types.map((member) => typeOf(member, where)) }
        case "intersection":
            return { k: "and", t: type.types.map((member) => typeOf(member, where)) }
        case "array":
            return { k: "arr", t: typeOf(type.elementType, where) }
        case "tuple":
            return { k: "tuple", t: (type.elements ?? []).map((element) => typeOf(element, where)) }
        case "namedTupleMember":
            return { k: "named", n: type.name, ...(type.isOptional ? { o: 1 } : {}), t: typeOf(type.element, where) }
        case "optional":
            return { k: "optional", t: typeOf(type.elementType, where) }
        case "rest":
            return { k: "rest", t: typeOf(type.elementType, where) }
        case "typeOperator":
            return { k: "op", op: type.operator, t: typeOf(type.target, where) }
        case "indexedAccess":
            return { k: "idx", o: typeOf(type.objectType, where), i: typeOf(type.indexType, where) }
        case "query":
            return { k: "query", t: typeOf(type.queryType, where) }
        case "conditional":
            return { k: "cond", c: typeOf(type.checkType, where), e: typeOf(type.extendsType, where), y: typeOf(type.trueType, where), f: typeOf(type.falseType, where) }
        case "mapped":
            return {
                k: "mapped", p: type.parameter, c: typeOf(type.parameterType, where), t: typeOf(type.templateType, where),
                ...(type.readonlyModifier ? { ro: type.readonlyModifier } : {}), ...(type.optionalModifier ? { opt: type.optionalModifier } : {}),
                ...(type.nameType ? { as: typeOf(type.nameType, where) } : {}),
            }
        case "inferred":
            return { k: "infer", n: type.name, ...(type.constraint ? { c: typeOf(type.constraint, where) } : {}) }
        case "predicate":
            return { k: "pred", n: type.name, ...(type.asserts ? { as: 1 } : {}), ...(type.targetType ? { t: typeOf(type.targetType, where) } : {}) }
        case "templateLiteral":
            return { k: "tpl", h: type.head, tail: type.tail.map(([inner, text]) => [typeOf(inner, where), text]) }
        case "reflection":
            return objectOf(type.declaration, where)
        case "unknown":
            return { k: "raw", s: type.name }
        default:
            unresolved.push(`${where}: unsupported type ${type.type}`)
            return { k: "raw", s: String(type.name ?? type.type) }
    }
}

const literalText = (value) =>
    value === null ? "null" : typeof value === "object" && value && "value" in value ? `${value.negative ? "-" : ""}${value.value}n` : JSON.stringify(value)

function objectOf(declaration, where) {
    const node = { k: "obj" }
    if (declaration.children?.length) node.m = declaration.children.map((child) => memberOf(child, `${where}.${child.name}`, undefined))
    if (declaration.signatures?.length) node.s = declaration.signatures.map((signature) => signatureOf(signature, where))
    if (declaration.indexSignatures?.length)
        node.x = declaration.indexSignatures.map((signature) => ({
            n: signature.parameters?.[0]?.name ?? "key",
            kt: typeOf(signature.parameters?.[0]?.type, where),
            t: typeOf(signature.type, where),
            ...(signature.flags?.isReadonly ? { r: 1 } : {}),
        }))
    return node
}

function signatureOf(signature, where, fallbackComment) {
    const node = {}
    if (signature.typeParameters?.length) node.tp = signature.typeParameters.map((parameter) => typeParameterOf(parameter, where))
    node.p = (signature.parameters ?? []).map((parameter) => {
        const item = { n: parameter.name, t: typeOf(parameter.type, where) }
        if (parameter.flags?.isOptional) item.o = 1
        if (parameter.flags?.isRest) item.r = 1
        if (parameter.defaultValue && parameter.defaultValue !== "...") item.dv = parameter.defaultValue
        const summary = parameter.comment ? partsToMarkdown(parameter.comment.summary, `${where}(${parameter.name})`) : ""
        if (summary) item.d = summary
        return item
    })
    node.r = typeOf(signature.type, where)
    const doc = docOf(signature.comment ?? fallbackComment, where)
    if (doc) node.doc = doc
    return node
}

const typeParameterOf = (parameter, where) => ({
    n: parameter.name,
    ...(parameter.type ? { c: typeOf(parameter.type, where) } : {}),
    ...(parameter.default ? { d: typeOf(parameter.default, where) } : {}),
})

function memberOf(member, where, ownerAnchor) {
    const node = {
        kind: member.kind === Kind.Constructor ? "constructor" : member.kind === Kind.Method ? "method" : member.kind === Kind.Accessor ? "accessor" : "property",
        name: member.name,
    }
    if (ownerAnchor !== undefined) node.anchor = ownerAnchor ? `${ownerAnchor}-${anchorOf(member.name)}` : anchorOf(member.name)
    const flags = member.flags ?? {}
    if (flags.isOptional) node.optional = true
    if (flags.isReadonly) node.readonly = true
    if (flags.isStatic) node.static = true
    if (flags.isAbstract) node.abstract = true
    if (member.signatures?.length) node.signatures = member.signatures.map((signature) => signatureOf(signature, where, member.comment))
    else if (member.getSignature) {
        node.kind = "accessor"
        node.type = typeOf(member.getSignature.type, where)
        if (!member.setSignature) node.readonly = true
    } else node.type = typeOf(member.type, where)
    const doc = docOf(member.comment ?? member.getSignature?.comment, where)
    if (doc) node.doc = doc
    return node
}

// Declarations

function declarationOf(child, module) {
    if (child.variant === "reference") {
        const target = resolveReference(child)
        const home = moduleOf.get(target?.id)
        const url = urlOf.get(child.id)
        if (!target || !url || !home) fail("A re-export has no public target", [`${module.key}.${child.name}`])
        const summary = firstSentence(summaryOf(target))
        return { kind: "reexport", name: child.name, anchor: anchorFor.get(child.id), url, home: home.key, of: declarationKinds[target.kind], ...(summary ? { summary } : {}) }
    }
    const kind = declarationKinds[child.kind]
    if (!kind) fail("Unsupported declaration kind", [`${module.key}.${child.name} (${child.kind})`])
    const where = `${module.key}.${child.name}`
    const node = { kind, name: child.name, anchor: anchorFor.get(child.id), url: urlOf.get(child.id) }
    if (ownsPage(child)) node.page = true
    const doc = docOf(child.comment, where)
    if (doc) node.doc = doc
    if (child.typeParameters?.length) node.tp = child.typeParameters.map((parameter) => typeParameterOf(parameter, where))
    if (child.signatures?.length) node.signatures = child.signatures.map((signature) => signatureOf(signature, where, child.comment))
    // Unexported SDK bases are implementation details, and their members are listed as this declaration's own
    const visible = (types) => (types ?? []).filter((type) => !(type.type === "reference" && typeof type.target === "object" && type.package === "@neontechspace/fluxerly"))
    if (visible(child.extendedTypes).length) node.extends = visible(child.extendedTypes).map((type) => typeOf(type, where))
    if (visible(child.implementedTypes).length) node.implements = visible(child.implementedTypes).map((type) => typeOf(type, where))
    if (child.flags?.isConst) node.const = true
    const members = membersOf(child)
    const ownerAnchor = node.page ? "" : node.anchor
    if (members.length) {
        // Members inherited from an unexported base, such as a mixin, are documented here as this declaration's own
        const fromPublicBase = (member) => typeof member.inheritedFrom?.target === "number" && urlOf.has(member.inheritedFrom.target)
        node.members = members.filter((member) => !fromPublicBase(member)).map((member) => memberOf(member, `${where}.${member.name}`, ownerAnchor))
        const inherited = inheritedOf(members.filter(fromPublicBase), ownerAnchor, where, child)
        if (inherited.length) node.inherited = inherited
        const seen = new Set()
        for (const anchor of [...node.members.map((member) => member.anchor), ...inherited.flatMap((group) => group.m.map((member) => member.a))]) {
            if (seen.has(anchor)) fail("Two members share an anchor", [`${where}#${anchor}`])
            seen.add(anchor)
        }
        // An object literal's members are listed, so its type keeps only the index signatures
        if (child.kind === Kind.Variable || child.kind === Kind.TypeAlias) {
            const literal = objectOf({ indexSignatures: (objectLiteralOf(child.type) ?? child).indexSignatures }, where)
            node.type = child.type?.type === "reference" ? { r: "Readonly", a: [literal] } : literal
        }
    } else if (child.type) node.type = typeOf(child.type, where)
    return node
}

// Inherited members are listed once per base, each linking to the base's documentation. TypeDoc can point an inherited
// member at the same member of an unrelated class that inherits it too, such as hint at UnhandledTestFailuresError on
// every error. A base that is not an ancestor gives way to the nearest public ancestor that has the member
function inheritedOf(members, ownerAnchor, where, declaration) {
    const ancestors = ancestorsOf(declaration)
    const groups = new Map()
    for (const member of members) {
        let target = member.inheritedFrom.target
        let owner = typeof target === "number" ? parentOf.get(target) : undefined
        if (owner && ancestors.length && !ancestors.some((ancestor) => ancestor.id === owner.id)) {
            const base = ancestors.find((ancestor) => urlOf.has(ancestor.id) && membersOf(ancestor).some((candidate) => candidate.name === member.name))
            if (base) {
                owner = base
                target = membersOf(base).find((candidate) => candidate.name === member.name).id
            }
        }
        const url = typeof target === "number" ? urlOf.get(target) : undefined
        if (!owner || !url) fail("An inherited member has no public base", [`${where}.${member.name}`])
        if (!groups.has(owner.id)) groups.set(owner.id, { from: owner.name, ...(urlOf.has(owner.id) ? { h: urlOf.get(owner.id) } : {}), m: [] })
        groups.get(owner.id).m.push({ n: member.name, a: ownerAnchor ? `${ownerAnchor}-${anchorOf(member.name)}` : anchorOf(member.name), h: url })
    }
    return [...groups.values()]
}

// The classes and interfaces a declaration extends, nearest first, including those inside a type argument, as in
// Omit<ClientOptions, "cache">
function ancestorsOf(declaration, seen = new Set()) {
    const found = []
    const walk = (type) => {
        if (!type || typeof type !== "object") return
        if (type.type === "reference") {
            const base = typeof type.target === "number" ? resolveReference(byId.get(type.target)) : undefined
            if (base && !seen.has(base.id)) {
                seen.add(base.id)
                found.push(base, ...ancestorsOf(base, seen))
            }
            for (const argument of type.typeArguments ?? []) walk(argument)
        }
        for (const inner of type.types ?? []) walk(inner)
    }
    for (const type of declaration.extendedTypes ?? []) walk(type)
    return found
}

const summaryOf = (reflection) =>
    partsToMarkdown(reflection?.comment?.summary ?? reflection?.signatures?.[0]?.comment?.summary, reflection?.name ?? "?")

// How often each declaration is referenced by the others' types. Category cards lead with the most referenced names
const referenceCount = new Map()
const countReferences = (node) => {
    if (Array.isArray(node)) return node.forEach(countReferences)
    if (!node || typeof node !== "object") return
    if (node.type === "reference" && typeof node.target === "number") referenceCount.set(node.target, (referenceCount.get(node.target) ?? 0) + 1)
    for (const [key, value] of Object.entries(node)) if (value && typeof value === "object" && key !== "symbolIdMap") countReferences(value)
}
countReferences(project.children)
const kindRank = { function: 0, class: 1, interface: 2, variable: 3, type: 4 }
function topNames(children) {
    return children
        .map((child) => {
            const target = resolveReference(child)
            return { name: child.name, rank: kindRank[declarationKinds[target.kind]] ?? 5, count: referenceCount.get(target.id) ?? 0 }
        })
        // Functions and classes lead, then the most referenced names
        .sort((a, b) => Math.min(a.rank, 2) - Math.min(b.rank, 2) || b.count - a.count || byName(a, b))
        .slice(0, 6)
        .map((item) => item.name)
}

// The task index: each client's namespaces and the first sentence of each method's summary
function tasksOf(module) {
    const client = module.reflection.children.find((child) => child.name === "Client" && child.kind === Kind.Interface && child.variant === "declaration")
    if (!client) return undefined
    const rows = (owner, prefix) => (owner.children ?? [])
        .filter((child) => child.kind === Kind.Method && child.signatures?.length)
        .flatMap((method) => {
            const task = firstSentence(partsToMarkdown((method.signatures[0].comment ?? method.comment)?.summary, `${prefix}.${method.name}`))
            return task ? [{ task, method: `${prefix}.${method.name}`, url: urlOf.get(method.id) }] : []
        })
    const groups = [{ name: "client", url: urlOf.get(client.id), rows: rows(client, "client") }]
    for (const property of client.children ?? []) {
        const target = property.type?.type === "reference" && typeof property.type.target === "number" ? resolveReference(byId.get(property.type.target)) : undefined
        if (target?.kind === Kind.Interface) groups.push({ name: `client.${property.name}`, url: urlOf.get(property.id), rows: rows(target, `client.${property.name}`) })
    }
    return groups.filter((group) => group.rows.length)
}

function moduleDoc(module) {
    return docOf(module.reflection.comment, module.key) ?? {}
}

const model = {
    entries: plan.map(({ module, base, categories, slugs, uncategorized }) => {
        const titles = [...categories.keys()].sort()
        const entry = {
            key: module.key,
            title: module.title,
            importPath: module.importPath,
            url: base,
            doc: moduleDoc(module),
            categories: titles.map((title) => {
                const children = categories.get(title).slice().sort(pageOrder)
                return {
                    title,
                    slug: slugs.get(title),
                    url: `${base}${slugs.get(title)}/`,
                    top: topNames(children),
                    items: children.map((child) => declarationOf(child, module)),
                }
            }),
            uncategorized: uncategorized.slice().sort(pageOrder).map((child) => declarationOf(child, module)),
        }
        const tasks = tasksOf(module)
        if (tasks) entry.tasks = tasks
        return entry
    }),
}

// Links from the previous docs site's reference paths

function legacyLinks() {
    const links = { api: "/docs/api/", "api/tasks": "/docs/api/tasks/", "error-and-log-codes": "/docs/codes/" }
    for (const { module, base, categories, slugs, uncategorized } of plan) {
        const modulePath = `api/modules/${module.old}`
        links[modulePath] = base
        for (const [title, children] of categories) {
            links[`${modulePath}#category-${slugs.get(title)}`] = `${base}${slugs.get(title)}/`
            for (const child of children) addLegacy(links, module, modulePath, child)
        }
        for (const child of uncategorized) addLegacy(links, module, modulePath, child)
    }
    return Object.fromEntries(Object.entries(links).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function addLegacy(links, module, modulePath, child) {
    // Re-exports, functions, variables and type aliases were sections of the module page. A re-export goes to its home
    if (child.variant === "reference" || (child.kind !== Kind.Class && child.kind !== Kind.Interface)) {
        const anchor = anchorFor.get(child.id)
        links[`${modulePath}#${anchor}`] = urlOf.get(child.id)
        // Members of an inline object type were anchored by the owner and member names run together
        for (const member of membersOf(child)) links[`${modulePath}#${anchor}${anchorOf(member.name)}`] ??= urlOf.get(member.id)
        return
    }
    const path = `api/${child.kind === Kind.Class ? "classes" : "interfaces"}/${module.old}.${child.name}`
    links[path] = urlOf.get(child.id)
    // A type parameter with a member's name took the plain anchor there, so the member's had a number
    const typeParameters = new Set((child.typeParameters ?? []).map((parameter) => anchorOf(parameter.name)))
    for (const member of membersOf(child)) {
        const anchor = anchorOf(member.name)
        links[`${path}#${anchor}`] = urlOf.get(member.id)
        if (typeParameters.has(anchor)) links[`${path}#${anchor}-1`] = urlOf.get(member.id)
    }
}

// Error and log codes

async function codes() {
    const source = await readFile(join(sdk, "src/internal/code-catalogue.ts"), "utf8")
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    const temporary = await mkdtemp(join(tmpdir(), "fluxerly-codes-"))
    const file = join(temporary, "code-catalogue.mjs")
    try {
        await writeFile(file, outputText)
        const { errorCodes, logCodes, operationReasonMeanings } = await import(pathToFileURL(file).href)
        if (!errorCodes || !logCodes || !operationReasonMeanings) throw new Error("The SDK code catalogue no longer exports errorCodes, logCodes and operationReasonMeanings")
        const sorted = (record) => Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        return {
            errors: sorted(errorCodes).map(([code, entry]) => ({
                code,
                error: entry.error,
                ...(errorUrl(entry.error) ? { url: errorUrl(entry.error) } : {}),
                meaning: entry.meaning,
                ...(entry.action ? { action: entry.action } : {}),
                ...(entry.values ? { values: [...entry.values] } : {}),
            })),
            reasons: Object.entries(operationReasonMeanings).map(([reason, meaning]) => ({ reason, meaning })),
            logs: sorted(logCodes).map(([code, entry]) => ({ code, levels: [...entry.levels], meaning: entry.meaning, ...(entry.action ? { action: entry.action } : {}) })),
        }
    } finally {
        await rm(temporary, { recursive: true, force: true })
    }
}

function errorUrl(name) {
    for (const module of modules) {
        const child = module.reflection.children.find((candidate) => candidate.name === name && candidate.variant === "declaration")
        if (child) return urlOf.get(child.id)
    }
    unresolved.push(`codes: error class ${name} is not in the reference`)
    return undefined
}

const codeCatalogue = await codes()

if (unresolved.length) fail("Unresolved references in SDK comments", [...new Set(unresolved)])

for (const name of ["createClient", "Message", "runBot"])
    if (![...byId.values()].some((reflection) => reflection.name === name)) fail("Missing public reference", [name])
for (const name of ["RestRuntime", "RestOwner", "superviseShards", "routeDispatch"])
    if ([...byId.values()].some((reflection) => reflection.name === name)) fail("An internal declaration escaped into the reference", [name])

await mkdir(output, { recursive: true })
const json = (value) => JSON.stringify(value) + "\n"
await writeFile(join(output, "model.json"), json(model))
await writeFile(join(output, "codes.json"), JSON.stringify(codeCatalogue, null, 1) + "\n")
await writeFile(join(output, "links.json"), JSON.stringify(legacyLinks(), null, 1) + "\n")

const size = (Buffer.byteLength(json(model)) / 1024).toFixed(0)
const counts = model.entries.map((entry) => `${entry.key} ${entry.categories.reduce((sum, category) => sum + category.items.length, 0) + entry.uncategorized.length}`)
console.log(`Reference extracted: ${counts.join(", ")} symbols, model.json ${size} KB`)
