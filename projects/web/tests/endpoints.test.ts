// Tests the endpoint map's rules on small fixtures: which Fluxer routes a bot keeps, how Fluxer's docs pages are read,
// which Fluxerly methods show beside a route, what a route without one falls back to, and how the static analysis reads
// the method and path an operation sends from TypeScript source
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock, test } from "node:test"
import ts from "typescript"
import { endpointView } from "../src/lib/endpoint-view.ts"
import { botSurface, docsPage, docsPagePath, endpointMap, fallbackOf, readDocs, referenceResolver, routeCallers, routeKey, sidebarPages, specOperations } from "../scripts/docs/endpoints.mjs"
import { download, fluxerSource } from "../scripts/docs/fluxer-source.mjs"
import { RouteAnalyzer, objectMembers, returnedObject, routeTemplate, tableEntries, HOLE_ANY, HOLE_SEGMENT } from "../scripts/docs/sdk-routes.mjs"

const spec = {
    security: [],
    paths: {
        "/channels/{channel_id}/messages": {
            get: { summary: "List messages", security: [{ botToken: [] }, { sessionToken: [] }] },
            post: { summary: "Send a message", security: [{ botToken: [] }, { sessionToken: [] }] },
        },
        "/users/@me/settings": { patch: { summary: "Update settings", security: [{ sessionToken: [] }] } },
        "/admin/users": { get: { summary: "List users", security: [{ adminApiKey: [] }] } },
        "/auth/login": { post: { summary: "Login account" } },
        "/oauth2/userinfo": { get: { summary: "Get OAuth2 user information", security: [{ oauth2Token: ["identify"] }] } },
        "/webhooks/{webhook_id}/{token}/slack": { post: { summary: "Execute Slack webhook", security: [] } },
    },
}

test("keeps the routes a bot or OAuth2 application can call and counts the rest", () => {
    const { kept, leftOut } = botSurface(specOperations(spec))
    assert.deepEqual(kept.map((operation) => operation.key).sort(), [
        "GET /channels/{}/messages",
        "GET /oauth2/userinfo",
        "POST /auth/login",
        "POST /channels/{}/messages",
        "POST /webhooks/{}/{}/slack",
    ])
    assert.deepEqual(leftOut, { userSession: 1, admin: 1 })
})

test("an operation without its own security takes the document's", () => {
    const operations = specOperations({ security: [{ sessionToken: [] }], paths: { "/a": { get: { summary: "A" } } } })
    assert.deepEqual(operations[0]!.tokens, ["sessionToken"])
    assert.equal(botSurface(operations).kept.length, 0)
})

test("route keys match by method and path shape, not by parameter names", () => {
    assert.equal(routeKey("get", "/users/{target_id}/profile"), routeKey("GET", "/users/{user_id}/profile"))
    assert.notEqual(routeKey("GET", "/users/@me"), routeKey("GET", "/users/{user_id}"))
})

// A page of Fluxer's docs source with the cases its anchors depend on
const messagesPage = `---
title: Messages
description: Message routes
---

import RouteHeader from '@/components/RouteHeader.astro';

<RouteHeader method="GET" path="/v1/before/any/section" />

## Message object

### Example

\`\`\`mdx
## Not a heading
<RouteHeader method="GET" path="/v1/in/a/code/block" />
\`\`\`

## Get message

<RouteHeader method="GET" path="/v1/channels/{channel_id}/messages/{message_id}" bot />

### Example

## Remove another user's reaction

### Response

<RouteHeader method="DELETE" path="/v1/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/{user_id}" bot />

## Example

<RouteHeader method="GET" path="/.well-known/fluxer" unauthenticated />
`

test("reads Fluxer's docs source with the anchors the docs site gives its headings", () => {
    const page = docsPage("http-api/messages.mdx", messagesPage)
    assert.equal(page.title, "Messages")
    assert.deepEqual(page.sections, [
        { key: "GET /channels/{}/messages/{}", anchor: "get-message" },
        // Slugged as the site does: an apostrophe is dropped, not turned into a hyphen
        { key: "DELETE /channels/{}/messages/{}/reactions/{}/{}", anchor: "remove-another-users-reaction" },
        // The third heading named Example on the page, so the site numbers its anchor
        { key: "GET /.well-known/fluxer", anchor: "example-2" },
    ])
    assert.equal(docsPagePath("http-api/users/mfa.mdx"), "/http-api/users/mfa/")
    assert.equal(docsPagePath("http-api/index.md"), "/http-api/")
    // Markup the anchors would depend on stops the build instead of linking a wrong anchor
    assert.throws(() => docsPage("http-api/x.mdx", "## Get `code`\n"), /does not read/)
    assert.throws(() => docsPage("http-api/x.mdx", '<RouteHeader\n  method="GET" path="/v1/x" />\n'), /several lines/)
    assert.throws(() => docsPage("http-api/x.mdx", "Get message\n---\n"), /underlined heading/)
})

test("orders the docs pages as the docs site's sidebar does", () => {
    const config = `starlight({
        sidebar: [
            { label: 'Topics', items: ['http-api/errors', 'topics/rate-limits', 'http-api/permissions'] },
            { label: 'HTTP API', items: [{label: 'Overview', link: '/http-api/'}, 'http-api/instance', 'http-api/messages'] },
        ],
        social: [{ href: 'https://github.com/fluxerapp/fluxer' }],
    })`
    assert.deepEqual(sidebarPages(config), ["/http-api/errors/", "/http-api/permissions/", "/http-api/instance/", "/http-api/messages/"])
    const plain = (title: string) => `---\ntitle: ${title}\n---\n`
    const documents = [
        { path: "http-api/index.md", text: plain("HTTP API") },
        { path: "http-api/messages.mdx", text: messagesPage },
        ...["errors", "permissions", "instance", "zz-unlisted", ...Array.from({ length: 6 }, (_, index) => `extra-${index}`)].map((name) => ({ path: `http-api/${name}.mdx`, text: plain(name) })),
    ]
    const docs = readDocs({ config, documents })
    assert.deepEqual(docs.pages.slice(0, 4), ["/http-api/errors/", "/http-api/permissions/", "/http-api/instance/", "/http-api/messages/"])
    assert.equal(docs.pages.at(-1), "/http-api/zz-unlisted/")
    assert.equal(docs.titles.get("/http-api/messages/"), "Messages")
    assert.deepEqual(docs.sections.get("GET /channels/{}/messages/{}"), { page: "/http-api/messages/", anchor: "get-message" })
    assert.throws(() => readDocs({ config, documents: documents.filter((document) => !document.path.includes("instance")) }), /no source/)
})

test("shows a method beside the route it exists for", () => {
    const callers = routeCallers([
        { name: "client.channels.fetch", routes: ["GET /channels/{}"] },
        // Reads the channel to check its type, then deletes it
        { name: "client.directMessages.close", routes: ["DELETE /channels/{}", "GET /channels/{}"] },
        { name: "client.channels.delete", routes: ["DELETE /channels/{}"] },
        // Only reads, all covered by their own methods
        { name: "client.permissions.fetch", routes: ["GET /channels/{}", "GET /guilds/{}"] },
        { name: "client.guilds.fetch", routes: ["GET /guilds/{}"] },
        // Two reads, one of which nothing else sends
        { name: "client.threads.fetchMember", routes: ["GET /channels/{}", "GET /channels/{}/thread-members/{}"] },
    ])
    assert.deepEqual(callers.get("GET /channels/{}"), ["client.channels.fetch"])
    assert.deepEqual(callers.get("DELETE /channels/{}"), ["client.channels.delete", "client.directMessages.close"])
    assert.deepEqual(callers.get("GET /guilds/{}"), ["client.guilds.fetch"])
    assert.deepEqual(callers.get("GET /channels/{}/thread-members/{}"), ["client.threads.fetchMember"])
})

test("falls back to client.rest.request only for routes it can send", () => {
    const operation = (path: string, tokens: string[]) => ({ method: "POST", path, key: routeKey("POST", path), summary: "", tags: [], tokens })
    assert.equal(fallbackOf(operation("/channels/{channel_id}/typing", ["botToken", "sessionToken"])), "rest")
    // client.rest.request refuses token webhook routes, whatever their security says
    assert.equal(fallbackOf(operation("/webhooks/{webhook_id}/{token}/slack", [])), "webhookToken")
    assert.equal(fallbackOf(operation("/webhooks/{webhook_id}", ["botToken"])), "rest")
    assert.equal(fallbackOf(operation("/auth/login", [])), "noToken")
    assert.equal(fallbackOf(operation("/oauth2/@me", ["oauth2Token"])), "oauth2")
})

test("builds areas in the docs' order with linked methods and fallbacks", () => {
    const { kept } = botSurface(specOperations(spec))
    const docs = {
        pages: ["/http-api/messages/", "/http-api/oauth2/"],
        titles: new Map([
            ["/http-api/messages/", "Messages"],
            ["/http-api/oauth2/", "OAuth2"],
        ]),
        sections: new Map([
            ["POST /channels/{}/messages", { page: "/http-api/messages/", anchor: "create-message" }],
            ["GET /channels/{}/messages", { page: "/http-api/messages/", anchor: "list-messages" }],
            ["GET /oauth2/userinfo", { page: "/http-api/oauth2/", anchor: "get-userinfo" }],
        ]),
    }
    const reference = (path: string) => `/docs/api/js-ts/x/#${path.toLowerCase()}`
    const { map, missingDocs, unknownRoutes } = endpointMap({
        kept,
        docs,
        operations: [
            { name: "client.messages.send", routes: ["POST /channels/{}/messages"] },
            // The discovery read before an OAuth2 request is not what the method is for
            { name: "OAuthClient.fetchIdentity", routes: ["GET /.well-known/fluxer", "GET /oauth2/userinfo"] },
            { name: "client.instance.resolve", routes: ["GET /.well-known/fluxer"] },
        ],
        reference,
    })
    assert.deepEqual(map.areas.map((area: { title: string }) => area.title), ["Messages", "OAuth2", "Other"])
    const messages = map.areas[0].routes
    assert.deepEqual(messages.map((route: { method: string }) => route.method), ["GET", "POST"])
    assert.equal(messages[0].fallback, "rest")
    assert.deepEqual(messages[1].methods, [{ name: "client.messages.send", url: "/docs/api/js-ts/x/#client.messages.send" }])
    assert.equal(messages[1].docs, "https://docs.fluxer.com/http-api/messages/#create-message")
    assert.deepEqual(map.areas[1].routes[0].methods.map((method: { name: string }) => method.name), ["OAuthClient.fetchIdentity"])
    assert.deepEqual(map.counts, { routes: 5, withMethod: 2, rest: 1, noToken: 1, oauth2: 0, webhookToken: 1 })
    assert.deepEqual(missingDocs.sort(), ["POST /auth/login", "POST /webhooks/{}/{}/slack"])
    // The discovery route is not among the kept ones, so the check reports it instead of dropping it silently
    assert.deepEqual(unknownRoutes, ["GET /.well-known/fluxer"])
})

test("resolves reference URLs through member types", () => {
    const model = {
        entries: [
            {
                key: "js-ts",
                uncategorized: [],
                categories: [
                    {
                        items: [
                            { kind: "interface", name: "Client", url: "/docs/api/js-ts/client/", members: [{ name: "messages", anchor: "messages", type: { r: "Messages" } }] },
                            { kind: "interface", name: "Messages", url: "/docs/api/js-ts/messages/#messages", members: [{ name: "send", anchor: "messages-send" }] },
                        ],
                    },
                ],
            },
        ],
    }
    const resolve = referenceResolver(model)
    assert.equal(resolve("Client.messages.send"), "/docs/api/js-ts/messages/#messages-send")
    assert.equal(resolve("Client.messages.forward"), undefined)
})

test("turns request paths into route templates", () => {
    assert.equal(routeTemplate(`/channels/${HOLE_SEGMENT}/messages?limit=${HOLE_ANY}`), "/channels/{}/messages")
    assert.equal(routeTemplate(`/emojis/${HOLE_SEGMENT}:${HOLE_SEGMENT}/source`), "/emojis/{}/source")
    // An unknown part that may hold slashes is never read as one parameter
    assert.equal(routeTemplate(`/channels/${HOLE_SEGMENT}${HOLE_ANY}`), undefined)
    assert.equal(routeTemplate(`${HOLE_ANY}/clone`), undefined)
    assert.equal(routeTemplate("/users/undefined"), undefined)
})

// A miniature SDK: an operation table, request builders and one place where requests leave
const fixture = {
    "failure.ts": `export class Failure { constructor(readonly reason: string) {} }
export const failure = (reason: string) => new Failure(reason)`,
    "rest.ts": `import { Failure } from "./failure.js"
export interface Request { path: string; method: string; tokenAuth?: boolean; id?: string }
export class Rest {
    #execute(_token: string, _request: { path: string; method: string; webhookId?: string }) { return Promise.resolve() }
    run(build: () => Request | Failure) {
        const input = build()
        if (input instanceof Failure) return Promise.reject(input)
        return this.#execute("token", { ...(input.tokenAuth ? { webhookId: input.id } : {}), path: input.path, method: input.method })
    }
    reaction(operation: "add" | "remove" | "clear", channelId: string, messageId: string, emoji: string) {
        const suffix = operation === "clear" ? "" : \`/\${encodeURIComponent(emoji)}/@me\`
        return this.#execute("token", {
            method: operation === "add" ? "PUT" : "DELETE",
            path: \`/channels/\${channelId}/messages/\${messageId}/reactions\${suffix}\`,
        })
    }
}`,
    "builders.ts": `import { failure, Failure } from "./failure.js"
import type { Request } from "./rest.js"
const identifier = (value: string) => /^\\d+$/.test(value)
export function list(kind: "emojis" | "stickers", guildId: string): Request | Failure {
    if (!identifier(guildId)) return failure("guildId")
    return { path: \`/guilds/\${guildId}/\${kind}\`, method: "GET" }
}
export function clone(kind: "emojis" | "stickers", guildId: string): Request | Failure {
    const base = list(kind, guildId)
    if (base instanceof Failure) return base
    return { ...base, method: "POST", path: \`\${base.path}/clone\` }
}
export function kick(guildId: string, userId: string): Request | Failure {
    return { path: \`/guilds/\${guildId}/members/\${userId}\`, method: "DELETE" }
}
export function unban(guildId: string, userId: string): Request | Failure {
    const request = kick(guildId, userId)
    if (request instanceof Failure) return request
    return { ...request, path: \`/guilds/\${guildId}/bans/\${userId}\` }
}
export function tokenMessage(id: string, messageId?: string): Request | Failure {
    return { tokenAuth: true, id, method: messageId === undefined ? "POST" : "GET", path: messageId === undefined ? "?wait=true" : \`/messages/\${messageId}\` }
}`,
    "operations.ts": `import { Rest } from "./rest.js"
import { clone, list, tokenMessage, unban } from "./builders.js"
const op = <A extends unknown[]>(run: (rest: Rest, ...args: A) => unknown) => run
const checked = <T>(table: T) => table
export function defineOperations() {
    return checked({
        emojis: {
            fetchAll: op((rest: Rest, guildId: string) => rest.run(() => list("emojis", guildId))),
            clone: op((rest: Rest, guildId: string) => rest.run(() => clone("emojis", guildId))),
        },
        members: {
            unban: op((rest: Rest, guildId: string, userId: string) => rest.run(() => unban(guildId, userId))),
        },
        messages: {
            addReaction: op((rest: Rest, channelId: string, messageId: string, emoji: string) => rest.reaction("add", channelId, messageId, emoji)),
            clearReactions: op((rest: Rest, channelId: string, messageId: string) => rest.reaction("clear", channelId, messageId, "")),
        },
    })
}
export function createWebhookClient(rest: Rest, id: string) {
    return Object.freeze({
        send: () => rest.run(() => tokenMessage(id)),
        fetchMessage: (messageId: string) => rest.run(() => tokenMessage(id, messageId)),
    })
}`,
}

test("reads each operation's method and path from source", () => {
    const directory = mkdtempSync(join(tmpdir(), "fluxerly-routes-"))
    try {
        const files = Object.entries(fixture).map(([name, source]) => {
            const file = join(directory, name).replaceAll("\\", "/")
            writeFileSync(file, source)
            return file
        })
        const program = ts.createProgram({
            rootNames: files,
            options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, types: [] },
        })
        const checker = program.getTypeChecker()
        const operations = program.getSourceFile(files.at(-1)!)!
        const find = (name: string) => operations.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!
        const analyzer = new RouteAnalyzer(program, { sinks: [{ file: /\/rest\.ts$/, name: "#execute", request: 1 }], isSource: (file: string) => file.startsWith(directory.replaceAll("\\", "/")) })
        const entries = [
            ...tableEntries(checker, find("defineOperations"), "client").map((entry: { name: string; functions: ts.FunctionLikeDeclaration[] }) => ({ name: entry.name, fn: entry.functions[0]! })),
            ...objectMembers(returnedObject(find("createWebhookClient")), "WebhookClient"),
        ]
        const routes = Object.fromEntries(entries.map((entry: { name: string; fn: ts.FunctionLikeDeclaration }) => [entry.name, analyzer.routesOf(entry.fn)]))
        assert.deepEqual(routes["client.emojis.fetchAll"], { routes: ["GET /guilds/{}/emojis"], unresolved: [] })
        assert.deepEqual(routes["client.emojis.clone"], { routes: ["POST /guilds/{}/emojis/clone"], unresolved: [] })
        // The spread request of a kick keeps its method and takes the ban path, so the kick's own path never shows
        assert.deepEqual(routes["client.members.unban"], { routes: ["DELETE /guilds/{}/bans/{}"], unresolved: [] })
        assert.deepEqual(routes["client.messages.addReaction"], { routes: ["PUT /channels/{}/messages/{}/reactions/{}/@me"], unresolved: [] })
        assert.deepEqual(routes["client.messages.clearReactions"], { routes: ["DELETE /channels/{}/messages/{}/reactions"], unresolved: [] })
        // Token webhook requests are relative to /webhooks/{webhook_id}/{token}, and the query is not part of the route
        assert.deepEqual(routes["WebhookClient.send"], { routes: ["POST /webhooks/{}/{}"], unresolved: [] })
        assert.deepEqual(routes["WebhookClient.fetchMessage"], { routes: ["GET /webhooks/{}/{}/messages/{}"], unresolved: [] })
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("the page shows only routes a bot can send, areas with the most methods first", () => {
    const route = (methods: number, fallback?: string) => ({ methods: Array.from({ length: methods }, () => ({})), ...(fallback ? { fallback } : {}) })
    const areas = [
        { title: "Billing", routes: [route(0, "noToken"), route(0, "noToken")] },
        { title: "Roles", routes: [route(1), route(0, "rest")] },
        { title: "Messages", routes: [route(1), route(2), route(0, "webhookToken")] },
    ]
    const { areas: shown, counts } = endpointView(areas)
    assert.deepEqual(
        shown.map((area) => area.title),
        ["Messages", "Roles"],
    )
    assert.equal(shown[0].routes.length, 2)
    assert.deepEqual(counts, { routes: 4, withMethod: 3, rest: 1, hidden: 3 })
})

test("Downloads wait out rate limits and server errors, and stop at a real answer", async () => {
    const answers = [new Response("", { status: 429, headers: { "retry-after": "7" } }), new Response("", { status: 503 }), new Response("ok")]
    const fetched = mock.method(globalThis, "fetch", () => Promise.resolve(answers.shift()))
    const waits: number[] = []
    const sleep = (ms: number) => {
        waits.push(ms)
        return Promise.resolve()
    }
    assert.equal(String(await download("https://example.test/a", { sleep })), "ok")
    assert.deepEqual(waits, [7000, 4000])

    fetched.mock.mockImplementation(() => Promise.resolve(new Response("", { status: 404 })))
    await assert.rejects(download("https://example.test/b", { sleep }), /HTTP 404/)
    assert.equal(waits.length, 2)
    fetched.mock.restore()
})

// Fluxer's repository at two commits, as raw.githubusercontent.com serves it, which records every file it serves
function fakeRepository(commits: Record<string, Record<string, string>>) {
    const reads: string[] = []
    const fetchFile = async (_repository: string, commit: string, path: string) => {
        reads.push(`${commit.slice(0, 1)} ${path}`)
        const text = commits[commit]?.[path]
        if (text === undefined) throw new Error(`${path} at ${commit} answered HTTP 404`)
        return Buffer.from(text)
    }
    return { fetchFile, reads }
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const docsFolder = "fluxer_docs/src/content/docs/http-api"
const commitA = "a".repeat(40)
const commitB = "b".repeat(40)
const repositoryAt: Record<string, Record<string, string>> = {
    [commitA]: {
        "fluxer_api/src/api/openapi/openapi.json": '{"paths":{}}',
        "fluxer_docs/astro.config.ts": "export default {}",
        [`${docsFolder}/index.md`]: "# HTTP API",
        [`${docsFolder}/users/mfa.mdx`]: "## MFA",
    },
    [commitB]: {
        "fluxer_api/src/api/openapi/openapi.json": '{"paths":{"/a":{}}}',
        "fluxer_docs/astro.config.ts": "export default {}",
        [`${docsFolder}/index.md`]: "# HTTP API",
        [`${docsFolder}/users/mfa.mdx`]: "## MFA, changed",
    },
}
// A manifest as node release/upstream.js --update writes it for one of those commits
const pinAt = (commit: string) => {
    const files = repositoryAt[commit]!
    const pin = (path: string) => ({ path, sha256: sha(files[path]!) })
    return {
        repository: "fluxerapp/fluxer",
        branch: "main",
        commit,
        files: { openapi: pin("fluxer_api/src/api/openapi/openapi.json") },
        endpointDocs: ["fluxer_docs/astro.config.ts", `${docsFolder}/index.md`, `${docsFolder}/users/mfa.mdx`].map(pin),
        gatewayDocs: { path: "fluxer_docs/src/content/docs/gateway", sha256: "0".repeat(64) },
        rateLimits: { path: "fluxer_api/src/api/rate_limit_configs", sha256: "0".repeat(64) },
    }
}

test("Fluxer's pinned files download once per pin, and a cached file that doesn't match its pin downloads again", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "fluxer-source-"))
    try {
        const log = () => {}
        const repository = fakeRepository(repositoryAt)
        const first = await fluxerSource(pinAt(commitA), { cacheDir, fetchFile: repository.fetchFile, log })
        assert.equal(first.openapi.toString(), '{"paths":{}}')
        assert.equal(first.config, "export default {}")
        assert.deepEqual(first.documents, [
            { path: "http-api/index.md", text: "# HTTP API" },
            { path: "http-api/users/mfa.mdx", text: "## MFA" },
        ])
        // The pinned files, each once, and nothing else such as a directory listing
        assert.deepEqual(repository.reads, [
            "a fluxer_api/src/api/openapi/openapi.json",
            "a fluxer_docs/astro.config.ts",
            `a ${docsFolder}/index.md`,
            `a ${docsFolder}/users/mfa.mdx`,
        ])

        // An unchanged pin downloads nothing
        repository.reads.length = 0
        const again = await fluxerSource(pinAt(commitA), { cacheDir, fetchFile: repository.fetchFile, log })
        assert.deepEqual(repository.reads, [])
        assert.deepEqual(again.downloaded, [])
        assert.deepEqual(again.documents, first.documents)

        // A cached file that changed on disk is checked against the pin, discarded and downloaded again, alone
        writeFileSync(join(cacheDir, commitA, docsFolder, "users/mfa.mdx"), "## Tampered")
        const repaired = await fluxerSource(pinAt(commitA), { cacheDir, fetchFile: repository.fetchFile, log })
        assert.deepEqual(repository.reads, [`a ${docsFolder}/users/mfa.mdx`])
        assert.equal(repaired.documents[1]!.text, "## MFA")
        assert.equal(readFileSync(join(cacheDir, commitA, docsFolder, "users/mfa.mdx"), "utf8"), "## MFA")

        // A new pin downloads its files once, then reads them from the cache, which keeps only the current pin
        repository.reads.length = 0
        await fluxerSource(pinAt(commitB), { cacheDir, fetchFile: repository.fetchFile, log })
        await fluxerSource(pinAt(commitB), { cacheDir, fetchFile: repository.fetchFile, log })
        // The assert.deepEqual calls above narrow the type to an empty list
        const moved = repository.reads as string[]
        assert.equal(moved.length, 4)
        assert.ok(moved.every((read) => read.startsWith("b ")))
        assert.deepEqual(readdirSync(cacheDir), [commitB])
    } finally {
        rmSync(cacheDir, { recursive: true, force: true })
    }
})

test("a downloaded file must match its pin, and a mismatch is never cached", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "fluxer-source-"))
    try {
        // The manifest pins commit A's hashes, but the files served are commit B's
        const served = fakeRepository({ [commitA]: repositoryAt[commitB]! })
        await assert.rejects(fluxerSource(pinAt(commitA), { cacheDir, fetchFile: served.fetchFile, log: () => {} }), /not the pinned/)
        assert.equal(existsSync(join(cacheDir, commitA, "fluxer_api/src/api/openapi/openapi.json")), false)
        // A manifest written before the endpoint docs were pinned says how to pin them
        const { endpointDocs, ...older } = pinAt(commitA)
        assert.ok(endpointDocs.length)
        await assert.rejects(fluxerSource(older, { cacheDir, fetchFile: served.fetchFile, log: () => {} }), /--update/)
    } finally {
        rmSync(cacheDir, { recursive: true, force: true })
    }
})

test("a route whose general rule would mislead carries its own fallback and note", () => {
    const operation = (method: string, path: string, tokens: string[]) => ({ key: routeKey(method, path), method, path, summary: path, tokens })
    const kept = [
        operation("GET", "/gateway/bot", []),
        operation("POST", "/channels/{channel_id}/attachments", ["botToken"]),
        operation("POST", "/channels/{channel_id}/attachments/complete", ["botToken"]),
        operation("POST", "/guilds/{guild_id}/delete", ["botToken"]),
        operation("POST", "/guilds/{guild_id}/transfer-ownership", ["botToken"]),
        operation("GET", "/guilds/{guild_id}", ["botToken"]),
    ]
    const { map } = endpointMap({ kept, docs: { sections: new Map(), pages: [], titles: new Map() }, operations: [], reference: (path: string) => `/docs/api/js-ts/x/#${path}` })
    const rows = (map.areas as { routes: { path: string; fallback: string; note?: string; methods: unknown[] }[] }[]).flatMap((area) => area.routes)
    const row = (path: string) => rows.find((route) => route.path === path)!

    // Fluxer lists this route with no security, and it needs a bot token
    assert.equal(row("/gateway/bot").fallback, "rest")
    assert.ok(row("/gateway/bot").note)
    // Sending attachments uses these two without any raw request, so their rows have to say so
    assert.notEqual(row("/channels/{channel_id}/attachments").note, undefined)
    assert.notEqual(row("/channels/{channel_id}/attachments/complete").note, undefined)
    assert.notEqual(row("/channels/{channel_id}/attachments").note, row("/channels/{channel_id}/attachments/complete").note)
    // An ordinary route keeps the plain fallback
    assert.deepEqual([row("/guilds/{guild_id}").fallback, row("/guilds/{guild_id}").note], ["rest", undefined])

    // Only a community's owner can send these two, so the page shows them but doesn't count them as reachable
    assert.equal(row("/guilds/{guild_id}/delete").fallback, "ownerOnly")
    assert.ok(row("/guilds/{guild_id}/transfer-ownership").note)
    const view = endpointView(map.areas as { routes: { methods: unknown[]; fallback?: string }[] }[])
    assert.equal(view.counts.routes, 6)
    assert.equal(view.counts.rest, 4)
    assert.equal(map.counts.rest, 4)
})

test("voice server routes need a voice server credential, not no token", () => {
    // Fluxer lists these with no security, and they check a voice server's join token or signed request
    const voice = [
        ["POST", "/voice/join"],
        ["POST", "/voice/join/preview"],
        ["GET", "/voice/node"],
        ["PATCH", "/voice/node"],
        ["DELETE", "/voice/node"],
    ]
    const open = { summary: "Voice", security: [] }
    const kept = specOperations({
        paths: {
            "/auth/login": { post: { summary: "Login", security: [] } },
            "/voice/join": { post: open },
            "/voice/join/preview": { post: open },
            "/voice/node": { get: open, patch: open, delete: open },
        },
    })
    const { map } = endpointMap({ kept, docs: { sections: new Map(), pages: [], titles: new Map() }, operations: [], reference: (path: string) => `/docs/api/js-ts/x/#${path}` })
    const rows = (map.areas as { routes: { method: string; path: string; fallback: string; note?: string; methods: unknown[] }[] }[]).flatMap((area) => area.routes)
    for (const [method, path] of voice) {
        const row = rows.find((route) => route.method === method && route.path === path)!
        assert.equal(row.fallback, "voiceServer", `${method} ${path}`)
        assert.ok(row.note)
    }
    // A route that really needs no token keeps that fallback, and the count leaves the voice server routes out
    assert.equal(rows.find((route) => route.path === "/auth/login")!.fallback, "noToken")
    assert.equal(map.counts.noToken, 1)
    assert.equal(endpointView(map.areas as { routes: { methods: unknown[]; fallback?: string }[] }[]).counts.routes, 0)
})

test("every bot route on the generated map without a method says why a bot doesn't need one", () => {
    // Read from the map the build generates, so a route Fluxer adds after a pin move fails here until it gets a method or a note
    const generated = JSON.parse(readFileSync(new URL("../content/reference/endpoints.json", import.meta.url), "utf8"))
    const rows = (generated.areas as { routes: { method: string; path: string; methods: unknown[]; fallback?: string; note?: string }[] }[]).flatMap((area) => area.routes)
    const unexplained = rows.filter((route) => !route.methods.length && route.fallback === "rest" && !route.note).map((route) => `${route.method} ${route.path}`)
    assert.deepEqual(unexplained, [])
})
