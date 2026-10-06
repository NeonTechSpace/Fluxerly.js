---
title: Example bots
navTitle: Examples
description: Small, complete bots for moderation, reaction roles, welcomes and tickets, ready to copy and run
---

Each example on this page is one complete file built on `runBot`. Copy it, set a few environment variables and run it. Every example logs failures in full and stops cleanly on Ctrl+C

Start with the [small bot](/docs/{{version}}/small-bot/) for a guided tour of commands, arguments, embeds, events, guards and cooldowns in one file. The examples below each solve one common task

## Run an example

Set up a project as in the [quick start](/docs/{{version}}/quick-start/): A folder with `"type": "module"` in `package.json` and the SDK installed. Save the example as `bot.js`, or as `bot.ts` to keep the TypeScript version, which Node.js 24 runs directly

Put the token and the example's other variables in a `.env` file, one `KEY=value` line each, and keep that file out of version control

```text
FLUXER_BOT_TOKEN=paste-the-token-here
WELCOME_CHANNEL_ID=123456789012345678
```

Start the bot with Node.js loading that file:

```command
{"kind":"run","command":"node --env-file=.env bot.js"}
```

A missing variable stops the bot at startup with an explanation. Channels, roles and messages are configured by their decimal [IDs](/docs/{{version}}/glossary/#id). The [deploying guide](/docs/{{version}}/deploying/) shows how to keep a bot running on a server

### Give the bot its permissions

The invite in [Create a bot](/docs/{{version}}/create-a-bot/#3-invite-the-bot-to-a-community) grants only what the quick start needs. Each example below lists the permissions it needs, and without them its requests fail with a missing-permissions error

For a bot that is already in the community, edit the role Fluxer created for it, which has the application's name, and turn on the listed permissions in the community's role settings. For a bot that is not in the community yet, pass the listed names to the invite script instead, for example for the moderation example:

```ts
import { links, permissionBits } from "@neontechspace/fluxerly"

const applicationId = process.argv[2] ?? ""
const permissions = permissionBits.from([
    "ViewChannel",
    "SendMessages",
    "ReadMessageHistory",
    "ModerateMembers",
    "KickMembers",
    "BanMembers",
    "ManageMessages",
])
console.log(links.installation(applicationId, { permissions }))
```

Some examples also change roles or members. Fluxer allows that only when the bot's highest role ranks above them, so place the bot's role above those roles in the role settings

## Moderation commands

Five prefix commands for moderators: `!timeout @member 10m reason` stops a member from talking for 1 minute to 7 days, `!kick @member reason` removes a member from the community, `!ban @member reason` bans a member permanently, `!tempban @member 7d reason` bans a member for 1 minute to 2 years, and `!clear 20` deletes up to 20 recent messages in the channel. Each reason is optional. Each command has a [guard](/docs/{{version}}/glossary/#guard) that checks the moderator's own permission. The `!timeout`, `!kick`, `!ban` and `!tempban` commands also refuse a member who ranks at or above the moderator, which `members.fetchCanManage` checks with the moderator's ID as `actorUserId`. When a command fails, a [middleware](/docs/{{version}}/glossary/#middleware) function tells the moderator without showing error details in the channel

- Variables: `FLUXER_BOT_TOKEN`
- Bot permissions: `ViewChannel`, `SendMessages`, `ReadMessageHistory`, `ModerateMembers`, `KickMembers`, `BanMembers` and `ManageMessages`. The bot's highest role must also rank above the members it acts on
- Moderator permissions: `ModerateMembers` for `!timeout`, `KickMembers` for `!kick`, `BanMembers` for `!ban` and `!tempban`, and `ManageMessages` for `!clear`
- Two-factor authentication: In a community that requires it for moderation, every command fails with HTTP 400 unless the account that owns the bot's application has it enabled. See [communities that require two-factor authentication](/docs/{{version}}/guilds-and-permissions/#communities-that-require-two-factor-authentication)

```ts
{{example:moderation/bot.ts}}
```

The `!clear` command previews the exact messages first and then deletes only those. The reply reports how many deletions were requested, because Fluxer confirms each batch rather than each message. See [the source on GitHub](https://github.com/NeonTechSpace/Fluxerly.js/tree/main/projects/sdk/examples/moderation)

## Reaction roles

Members react to one existing message to receive an opt-in role, and remove their reaction to give it back. At startup, the bot checks that it ranks above the role and adds the emoji to the message itself, so members can see which one to use

- Variables: `FLUXER_BOT_TOKEN`, `ROLE_CHANNEL_ID` and `ROLE_MESSAGE_ID` for the message, `ROLE_ID` for the role, and an optional `ROLE_EMOJI`, a Unicode emoji that defaults to ✅
- Bot permissions: `ViewChannel`, `ReadMessageHistory`, `AddReactions` and `ManageRoles`. The bot's highest role must rank above the configured role

```ts
{{example:reaction-roles/bot.ts}}
```

Configure only a role that members may give themselves. The bot sees only reactions made while it runs, so a member who reacted while it was offline removes the reaction and adds it again. See [the source on GitHub](https://github.com/NeonTechSpace/Fluxerly.js/tree/main/projects/sdk/examples/reaction-roles) and [communities and permissions](/docs/{{version}}/guilds-and-permissions/) for more about role hierarchy

## Welcome messages

The bot greets each new member in a configured channel with a mention and an embed, and can also give every new member a starter role. It ignores joins in other communities and joining bots

- Variables: `FLUXER_BOT_TOKEN`, `WELCOME_CHANNEL_ID`, and an optional `WELCOME_ROLE_ID` for the starter role
- Bot permissions: `ViewChannel`, `SendMessages` and `EmbedLinks` in the welcome channel, plus `ManageRoles` when `WELCOME_ROLE_ID` is set. The bot's highest role must then rank above the starter role

```ts
{{example:welcome/bot.ts}}
```

A welcome message that was sent but whose role grant failed stays posted, and the failure is logged. See [the source on GitHub](https://github.com/NeonTechSpace/Fluxerly.js/tree/main/projects/sdk/examples/welcome) and [events and collectors](/docs/{{version}}/events-and-collectors/) for more about member and community events

## Support tickets

A member sends `!ticket` to open a private channel that only they, the staff role and the bot can see. Anyone in that channel sends `!close` to delete it. Each member has at most one open ticket, and a [cooldown](/docs/{{version}}/glossary/#cooldown) allows one `!ticket` per member per minute

- Variables: `FLUXER_BOT_TOKEN`, `TICKET_CATEGORY_ID` for the category that holds tickets, and `TICKET_STAFF_ROLE_ID` for the role that answers them
- Bot permissions: `ManageChannels` and `ManageRoles`, plus `ViewChannel`, `SendMessages` and `ReadMessageHistory` in the ticket category. Fluxer lets the bot grant only permissions it has itself

```ts
{{example:tickets/bot.ts}}
```

The bot reads its own user ID with `client.users.getSelf()`, which returns the account Fluxer reported when the bot connected, without a request. The `!close` command deletes only channels in the ticket category whose names start with `ticket-`. See [the source on GitHub](https://github.com/NeonTechSpace/Fluxerly.js/tree/main/projects/sdk/examples/tickets) and [commands](/docs/{{version}}/commands/) for more about guards and cooldowns
