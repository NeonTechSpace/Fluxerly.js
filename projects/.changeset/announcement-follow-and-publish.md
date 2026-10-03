---
"@neontechspace/fluxerly": minor
---

Add `channels.follow`, `channels.fetchFollowerStats`, `messages.publish` and `messages.fetchCrosspostSource` to both APIs for announcement-channel follows, follower counts, message publishing and public source-community lookups. Follow results identify the source channel and the created follower webhook, which can be deleted to stop following. After publishing, the cached source is updated and copies enter the cache only when they arrive. After an unknown outcome, the SDK drops the source from the cache and does not publish again

The `errors.apiCode` helper now names announcement, follow, conversion, publishing and published-message editing rejections, such as `invalidFollowTargetChannel`
