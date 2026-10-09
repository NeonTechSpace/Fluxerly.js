import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    createWebhookClient,
    type WebhookMessageEdit,
    type WebhookMessageInput,
    type WebhookMessageOperationOptions,
} from "../../../src/index.js"
import { createWebhookClient as createNativeWebhook } from "../../../src/effect.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { hostedOperationCalls, stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle } from "../../support/settle.js"

// Fluxer 4749eb7f: WebhookController (thread_id on execute and on message get, edit and delete), WebhookRequestSchemas
// (thread_name and applied_tags in the body) and WebhookService (WEBHOOK_FORUM_TARGET_REQUIRED, _CONFLICT and
// WEBHOOK_THREAD_NAME_REQUIRES_FORUM). The raw request method refuses webhook paths, so these options are the only way
// to reach a thread through a webhook

const secret = "test_only_secret"
const message = (extra = {}) => ({
    id: "400",
    channel_id: "300",
    webhook_id: "100",
    content: "Deploying",
    author: { id: "100", username: "Deployments", bot: true },
    ...extra,
})

afterEach(() => {
    vi.unstubAllGlobals()
})

/** Answer every webhook request with the given response and record what Fluxer would have received */
function recordRequests(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
    const requests: Array<{ method: string; path: string; query: string; body: unknown }> = []
    const fetch = stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const target = new URL(url)
        // The default mention policy is not under test here, so it stays out of the recorded bodies
        const { allowed_mentions: _mentions, ...body } =
            typeof init.body === "string" ? JSON.parse(init.body) : { allowed_mentions: undefined }
        requests.push({
            method: init.method!,
            path: target.pathname.replace(`/v1/webhooks/100/${secret}`, ""),
            query: target.search,
            body: typeof init.body === "string" ? body : undefined,
        })
        return respond(target, init)
    })
    return { requests, fetch }
}

async function open(mode: Mode) {
    const options = { id: "100", token: secret }
    const scope = Scope.makeUnsafe()
    const defaultWebhook = mode === "default" ? createWebhookClient(options) : undefined
    const nativeWebhook =
        mode === "native" ? await Effect.runPromise(createNativeWebhook(options).pipe(Scope.provide(scope))) : undefined
    onTestFinished(async () => {
        if (defaultWebhook) await defaultWebhook.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        send: (input: WebhookMessageInput | string, options?: { timeoutMs?: number }) =>
            defaultWebhook ? settle(defaultWebhook.send(input, options)) : settle(nativeWebhook!.send(input, options)),
        fetchMessage: (id: string, options?: WebhookMessageOperationOptions) =>
            defaultWebhook
                ? settle(defaultWebhook.fetchMessage(id, options))
                : settle(nativeWebhook!.fetchMessage(id, options)),
        editMessage: (id: string, input: WebhookMessageEdit | string, options?: WebhookMessageOperationOptions) =>
            defaultWebhook
                ? settle(defaultWebhook.editMessage(id, input, options))
                : settle(nativeWebhook!.editMessage(id, input, options)),
        deleteMessage: (id: string, options?: WebhookMessageOperationOptions) =>
            defaultWebhook
                ? settle(defaultWebhook.deleteMessage(id, options))
                : settle(nativeWebhook!.deleteMessage(id, options)),
    }
}

test.each(modes)(
    "%s posts into a thread through the thread_id query and keeps the ID out of the body",
    async (mode) => {
        const { requests } = recordRequests(() => Response.json(message({ channel_id: "500" })))
        const webhook = await open(mode)

        const sent = await webhook.send({ content: "Deploying", threadId: "500" })
        await webhook.send("No thread")

        expect(sent.channelId).toBe("500")
        expect(requests).toEqual([
            { method: "POST", path: "", query: "?wait=true&thread_id=500", body: { content: "Deploying" } },
            { method: "POST", path: "", query: "?wait=true", body: { content: "No thread" } },
        ])
    },
)

test.each(modes)("%s targets a thread when it fetches, edits and deletes a webhook message", async (mode) => {
    const { requests } = recordRequests((_url, init) =>
        init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(message({ channel_id: "500" })),
    )
    const webhook = await open(mode)

    await webhook.fetchMessage("400", { threadId: "500" })
    await webhook.editMessage("400", "Done", { threadId: "500", timeoutMs: 5_000 })
    await webhook.deleteMessage("400", { threadId: "500" })
    await webhook.fetchMessage("400")
    await webhook.editMessage("400", "Again")
    await webhook.deleteMessage("400")

    expect(requests).toEqual([
        { method: "GET", path: "/messages/400", query: "?thread_id=500", body: undefined },
        { method: "PATCH", path: "/messages/400", query: "?thread_id=500", body: { content: "Done" } },
        { method: "DELETE", path: "/messages/400", query: "?thread_id=500", body: undefined },
        { method: "GET", path: "/messages/400", query: "", body: undefined },
        { method: "PATCH", path: "/messages/400", query: "", body: { content: "Again" } },
        { method: "DELETE", path: "/messages/400", query: "", body: undefined },
    ])
})

test.each(modes)("%s starts a forum post from a webhook message and returns its first message", async (mode) => {
    const { requests } = recordRequests(() => Response.json(message({ id: "500", channel_id: "500" })))
    const webhook = await open(mode)

    const first = await webhook.send({
        content: "Release notes",
        threadName: "Release 1.2",
        appliedTagIds: ["70", "71"],
        username: "Releases",
    })
    await webhook.send({ content: "Untagged", threadName: "No tags", appliedTagIds: [] })

    // Fluxer gives the post and its first message one ID, so the result's channel is the new post
    expect(first.channelId).toBe(first.id)
    expect(requests).toEqual([
        {
            method: "POST",
            path: "",
            query: "?wait=true",
            body: {
                content: "Release notes",
                username: "Releases",
                thread_name: "Release 1.2",
                applied_tags: ["70", "71"],
            },
        },
        {
            method: "POST",
            path: "",
            query: "?wait=true",
            body: { content: "Untagged", thread_name: "No tags", applied_tags: [] },
        },
    ])
})

test.each(modes)("%s carries the post name and tags in the multipart payload of an upload", async (mode) => {
    let payload: unknown
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers)
        const form = await new Response(init.body, { headers }).formData()
        payload = JSON.parse(String(form.get("payload_json")))
        return Response.json(message({ id: "500", channel_id: "500" }))
    })
    const webhook = await open(mode)

    await webhook.send({
        threadName: "Photos",
        appliedTagIds: ["70"],
        attachments: [{ data: new Uint8Array([1, 2, 3]), filename: "photo.png" }],
    })

    expect(payload).toMatchObject({
        thread_name: "Photos",
        applied_tags: ["70"],
        attachments: [{ filename: "photo.png" }],
    })
})

// The SDK cannot see a webhook's channel type, so Fluxer's answer is the only way a sender learns that a forum webhook
// needs a post target or that a post name needs a forum channel
test.each(modes)("%s categorizes the post targets Fluxer refuses and names the fix", async (mode) => {
    let code = "WEBHOOK_FORUM_TARGET_REQUIRED"
    recordRequests(() => Response.json({ code }, { status: 400 }))
    const webhook = await open(mode)

    await expect(webhook.send("No post target")).rejects.toMatchObject({
        status: 400,
        apiError: { providerCode: code, code: "webhookForumTargetRequired" },
        hint: expect.stringMatching(/\S/),
    })
    code = "WEBHOOK_THREAD_NAME_REQUIRES_FORUM"
    await expect(webhook.send({ content: "Not a forum", threadName: "Post" })).rejects.toMatchObject({
        status: 400,
        apiError: { providerCode: code, code: "webhookThreadNameRequiresForum" },
        hint: expect.stringMatching(/\S/),
    })
})

// Fluxer answers a message that sets both a post name and a thread with WEBHOOK_FORUM_TARGET_CONFLICT, and ignores tags
// that arrive without a post name, so the SDK refuses these combinations instead of sending a request that fails or
// silently drops a field
test.each(modes)("%s refuses thread settings that Fluxer rejects or ignores, before any request", async (mode) => {
    const { fetch } = recordRequests(() => Response.json(message()))
    const webhook = await open(mode)
    const reply = { type: "reply" as const, target: { id: "1", channelId: "2" } }
    const forward = { type: "forward" as const, source: { source: { id: "1", channelId: "2" } } }
    const rejected: Array<[string, unknown, string, string]> = [
        [
            "a post name with a thread",
            { content: "x", threadName: "Post", threadId: "500" },
            "threadName",
            "relationship",
        ],
        ["tags without a post name", { content: "x", appliedTagIds: ["70"] }, "appliedTagIds", "relationship"],
        ["an empty tag list without a post name", { content: "x", appliedTagIds: [] }, "appliedTagIds", "relationship"],
        [
            "tags with only a thread",
            { content: "x", appliedTagIds: ["70"], threadId: "500" },
            "appliedTagIds",
            "relationship",
        ],
        [
            "a post name on a reply",
            { content: "x", threadName: "Post", messageReference: reply },
            "threadName",
            "relationship",
        ],
        ["a post name on a forward", { threadName: "Post", messageReference: forward }, "threadName", "relationship"],
        ["an empty post name", { content: "x", threadName: "" }, "threadName", "length"],
        ["a blank post name", { content: "x", threadName: " \u000c " }, "threadName", "length"],
        ["a post name over 100 units", { content: "x", threadName: "n".repeat(101) }, "threadName", "length"],
        ["a post name that is not text", { content: "x", threadName: 5 }, "threadName", "length"],
        [
            "six tags",
            { content: "x", threadName: "Post", appliedTagIds: ["1", "2", "3", "4", "5", "6"] },
            "appliedTagIds",
            "format",
        ],
        [
            "a tag ID that is not decimal",
            { content: "x", threadName: "Post", appliedTagIds: ["bug"] },
            "appliedTagIds",
            "format",
        ],
        [
            "tags that are not a list",
            { content: "x", threadName: "Post", appliedTagIds: "70" },
            "appliedTagIds",
            "format",
        ],
        ["a thread ID that is not decimal", { content: "x", threadId: "latest" }, "threadId", "format"],
        ["a numeric thread ID", { content: "x", threadId: 500 }, "threadId", "format"],
    ]
    for (const [, input, path, constraint] of rejected)
        await expect(webhook.send(input as WebhookMessageInput)).rejects.toMatchObject({
            _tag: "WebhookOperationError",
            operation: "webhooks.send",
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path, constraint },
        })
    for (const [operation, call] of [
        ["webhooks.fetchMessage", (threadId: unknown) => webhook.fetchMessage("400", { threadId } as never)],
        ["webhooks.editMessage", (threadId: unknown) => webhook.editMessage("400", "x", { threadId } as never)],
        ["webhooks.deleteMessage", (threadId: unknown) => webhook.deleteMessage("400", { threadId } as never)],
    ] as const)
        for (const threadId of ["latest", 500])
            await expect(call(threadId)).rejects.toMatchObject({
                operation,
                reason: "input",
                outcome: "notDispatched",
                inputValidation: { path: "options.threadId", constraint: "format" },
            })
    // The thread of a new message belongs in its input, so the send options do not take it
    await expect(webhook.send("x", { threadId: "500" } as never)).rejects.toMatchObject({
        reason: "input",
        inputValidation: { path: "options", constraint: "allowedFields" },
    })
    await expect(webhook.fetchMessage("400", { thread: "500" } as never)).rejects.toMatchObject({
        reason: "input",
        inputValidation: { path: "options", constraint: "allowedFields" },
    })
    expect(hostedOperationCalls(fetch)).toEqual([])
})
