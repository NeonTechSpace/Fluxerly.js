import type { Message, MessageDeletion, MessageBulkDeletion } from "./messages.js"

/** Implemented gateway events and their frozen payloads. No subscription history, cache reconstruction or REST-generated notifications */
export interface EventMap {
    /** Newly created message with text, deeply frozen embeds and attachment metadata, never file bytes. Malformed known message data fails the connection as a protocol error */
    readonly messageCreate: Message
    /** Current message projection, not an old/new pair or partial patch. Non-text changes may repeat the same projected values */
    readonly messageUpdate: Message
    /** Single deletion with required message/channel IDs and only the optional context supplied by Fluxer */
    readonly messageDelete: MessageDeletion
    /** One batch with channel and message IDs. Subscribe to both deletion types to observe both forms */
    readonly messageDeleteBulk: MessageBulkDeletion
}

/** Names accepted by on/events in both API styles */
export type EventName = keyof EventMap

/** Pending queue budgets for one live event subscription or message collector, not total process memory limits */
export interface EventBufferOptions {
    /** Maximum queued event payloads, excluding active handlers. A bulk deletion counts once. Positive safe integer, default 256 */
    readonly maxPendingMessages?: number
    /** Maximum queued source-JSON bytes, including the full bulk payload. Positive safe integer, default 4,194,304 */
    readonly maxPendingBytes?: number
}

/** Callback scheduling shared by default and native consumption */
export interface HandlerOptions extends EventBufferOptions {
    /** Active invocations per registration. Defaults to 1, with receive-order starts but no concurrent completion order */
    readonly concurrency?: number
}

/** Safe diagnostic metadata. Intentionally excludes message bodies, credentials and original handler errors */
export interface HandlerErrorReport {
    /** Event whose subscription reported this failure */
    readonly event: EventName
    /** Handler failures continue delivery. Overflow permanently stops this subscription */
    readonly kind: "handler" | "overflow"
}
