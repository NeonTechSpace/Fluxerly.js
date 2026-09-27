---
"@neontechspace/fluxerly": major
---

Check every validated timestamp, whether received from Fluxer or supplied as a pin cursor, community history cutoff or embed time, with one ISO 8601 grammar: A date, `T`, hours, minutes and seconds, an optional fraction of any length and a `Z` or `±hh:mm` offset, on a real calendar day.
Accepted values stay exactly as received or supplied. Custom status expiry inputs keep their own rules, which also allow omitting seconds, and attachment expiry times remain unchecked text.
`GuildEdit.messageHistoryCutoff` now accepts an offset instead of only UTC, discovery times and community history cutoffs from Fluxer accept offsets, and pin cursors and message, pin and community times accept fractions longer than nine digits

Migration: Member join and timeout times, invite times, ban times and channel last-pin times received in any other form, such as without seconds or a zone, are now rejected. Before, only the date was checked and `Date.parse` had to accept the value
