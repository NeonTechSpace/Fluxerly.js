---
"@neontechspace/fluxerly": minor
---

`GuildFeatureToggles.VisitsEnabled` lets `guilds.edit` keep community visits on. Fluxer now enables `VISITS_ENABLED` for new communities and removes every toggleable feature that a `featureToggles` list leaves out, so an edit without it turns visits off and ends current visits. Before this, the SDK rejected `VISITS_ENABLED` locally, so every `featureToggles` edit turned visits off
