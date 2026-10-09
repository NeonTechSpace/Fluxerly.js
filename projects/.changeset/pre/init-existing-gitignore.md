---
"@neontechspace/fluxerly": patch
---

The `fluxerly init` command no longer refuses a folder that already has a `.gitignore`, such as the one the Create a bot guide has readers write before the quick start. It keeps that file and appends `node_modules` and `.env` only when a line is missing, leaving the rest and its line endings as they were, and a failed run still leaves the file untouched. Its next steps now link the guide that explains how to get the token and invite the bot to a community, and the quick start presents `init` before saving the token by hand. The missing-token hint no longer tells projects created by `init` to copy `.env.example`, because init already writes the `.env` file, and now says to set `FLUXER_BOT_TOKEN` in it
