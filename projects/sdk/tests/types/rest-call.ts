// Compile-only check, run by the test typecheck: client.rest.call checks the route, path parameters, query and JSON body
// against Fluxer's API description in both APIs, returns the route's response type, and takes the same input in both
// APIs apart from the default API's signal
import * as Effect from "effect/Effect"
import type {
    Client as DefaultClient,
    RestCallInput as DefaultCallInput,
    RestRoute,
    RestRouteResponse,
} from "../../src/index.js"
import type { Client as NativeClient, RestCallInput as NativeCallInput } from "../../src/effect.js"
import type { AssertNever } from "../contract/fixtures/public-client-parity/compare.js"

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** Every route whose default input without the signal differs from the native input */
type InputMismatches = {
    [R in RestRoute]: Same<Omit<DefaultCallInput<R>, "signal">, NativeCallInput<R>> extends true ? never : R
}[RestRoute]
export type CallInputParity = AssertNever<InputMismatches>

export async function defaultCalls(client: DefaultClient, channelId: string, signal: AbortSignal) {
    // A route without input takes no second argument, and the response has the route's type
    const me = await client.rest.call("GET /users/@me")
    if (me.isOk()) {
        const username: string = me.value.body.username
        void username
    }

    const sent = await client.rest.call("POST /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        body: { content: "Hello", allowed_mentions: { parse: [] }, embeds: [{ title: "Fixture" }] },
        auditReason: "fixture",
        timeoutMs: 5_000,
        signal,
    })
    if (sent.isOk()) {
        const id: string = sent.value.body.id
        void id
    }

    // An integer query parameter takes a number, and a repeated one an array
    void client.rest.call("GET /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        query: { limit: 50 },
    })
    void client.rest.call("GET /channels/{channel_id}/threads/search", {
        params: { channel_id: channelId },
        query: { tag: ["101", "102"], archived: false, limit: 25 },
    })

    // A route answered without a body resolves with undefined
    const deleted = await client.rest.call("DELETE /channels/{channel_id}/messages/{message_id}", {
        params: { channel_id: channelId, message_id: "2" },
    })
    if (deleted.isOk()) {
        const body: undefined = deleted.value.body
        void body
    }

    // A thread's type is narrowed to the thread channel types by a reviewed correction
    const thread: RestRouteResponse<"POST /channels/{channel_id}/threads">["type"] = 11
    void thread

    // Public read routes that Fluxer serves without a token are listed too
    const invite = await client.rest.call("GET /invites/{invite_code}", { params: { invite_code: "fixture" } })
    if (invite.isOk()) void invite.value.body.code
    void client.rest.call("GET /.well-known/fluxer")
    void client.rest.call("GET /instance/badges", { query: { limit: 50 } })
    void client.rest.call("GET /ip")
    void client.rest.call("GET /oauth2/applications/{id}/public", { params: { id: "1" } })

    // Reviewed corrections follow what Fluxer's server sends and accepts
    // Thread member user_id is required, so reading it needs no undefined check
    const threadMember = {} as RestRouteResponse<"GET /channels/{channel_id}/thread-members/{user_id}">
    const memberUserId: string = threadMember.user_id
    void memberUserId
    const change: NonNullable<
        RestRouteResponse<"GET /guilds/{guild_id}/audit-logs">["audit_log_entries"][number]["changes"]
    >[number]["new_value"] = [{ id: "1", name: "tag", moderated: false, emoji_id: null, emoji_name: null }]
    void change
    void client.rest.call("POST /search/messages", {
        // @ts-expect-error Fluxer refuses every scope but current from a bot
        body: { content: "x", scope: "all" },
    })
    void client.rest.call("PATCH /channels/{channel_id}/messages/{message_id}", {
        params: { channel_id: channelId, message_id: "2" },
        // @ts-expect-error Fluxer refuses every edit that sends message_snapshots
        body: { message_snapshots: [] },
    })

    // @ts-expect-error A route Fluxer's API description does not list for bots
    void client.rest.call("GET /channels/{channel_id}/nonexistent", { params: { channel_id: channelId } })
    // @ts-expect-error The method belongs to the route
    void client.rest.call("PUT /channels/{channel_id}/messages", { params: { channel_id: channelId }, body: {} })
    void client.rest.call("POST /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        // @ts-expect-error A misspelled body field
        body: { contnet: "x" },
    })
    void client.rest.call("POST /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        // @ts-expect-error A misspelled nested body field
        body: { content: "x", allowed_mentions: { prase: [] } },
    })
    void client.rest.call("POST /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        // @ts-expect-error A body field with the wrong type
        body: { tts: "yes" },
    })
    // @ts-expect-error The path parameters are required
    void client.rest.call("POST /channels/{channel_id}/messages", { body: { content: "x" } })
    // @ts-expect-error The route requires a JSON body
    void client.rest.call("POST /channels/{channel_id}/messages", { params: { channel_id: channelId } })
    // @ts-expect-error A misspelled path parameter
    void client.rest.call("GET /channels/{channel_id}", { params: { channelId } })
    void client.rest.call("GET /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        // @ts-expect-error A misspelled query parameter
        query: { limt: 5 },
    })
    // @ts-expect-error A route without input takes no body
    void client.rest.call("GET /users/@me", { body: {} })
    // @ts-expect-error A route that requires input needs the second argument
    void client.rest.call("GET /channels/{channel_id}")
    // @ts-expect-error Only message routes take files
    void client.rest.call("GET /users/@me", { files: [] })
}

export function nativeCalls(client: NativeClient, channelId: string) {
    const me = client.rest.call("GET /users/@me").pipe(Effect.map((response) => response.body.username))
    const sent = client.rest
        .call("POST /channels/{channel_id}/messages", {
            params: { channel_id: channelId },
            body: { content: "Hello" },
            files: [{ filename: "a.txt", data: new Uint8Array([1]) }],
            auditReason: "fixture",
        })
        .pipe(Effect.map((response) => response.body.id))
    const search = client.rest.call("GET /channels/{channel_id}/threads/search", {
        params: { channel_id: channelId },
        query: { tag: ["101"] },
    })

    // @ts-expect-error A route Fluxer's API description does not list for bots
    void client.rest.call("GET /nonexistent")
    void client.rest.call("POST /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        // @ts-expect-error A misspelled body field
        body: { contnet: "x" },
    })
    // @ts-expect-error The route requires a JSON body
    void client.rest.call("POST /channels/{channel_id}/messages", { params: { channel_id: channelId } })
    void client.rest.call("GET /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        // @ts-expect-error A misspelled query parameter
        query: { limt: 5 },
    })
    // @ts-expect-error The Effect API takes no signal, interruption cancels instead
    void client.rest.call("GET /users/@me", { signal: new AbortController().signal })
    return [me, sent, search] as const
}

// The examples in the rest.call comments and the raw requests guide
export async function recentContents(client: DefaultClient, channelId: string) {
    const result = await client.rest.call("GET /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        query: { limit: 10 },
    })
    return result.map((response) => response.body.map((message) => message.content))
}

export const nativeRecentContents = (client: NativeClient, channelId: string) =>
    client.rest
        .call("GET /channels/{channel_id}/messages", { params: { channel_id: channelId }, query: { limit: 10 } })
        .pipe(Effect.map((response) => response.body.map((message) => message.content)))

// The raw requests guide's client.rest.request example, for a route that needs no token and so has no route type
export async function applicationName(client: DefaultClient, applicationId: string) {
    const result = await client.rest.request<{ name?: unknown }>({
        method: "GET",
        path: `/oauth2/applications/${applicationId}/public`,
    })
    return result.map((response) => (typeof response.body.name === "string" ? response.body.name : undefined))
}

// Files beside body.attachments: an edit keeps an existing attachment by ID, and a send describes a new file by index
export function attachmentLists(client: DefaultClient, channelId: string, data: Uint8Array) {
    void client.rest.call("PATCH /channels/{channel_id}/messages/{message_id}", {
        params: { channel_id: channelId, message_id: "2" },
        body: { attachments: [{ id: "900" }] },
        files: [{ filename: "new.txt", data }],
    })
    void client.rest.call("POST /channels/{channel_id}/messages", {
        params: { channel_id: channelId },
        body: { attachments: [{ id: 0, filename: "new.txt", description: "A chart" }] },
        files: [{ filename: "new.txt", data }],
    })
}
