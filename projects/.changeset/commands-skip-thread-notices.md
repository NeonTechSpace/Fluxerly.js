---
"@neontechspace/fluxerly": patch
---

Prefix commands now run only for messages a person typed, meaning the `Default` and `Reply` message types, and skip every other type. When a thread is created, Fluxer posts a notice of type 18 into the parent channel, with the thread's name as its content and the thread's creator as its author, so a thread named `!ping` ran the `!ping` command as its creator. The message `type` is now part of `MessageCore`, so every client keeps it, even with a `messageFields` selection that leaves it out. A message without a `type`, such as a hand-built test message, still counts as typed
