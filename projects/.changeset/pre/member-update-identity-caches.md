---
"@neontechspace/fluxerly": patch
---

With the users or direct-message cache enabled, a member update now removes that member's cached user and clears cached direct-message channels before handlers run, in both entry points. Fluxer reports username and other account changes to bots through member updates, so cached users and DM recipients could show the old identity. Automatic gateway event selection keeps member updates for these caches even without a `guildMemberUpdate` handler. Later reads fetch fresh snapshots, and snapshots already returned stay unchanged
