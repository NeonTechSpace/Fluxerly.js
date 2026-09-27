/**
 * Webhook operations and the standalone webhook client owner.
 * Invariant: Token-authenticated routes carry the webhook token only in the request path, never in logs or errors, and a
 * webhook-only client still resolves its own instance. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import { MessageError } from "#sdk/message-errors"
import type { Message, MessageOperationOptions, MessageReference } from "#sdk/messages"
import type {
    CreatedWebhook,
    Webhook,
    WebhookCreate,
    WebhookEdit,
    WebhookMessageInput,
    WebhookMessageEdit,
    WebhookTokenEdit,
    WebhookOperation,
    WebhookOperationOptions,
    WebhookClientOptions,
    WebhookCredentials,
} from "#sdk/webhooks"
import { decodeMessage, encodeForward, encodeMessage, encodeEdit, messageObject, snapshotReference } from "./message.js"
import { fieldsOnce, identifier, record } from "./decode/primitives.js"
import { suspendInput } from "./defects.js"
import type { EncodedBody } from "./attachments.js"
import { RestOwner } from "./rest.js"
import { loggingConfiguration, type ClientLogger } from "./logging.js"
import { InstanceResolver, type InstanceConfiguration, instanceConfiguration } from "./instance.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { normalizedText } from "./field-text.js"
import { type LogicalScheduler, makeLogicalScheduler } from "./logical-scheduler.js"

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
type WebhookValidationResult<A> = WebhookRequest<A> | InputValidationFailure

const validToken = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value)
const name = (value: unknown): value is string => normalizedText(value, 1, 80)

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
    if (!record(value)) return inputValidationFailure("input", "type", "Webhook input must be an object")
    const unsupported = unsupportedKeyFailure(
        value,
        ["name", "avatar", ...(move ? ["channelId"] : [])],
        "input",
        "the webhook input",
    )
    if (unsupported) return unsupported
    const displayName = value.name
    if ((create || displayName !== undefined) && !name(displayName))
        return inputValidationFailure(
            "name",
            "length",
            "Webhook name must contain 1 through 80 UTF-16 code units after Fluxer's normalization",
        )
    const avatar = value.avatar
    if (
        avatar !== undefined &&
        avatar !== null &&
        (typeof avatar !== "string" || !/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/.test(avatar))
    )
        return inputValidationFailure("avatar", "format", "Webhook avatar must be null or a base64 image data URI")
    const channelId = value.channelId
    if (channelId !== undefined && !identifier(channelId))
        return inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings")
    if (!create && displayName === undefined && avatar === undefined && channelId === undefined)
        return inputValidationFailure("input", "required", "Webhook edit must contain a change")
    return {
        json: JSON.stringify({
            ...(displayName === undefined ? {} : { name: displayName }),
            ...(avatar === undefined ? {} : { avatar }),
            ...(channelId === undefined ? {} : { channel_id: channelId }),
        }),
        files: [],
    }
}

function audit(options?: WebhookOperationOptions) {
    const reason = options?.auditReason
    if (reason === undefined) return {}
    if (typeof reason !== "string" || !/^[\x20-\x7e]+$/.test(reason) || !reason.trim() || reason.trim().length > 512)
        return inputValidationFailure(
            "options.auditReason",
            "format",
            "Audit reason must contain 1 through 512 printable ASCII characters after trimming",
        )
    return { auditReason: reason.trim() }
}

export function webhookCreate(
    channelId: string,
    input: WebhookCreate,
    options?: WebhookOperationOptions,
): WebhookValidationResult<CreatedWebhook> {
    const body = settings(input, true, false),
        extra = audit(options)
    if (!identifier(channelId))
        return inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings")
    if (body instanceof InputValidationFailure) return body
    if (extra instanceof InputValidationFailure) return extra
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

export function webhookFetch(id: string): WebhookValidationResult<Webhook> {
    if (!identifier(id)) return inputValidationFailure("webhookId", "format", "Webhook IDs must be decimal strings")
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

export function webhookList(id: string, kind: "channels" | "guilds"): WebhookValidationResult<readonly Webhook[]> {
    if (!identifier(id))
        return inputValidationFailure(
            kind === "channels" ? "channelId" : "guildId",
            "format",
            kind === "channels" ? "Channel IDs must be decimal strings" : "Guild IDs must be decimal strings",
        )
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
): WebhookValidationResult<Webhook> {
    const base = webhookFetch(id),
        body = settings(input, false, true),
        extra = audit(options)
    if (base instanceof InputValidationFailure) return base
    if (body instanceof InputValidationFailure) return body
    if (extra instanceof InputValidationFailure) return extra
    return { ...base, ...extra, method: "PATCH", body }
}

export function webhookDelete(id: string, options?: WebhookOperationOptions): WebhookValidationResult<void> {
    const base = webhookFetch(id),
        extra = audit(options)
    if (base instanceof InputValidationFailure) return base
    if (extra instanceof InputValidationFailure) return extra
    return { ...base, ...extra, method: "DELETE", status: 204, decode: () => undefined }
}

export function webhookTokenFetch(id: string): WebhookValidationResult<Webhook> {
    if (!identifier(id)) return inputValidationFailure("webhookId", "format", "Webhook IDs must be decimal strings")
    return {
        majorId: id,
        tokenAuth: true,
        method: "GET",
        path: "",
        status: 200,
        decode: (value) => {
            const webhook = decodeWebhook(value)
            return webhook?.id === id ? webhook : undefined
        },
    }
}

export function webhookTokenEdit(id: string, input: WebhookTokenEdit): WebhookValidationResult<Webhook> {
    const base = webhookTokenFetch(id),
        body = settings(input, false, false)
    if (base instanceof InputValidationFailure) return base
    if (body instanceof InputValidationFailure) return body
    return { ...base, method: "PATCH", body }
}

export function webhookTokenDelete(id: string): WebhookValidationResult<void> {
    const base = webhookTokenFetch(id)
    return base instanceof InputValidationFailure
        ? base
        : { ...base, method: "DELETE", status: 204, decode: () => undefined }
}

/**
 * The reply target of a webhook messageReference whose type was already read as reply, snapshotted from one read of
 * its target so the validated target is the one sent. Undefined when the reference has other fields or a bad target
 */
function webhookReplyTarget(
    messageReference: unknown,
    reference: (key: string) => unknown,
): MessageReference | undefined {
    return Object.keys(messageReference as object).every((key) => ["type", "target"].includes(key))
        ? snapshotReference(reference("target"))
        : undefined
}

function messageRequest(id: string, messageId?: string): WebhookValidationResult<Message> {
    if (!identifier(id)) return inputValidationFailure("webhookId", "format", "Webhook IDs must be decimal strings")
    if (messageId !== undefined && !identifier(messageId))
        return inputValidationFailure("messageId", "format", "Message IDs must be decimal strings")
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

export function webhookSend(id: string, value: WebhookMessageInput | string): WebhookValidationResult<Message> {
    const base = messageRequest(id)
    if (base instanceof InputValidationFailure) return base
    const input = messageObject(value)
    if (!record(input))
        return inputValidationFailure("input", "type", "Webhook message input must be a string or an object")
    const unsupported = unsupportedKeyFailure(
        input,
        [
            "content",
            "embeds",
            "attachments",
            "stickerIds",
            "allowedMentions",
            "messageReference",
            "flags",
            "username",
            "avatarUrl",
        ],
        "input",
        "the webhook message input",
    )
    if (unsupported) return unsupported
    const { username, avatarUrl, messageReference, ...message } = input
    if (username !== undefined && !name(username))
        return inputValidationFailure(
            "username",
            "length",
            "Webhook username must contain 1 through 80 UTF-16 code units after Fluxer's normalization",
        )
    if (avatarUrl !== undefined) {
        if (typeof avatarUrl !== "string" || avatarUrl.length > 8192)
            return inputValidationFailure(
                "avatarUrl",
                "format",
                "Webhook avatarUrl must be an HTTP or HTTPS URL of at most 8,192 characters",
            )
        try {
            const url = new URL(avatarUrl)
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
                return inputValidationFailure(
                    "avatarUrl",
                    "format",
                    "Webhook avatarUrl must be an HTTP or HTTPS URL without a username or password",
                )
        } catch {
            return inputValidationFailure("avatarUrl", "format", "Webhook avatarUrl must be a valid HTTP or HTTPS URL")
            // allow-silent: The parse failure becomes the typed input failure
        }
    }
    let body: EncodedBody | MessageError
    const reference = record(messageReference) ? fieldsOnce(messageReference) : undefined
    const referenceType = reference?.("type")
    const replyTarget =
        reference !== undefined && referenceType === "reply"
            ? webhookReplyTarget(messageReference, reference)
            : undefined
    if (messageReference === undefined) body = encodeMessage("0", message, "")
    else if (replyTarget !== undefined)
        body = encodeMessage(replyTarget.channelId, { ...message, messageReference: replyTarget }, "")
    else if (
        reference !== undefined &&
        referenceType === "forward" &&
        Object.keys(messageReference as object).every((key) => ["type", "source"].includes(key)) &&
        !("content" in message) &&
        !("embeds" in message) &&
        !("attachments" in message) &&
        !("stickerIds" in message)
    ) {
        const forward = encodeForward("0", reference("source"), "")
        const options = encodeMessage(
            "0",
            { content: "_", flags: message.flags, allowedMentions: message.allowedMentions },
            "",
        )
        if (forward instanceof MessageError) return new InputValidationFailure(forward.inputValidation!)
        if (options instanceof MessageError) return new InputValidationFailure(options.inputValidation!)
        const payload = JSON.parse(options.json)
        body = {
            files: [],
            json: JSON.stringify({
                ...(message.flags === undefined ? {} : { flags: payload.flags }),
                allowed_mentions: payload.allowed_mentions,
                ...JSON.parse(forward.json),
            }),
        }
    } else
        return inputValidationFailure(
            "messageReference",
            "relationship",
            "Webhook messageReference must be a valid reply, or a forward with only type and source sent without content, embeds, attachments, or stickerIds",
        )
    if (body instanceof MessageError) return new InputValidationFailure(body.inputValidation!)
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
    value?: WebhookMessageEdit | string,
): WebhookValidationResult<Message> {
    const base = messageRequest(id, messageId)
    if (base instanceof InputValidationFailure) return base
    if (method === "GET") return base
    const input = messageObject(value)
    if (!record(input))
        return inputValidationFailure("input", "type", "Webhook message edit must be a string or an object")
    const unsupported = unsupportedKeyFailure(
        input,
        ["content", "embeds", "allowedMentions", "flags"],
        "input",
        "the webhook message edit",
    )
    if (unsupported) return unsupported
    const body = encodeEdit(input)
    return body instanceof InputValidationFailure ? body : { ...base, method, body }
}

export function webhookMessageDelete(id: string, messageId: string): WebhookValidationResult<void> {
    const base = messageRequest(id, messageId)
    return base instanceof InputValidationFailure
        ? base
        : { ...base, method: "DELETE", status: 204, decode: () => undefined }
}

/** Token-only lifetime with its own bounded scheduler and no gateway, token store or observation cache */
class WebhookOwner {
    #token: Redacted.Redacted<string> | undefined
    readonly rest: RestOwner
    /** Token-only clients still own an independent immutable instance result and discovery worker */
    readonly instance: InstanceResolver
    readonly #scope: Scope.Scope
    readonly #logging: ClientLogger
    constructor(
        readonly id: string,
        token: string,
        settings: {
            readonly maxBytes: number
            readonly instance: InstanceConfiguration
            readonly logging: ClientLogger
        },
        scope: Scope.Scope,
        logical: LogicalScheduler,
    ) {
        this.#token = Redacted.make(token)
        this.#scope = scope
        this.#logging = settings.logging
        this.instance = new InstanceResolver(settings.instance, scope)
        this.rest = new RestOwner<Message>({
            uploadMaxBytes: settings.maxBytes,
            resolveInstance: () => this.instance.resolve(),
            decodeMessage,
            logical,
            logging: settings.logging,
        })
    }
    run<A>(
        operation: WebhookOperation,
        build: () => WebhookRequest<A> | InputValidationFailure,
        options?: MessageOperationOptions,
    ) {
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
                        Effect.withFiber((fiber) =>
                            Effect.sync(() => {
                                if (token) Redacted.wipeUnsafe(token)
                                this.#logging.flush(fiber.context)
                            }),
                        ),
                    ),
                )
            }),
        )
    }
}

/**
 * Validate webhook client options, reading each field once, then create the owner. Reading the options, including
 * calling revealToken, is marked as application input, while creating the owner is SDK work
 */
export function makeWebhookClient(
    options: WebhookClientOptions,
    native = false,
): Effect.Effect<WebhookOwner, ConfigurationError> {
    return suspendInput(() => {
        if (
            !record(options) ||
            Object.keys(options).some(
                (key) => !["id", "token", "revealToken", "uploadMaxBytes", "instance", "logging"].includes(key),
            )
        )
            return Effect.fail(
                new ConfigurationError(
                    "configuration",
                    "Webhook client options must be an object with only id, token or revealToken, uploadMaxBytes, instance, and logging",
                ),
            )
        const id = options.id
        if (!identifier(id))
            return Effect.fail(
                new ConfigurationError(
                    "configuration",
                    "The webhook client option id must be a decimal webhook ID string",
                ),
            )
        const value: Record<string, unknown> = options
        let token: unknown
        if ("token" in value) token = value.token
        else {
            const reveal = value.revealToken
            token = typeof reveal === "function" ? reveal.call(value) : undefined
        }
        if (!validToken(token))
            return Effect.fail(
                new ConfigurationError(
                    "token",
                    "The webhook token must be 1 through 512 letters, digits, underscores, or hyphens, supplied as token or returned by revealToken",
                ),
            )
        const uploadMaxBytes = options.uploadMaxBytes
        const maxBytes = uploadMaxBytes === undefined ? 104_857_600 : uploadMaxBytes
        if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
            return Effect.fail(
                new ConfigurationError(
                    "uploads",
                    "The webhook client option uploadMaxBytes must be a positive safe integer number of bytes",
                ),
            )
        const instance = instanceConfiguration(options.instance)
        if (instance instanceof ConfigurationError) return Effect.fail(instance)
        const logging = loggingConfiguration(options.logging, native)
        if (logging instanceof ConfigurationError) return Effect.fail(logging)
        logging.addSecret(token)
        return Effect.succeed({ id, token, maxBytes, instance, logging })
    }).pipe(
        Effect.flatMap(({ id, token, ...settings }) =>
            Effect.withFiber((fiber) => {
                // Native records outside an operation use the creating fiber's logger and annotations
                if (native) settings.logging.context = fiber.context
                const scope = Scope.makeUnsafe()
                return makeLogicalScheduler(scope).pipe(
                    Effect.map((logical) => new WebhookOwner(id, token, settings, scope, logical)),
                )
            }),
        ),
    )
}
