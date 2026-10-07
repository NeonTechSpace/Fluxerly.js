---
"@neontechspace/fluxerly": patch
---

Prepare for Fluxer threads, which the SDK does not support yet. The `guards.requirePermissions` guard now denies a command, with the reason "This command cannot check permissions in this kind of channel", when the channel has a type this SDK version does not know and Fluxer reads it without permission overwrites, as it does for threads. It previously used only the member's role permissions there, which ignored the parent channel's overwrites. With the channel or message cache enabled, a thread update now removes the cached thread, and a thread deletion also removes its cached messages, so neither stays stale
