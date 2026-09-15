---
"@neontechspace/fluxerly": patch
---

Reject malformed array entries using their indexed values while preserving documented local bounds

Reject impossible calendar dates in embed timestamps, pin cursors, guild history cutoffs and status expiry before dispatch or retention. Apply the same calendar validation to received message, pin, channel, guild, member, invite, ban and discovery timestamps while preserving each field's existing timezone and precision rules
