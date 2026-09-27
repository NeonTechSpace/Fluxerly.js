---
"@neontechspace/fluxerly": major
---

The command argument types that pick from a fixed list are renamed to `userChoice`, `channelChoice` and `roleChoice`, next to `choice`, so the names `user`, `channel` and `role` no longer suggest a lookup in the message's community. They still select one of up to 100 `candidates` given at registration.
The old names now fail registration with `ConfigurationError`, whose hint names `{ type: "id", mention }` for any ID or mention, `{ type: "member" }` for a member of the message's community when the old type was `user`, and the new list form

Migration: Replace `type: "user"`, `"channel"` and `"role"` with `"userChoice"`, `"channelChoice"` and `"roleChoice"` in argument schemas, and in code that reads `CommandArgumentMetadata.type`
