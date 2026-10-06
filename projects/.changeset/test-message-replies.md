---
"@neontechspace/fluxerly": major
---

Test clients in both testing entry points now answer message sends (`POST /channels/:id/messages`) and edits (`PATCH /channels/:id/messages/:id`) that no `rest.respond` registration matches. The reply is a message by the bot account that echoes the request's content, embeds, flags and tts, so a first test needs no response fixture. A registered response still wins, and other unmatched requests still receive a 404 with a `testing.unmatchedRequest` Warn

Migration: A test that relied on the 404 for an unmatched message send or edit registers that failure with `rest.respond`
