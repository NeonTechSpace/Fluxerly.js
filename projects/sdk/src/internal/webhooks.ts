import { Cause, Effect, Exit, Redacted, Scope } from "effect"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import { MessageError } from "#sdk/message-errors"
import type { Message, MessageOperationOptions } from "#sdk/messages"
import type {
    CreatedWebhook,
    Webhook,
    WebhookCreate,
    WebhookEdit,
    WebhookMessageInput,
    WebhookMessageEdit,
    WebhookOperation,
    WebhookOperationOptions,
    WebhookClientOptions,
    WebhookCredentials,
} from "#sdk/webhooks"
import { record, identifier, decodeMessage, encodeMessage, encodeEdit } from "./message.js"
import type { EncodedBody } from "./attachments.js"
import { RestOwner } from "./rest.js"
import { InstanceResolver, type InstanceConfiguration, instanceConfiguration } from "./instance.js"

export type WebhookRequest<A> = {
    majorId: string
    method: "GET" | "POST" | "PATCH" | "DELETE"
    path: string
    status: number
    body?: EncodedBody
    tokenAuth?: true
    auditReason?: string
    decode: (value: unknown) => A | undefined
}

const validToken = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value)
const name = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && [...value].length <= 80

function decodeWebhook(value: unknown): Webhook | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        !identifier(value.guild_id) ||
        !identifier(value.channel_id) ||
        typeof value.name !== "string" ||
        (value.avatar != null && typeof value.avatar !== "string")
    )
        return undefined
    return Object.freeze({
        id: value.id,
        guildId: value.guild_id,
        channelId: value.channel_id,
        name: value.name,
        avatar: value.avatar ?? null,
    })
}

function credentials(id: string, token: string): WebhookCredentials {
    return Object.freeze({ id, revealToken: () => token })
}

function settings(value: unknown, create: boolean, move: boolean) {
    if (
        !record(value) ||
        Object.keys(value).some((key) => !["name", "avatar", ...(move ? ["channelId"] : [])].includes(key))
    )
        return undefined
    if ((create || value.name !== undefined) && !name(value.name)) return undefined
    if (
        value.avatar !== undefined &&
        value.avatar !== null &&
        (typeof value.avatar !== "string" ||
            !/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/.test(value.avatar))
    )
        return undefined
    if (value.channelId !== undefined && !identifier(value.channelId)) return undefined
    if (!create && value.name === undefined && value.avatar === undefined && value.channelId === undefined)
        return undefined
    return {
        json: JSON.stringify({
            ...(value.name === undefined ? {} : { name: value.name }),
            ...(value.avatar === undefined ? {} : { avatar: value.avatar }),
            ...(value.channelId === undefined ? {} : { channel_id: value.channelId }),
        }),
        files: [],
    }
}

function audit(options?: WebhookOperationOptions) {
    const reason = options?.auditReason
    if (reason === undefined) return {}
    if (typeof reason !== "string" || !/^[\x20-\x7e]+$/.test(reason) || !reason.trim() || reason.trim().length > 512)
        return undefined
    return { auditReason: reason.trim() }
}

export function webhookCreate(
    channelId: string,
    input: WebhookCreate,
    options?: WebhookOperationOptions,
): WebhookRequest<CreatedWebhook> | undefined {
    const body = settings(input, true, false),
        extra = audit(options)
    if (!identifier(channelId) || !body || !extra) return undefined
    return {
        majorId: channelId,
        method: "POST",
        path: `/channels/${channelId}/webhooks`,
        status: 200,
        body,
        ...extra,
        decode: (value) => {
            const webhook = decodeWebhook(value)
            if (!webhook || webhook.channelId !== channelId || !record(value) || !validToken(value.token))
                return undefined
            return Object.freeze({ webhook, credentials: credentials(webhook.id, value.token) })
        },
    }
}

export function webhookFetch(id: string): WebhookRequest<Webhook> | undefined {
    if (!identifier(id)) return undefined
    return {
        majorId: id,
        method: "GET",
        path: `/webhooks/${id}`,
        status: 200,
        decode: (value) => {
            const webhook = decodeWebhook(value)
            return webhook?.id === id ? webhook : undefined
        },
    }
}

export function webhookList(id: string, kind: "channels" | "guilds"): WebhookRequest<readonly Webhook[]> | undefined {
    if (!identifier(id)) return undefined
    return {
        majorId: id,
        method: "GET",
        path: `/${kind}/${id}/webhooks`,
        status: 200,
        decode: (value) => {
            if (!Array.isArray(value)) return undefined
            const items: Webhook[] = [],
                ids = new Set<string>()
            for (const item of value) {
                const webhook = decodeWebhook(item)
                if (
                    !webhook ||
                    ids.has(webhook.id) ||
                    (kind === "channels" ? webhook.channelId : webhook.guildId) !== id
                )
                    return undefined
                ids.add(webhook.id)
                items.push(webhook)
            }
            return Object.freeze(items)
        },
    }
}

export function webhookEdit(
    id: string,
    input: WebhookEdit,
    options?: WebhookOperationOptions,
): WebhookRequest<Webhook> | undefined {
    const base = webhookFetch(id),
        body = settings(input, false, true),
        extra = audit(options)
    if (!base || !body || !extra) return undefined
    return { ...base, ...extra, method: "PATCH", body }
}

export function webhookDelete(id: string, options?: WebhookOperationOptions): WebhookRequest<void> | undefined {
    const base = webhookFetch(id),
        extra = audit(options)
    if (!base || !extra) return undefined
    return { ...base, ...extra, method: "DELETE", status: 204, decode: () => undefined }
}

function messageRequest(id: string, messageId?: string): WebhookRequest<Message> | undefined {
    if (!identifier(id) || (messageId !== undefined && !identifier(messageId))) return undefined
    return {
        majorId: id,
        tokenAuth: true,
        method: messageId === undefined ? "POST" : "GET",
        path: messageId === undefined ? "?wait=true" : `/messages/${messageId}`,
        status: 200,
        decode: (value) => {
            const message = decodeMessage(value)
            if (
                !message ||
                !record(value) ||
                value.webhook_id !== id ||
                (messageId !== undefined && message.id !== messageId)
            )
                return undefined
            return message
        },
    }
}

export function webhookSend(id: string, input: WebhookMessageInput): WebhookRequest<Message> | undefined {
    const base = messageRequest(id)
    if (!base || !record(input)) return undefined
    const { username, avatarUrl, ...message } = input
    if (username !== undefined && !name(username)) return undefined
    if (avatarUrl !== undefined) {
        if (typeof avatarUrl !== "string" || avatarUrl.length > 8192) return undefined
        try {
            const url = new URL(avatarUrl)
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined
        } catch {
            return undefined
        }
    }
    if ("messageReference" in message) return undefined
    const body = encodeMessage("0", message, "")
    if (body instanceof MessageError) return undefined
    const payload = JSON.parse(body.json)
    delete payload.nonce
    body.json = JSON.stringify({
        ...payload,
        ...(username === undefined ? {} : { username }),
        ...(avatarUrl === undefined ? {} : { avatar_url: avatarUrl }),
    })
    return { ...base, body }
}

export function webhookMessage(
    id: string,
    messageId: string,
    method: "GET" | "PATCH",
    input?: WebhookMessageEdit,
): WebhookRequest<Message> | undefined {
    const base = messageRequest(id, messageId)
    if (!base) return undefined
    if (method === "GET") return base
    if (
        !record(input) ||
        Object.keys(input).some((key) => !["content", "embeds", "allowedMentions", "flags"].includes(key))
    )
        return undefined
    const body = encodeEdit(input)
    return body ? { ...base, method, body } : undefined
}

export function webhookMessageDelete(id: string, messageId: string): WebhookRequest<void> | undefined {
    const base = messageRequest(id, messageId)
    return base ? { ...base, method: "DELETE", status: 204, decode: () => undefined } : undefined
}

/** Token-only lifetime with its own bounded scheduler and no gateway, token store or observation cache */
class WebhookOwner {
    #token: Redacted.Redacted<string> | undefined
    readonly rest: RestOwner
    /** Token-only clients still own an independent immutable instance result and discovery worker */
    readonly instance: InstanceResolver
    readonly #scope = Scope.makeUnsafe()
    constructor(
        readonly id: string,
        token: string,
        maxBytes: number,
        instance: InstanceConfiguration,
    ) {
        this.#token = Redacted.make(token)
        this.instance = new InstanceResolver(instance, this.#scope)
        this.rest = new RestOwner(undefined, maxBytes, undefined, undefined, undefined, () => this.instance.resolve())
    }
    run<A>(operation: WebhookOperation, build: () => WebhookRequest<A> | undefined, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#token
                ? this.rest.webhook(this.#token, operation, build, options)
                : Effect.fail(new ClientClosedError()),
        )
    }
    shutdown() {
        return Effect.uninterruptible(
            Effect.suspend(() => {
                const token = this.#token
                this.#token = undefined
                return Effect.all([Effect.exit(this.instance.shutdown()), Effect.exit(this.rest.shutdown())], {
                    concurrency: "unbounded",
                }).pipe(
                    Effect.flatMap((exits) => {
                        const reasons = exits.flatMap((exit) => (Exit.isFailure(exit) ? exit.cause.reasons : []))
                        return reasons.length ? Effect.failCause(Cause.fromReasons<never>(reasons)) : Effect.void
                    }),
                    Effect.ensuring(Scope.close(this.#scope, Exit.void)),
                    Effect.ensuring(
                        Effect.sync(() => {
                            if (token) Redacted.wipeUnsafe(token)
                        }),
                    ),
                )
            }),
        )
    }
}

export function makeWebhookClient(options: WebhookClientOptions): Effect.Effect<WebhookOwner, ConfigurationError> {
    return Effect.suspend(() => {
        if (
            !record(options) ||
            Object.keys(options).some(
                (key) => !["id", "token", "revealToken", "uploadMaxBytes", "instance"].includes(key),
            ) ||
            !identifier(options.id)
        )
            return Effect.fail(new ConfigurationError("configuration", "Invalid webhook client configuration"))
        const value: Record<string, unknown> = options
        const token =
            "token" in value ? value.token : typeof value.revealToken === "function" ? value.revealToken() : undefined
        if (!validToken(token)) return Effect.fail(new ConfigurationError("token", "Invalid webhook credential"))
        const maxBytes = options.uploadMaxBytes === undefined ? 104_857_600 : options.uploadMaxBytes
        if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
            return Effect.fail(new ConfigurationError("uploads", "Invalid webhook upload budget"))
        const instance = instanceConfiguration(options.instance)
        if (instance instanceof ConfigurationError) return Effect.fail(instance)
        return Effect.succeed(new WebhookOwner(options.id, token, maxBytes, instance))
    })
}
