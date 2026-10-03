import {
    type IncomingWebhook,
    type WebhookTokenEdit,
    type WebhookMessageInput,
    type WebhookMessageEdit,
    type WebhookClientOptions,
    type WebhookOperationFailure,
} from "#sdk/webhooks"
import {
    makeWebhookClient,
    webhookTokenFetch,
    webhookTokenEdit,
    webhookTokenDelete,
    webhookSend,
    webhookMessage,
    webhookMessageDelete,
} from "#sdk/internal/webhooks"
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
import type { InstanceResolveOptions } from "#sdk/instance"
import type { Message, MessageOperationOptions } from "#sdk/messages"
import { type ResolvedInstance, effectInstance, type Instance } from "./instance.js"

/** Send and manage one incoming webhook's messages using its webhook token.
 * Follower webhooks have no exposed token and Fluxer rejects their token-authenticated operations with UNKNOWN_WEBHOOK.
 * This client does not use a bot token, connect the gateway, cache resources or store tokens persistently
 *
 * Operations start when executed and preserve unexpected faults/interruption.
 * Cleanup defects stop retries and preserve any operation failure or interruption alongside the defect in Cause
 *
 * Requests default to a 30-second total deadline across queue waits, rate-limit waits, retries and HTTP.
 * Confirmed HTTP 429 responses use this client's shared rate-limit state as described on Client.
 * Cancellation interrupts only that operation and awaits request/body cleanup, without rolling back remote effects
 *
 * Errors contain only safe categories and status, never credential-bearing paths or upstream bodies
 *
 * Successful JSON bodies are capped at 16 MiB of response-body bytes before parsing, not total heap usage. Oversized successes fail with reason response.
 * A response failure after a mutation request was sent leaves an unknown outcome and never retries automatically
 *
 * Other client caches are not updated by this token-only client
 *
 * @category Invites and webhooks
 */
export interface WebhookClient {
    /**
     * The webhook's decimal ID, without its token or a token-bearing URL
     */
    readonly id: string
    /**
     * Resolve this webhook client's selected instance and get pure URL helpers for it
     */
    readonly instance: Instance
    /**
     * Fetch this incoming webhook's current metadata using its token, not bot authentication.
     * Creator and private fields are not retained
     */
    fetch(options?: MessageOperationOptions): Effect.Effect<IncomingWebhook, WebhookOperationFailure>
    /**
     * Change this webhook's name or avatar using its token and return metadata without credentials.
     * To move it to another channel, use a bot client's webhooks.edit.
     * A failed or cancelled write can still have applied.
     * This method does not close the client
     */
    edit(
        input: WebhookTokenEdit,
        options?: MessageOperationOptions,
    ): Effect.Effect<IncomingWebhook, WebhookOperationFailure>
    /**
     * Delete this webhook remotely using its token, succeeding after HTTP 204.
     * This does not close the client or release its local credential reference.
     * Later requests normally fail with notFound because the token was revoked.
     * Call shutdown separately to release the client's local resources
     */
    delete(options?: MessageOperationOptions): Effect.Effect<void, WebhookOperationFailure>
    /**
     * Send a webhook message and return the created message after Fluxer's HTTP response.
     * A plain string sends only that text, as shorthand for `{ content }`.
     * The SDK uses wait=true, and mentions are disabled by default.
     * A supplied nonce requests best-effort duplicate suppression for five minutes, not exactly-once delivery.
     * Omission sends no nonce. Forward source nonces are accepted, but supplying both locations fails before dispatch.
     * Reply references can include files.
     * Forward references preserve only the source snapshot and reject new content or uploads
     *
     * Each attachment supplies data bytes, a sized Blob or File source, or a finite stream with its exact size.
     * Metadata and data bytes are copied when execution starts, before waiting.
     * File and stream sources are read when the multipart upload begins, without copying or spooling.
     * Keep file data stable, and supply a fresh stream for each operation because a stream is consumed at most once and must deliver exactly its declared size.
     * Cleanup cancels unfinished readers and awaits lock release, without closing caller paths or FileHandles.
     * Multipart file uploads are streamed with a maximum of 50 MiB per file and share the configured upload-byte budget.
     * An attachment:// image or thumbnail URL must match one new upload whose filename maps to an image or video MIME type.
     * The flags input accepts only MessageFlags.SuppressEmbeds and MessageFlags.SuppressNotifications.
     * Crossposted, IsCrosspost and SourceMessageDeleted are server-managed.
     * Those bits and VoiceMessage fail locally before dispatch
     *
     * A failure with an unknown outcome can leave the message posted and is never replayed automatically.
     * A confirmed inline HTTP 429 can replay copied data bytes, but file and stream inputs fail with rateLimit without being reopened or reread
     */
    send(
        input: WebhookMessageInput | string,
        options?: MessageOperationOptions,
    ): Effect.Effect<Message, WebhookOperationFailure>
    /**
     * Fetch a message authored by this webhook in its current channel, using a decimal message ID.
     * Eligible transient read failures have bounded retries
     */
    fetchMessage(messageId: string, options?: MessageOperationOptions): Effect.Effect<Message, WebhookOperationFailure>
    /**
     * Change this webhook's message and return its updated snapshot.
     * A plain string replaces only the text, as shorthand for `{ content }`.
     * Omitted fields stay unchanged.
     * Mentions default off and attachments cannot be replaced.
     * A flags-only edit replaces only MessageFlags.SuppressEmbeds and MessageFlags.SuppressNotifications, and 0 clears them.
     * Crossposted, IsCrosspost and SourceMessageDeleted are server-managed.
     * Those bits and VoiceMessage fail locally before dispatch.
     * Embed input cannot resolve existing file references
     */
    editMessage(
        messageId: string,
        input: WebhookMessageEdit | string,
        options?: MessageOperationOptions,
    ): Effect.Effect<Message, WebhookOperationFailure>
    /**
     * Delete this webhook's message, succeeding with no value after HTTP 204.
     * Success does not prove it previously existed.
     * A failure with an unknown outcome can follow a completed deletion
     */
    deleteMessage(messageId: string, options?: MessageOperationOptions): Effect.Effect<void, WebhookOperationFailure>
    /**
     * Permanently stop this local client, reject new work, cancel active work and await transport cleanup.
     * The client's token reference is released, but the remote webhook and caller-held credentials remain.
     * Concurrent calls wait for the same pending cleanup.
     * No expected failure is returned
     *
     * @remarks
     * Cleanup defects remain in the Cause
     */
    shutdown(): Effect.Effect<void>
}

/**
 * Create a webhook-only client for hosted Fluxer or an explicitly selected self-hosted instance, from { id, token } or redacted creation credentials.
 * Validate the inputs locally without requests. The client copies the credential into its own redacted reference.
 * Creation starts when the Effect executes. Closing its Scope shuts down the client.
 * The Effect Clock available when creation executes owns this client's request queue and deadlines. Providing a
 * different Clock around a later operation does not replace that owner Clock.
 * The SDK does not persist the token, connect a gateway or authenticate as a bot. Reuse one client per credential to share request slots, queue limits and rate-limit waits.
 * Invalid configuration is misuse and dies with ConfigurationError, and other defects retain their Cause
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { createWebhookClient } from "@neontechspace/fluxerly/effect"
 * export const webhookExample = (id: string, token: string) => Effect.scoped(Effect.gen(function* () {
 *     const webhook = yield* createWebhookClient({ id, token })
 *     const message = yield* webhook.send({ content: "Deploying…" })
 *     return yield* webhook.editMessage(message.id, { content: "Deployed" })
 * }))
 * ```
 *
 * @category Invites and webhooks
 */
export function createWebhookClient(options: WebhookClientOptions): Effect.Effect<WebhookClient, never, Scope.Scope> {
    return Effect.gen(function* () {
        const owner = yield* makeWebhookClient(options, true).pipe(Effect.orDie)
        yield* Effect.addFinalizer(() => owner.shutdown())
        let instance: ResolvedInstance | undefined
        return Object.freeze({
            id: owner.id,
            instance: Object.freeze({
                resolve: (options?: InstanceResolveOptions) =>
                    owner.instance
                        .resolveInfo(options)
                        .pipe(Effect.map((value) => (instance ??= effectInstance(value)))),
            }),
            fetch: (options?: MessageOperationOptions) =>
                owner.run("webhooks.fetchToken", () => webhookTokenFetch(owner.id), options),
            edit: (input: WebhookTokenEdit, options?: MessageOperationOptions) =>
                owner.run("webhooks.editToken", () => webhookTokenEdit(owner.id, input), options),
            delete: (options?: MessageOperationOptions) =>
                owner.run("webhooks.deleteToken", () => webhookTokenDelete(owner.id), options),
            send: (input: WebhookMessageInput | string, options?: MessageOperationOptions) =>
                owner.run("webhooks.send", () => webhookSend(owner.id, input), options),
            fetchMessage: (id: string, options?: MessageOperationOptions) =>
                owner.run("webhooks.fetchMessage", () => webhookMessage(owner.id, id, "GET"), options),
            editMessage: (id: string, input: WebhookMessageEdit | string, options?: MessageOperationOptions) =>
                owner.run("webhooks.editMessage", () => webhookMessage(owner.id, id, "PATCH", input), options),
            deleteMessage: (id: string, options?: MessageOperationOptions) =>
                owner.run("webhooks.deleteMessage", () => webhookMessageDelete(owner.id, id), options),
            shutdown: () => owner.shutdown(),
        })
    })
}
