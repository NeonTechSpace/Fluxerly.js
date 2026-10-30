---
"@neontechspace/fluxerly": minor
---

Roles can have icons. `GuildRole` now has `icon`, the image's hash, next to `unicodeEmoji`, and `assets.roleIcon` builds the image's URL. `RoleCreate` and `RoleEdit` take `icon`, an image data URI, and `unicodeEmoji`, where null removes the icon and setting one replaces the other. `RoleCreate` also takes `iconSourceRoleId` to copy another role's icon. The input fails locally when it sets an image together with an emoji or a role to copy from, and the everyone role accepts neither field
