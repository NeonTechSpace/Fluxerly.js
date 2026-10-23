---
"@neontechspace/fluxerly": patch
---

The `messages.deleteOwnMessages` comments now describe Fluxer's wider deletion. Called with a channel ID, it also deletes the bot's messages in every thread under that channel, active or archived, and for a forum or media channel it deletes the bot's messages in its posts. Called with a thread ID, it still clears only that thread
