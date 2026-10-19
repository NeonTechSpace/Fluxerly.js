// Which gateway frames the capture harness may retain. A frame is kept only when it belongs to the harness's own
// temporary channel and its actor is the sandbox bot, so another member's message, reaction or typing in that channel
// is never recorded. The thumbs-up emoji is the only reaction the harness adds

/** The emoji the capture harness reacts with */
export const captureEmoji = "\u{1F44D}"

/**
 * Whether a dispatch is the bot's own activity in the harness's channel. `channel` holds the journaled marker name and
 * the returned ID when known. Channel dispatches have no actor, and are recognized by the ID or, for creation, the name
 */
export function retainFrame(type, body, { channel, botId }) {
    if (typeof body !== "object" || body === null || !channel) return false
    if (type.startsWith("CHANNEL_"))
        return (
            (channel.id !== undefined && body.id === channel.id) ||
            (type === "CHANNEL_CREATE" && body.name === channel.name)
        )
    if (channel.id === undefined || body.channel_id !== channel.id) return false
    if (type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE") return body.author?.id === botId
    if (type === "MESSAGE_DELETE") return body.author_id === botId
    if (type === "MESSAGE_REACTION_ADD" || type === "MESSAGE_REACTION_REMOVE")
        return body.user_id === botId && body.emoji?.id == null && body.emoji?.name === captureEmoji
    if (type === "TYPING_START") return body.user_id === botId
    return false
}
