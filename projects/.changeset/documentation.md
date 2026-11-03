---
"@neontechspace/fluxerly": patch
---

Documentation corrections:

- Messages: Message sends and replies accept `MessageFlags.VoiceMessage` for a voice note. Flags in an edit of the bot's own message replace Fluxer's sendable set, so they also clear `MessageFlags.VoiceMessage` on a voice note, and an edit cannot set it again. On another author's message, Fluxer changes only `SuppressEmbeds`. New uploads in an edit accept `duration` and `waveform`. Received attachment and embed media flags are explained. Cached channels and direct messages keep `lastMessageId` from when they were observed, since sending does not update it
- API reference: Corrections cover reaction moderation permissions, search scope, sort order, media and extension filters, nonce scope, forum webhook retries, own-nickname permissions, webhook destinations, locked threads, malformed events, overflow and concurrency defaults, startup budgets, supervisor startup and process splits, Resume replay and test wait deadlines
- Rate limits: The client's rate-limit notes describe route, unidentified and supervisor-shared pauses as they work
- Runtime: The `drainMs` option of `runBot` says the drain covers only running work and recommends a stop timeout of about 30 seconds, as the deployment guide does. The `gateway.send` reference says a session loaded from a session store after a restart starts with an empty send history. Client shutdown docs say that a kept client or failure report still holds the token string used to mask logs
- Threads: A thread search that waits for Fluxer's index says to try again after a few seconds, and `threadMembersUpdate` says that it leaves out the presence Fluxer sends with joined members
- Errors: The `errors.isRetryable` reference says a retryable failure from `run` needs a new client, and the codes reference explains the two meanings of `supervisor.spawn`
- Testing and commands: The testing guide names `commands.memoryCooldowns()`, argument schemas say which keys throw, and the Effect `keepTyping` says which Clock times its refresh
- Permissions: The Permissions overview gives the write range, 0n through 2^63-1, beside the unsigned 64-bit range that reads and checks accept
- OAuth: The OAuth client overviews name `fetchGuilds` and `fetchConnections` for the user's communities and connections, and `authorizationUrl` says that Fluxer's `prompt` parameter is not supported
- Agent guide: The packaged agent guide says that the Effect API's `setup` gets only the client, and that a test bot's `say()` includes sends a `rest.respond` fixture rejected
- Raw requests: The `client.rest.request` reference and the raw requests guide say that `logging.unsafe` prints masked request and response bodies for the `rest` category. They used to say that logs never contain a body
- Messages: The `Message` reference no longer says that every explicit null is kept. The `embeds`, `attachments` and `stickers` arrays are empty when Fluxer sent null, and a member of an attachment or embed that Fluxer sent as null is left out
- Field names: Members whose name differs from Fluxer's field name in more than case, such as `User.displayName`, `Message.createdAt`, `Message.mentionRoleIds`, `DiscoveryGuild.categoryId` and the thread `autoArchiveMinutes`, now name Fluxer's field, such as `global_name`, `timestamp`, `mention_roles`, `category_type` and `thread_metadata.auto_archive_duration`, so a search for Fluxer's name finds them
- Left-out fields: The references now say which fields Fluxer sends that a result leaves out, why, and how to read them with a raw request or the `raw` event: Emoji and sticker `nsfw`, the message search `cursor` and full search channels, the OAuth user information `sub`, the profile `guild_member`, the reaction `session_id`, the thread member `muted` and `mute_config` and the message `call`
- Invites: The `InviteCreate` reference says that the SDK's defaults, a lifetime of 86,400 seconds and `unique: true`, differ from Fluxer's own, no expiry and `unique: false`, and that `maxAgeSeconds: 0` and `unique: false` give Fluxer's behavior
- Voice states: The `isE2eeCapable` reference and the communities and permissions guide no longer call the flag end-to-end encrypted voice. It marks a client that supports Fluxer's encrypted call media, and Fluxer's server issues that key, so it is not end-to-end encryption
