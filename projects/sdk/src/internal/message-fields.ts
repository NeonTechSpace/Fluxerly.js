import { ConfigurationError } from "#sdk/errors"
import { decodeMessage } from "./message.js"
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
    createdAt: true,
    editedAt: true,
    type: true,
    flags: true,
    mentionedEveryone: true,
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
}

/** Snapshot public field names once, without retaining the caller's array or constructing message data */
export function snapshotMessageFields(value: unknown): ReadonlySet<MessageField> | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value))
        throw new ConfigurationError("messageFields", "messageFields must be an array of known Message field names")
    const selected = new Set<MessageField>()
    for (const field of value) {
        if (typeof field !== "string" || !Object.hasOwn(fields, field))
            throw new ConfigurationError("messageFields", "messageFields must be an array of known Message field names")
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
