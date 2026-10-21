---
"@neontechspace/fluxerly": patch
---

A session saved by `sharding.sessions` is now resumed at most once. Before, a restart that resumed a saved session and then crashed left the old snapshot in the store, so a restart within 60 seconds of the original shutdown could resume it again and receive the same dispatches a second time, including any dispatch that caused the crash. Before resuming, startup now saves a copy of the loaded snapshot with an empty `sessionId`. A later load of that copy starts a new session and logs `lifecycle.sessionSnapshotIgnored` at Warn, until the next shutdown saves a resumable session again. Custom stores receive this extra `save` call at startup. If it fails, the shard logs `lifecycle.sessionSaveFailed` and starts a new session instead of resuming

Durations in log messages no longer read "1 min 60 s" or "60.0 s" near a minute boundary, or "1000 ms" just below a second. They now read "2 min 0 s", "1 min 0 s" and "1.0 s"

A command reply for a rejected `duration` argument now shows its bounds in the argument's own syntax, such as "from 1s to 1h30m", instead of in milliseconds such as "from 1000 ms to 5400000 ms"
