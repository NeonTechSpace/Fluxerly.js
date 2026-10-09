---
"@neontechspace/fluxerly": minor
---

`PresenceUpdate`, and so each entry of `PresenceUpdateBulk` and of the presences in a member chunk, now carries `customStatus` in both entry points, instead of dropping the custom status Fluxer sends. The value is `null` when the account has none, which includes an offline or invisible account because Fluxer hides the status of one, and otherwise an `ObservedCustomStatus` with `text`, `emoji` and `expiresAt`. The `emoji` field is `null` or an `ObservedCustomStatusEmoji` with `id`, `name` and `animated`, so a custom emoji keeps its ID and animation flag and a Unicode emoji has a name and no ID and always reads as `animated: false`. Fluxer stores custom statuses without validating them, so a field of the wrong type reads as `null` and the presence is still delivered
