/**
 * Message field selection shared by gateway and REST message projections.
 * Invariant: The selection is snapshotted once, and one decoder serves every message projection for a client.
 * Implements [SDK contracts: Public API model](/docs/SDK-CONTRACTS.md#public-api-model)
 */
import { ConfigurationError } from "#sdk/errors"
import { decodeGatewayMessage, decodeMessage } from "./message.js"
import type { MessageCore, MessageField, MessageFields, SelectedMessage } from "#sdk/messages"

/** Internal observation when the caller's runtime selection is not known statically */
export type MessageObservation = SelectedMessage<MessageFields>

const fields: Record<MessageField, true> = {
    id: true,
    channelId: true,
    content: true,
    author: true,
    guildId: true,
    nonce: true,
    webhookId: true,
    pinned: true,
    tts: true,
    createdAt: true,
    editedAt: true,
    type: true,
    flags: true,
    mentionedEveryone: true,
    mentionedHere: true,
    channelType: true,
    nicknames: true,
    embeds: true,
    attachments: true,
    stickers: true,
    mentions: true,
    referencedUsers: true,
    mentionRoleIds: true,
    nsfwEmojiIds: true,
    mentionChannels: true,
    reactions: true,
    messageReference: true,
    messageSnapshots: true,
    referencedMessage: true,
    thread: true,
    member: true,
}

/** Snapshot public field names once, without retaining the caller's array or constructing message data */
export function snapshotMessageFields(value: unknown): ReadonlySet<MessageField> | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value))
        throw new ConfigurationError(
            "messageFields",
            "The option messageFields must be an array of known Message field names",
        )
    const selected = new Set<MessageField>()
    for (const field of value) {
        if (typeof field !== "string" || !Object.hasOwn(fields, field))
            throw new ConfigurationError(
                "messageFields",
                "The option messageFields must be an array of known Message field names",
            )
        selected.add(field as MessageField)
    }
    return selected
}

/** One validated client selection, shared by gateway and REST message projections */
export type MessageDecoder<M extends MessageCore> = (value: unknown) => M | undefined

export function createMessageDecoder<F extends MessageFields | undefined = undefined>(
    fields: ReadonlySet<MessageField> | undefined,
): MessageDecoder<SelectedMessage<F>> {
    // Configuration validates and copies F before binding this projection
    return ((value: unknown) => decodeMessage(value, fields)) as MessageDecoder<SelectedMessage<F>>
}

/** The gateway dispatch types that carry a message, which differ in the fields they add */
export type GatewayMessageDispatch = "MESSAGE_CREATE" | "MESSAGE_UPDATE"

/** One validated client selection for gateway dispatches, given the type of the dispatch being decoded */
export type GatewayMessageDecoder<M extends MessageCore> = (
    value: unknown,
    type: GatewayMessageDispatch,
) => M | undefined

/** The same selection for gateway dispatches, which alone can carry the author's member and the fields of a created message */
export function createGatewayMessageDecoder<F extends MessageFields | undefined = undefined>(
    fields: ReadonlySet<MessageField> | undefined,
): GatewayMessageDecoder<SelectedMessage<F>> {
    return ((value: unknown, type: GatewayMessageDispatch) =>
        decodeGatewayMessage(value, fields, type)) as GatewayMessageDecoder<SelectedMessage<F>>
}
