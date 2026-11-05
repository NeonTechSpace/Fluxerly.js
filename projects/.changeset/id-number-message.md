---
"@neontechspace/fluxerly": patch
---

The explanation for an invalid ID now says why IDs must be decimal strings: JavaScript numbers cannot hold Fluxer IDs exactly. An ID passed as a number still fails before sending with reason `input`, even though Fluxer accepts JSON integers, because a number holding a real Fluxer ID has already lost digits
