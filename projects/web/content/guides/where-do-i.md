---
title: Where do I…?
navTitle: Where do I…?
description: Find the guide or API for a common bot task
---

Find a task below and follow its link to the guide section or reference page that covers it. Unfamiliar terms are defined in the [glossary](/docs/{{version}}/glossary/)

## Start

- [Create a Fluxer application and get its token](/docs/{{version}}/create-a-bot/)
- [Add the bot to a community](/docs/{{version}}/create-a-bot/#3-invite-the-bot-to-a-community)
- [Run a first bot that answers !ping](/docs/{{version}}/quick-start/)
- [Build a bot with commands, a welcome message and clean shutdown](/docs/{{version}}/small-bot/)
- [Understand clients, events, Results and caches](/docs/{{version}}/core-concepts/)
- [Run code when the bot is connected](/docs/{{version}}/core-concepts/#events-and-handlers)
- [Copy a complete example bot](/docs/{{version}}/examples/)

## Messages

- [Reply to a message and check the result](/docs/{{version}}/messages/#reply-to-a-message-and-check-what-happened)
- [Mention a user or role safely](/docs/{{version}}/messages/#mention-someone-deliberately)
- [Edit a sent message](/docs/{{version}}/messages/#send-then-edit-the-returned-message)
- [Send an embed](/docs/{{version}}/messages/#build-an-embed)
- [Attach or download a file](/docs/{{version}}/messages/#upload-a-small-generated-file)
- [Send a direct message](/docs/{{version}}/messages/#send-a-requested-direct-message)
- [Use custom emoji and stickers](/docs/{{version}}/emoji-and-stickers/)
- [Post through a webhook without a bot connection](/docs/{{version}}/webhooks-and-oauth/#send-through-a-configured-webhook)
- [Look up every message method](/docs/{{version}}/api/interfaces/js-ts.Messages/)

## Commands

- [Register prefix commands](/docs/{{version}}/commands/#register-commands)
- [Parse command arguments](/docs/{{version}}/commands/#convert-arguments-before-execution)
- [Restrict a command with guards, cooldowns or middleware](/docs/{{version}}/commands/#guard-limit-and-wrap-commands)
- [Generate a help command](/docs/{{version}}/commands/#add-help-from-the-registered-commands)
- [Configure commands in runBot](/docs/{{version}}/api/modules/js-ts/#runbot)
- [Look up the built-in guards](/docs/{{version}}/api/modules/js-ts/#guards)

## Events

- [Welcome new members](/docs/{{version}}/examples/#welcome-messages)
- [Wait for one future event](/docs/{{version}}/events-and-collectors/#wait-for-one-future-event)
- [Ask a question and collect the reply](/docs/{{version}}/events-and-collectors/#ask-a-question-without-missing-a-fast-reply)
- [Collect reactions](/docs/{{version}}/events-and-collectors/#accept-a-confirmation-reaction)
- [Run code around every handler](/docs/{{version}}/api/interfaces/js-ts.Client/#use)
- [Look up the handler registration options](/docs/{{version}}/api/interfaces/js-ts.Client/#on)

## Communities and permissions

- [Read a community and its members](/docs/{{version}}/guilds-and-permissions/#read-a-community-and-one-member-together)
- [Check permissions](/docs/{{version}}/guilds-and-permissions/#check-permissions-using-available-data)
- [Check whether the bot or a moderator outranks a member](/docs/{{version}}/api/interfaces/js-ts.Members/#fetchcanmanage)
- [Give a member a role](/docs/{{version}}/guilds-and-permissions/#grant-a-configured-opt-in-role)
- [Look up member and role methods](/docs/{{version}}/api/interfaces/js-ts.Members/)

## Data and cache

- [Search or scan message history](/docs/{{version}}/history-and-cache/)
- [Turn on and size the caches](/docs/{{version}}/configuration/#cache)
- [Read from the cache and fetch when data is missing](/docs/{{version}}/history-and-cache/#use-the-cache-then-fetch-if-needed)
- [Call a Fluxer API route that has no SDK method](/docs/{{version}}/api/interfaces/js-ts.Client/#rest)
- [Ask for a person's consent with OAuth](/docs/{{version}}/webhooks-and-oauth/#create-a-user-consent-url)

## Production

- [Choose client options](/docs/{{version}}/configuration/)
- [Read and configure log output](/docs/{{version}}/logging/)
- [Handle failures that have no Result](/docs/{{version}}/reliability/#report-failures-that-have-no-result)
- [Retry a failed request safely](/docs/{{version}}/reliability/#send-once-when-the-outcome-is-uncertain)
- [Stop the bot cleanly](/docs/{{version}}/starter-lifetime/)
- [Deploy the bot](/docs/{{version}}/deploying/)
- [Split a large bot into shards](/docs/{{version}}/sharding/)
- [Watch subscriptions and finish application work before exit](/docs/{{version}}/application-supervision/)
- [Look up every client option](/docs/{{version}}/api/interfaces/js-ts.ClientOptions/)

## Testing

- [Test a bot without Fluxer](/docs/{{version}}/testing/)
- [Test a runBot bot with its own options](/docs/{{version}}/testing/#share-the-bots-options-with-its-tests)
- [Test handlers registered with client.on](/docs/{{version}}/testing/#test-handlers-registered-with-clienton)
- [Look up the test client](/docs/{{version}}/api/modules/testing/)

## Effect

- [Write a first bot with Effect](/docs/{{version}}/effect-first-bot/)
- [Handle failures, collect replies and run reads together](/docs/{{version}}/effect-workflows/)
- [Provide the client as a service and test with Layers](/docs/{{version}}/effect-application-testing/)
- [Test a native runBot bot against an in-memory Fluxer](/docs/{{version}}/effect-application-testing/#test-a-runbot-bot-against-an-in-memory-fluxer)
- [Look up the Effect entry point](/docs/{{version}}/api/modules/Effect/)
- [Look up the Effect test client](/docs/{{version}}/api/modules/Effect-testing/)

## Help

- [Match a log line with its fix](/docs/{{version}}/troubleshooting/#match-a-log-line-with-its-fix)
- [Look up an error or log code](/docs/{{version}}/error-and-log-codes/)
- [Find out why the bot does not reply](/docs/{{version}}/troubleshooting/#no-reply-arrives)
- [Read short answers to common questions](/docs/{{version}}/faq/)
- [Look up a term](/docs/{{version}}/glossary/)
- [Check Node.js, TypeScript and Effect requirements](/docs/{{version}}/support-and-compatibility/)
- [Get help or report a vulnerability](/docs/{{version}}/support-and-compatibility/#get-help)
- [Browse the API reference by task](/docs/{{version}}/api/tasks/)
