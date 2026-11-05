---
"@neontechspace/fluxerly": major
---

Lists that Fluxer caps at 10,000 entries now fail before sending when they are longer, with reason `input`, constraint `length` and an explanation that names the cap. This covers `permissionOverwrites` on channel creation and channel edits, channel position updates, role position updates and role hoist position updates. Fluxer refuses such a list, so it used to fail remotely

- Channel, role and role hoist position updates no longer check their encoded size, since 10,000 entries stay far below Fluxer's body limits. A position list that used to fail on its size now fails on its entry count
  Affected: Code that sends more than 10,000 entries in one of these lists, or matches constraint `size` on a position update
  Migration: Send at most 10,000 entries, and match constraint `length`
