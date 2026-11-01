// Builds the endpoint map: each Fluxer HTTP route a bot can use, the Fluxerly method that sends it, and the section of
// Fluxer's own documentation that describes it. Writes content/reference/endpoints.json, which the build reads, so the
// build never needs the SDK repository or the network.
// Run with `pnpm docs:endpoints` after `pnpm docs:extract`, so the map links only methods the reference documents.
// FLUXERLY_SDK overrides the SDK path, FLUXERLY_REPOSITORY the repository around it
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const site = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const docsOrigin = "https://docs.fluxer.app"
const docsIndex = `${docsOrigin}/http-api/`
const methodOrder = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const httpMethods = ["get", "put", "post", "patch", "delete", "options", "head", "trace"]

// Security schemes a bot or OAuth2 application can hold, as the SDK's upstream drift check counts them in
// projects/release/upstream.js. An operation without a requirement needs no token. Every other operation needs a user
// session or the admin API key and is left out
const applicationSchemes = new Set(["botToken", "oauth2Token", "bearerToken"])

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** A route's key for matching: the method and the path with each parameter written as {} */
export const routeKey = (method, path) => `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{}")}`

/** Every operation of an OpenAPI document with the security schemes that can authorize it */
export function specOperations(spec) {
    const operations = []
    for (const [path, item] of Object.entries(spec?.paths ?? {}))
        for (const method of httpMethods) {
            const operation = item?.[method]
            if (!operation) continue
            const security = operation.security ?? spec.security ?? []
            const tokens = [...new Set(security.flatMap((requirement) => Object.keys(requirement)))].sort(compare)
            operations.push({
                method: method.toUpperCase(),
                path,
                key: routeKey(method, path),
                summary: String(operation.summary ?? "").trim(),
                tags: operation.tags ?? [],
                tokens,
            })
        }
    return operations
}

/**
 * The operations a bot or OAuth2 application can call, by the same rule as the SDK's drift check, and how many are left
 * out because they need a user session or the admin API key
 */
export function botSurface(operations) {
    const kept = []
    const leftOut = { userSession: 0, admin: 0 }
    for (const operation of operations) {
        if (operation.tokens.length === 0 || operation.tokens.some((token) => applicationSchemes.has(token))) kept.push(operation)
        else if (operation.tokens.includes("adminApiKey")) leftOut.admin++
        else leftOut.userSession++
    }
    const keys = new Set()
    for (const operation of kept) {
        if (keys.has(operation.key)) throw new Error(`Two kept routes share the key ${operation.key}`)
        keys.add(operation.key)
    }
    return { kept, leftOut }
}

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#123": "{", "#125": "}", nbsp: " " }
const text = (html) =>
    html
        .replace(/<[^>]*>/g, "")
        .replace(/&(#?\w+);/g, (match, name) => entities[name] ?? (name.startsWith("#x") ? String.fromCodePoint(parseInt(name.slice(2), 16)) : name.startsWith("#") ? String.fromCodePoint(Number(name.slice(1))) : match))
        .replace(/\s+/g, " ")
        .trim()

/** The HTTP API pages linked from the documentation's index, in the order its sidebar lists them */
export function docsPages(html) {
    return [...new Set([...html.matchAll(/href="(\/http-api\/[^"#?]*)"/g)].map((match) => match[1]))].filter((path) => path !== "/http-api/")
}

/** A documentation page's title, its first heading */
export const pageTitle = (html) => text(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "")

/**
 * The endpoint sections of one documentation page: each level two heading followed by route lines, which give the
 * method and the path under /v1. Matched by method and path, never by title
 */
export function docsSections(html) {
    const sections = []
    const parts = html.split(/<h2 id="/)
    for (const part of parts.slice(1)) {
        const anchor = part.slice(0, part.indexOf('"'))
        for (const line of part.matchAll(/<flx-route-line>([\s\S]*?)<\/flx-route-line>/g)) {
            const method = /data-method="([A-Z]+)"/.exec(line[1])?.[1]
            const path = text(/<code class="route-path">([\s\S]*?)<\/code>/.exec(line[1])?.[1] ?? "").replace(/^\/v1(?=\/)/, "")
            if (method && path.startsWith("/")) sections.push({ key: routeKey(method, path), anchor })
        }
    }
    return sections
}

/**
 * Which operations to show beside a route. An operation that sends only this route shows. One that also reads other
 * routes before its single write, such as a direct message close that checks the channel first, shows beside the
 * write. Any other operation that sends several routes shows only beside a route nothing else covers
 */
export function routeCallers(operations) {
    const byRoute = new Map()
    const add = (route, name, shown) => {
        if (!byRoute.has(route)) byRoute.set(route, { shown: new Set(), others: new Set() })
        byRoute.get(route)[shown ? "shown" : "others"].add(name)
    }
    for (const { name, routes } of operations) {
        const writes = routes.filter((route) => !route.startsWith("GET "))
        for (const route of routes) {
            const direct = routes.length === 1 || (writes.length === 1 && writes[0] === route)
            add(route, name, direct)
        }
    }
    const callers = new Map()
    for (const [route, { shown, others }] of byRoute) callers.set(route, [...(shown.size ? shown : others)].sort(compare))
    return callers
}

/**
 * What a reader can use when no Fluxerly method sends a route. client.rest.request sends routes that accept a bot
 * token, except token webhook routes, which it refuses because their path carries a credential
 */
export function fallbackOf(operation) {
    const segments = operation.path.split("/").filter(Boolean)
    if (segments[0] === "webhooks" && segments.length > 2) return "webhookToken"
    if (operation.tokens.includes("botToken")) return "rest"
    if (operation.tokens.length === 0) return "noToken"
    return "oauth2"
}

/** Every SDK reference URL by dotted member path, such as Client.messages.send or WebhookClient.send */
export function referenceResolver(model, key = "js-ts") {
    const entry = model.entries.find((candidate) => candidate.key === key)
    if (!entry) throw new Error(`The reference model has no ${key} entry`)
    const declarations = new Map()
    for (const item of [...entry.categories.flatMap((category) => category.items), ...entry.uncategorized])
        if (item.kind !== "reexport" && !declarations.has(item.name)) declarations.set(item.name, item)
    return (path) => {
        const [first, ...rest] = path.split(".")
        let declaration = declarations.get(first)
        for (const [index, name] of rest.entries()) {
            const member = declaration?.members?.find((candidate) => candidate.name === name)
            if (!member) return undefined
            if (index === rest.length - 1) return `${declaration.url.split("#")[0]}#${member.anchor}`
            declaration = typeof member.type === "object" && member.type?.r ? declarations.get(member.type.r) : undefined
        }
        return declaration?.url
    }
}

// The reference path of an operation name: client.messages.send is a member of the Client interface
const referencePath = (name) => name.replace(/^client\./, "Client.")

const slugOf = (title) =>
    title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")

/** Route rows grouped by documentation page, with the operations that send each route */
export function endpointMap({ kept, docs, operations, reference }) {
    // Every client reads the instance discovery document before its first request. Only instance.resolve exists to read it
    const discovery = routeKey("GET", "/.well-known/fluxer")
    const sending = operations
        .map((operation) => ({ ...operation, routes: operation.name.endsWith(".instance.resolve") ? operation.routes : operation.routes.filter((route) => route !== discovery) }))
        .filter((operation) => operation.routes.length)
    const callers = routeCallers(sending)
    const unknownRoutes = [...callers.keys()].filter((route) => !kept.some((operation) => operation.key === route)).sort(compare)

    const areas = new Map()
    const missingDocs = []
    for (const operation of kept) {
        const section = docs.sections.get(operation.key)
        if (!section) missingDocs.push(operation.key)
        const page = section?.page ?? "other"
        if (!areas.has(page)) areas.set(page, [])
        const methods = (callers.get(operation.key) ?? []).map((name) => {
            const url = reference(referencePath(name))
            if (!url) throw new Error(`The reference model has no page for ${name}`)
            return { name, url }
        })
        areas.get(page).push({
            method: operation.method,
            path: operation.path,
            summary: operation.summary,
            docs: section ? `${docsOrigin}${page}#${section.anchor}` : null,
            methods,
            ...(methods.length ? {} : { fallback: fallbackOf(operation) }),
        })
    }
    const order = (page) => {
        const index = docs.pages.indexOf(page)
        return index < 0 ? docs.pages.length : index
    }
    const rest = reference("Client.rest.request")
    if (!rest) throw new Error("The reference model has no page for client.rest.request")
    const groups = [...areas]
        .sort(([a], [b]) => order(a) - order(b) || compare(a, b))
        .map(([page, routes]) => {
            const title = docs.titles.get(page) ?? "Other"
            return {
                title,
                slug: slugOf(title),
                url: page === "other" ? null : `${docsOrigin}${page}`,
                routes: routes.sort((a, b) => compare(a.path, b.path) || methodOrder.indexOf(a.method) - methodOrder.indexOf(b.method)),
            }
        })
    const rows = groups.flatMap((group) => group.routes)
    return {
        map: {
            rest: { name: "client.rest.request", url: rest },
            counts: {
                routes: rows.length,
                withMethod: rows.filter((row) => row.methods.length).length,
                rest: rows.filter((row) => row.fallback === "rest").length,
                noToken: rows.filter((row) => row.fallback === "noToken").length,
                oauth2: rows.filter((row) => row.fallback === "oauth2").length,
                webhookToken: rows.filter((row) => row.fallback === "webhookToken").length,
            },
            areas: groups,
        },
        missingDocs,
        unknownRoutes,
    }
}

// Network and files

// A dropped connection, a server error or a rate limit is tried again, so a blip can't fail a check or a release. A real answer such as 404 isn't
export async function download(url, attempt = 1, sleep = (ms) => new Promise((done) => setTimeout(done, ms))) {
    let wait = attempt * 2000
    try {
        const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) })
        if (response.ok) return Buffer.from(await response.arrayBuffer())
        if (response.status !== 429 && response.status < 500) throw Object.assign(new Error(`${url} answered HTTP ${response.status}`), { final: true })
        const asked = Number(response.headers.get("retry-after"))
        if (asked > 0) wait = Math.min(asked, 120) * 1000
        throw new Error(`${url} answered HTTP ${response.status}`)
    } catch (error) {
        if (error.final || attempt >= 6) throw error
        console.warn(`Retrying ${url} in ${Math.round(wait / 1000)} s: ${error.message}`)
        await sleep(wait)
        return download(url, attempt + 1, sleep)
    }
}

async function readDocs() {
    const index = (await download(docsIndex)).toString("utf8")
    const pages = docsPages(index)
    if (pages.length < 10) throw new Error(`The Fluxer docs index lists only ${pages.length} HTTP API pages`)
    const sections = new Map()
    const titles = new Map()
    // One page at a time, once each
    for (const page of pages) {
        const html = (await download(`${docsOrigin}${page}`)).toString("utf8")
        titles.set(page, pageTitle(html))
        for (const section of docsSections(html)) {
            if (sections.has(section.key)) throw new Error(`Two Fluxer docs sections describe ${section.key}`)
            sections.set(section.key, { page, anchor: section.anchor })
        }
    }
    return { pages, sections, titles }
}

function git(directory, ...args) {
    try {
        return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
    } catch {
        return undefined
    }
}

async function main() {
    const referenceDir = join(resolve(process.env.DOCS_CONTENT ?? join(site, "content")), "reference")
    const sdk = resolve(site, "../sdk")
    const repository = resolve(sdk, "../..")
    const manifest = JSON.parse(await readFile(join(repository, "projects/release/upstream/manifest.json"), "utf8"))
    const pin = manifest.files?.openapi
    if (!/^[\w.-]+\/[\w.-]+$/.test(manifest.repository ?? "") || !/^[a-f0-9]{40}$/.test(manifest.commit ?? "") || !pin?.path || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? ""))
        throw new Error("The SDK's upstream manifest does not pin a Fluxer commit and OpenAPI document")

    const bytes = await download(`https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/${pin.path}`)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    if (sha256 !== pin.sha256) throw new Error(`The OpenAPI document at ${manifest.commit} hashes to ${sha256}, not the pinned ${pin.sha256}`)
    const { kept, leftOut } = botSurface(specOperations(JSON.parse(bytes.toString("utf8"))))

    const docs = await readDocs()
    const { sdkOperations } = await import("./sdk-routes.mjs")
    const model = JSON.parse(await readFile(join(referenceDir, "model.json"), "utf8"))
    const reference = referenceResolver(model)
    const effect = referenceResolver(model, "effect")
    // The map links methods the site's reference documents. A method the SDK source has gained since the reference was
    // extracted waits for the next extraction
    const found = sdkOperations(sdk).filter((operation) => !operation.name.includes("[") && operation.routes.length + operation.unresolved.length)
    const operations = found.filter((operation) => reference(referencePath(operation.name)))
    const unreferenced = found.filter((operation) => !reference(referencePath(operation.name))).map((operation) => operation.name)
    if (unreferenced.length) console.warn(`Not in the reference yet, run pnpm docs:extract to include them (${unreferenced.length}):\n  ${unreferenced.join("\n  ")}`)

    // The client operation table, the webhook client and the OAuth2 client serve both APIs, so the Effect reference
    // documents the same names. A name it lacks would need its own column
    const effectGaps = operations.filter((operation) => operation.routes.length && !effect(referencePath(operation.name))).map((operation) => operation.name)
    if (effectGaps.length) throw new Error(`The Effect reference lacks ${effectGaps.join(", ")}`)

    const escapeHatch = "client.rest.request"
    const mapped = operations.filter((operation) => operation.name !== escapeHatch)
    const { map, missingDocs, unknownRoutes } = endpointMap({ kept, docs, operations: mapped, reference })
    if (missingDocs.length) console.warn(`Routes without a Fluxer docs section (${missingDocs.length}):\n  ${missingDocs.join("\n  ")}`)
    if (unknownRoutes.length) throw new Error(`The SDK sends routes the pinned OpenAPI document does not list for bots:\n  ${unknownRoutes.join("\n  ")}`)

    const packageJson = JSON.parse(await readFile(join(sdk, "package.json"), "utf8"))
    const output = {
        source: {
            fluxer: { repository: manifest.repository, commit: manifest.commit, openapi: pin.path, sha256 },
            docs: docsIndex,
            sdk: { version: packageJson.version, commit: git(repository, "rev-parse", "HEAD") ?? null },
        },
        leftOut,
        ...map,
    }
    await writeFile(join(referenceDir, "endpoints.json"), JSON.stringify(output, null, 1) + "\n")

    // What the SDK sends but the map could not read, for whoever maintains the SDK's request code
    const silent = mapped.filter((operation) => !operation.routes.length && operation.unresolved.length)
    const partial = mapped.filter((operation) => operation.routes.length && operation.unresolved.length)
    const { counts } = map
    console.log(
        `Endpoint map: ${counts.routes} routes, ${counts.withMethod} with a Fluxerly method, ${counts.rest} through ${escapeHatch}, ` +
            `${counts.noToken + counts.oauth2 + counts.webhookToken} without either. Left out: ${leftOut.userSession} user session, ${leftOut.admin} admin`,
    )
    if (silent.length) console.warn(`Operations whose requests could not be read:\n  ${silent.map((operation) => `${operation.name}: ${operation.unresolved.join("; ")}`).join("\n  ")}`)
    if (partial.length) console.log(`Operations with an unread branch beside their mapped routes:\n  ${partial.map((operation) => `${operation.name}: ${operation.unresolved.join("; ")}`).join("\n  ")}`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
