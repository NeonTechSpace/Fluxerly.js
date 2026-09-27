---
"@neontechspace/fluxerly": patch
---

Pace presence, member-subscription, member-chunk, count and `gateway.send` commands on each gateway connection to at most 500 in any 60-second window, sent in order, so they stay within Fluxer's budget of 600 payloads per connection instead of closing it with 4008. Heartbeats, Identify and Resume are never delayed behind them
