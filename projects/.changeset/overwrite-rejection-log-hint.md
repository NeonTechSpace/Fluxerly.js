---
"@neontechspace/fluxerly": patch
---

The `rest.rejected` Warn record logged for a refused permission overwrite write now carries a precise `fields.hint`. Before, a 403 `MISSING_PERMISSIONS` on setting or removing a channel's permission overwrite logged the general missing-permission hint. Now the hint is the one that `channels.setPermissionOverwrite` and `channels.removePermissionOverwrite` already put on their errors: It names Manage roles, where the channel's permission overrides title it "Manage permissions", the rule that the bot can allow, or stop denying, only permissions it has in the channel (for a removal, that it needs every permission the overwrite denies), and the `permissionBits.refusedGrants` helper. No code change is needed
