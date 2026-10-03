---
"@neontechspace/fluxerly": patch
---

Gateway member requests, presence member selection and member count requests now reject IDs above 9223372036854775807 before sending, in both entry points. Fluxer ignores such IDs, so a request could wait until its timeout, and an explicit member list made only of such IDs could turn into a request for all members
