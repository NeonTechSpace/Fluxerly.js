import {
    type IncomingWebhook,
    type WebhookTokenEdit,
    type WebhookMessageInput,
    type WebhookMessageEdit,
    type WebhookClientOptions,
    type WebhookOperationFailure,
    type DefaultWebhookMessageOperationOptions,
} from "#sdk/webhooks"
import {
    makeWebhookClient,
    webhookTokenFetch,
    webhookTokenEdit,
    webhookTokenDelete,
    webhookSend,
    webhookMessageFetch,
    webhookMessageEdit,
    webhookMessageDelete,
} from "#sdk/internal/webhooks"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { ok, ResultAsync } from "neverthrow"
import { causeReasons } from "#sdk/internal/defects"
import { CancelledError, ConfigurationError, SdkDefect } from "#sdk/errors"
import type { Message, DefaultMessageOperationOptions } from "#sdk/messages"
import { type Instance, type DefaultInstanceResolveOptions } from "./instance.js"
import { executeOperation, fromExit } from "#sdk/internal/binding/execute"

/**
 * Send and manage messages with one incoming webhook's token, without a bot token or gateway.
 * Follower webhooks have no exposed token and Fluxer rejects their token-authenticated operations with UNKNOWN_WEBHOOK.
 * Create this with createWebhookClient and always await shutdown when finished
 *
 * @remarks
 * No cache or persistent token store is created, and other clients' caches are not updated.
 * Calls start immediately and return ResultAsync for expected successes and failures.
 * The default 30,000 ms total deadline includes capacity, rate-limit, retry and HTTP waits.
 * Confirmed HTTP 429 responses use this client's shared rate-limit state as described on Client.
 * Abort cancels only the operation and waits for request and body cleanup, without reversing remote changes.
 * Errors include safe categories and status, not token-bearing paths or response bodies.
 * Successful JSON is capped at 16 MiB before parsing, not total memory.
 * A failed response after sending a write leaves an uncertain result and is not retried automatically.
 * Unexpected SDK or cleanup failures reject with SdkDefect.
 * Cleanup failure stops retries and keeps safe details of any accompanying operation failure or cancellation
 *
 * @category Invites and webhooks
 */
export interface WebhookClient extends AsyncDisposable {
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
    fetch(
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<IncomingWebhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change this webhook's name or avatar using its token and return metadata without credentials.
     * To move it to another channel, use a bot client's webhooks.edit.
     * A failed or cancelled write can still have applied.
     * This method does not close the client
     */
    edit(
        input: WebhookTokenEdit,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<IncomingWebhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete this webhook remotely using its token, succeeding after HTTP 204.
     * This does not close the client or release its local credential reference.
     * Later requests normally fail with notFound because the token was revoked.
     * Call shutdown separately to release the client's local resources
     */
    delete(
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Send a webhook message and return the created message after Fluxer's HTTP response.
     * A plain string sends only that text, as shorthand for `{ content }`.
     * The SDK uses wait=true, and mentions are disabled by default.
     * A supplied nonce requests best-effort duplicate suppression for five minutes, not exactly-once delivery.
     * Omission sends no nonce. Forward source nonces are accepted, but supplying both locations fails before dispatch.
     * Reply references can include files.
     * Forward references preserve only the source snapshot and reject new content or uploads
     *
     * Set threadId to post into an existing thread. In a forum or media channel, set threadName, with optional
     * appliedTagIds, to start a new post instead. The result is then the post's first message, whose channelId is the
     * new post's ID. See WebhookMessageInput for the rules that the SDK checks before dispatch
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
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch a message authored by this webhook in its current channel, using a decimal message ID.
     * For a message in a thread, including a forum post, set options.threadId to the thread's ID.
     * Eligible transient read failures have bounded retries
     */
    fetchMessage(
        messageId: string,
        options?: DefaultWebhookMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change this webhook's message and return its updated snapshot.
     * A plain string replaces only the text, as shorthand for `{ content }`.
     * Omitted fields stay unchanged.
     * Mentions default off and attachments cannot be replaced.
     * A flags-only edit replaces only MessageFlags.SuppressEmbeds and MessageFlags.SuppressNotifications, and 0 clears them.
     * Crossposted, IsCrosspost and SourceMessageDeleted are server-managed.
     * Those bits and VoiceMessage fail locally before dispatch.
     * Embed input cannot resolve existing file references.
     * For a message in a thread, including a forum post, set options.threadId to the thread's ID
     */
    editMessage(
        messageId: string,
        input: WebhookMessageEdit | string,
        options?: DefaultWebhookMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete this webhook's message, succeeding with no value after HTTP 204.
     * For a message in a thread, including a forum post, set options.threadId to the thread's ID.
     * Success does not prove it previously existed.
     * A failure with an unknown outcome can follow a completed deletion
     */
    deleteMessage(
        messageId: string,
        options?: DefaultWebhookMessageOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Permanently stop this local client, reject new work, cancel active work and await transport cleanup.
     * The client's token reference is released, but the remote webhook and caller-held credentials remain.
     * Concurrent calls wait for the same pending cleanup.
     * No expected failure is returned
     *
     * @remarks
     * Unexpected cleanup failures reject with SdkDefect
     */
    shutdown(): ResultAsync<void, never>
    /**
     * Shut down this client and wait for cleanup, as `await using` does at the end of a block.
     * Unexpected cleanup failures reject with SdkDefect, as shutdown does
     */
    [Symbol.asyncDispose](): Promise<void>
}

/**
 * Create a client that uses one webhook's token rather than bot authentication.
 * Pass { id, token } or the credentials returned by a bot client's webhooks.create.
 * Creation is synchronous, validates locally and makes no request.
 * It copies the credential into a separate reference that hides the token when displayed.
 * Reuse one client per credential to share its request limits and rate waits.
 * The default instance is hosted Fluxer.
 * A self-hosted instance can be selected explicitly.
 * No token store or gateway is created.
 * Always await shutdown in finally when finished.
 * Invalid settings throw ConfigurationError.
 * Unexpected creation failures throw SdkDefect. A throwing option getter or revealToken uses code application.defect
 * with the thrown value as its cause
 *
 * @example
 * ```ts
 * import { createWebhookClient } from "@neontechspace/fluxerly"
 * export async function webhookExample(id: string, token: string) {
 *     await using webhook = createWebhookClient({ id, token })
 *     const message = await webhook.send({ content: "Deploying…" })
 *     return message.isErr() ? message : await webhook.editMessage(message.value.id, { content: "Deployed" })
 * }
 * ```
 *
 * @category Invites and webhooks
 */
export function createWebhookClient(options: WebhookClientOptions): WebhookClient {
    const result = fromExit(Effect.runSyncExit(makeWebhookClient(options)), "createWebhookClient")
    if (result.isErr()) {
        if (result.error instanceof ConfigurationError) throw result.error
        throw new SdkDefect("createWebhookClient", [{ kind: "Failure", failure: result.error }])
    }
    const owner = result.value
    const execute = executeOperation
    const shutdown = () =>
        new ResultAsync<void, never>(
            Effect.runPromiseExit(owner.shutdown()).then((exit) => {
                const result = fromExit(exit, "shutdown")
                if (result.isErr())
                    throw new SdkDefect("shutdown", Exit.isFailure(exit) ? causeReasons(exit.cause) : [])
                return ok(undefined)
            }),
        )
    return Object.freeze({
        id: owner.id,
        instance: Object.freeze({
            resolve: (options?: DefaultInstanceResolveOptions) =>
                execute(owner.instance.resolveInfo(options), "instance.resolve", options),
        }),
        fetch: (options?: DefaultMessageOperationOptions) =>
            execute(
                owner.run("webhooks.fetchToken", () => webhookTokenFetch(owner.id), options),
                "webhooks.fetchToken",
                options,
            ),
        edit: (input: WebhookTokenEdit, options?: DefaultMessageOperationOptions) =>
            execute(
                owner.run("webhooks.editToken", () => webhookTokenEdit(owner.id, input), options),
                "webhooks.editToken",
                options,
            ),
        delete: (options?: DefaultMessageOperationOptions) =>
            execute(
                owner.run("webhooks.deleteToken", () => webhookTokenDelete(owner.id), options),
                "webhooks.deleteToken",
                options,
            ),
        send: (input: WebhookMessageInput | string, options?: DefaultMessageOperationOptions) =>
            execute(
                owner.run("webhooks.send", () => webhookSend(owner.id, input), options),
                "webhooks.send",
                options,
            ),
        fetchMessage: (id: string, options?: DefaultWebhookMessageOperationOptions) =>
            execute(
                owner.run("webhooks.fetchMessage", () => webhookMessageFetch(owner.id, id, options), options),
                "webhooks.fetchMessage",
                options,
            ),
        editMessage: (
            id: string,
            input: WebhookMessageEdit | string,
            options?: DefaultWebhookMessageOperationOptions,
        ) =>
            execute(
                owner.run("webhooks.editMessage", () => webhookMessageEdit(owner.id, id, input, options), options),
                "webhooks.editMessage",
                options,
            ),
        deleteMessage: (id: string, options?: DefaultWebhookMessageOperationOptions) =>
            execute(
                owner.run("webhooks.deleteMessage", () => webhookMessageDelete(owner.id, id, options), options),
                "webhooks.deleteMessage",
                options,
            ),
        shutdown,
        [Symbol.asyncDispose]: async () => {
            await shutdown()
        },
    })
}
