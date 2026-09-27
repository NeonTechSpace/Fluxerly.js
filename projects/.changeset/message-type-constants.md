---
"@neontechspace/fluxerly": minor
---

Add `MessageType` constants to both entry points, naming the values of `Message.type`, for example `message.type === MessageType.UserJoin`. They cover every message type in Fluxer's message schema: Default, RecipientAdd, RecipientRemove, Call, ChannelNameChange, ChannelIconChange, ChannelPinnedMessage, UserJoin and Reply.
`Message` stays one shape rather than a union by type, because Fluxer returns the same message fields for every type. A value Fluxer adds later is still kept in `Message.type`
