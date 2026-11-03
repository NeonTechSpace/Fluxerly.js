---
title: Where do I…?
navTitle: Where do I…?
description: Find the guide or API for a common bot task
---

Find a task below and follow its link to the guide section or reference page that covers it. Unfamiliar terms are defined in the [glossary](/docs/glossary/)

## Start

- [Create a Fluxer application and get its token](/docs/create-a-bot/)
- [Add the bot to a community](/docs/create-a-bot/#3-invite-the-bot-to-a-community)
- [Run a first bot that answers !ping](/docs/quick-start/)
- [Build a bot with commands, a welcome message and clean shutdown](/docs/small-bot/)
- [Understand clients, events, Results and caches](/docs/core-concepts/)
- [Run code when the bot is connected](/docs/starter-lifetime/#run-code-once-the-bot-is-connected)
- [Copy a complete example bot](/docs/examples/)

## Messages

- [Reply to a message and check the result](/docs/messages/#reply-to-a-message-and-check-what-happened)
- [Mention a user or role safely](/docs/messages/#mention-someone-deliberately)
- [Edit a sent message](/docs/messages/#send-then-edit-the-returned-message)
- [Send an embed](/docs/messages/#build-an-embed)
- [Attach or download a file](/docs/messages/#upload-a-small-generated-file)
- [Send a direct message](/docs/messages/#send-a-requested-direct-message)
- [Send a voice note](/docs/messages/#mark-media-as-explicit-or-send-a-voice-note)
- [Start a thread in a channel](/docs/threads/#create-a-thread)
- [Start a post in a forum channel](/docs/forum-channels/#start-posts)
- [Publish a message in an announcement channel](/docs/announcement-channels/#send-a-message-then-publish-it)
- [Add a reaction to a message](/docs/emoji-and-stickers/#find-an-emoji-and-use-it-twice)
- [Delete a message](/docs/api/js-ts/messages/#messages-delete)
- [Clear recent messages in a channel](/docs/examples/#moderation-commands)
- [Use custom emoji and stickers](/docs/emoji-and-stickers/)
- [Post through a webhook without a bot connection](/docs/webhooks-and-oauth/#send-through-a-configured-webhook)
- [Look up every message method](/docs/api/js-ts/messages/#messages)

## Commands

- [Register prefix commands](/docs/commands/#register-commands)
- [Parse command arguments](/docs/commands/#convert-arguments-before-execution)
- [Restrict a command with guards, cooldowns or middleware](/docs/commands/#guard-limit-and-wrap-commands)
- [Generate a help command](/docs/commands/#add-help-from-the-registered-commands)
- [Configure commands in runBot](/docs/api/js-ts/client-and-lifecycle/#runbot)
- [Look up the built-in guards](/docs/api/js-ts/commands/#guards)

## Events

- [Welcome new members](/docs/examples/#welcome-messages)
- [Wait for one future event](/docs/events-and-collectors/#wait-for-one-future-event)
- [Ask a question and collect the reply](/docs/events-and-collectors/#ask-a-question-without-missing-a-fast-reply)
- [Collect reactions](/docs/events-and-collectors/#accept-a-confirmation-reaction)
- [Check whether one user reacted](/docs/api/js-ts/messages/#messages-fetchhasreaction)
- [Run code around every handler](/docs/api/js-ts/client/#use)
- [Look up the handler registration options](/docs/api/js-ts/client/#on)

## Communities and permissions

- [Read a community and its members](/docs/guilds-and-permissions/#read-a-community-and-one-member-together)
- [Check permissions](/docs/guilds-and-permissions/#check-permissions-using-available-data)
- [Check whether the bot or a moderator outranks a member](/docs/api/js-ts/guilds-and-members/#members-fetchcanmanage)
- [Give a member a role](/docs/guilds-and-permissions/#grant-a-configured-opt-in-role)
- [Give a role an icon](/docs/guilds-and-permissions/#give-a-role-an-icon)
- [Kick, ban or time out a member](/docs/guilds-and-permissions/#moderate-members)
- [Look up member and role methods](/docs/api/js-ts/guilds-and-members/#members)

## Data and cache

- [Search or scan message history](/docs/history-and-cache/)
- [Turn on and size the caches](/docs/configuration/#cache)
- [Read from the cache and fetch when data is missing](/docs/history-and-cache/#use-the-cache-then-fetch-if-needed)
- [Call a Fluxer API route that has no SDK method](/docs/api/endpoints/)
- [Ask for a person's consent with OAuth](/docs/webhooks-and-oauth/#create-a-user-consent-url)
- [Keep data across restarts](/docs/starter-lifetime/#keep-reminders-across-restarts)

## Production

- [Choose client options](/docs/configuration/)
- [Read and configure log output](/docs/logging/)
- [Set the bot's status](/docs/api/js-ts/client-and-lifecycle/#presence-set)
- [Schedule a task or reminder](/docs/starter-lifetime/#run-work-later-or-on-a-schedule)
- [Handle failures that have no Result](/docs/reliability/#report-failures-that-have-no-result)
- [Retry a failed request safely](/docs/reliability/#send-once-when-the-outcome-is-uncertain)
- [Stop the bot cleanly](/docs/starter-lifetime/)
- [Deploy the bot](/docs/deploying/)
- [Split a large bot into shards](/docs/sharding/)
- [Watch subscriptions and finish application work before exit](/docs/application-supervision/)
- [Look up every client option](/docs/api/js-ts/options/#clientoptions)

## Testing

- [Test a bot without Fluxer](/docs/testing/)
- [Test a runBot bot with its own options](/docs/testing/#share-the-bots-options-with-its-tests)
- [Test handlers registered with client.on](/docs/testing/#test-handlers-registered-with-clienton)
- [Look up the test client](/docs/api/testing/)

## Effect

- [Write a first bot with Effect](/docs/effect-first-bot/)
- [Handle failures, collect replies and run reads together](/docs/effect-workflows/)
- [Provide the client as a service and test with Layers](/docs/effect-application-testing/)
- [Test a native runBot bot against an in-memory Fluxer](/docs/effect-application-testing/#test-a-runbot-bot-against-an-in-memory-fluxer)
- [Look up the Effect entry point](/docs/api/effect/)
- [Look up the Effect test client](/docs/api/effect-testing/)

## Help

- [Match a log line with its fix](/docs/troubleshooting/#match-a-log-line-with-its-fix)
- [Look up an error or log code](/docs/codes/)
- [Find out why the bot does not reply](/docs/troubleshooting/#no-reply-arrives)
- [Read short answers to common questions](/docs/faq/)
- [Look up a term](/docs/glossary/)
- [Check Node.js, TypeScript and Effect requirements](/docs/support-and-compatibility/)
- [Get help or report a vulnerability](/docs/support-and-compatibility/#get-help)
- [Browse the API reference by task](/docs/api/tasks/)
