// Builds the endpoint map: each Fluxer HTTP route a bot can use, the Fluxerly method that sends it, and the section of
// Fluxer's own documentation that describes it. Writes content/reference/endpoints.json, which the build reads, so the
// build never needs the SDK repository or the network.
// Fluxer's OpenAPI document and docs source come from GitHub at the commit projects/release/upstream/manifest.json pins,
// downloaded once per pin into .cache/fluxer by fluxer-source.mjs. Nothing is read from docs.fluxer.com, which shares a
// server address with Fluxer's API. The links still point there, at the pages and anchors the docs site builds from that source
// `pnpm run generate` runs it after extract.mjs, so the map links only methods the reference documents.
// FLUXERLY_SDK overrides the SDK path, FLUXERLY_REPOSITORY the repository around it
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseFrontmatter, rehypeHeadingIds } from "@astrojs/markdown-remark"
import { fluxerSource } from "./fluxer-source.mjs"

const site = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const docsOrigin = "https://docs.fluxer.com"
const docsIndex = `${docsOrigin}/http-api/`
const methodOrder = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const httpMethods = ["get", "put", "post", "patch", "delete", "options", "head", "trace"]

// Security schemes a bot or OAuth2 application can hold, as the SDK's upstream drift check counts them in
// projects/release/upstream.js. An operation without a requirement is kept, though some check another credential at
// runtime, which routeExceptions marks. Every other operation needs a user session or the admin API key and is left out
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

/** A docs page's address, the way Starlight serves a content file: http-api/users/mfa.mdx is /http-api/users/mfa/ */
export function docsPagePath(file) {
    const slug = file.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "")
    // Starlight slugs each folder and file name. These are already slugs, so anything else needs that rule written here
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(slug)) throw new Error(`${file} is not named as a plain docs slug`)
    return `/${slug}/`
}

/**
 * The HTTP API pages in the docs site's sidebar order, which astro.config.ts lists as slugs such as 'http-api/users'.
 * The overview, /http-api/, holds no routes
 */
export function sidebarPages(config) {
    const start = config.indexOf("sidebar:")
    if (start < 0) throw new Error("The Fluxer docs config has no sidebar")
    let depth = 0
    let end = config.indexOf("[", start)
    for (; end < config.length; end++) {
        if (config[end] === "'" || config[end] === '"') end = config.indexOf(config[end], end + 1)
        else if (config[end] === "[") depth++
        else if (config[end] === "]" && --depth === 0) break
    }
    const pages = [...config.slice(start, end).matchAll(/['"](\/?http-api(?:\/[^'"]*)?)['"]/g)].map((match) => `/${match[1].replace(/^\/|\/$/g, "")}/`)
    return [...new Set(pages)].filter((page) => page !== "/http-api/")
}

// Heading text the docs site would change before slugging: code, emphasis, links, tags, expressions, escapes and entities
const markedUp = /[`*_[\]<>{}\\&]/

/**
 * One docs page from its source: its title and the endpoint sections, each level two heading followed by RouteHeader
 * components, which give the method and the path under /v1. Matched by method and path, never by title. Each heading's
 * anchor comes from Astro's own rehypeHeadingIds, which the docs site runs, so numbering of repeated headings matches too
 */
export function docsPage(file, source) {
    const { frontmatter, content } = parseFrontmatter(source, { frontmatter: "remove" })
    if (frontmatter.slug !== undefined) throw new Error(`${file} sets its own slug, which the endpoint map does not follow`)
    const headings = []
    const routes = []
    let fence
    let previous = ""
    for (const line of content.split(/\r?\n/)) {
        if (fence) {
            if (fence.test(line)) fence = undefined
            continue
        }
        const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)
        if (opening) {
            fence = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`)
            continue
        }
        const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line)
        if (heading) {
            const text = heading[2] ?? ""
            if (markedUp.test(text) || /(^|\s)#+$/.test(text)) throw new Error(`${file}: the heading "${text}" uses Markdown the endpoint map does not read`)
            headings.push({ depth: heading[1].length, text })
        } else if (/^ {0,3}(=+|-+)[ \t]*$/.test(line) && previous.trim()) throw new Error(`${file}: "${previous}" may be an underlined heading, which the endpoint map does not read`)
        for (const component of line.matchAll(/<RouteHeader\b([^>]*)>/g)) {
            const method = /\bmethod="([A-Z]+)"/.exec(component[1])?.[1]
            const path = /\bpath="([^"]+)"/.exec(component[1])?.[1]
            if (!component[1].endsWith("/") || !method || !path) throw new Error(`${file}: a RouteHeader the endpoint map can't read: ${component[0]}`)
            const section = headings.findLastIndex((candidate) => candidate.depth === 2)
            if (section >= 0) routes.push({ section, method, path: path.replace(/^\/v1(?=\/)/, "") })
        }
        if (/<RouteHeader\b(?![^>]*>)/.test(line)) throw new Error(`${file}: a RouteHeader spans several lines, which the endpoint map does not read`)
        previous = line
    }
    const tree = { type: "root", children: headings.map(({ depth, text }) => ({ type: "element", tagName: `h${depth}`, properties: {}, children: [{ type: "text", value: text }] })) }
    rehypeHeadingIds()(tree, { data: {}, history: [file] })
    return {
        title: String(frontmatter.title ?? ""),
        sections: routes.filter(({ path }) => path.startsWith("/")).map(({ section, method, path }) => ({ key: routeKey(method, path), anchor: tree.children[section].properties.id })),
    }
}

/** The HTTP API pages in sidebar order, then any the sidebar leaves out, with each route's page and anchor */
export function readDocs({ config, documents }) {
    const read = new Map(documents.map(({ path, text }) => [docsPagePath(path), docsPage(path, text)]))
    const sidebar = sidebarPages(config)
    const missing = sidebar.filter((page) => !read.has(page))
    if (missing.length) throw new Error(`The Fluxer docs sidebar lists pages with no source: ${missing.join(", ")}`)
    const pages = [...sidebar, ...[...read.keys()].filter((page) => page !== "/http-api/" && !sidebar.includes(page)).sort(compare)]
    if (pages.length < 10) throw new Error(`The Fluxer docs list only ${pages.length} HTTP API pages`)
    const sections = new Map()
    const titles = new Map()
    for (const page of pages) {
        const { title, sections: found } = read.get(page)
        titles.set(page, title)
        for (const section of found) {
            if (sections.has(section.key)) throw new Error(`Two Fluxer docs sections describe ${section.key}`)
            sections.set(section.key, { page, anchor: section.anchor })
        }
    }
    return { pages, sections, titles }
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

/** Routes that no SDK method sends, whose general rule above would mislead. Each states its own fallback and what its row says */
export const routeExceptions = new Map([
    // Fluxer's documents list no security for this route, but fluxer_api/src/api/gateway/GatewayRequestService.ts requires a bot
    // token and answers with fixed values
    ["GET /gateway/bot", { fallback: "rest", note: "Use client.rest.request. The shard count and session-start numbers in this response are fixed values, not measured capacity" }],
    // The SDK calls these two itself when it sends attachments
    ["POST /channels/{}/attachments", { fallback: "rest", note: "Used automatically when sending attachments. Use client.rest.request for a standalone upload plan" }],
    ["POST /channels/{}/attachments/complete", { fallback: "rest", note: "Used automatically for multipart uploads. Use client.rest.request for a standalone completion" }],
    // fluxer_api/src/api/channel/controllers/MessageInteractionController.ts serves the reaction list at this address and, with
    // pagination details, at /users after it
    ["GET /channels/{}/messages/{}/reactions/{}", { fallback: "rest", note: "An older form of the list client.messages.fetchReactionUsers reads through the newer route" }],
    // fluxer_api/src/api/oauth/OAuth2ApplicationsController.ts answers /oauth2/applications/@me with the bot's application too
    ["GET /applications/@me", { fallback: "rest", note: "Reads the bot's application, as client.application.fetch does through /oauth2/applications/@me" }],
    // fluxer_api/src/api/auth/AuthController.ts: a bot token has no session, so the call answers 204 and the token stays valid
    ["POST /auth/logout", { fallback: "rest", note: "Does nothing for a bot. Its token has no session to end and stays valid" }],
    // fluxer_api/src/api/channel/services/ChannelService.ts gives a bot a zero wait, and the channel already holds the setting
    ["GET /channels/{}/slowmode", { fallback: "rest", note: "Does nothing useful for a bot. A bot always gets a zero wait, and the channel's rateLimitPerUser holds the setting" }],
    // Read state, the direct message list's order, message preloading, personal notes and feature flags of a person's app
    ...["DELETE /channels/{}/messages/ack", "POST /channels/{}/pins/ack", "PUT /users/@me/channels/{}/pin", "DELETE /users/@me/channels/{}/pin", "POST /users/@me/preload-messages", "GET /experiments"].map((route) => [
        route,
        { fallback: "rest", note: "Only for people's chat apps. A bot has no use for it" },
    ]),
    ["POST /channels/{}/messages/purge", { fallback: "rest", note: "Only for the caller's personal notes channel. A bot has no use for it" }],
    // Usernames are chosen in people's chat apps. Fluxer documents the route for bots, so the raw request stays available
    ["GET /users/check-tag", { fallback: "rest", note: "Used by people's chat apps to check a new username. Use client.rest.request if a bot needs it" }],
    // fluxer_api/src/api/channel/controllers/ChannelController.ts guards it with a captcha check that has no bot exemption, and
    // GroupDmOperationsService.ts requires a friendship, which a bot cannot ask for
    ["PUT /channels/{}/recipients/{}", { fallback: "rest", note: "Needs a friendship with the person, and a solved captcha where Fluxer turns captcha on, which the SDK cannot send. Otherwise use client.rest.request" }],
    // fluxer_api/src/api/oauth/OAuth2Controller.ts serves it without a token check, so the bot token a raw request sends does no harm
    ["GET /oauth2/applications/{}/public", { fallback: "rest", note: "Reads another application's public name, icon, scopes and bot. No method sends it. Use client.rest.request" }],
    // fluxer_api/src/api/webhook/WebhookController.ts turns a GitHub, Slack, Instatus or LibreDesk notification into a message.
    // The service posts to the webhook's URL itself, and client.rest.request refuses webhook token paths
    ...["POST /webhooks/{}/{}/github", "POST /webhooks/{}/{}/slack", "POST /webhooks/{}/{}/instatus", "POST /webhooks/{}/{}/libredesk"].map((route) => [
        route,
        { fallback: "webhookToken", note: "For the named service, which posts its own notifications to the webhook URL with this suffix. Set it up in that service. The SDK does not send these" },
    ]),
    // fluxer_api/src/api/guild/services/data/GuildOperationsService.ts and GuildOwnershipService.ts require the owner, and a bot can't become one
    ["POST /guilds/{}/delete", { fallback: "ownerOnly", note: "Requires community ownership, which ordinary bot accounts cannot get" }],
    ["POST /guilds/{}/transfer-ownership", { fallback: "ownerOnly", note: "Requires community ownership, which ordinary bot accounts cannot get" }],
    // Fluxer's documents list no security for these, but fluxer_api/src/api/voice/VoiceNodeController.ts checks a voice
    // server's join token or signed request
    ...["POST /voice/join", "POST /voice/join/preview", "GET /voice/node", "PATCH /voice/node", "DELETE /voice/node"].map((route) => [
        route,
        { fallback: "voiceServer", note: "For an instance's own voice servers. Needs a voice server credential, which a bot does not have" },
    ]),
])

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
            ...(methods.length ? {} : (routeExceptions.get(operation.key) ?? { fallback: fallbackOf(operation) })),
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

// Files

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

    // Verified against the pin when downloaded and against the cache's record when read back
    const source = await fluxerSource(manifest, { cacheDir: join(site, ".cache/fluxer") })
    const sha256 = createHash("sha256").update(source.openapi).digest("hex")
    const { kept, leftOut } = botSurface(specOperations(JSON.parse(source.openapi.toString("utf8"))))

    const docs = readDocs(source)
    const { sdkOperations } = await import("./sdk-routes.mjs")
    const model = JSON.parse(await readFile(join(referenceDir, "model.json"), "utf8"))
    const reference = referenceResolver(model)
    const effect = referenceResolver(model, "effect")
    // The map links methods the site's reference documents. A method the SDK source has gained since the reference was
    // extracted waits for the next extraction
    const found = sdkOperations(sdk).filter((operation) => !operation.name.includes("[") && operation.routes.length + operation.unresolved.length)
    const operations = found.filter((operation) => reference(referencePath(operation.name)))
    const unreferenced = found.filter((operation) => !reference(referencePath(operation.name))).map((operation) => operation.name)
    if (unreferenced.length) console.warn(`Not in the reference yet, run pnpm run generate to include them (${unreferenced.length}):\n  ${unreferenced.join("\n  ")}`)

    // The client operation table, the webhook client and the OAuth2 client serve both APIs, so the Effect reference
    // documents the same names. A name it lacks would need its own column
    const effectGaps = operations.filter((operation) => operation.routes.length && !effect(referencePath(operation.name))).map((operation) => operation.name)
    if (effectGaps.length) throw new Error(`The Effect reference lacks ${effectGaps.join(", ")}`)

    const escapeHatch = "client.rest.request"
    const mapped = operations.filter((operation) => operation.name !== escapeHatch)
    const { map, missingDocs, unknownRoutes } = endpointMap({ kept, docs, operations: mapped, reference })
    if (missingDocs.length) console.warn(`Routes without a Fluxer docs section (${missingDocs.length}):\n  ${missingDocs.join("\n  ")}`)
    // tests/endpoints.test.ts fails on these. A warning here keeps the build going while a method for one is being written
    const unexplained = map.areas.flatMap((area) => area.routes).filter((route) => !route.methods.length && route.fallback === "rest" && !route.note)
    if (unexplained.length) console.warn(`Bot routes with no method and no note in routeExceptions saying why:\n  ${unexplained.map((route) => `${route.method} ${route.path}`).join("\n  ")}`)
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
