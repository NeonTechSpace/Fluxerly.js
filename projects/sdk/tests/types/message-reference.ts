import type { MessageContextReference, MessageReference, Client } from "../../src/index.js"
import type {
    MessageContextReference as NativeMessageContextReference,
    MessageReference as NativeMessageReference,
    Client as NativeClient,
} from "../../src/effect.js"

export function defaultReference(context: MessageContextReference, client: Client): MessageReference | undefined {
    // @ts-expect-error Received context can identify only a channel, not an operational message target
    const target: MessageReference = context
    // @ts-expect-error Fetch requires a message ID, even if context.type describes a default reference
    void client.messages.fetch(context)
    // @ts-expect-error Reply requires a message ID, not only received channel context
    void client.messages.reply(context, "Reply")
    void target
    if (context.id === undefined) return undefined
    const narrowed: MessageReference = { id: context.id, channelId: context.channelId }
    void client.messages.fetch(narrowed)
    void client.messages.reply(narrowed, "Reply")
    return narrowed
}

export function nativeReference(
    context: NativeMessageContextReference,
    client: NativeClient,
): NativeMessageReference | undefined {
    // @ts-expect-error Received context is not an operational target in the Effect API either
    const target: NativeMessageReference = context
    // @ts-expect-error Effect fetch also requires a present message ID
    void client.messages.fetch(context)
    // @ts-expect-error Effect reply also requires a present message ID
    void client.messages.reply(context, "Reply")
    void target
    if (context.id === undefined) return undefined
    const narrowed: NativeMessageReference = { id: context.id, channelId: context.channelId }
    void client.messages.fetch(narrowed)
    void client.messages.reply(narrowed, "Reply")
    return narrowed
}

const channelOnly: MessageContextReference = { channelId: "70", guildId: "80", type: 0 }
export const nativeChannelOnly: NativeMessageContextReference = channelOnly

// @ts-expect-error Received references still require the source channel ID
export const missingChannel: MessageContextReference = { id: "90" }
// @ts-expect-error Null wire message IDs are omitted instead of exposed as null
export const nullId: NativeMessageContextReference = { channelId: "70", id: null }
