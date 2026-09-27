---
"@neontechspace/fluxerly": minor
---

Add the advanced `transport` client option. Its `fetch` and `webSocket` settings replace the HTTP and WebSocket implementations, for example for proxies, instrumentation or tests, and `userAgent` replaces the User-Agent header.
Replacements receive every client request, including instance discovery, REST, signed upload parts, attachment downloads and gateway connections. Invalid values throw `ConfigurationError` naming the field in the default API and are defects in the Effect API.
Bot, webhook and OAuth clients now send `User-Agent: Fluxerly.js/<version> (+https://fluxerly.neontechspace.com)` with every HTTP request and gateway handshake. A configured `transport.userAgent` replaces it for a bot client.
Custom WebSocket factories receive the handshake headers, including the User-Agent, in `WebSocketOptions.headers`
