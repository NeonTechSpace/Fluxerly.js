---
"@neontechspace/fluxerly": patch
---

The comments on `GuildBan.moderatorId` and `AuditLogEntry.userId` now state that the ID `"0"` is the Fluxer system user. Fluxer records a member removal, ban or ban removal made by its staff under that ID, and a staff ban stores it as the moderator. An invite pause that Fluxer places, lifts or lets expire is also recorded under `"0"` as a `GuildUpdate` entry. Both IDs already decoded, so no behavior changes
