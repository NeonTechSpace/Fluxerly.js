---
"@neontechspace/fluxerly": minor
---

Add `messages.fetchHasReaction` to both APIs. It answers whether one user currently has a given reaction on a message, with one request and no cache, so bots with reaction roles, verification or voting can recheck a reaction after being offline. A deleted or unavailable message fails instead of answering false
