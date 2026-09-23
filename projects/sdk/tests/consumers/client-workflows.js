import { createClient } from "@neontechspace/fluxerly"
import { runClientWorkflowContract } from "./client-workflow-contract.js"

const originalFetch = globalThis.fetch
const requests = []
let nextKickFails = false

const message = (id, content) => ({
    id,
    channel_id: "20",
    content,
    author: { id: "90", username: "fixture-bot", bot: true },
})

globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    const method = init.method ?? "GET"
    requests.push({ method, path: url.pathname, before: url.searchParams.get("before") })
    if (url.pathname === "/.well-known/fluxer") {
        return Response.json({
            api_code_version: 1,
            endpoints: {
                api_public: "https://consumer.example.test/api",
                gateway: "wss://consumer.example.test/gateway",
                media: "https://consumer.example.test/media",
                static_cdn: "https://consumer.example.test/static",
                webapp: "https://consumer.example.test/app",
                invite: "https://consumer.example.test/invite",
            },
            features: { presigned_attachment_uploads: false },
        })
    }
    if (method === "POST" && url.pathname === "/api/v1/channels/20/messages") {
        const body = JSON.parse(String(init.body))
        return Response.json(message("40", body.content))
    }
    if (method === "GET" && url.pathname === "/api/v1/channels/20/messages") {
        const before = url.searchParams.get("before")
        return Response.json(
            before === "20" ? [message("10", "oldest")] : [message("30", "newest"), message("20", "older")],
        )
    }
    if (method === "DELETE" && url.pathname === "/api/v1/guilds/10/members/30") {
        if (nextKickFails) {
            nextKickFails = false
            throw new TypeError("fixture connection closed after dispatch")
        }
        return new Response(null, { status: 204 })
    }
    if (method === "POST" && url.pathname === "/api/v1/attachments/refresh-urls") {
        const body = JSON.parse(String(init.body))
        return Response.json({
            refreshed_urls: body.attachment_urls.map((original) => ({
                original,
                refreshed: "https://cdn.example.test/attachments/fresh?expires=2",
            })),
        })
    }
    throw new Error(`Unexpected consumer fixture request: ${method} ${url.pathname}${url.search}`)
}

const created = createClient({
    token: "fixture-only-not-a-credential",
    instance: { url: "https://consumer.example.test" },
    cache: { messages: { maxEntries: 10 } },
})
if (created.isErr()) throw created.error
const client = created.value
let closed = false

const unwrap = async (operation) => {
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}

const adapter = {
    message: { id: "1", channelId: "20", content: "!hello", authorId: "30" },
    async reply(target, content) {
        await unwrap(client.messages.reply(target, { content, allowedMentions: {} }))
    },
    async history(channelId, maxItems) {
        const ids = []
        for await (const result of client.messages.iterateHistory(channelId, { maxItems, pageSize: 2 })) {
            if (result.isErr()) throw result.error
            ids.push(result.value.id)
        }
        return ids
    },
    historyRequests() {
        return requests
            .filter(({ method, path }) => method === "GET" && path === "/api/v1/channels/20/messages")
            .map(({ before }) => before)
    },
    async kick(target, reason) {
        const result = await client.members.kick(target, { auditReason: reason })
        return result.isOk() ? { kind: "succeeded" } : { kind: "failed", outcome: result.error.outcome }
    },
    failNextKick() {
        nextKickFails = true
    },
    kickAttempts() {
        return requests.filter(({ method, path }) => method === "DELETE" && path === "/api/v1/guilds/10/members/30")
            .length
    },
    async prepareAttachment(attachment) {
        if (!attachment.expired) return { kind: "ready", url: attachment.url }
        const [refreshed] = await unwrap(client.attachments.refreshUrls([attachment.url]))
        return { kind: "ready", url: refreshed.refreshed }
    },
    health() {
        const diagnostics = client.diagnostics()
        return {
            gateway: client.state === "Connected" ? "ready" : "notStarted",
            cachedMessages: diagnostics.caches.messages.retainedEntries,
        }
    },
    async close() {
        await unwrap(client.shutdown())
        closed = true
    },
    closeState() {
        return closed && client.state === "Closed" ? "closed" : "open"
    },
}

try {
    await runClientWorkflowContract(adapter)
    console.log("Packed client workflows passed")
} finally {
    globalThis.fetch = originalFetch
    if (client.state !== "Closed") await client.shutdown()
}
