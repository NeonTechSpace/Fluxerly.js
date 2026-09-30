---
"@neontechspace/fluxerly": patch
---

Clear a shard's cached communities and dependent resources when partial replay of a saved session falls back to Identify. Clear reads cached during the outage again at `READY`, while retaining replayed observations after a successful Resume

Make the in-memory test gateway enforce the session's Identify event filtering, including message mention exceptions and filtering retained across Resume. Emitting a dispatch Fluxer would suppress now fails with `ConfigurationError` instead of making an unrealistic test pass

Keep `MESSAGE_REACTION_ADD` available under automatic filtering when a `messageReactionAddMany` handler is registered, because Fluxer generates reaction batches only from unsuppressed additions. Test reaction batches use the same source filter, including when an explicit list ignores only the generated batch name
