---
title: Glossary
navTitle: Glossary
description: Short definitions of the terms used across the guides
---

Each term has a short definition and a link to the guide or reference page that covers it in more detail

## C

### Cache

A cache is a local copy of Fluxer data that the client keeps up to date from gateway events, so a lookup needs no request. Caching is off until it is enabled in the client options, and each lookup returns a [frozen snapshot](/docs/{{version}}/glossary/#frozen-snapshot). See [Configuration](/docs/{{version}}/configuration/#cache) for every cache category and [History and cache](/docs/{{version}}/history-and-cache/) for the message cache

### Channel

A channel is a place where messages are sent: A text or voice channel in a [community](/docs/{{version}}/glossary/#guild), or a direct conversation. Most message methods take a channel ID. See [Messages](/docs/{{version}}/messages/)

### Collector

A collector gathers future messages or reactions that pass a filter, up to a count or a time limit, and then returns them together. Register it before sending the prompt it waits for, so a fast reply is not missed. See [Events and collectors](/docs/{{version}}/events-and-collectors/)

### Command router

A command router reads each new message, finds the [prefix command](/docs/{{version}}/glossary/#prefix-command) it names, converts its arguments and runs that command. Create one with `commands.create`, or pass a `commands` option to `runBot`. See [Commands](/docs/{{version}}/commands/)

### Cooldown

A cooldown stops a command from running again too soon for the same user, channel or community. Set it with the command's `cooldown` option. See [Commands](/docs/{{version}}/commands/#guard-limit-and-wrap-commands)

## D

### Duration options

Options whose names end in `Ms`, such as `timeoutMs` and `durationMs`, are measured in milliseconds. For example, `30_000` means 30 seconds

## E

### Effect

Effect is a TypeScript library for describing work, its expected errors and the services it needs. The optional `@neontechspace/fluxerly/effect` entry point returns Effects instead of Promises. Bots do not need it. See [First Effect bot](/docs/{{version}}/effect-first-bot/)

### Embed

An embed is a card attached to a message, with a title, description, fields, images and a color. Pass embeds in a message's `embeds` array. See [Messages](/docs/{{version}}/messages/#build-an-embed)

### Event

An event is a notification that Fluxer sends through the [gateway](/docs/{{version}}/glossary/#gateway), such as `messageCreate` for a new message or `guildMemberAdd` for a member joining. The SDK checks and converts each event before passing it to [handlers](/docs/{{version}}/glossary/#handler). See [Events and collectors](/docs/{{version}}/events-and-collectors/)

### Exit

An Exit is Effect's record of how a program ended: Either its value, or a Cause that describes why it failed or was interrupted. Passing `exit.cause` to `describeError` prints that reason. See [the Effect bot guide](/docs/{{version}}/effect-first-bot/)

## F

### Finalizer

A finalizer is a cleanup action that Effect runs and waits for when work ends, whether it succeeded, failed or was interrupted. The Effect entry point uses finalizers to close clients, subscriptions and collectors. See [Effect workflows](/docs/{{version}}/effect-workflows/)

### Fixture

A fixture is a ready-made Fluxer payload, such as a message or a member, for tests. A test client's `fixtures` builders return them. See [Testing](/docs/{{version}}/testing/)

### Frozen snapshot

A frozen snapshot is a read-only copy of Fluxer data that does not change when the data changes on Fluxer. Messages, members and cache lookups are snapshots, so read or fetch again for current data. See [History and cache](/docs/{{version}}/history-and-cache/)

## G

### Gateway

The gateway is the live WebSocket connection that carries [events](/docs/{{version}}/glossary/#event) from Fluxer to the bot. The client opens it with `connect()` or `run()`, and `runBot` opens it automatically. Sending messages and most other actions use [REST](/docs/{{version}}/glossary/#rest) requests instead. See [Core concepts](/docs/{{version}}/core-concepts/)

### Gateway gap

A gateway gap is a period when the connection may have missed events, such as while it recovers from a lost connection. A collector stops with an error after a gap, because replies may have been missed. A collector given a guild ID stops only when that community's shard recovers, and one without a guild ID stops when any shard does. See [Reliability](/docs/{{version}}/reliability/)

### Guard

A guard is a check that runs before a command and can deny it with a reason. The exported `guards` include `guildOnly()`, `dmOnly()`, `ownerOnly(ids)` and `requirePermissions(names)`. See [Commands](/docs/{{version}}/commands/#guard-limit-and-wrap-commands)

### Guild

A guild in the API is a community in Fluxer. The app says community, while API fields and SDK names such as `guildId` and `guilds.fetch` say guild. A community has its own [channels](/docs/{{version}}/glossary/#channel), [members](/docs/{{version}}/glossary/#member) and [roles](/docs/{{version}}/glossary/#role), and a bot is added to one through its installation link. See [Create a bot](/docs/{{version}}/create-a-bot/) and [Communities and permissions](/docs/{{version}}/guilds-and-permissions/)

## H

### Handler

A handler is a function that the SDK calls for each [event](/docs/{{version}}/glossary/#event) of one type. Register it with `client.on` or the `events` option of `runBot`. A handler that throws, or returns an Err, is reported and keeps receiving later events. See [Events and collectors](/docs/{{version}}/events-and-collectors/)

## I

### ID

An ID is the unique number Fluxer gives each user, community, channel, message and role. The SDK keeps IDs as decimal strings, such as `"1234567890123456789"`, because JavaScript numbers lose precision for values this large. A canonical ID has no sign, surrounding whitespace or leading zeroes. See [snowflake](/docs/{{version}}/glossary/#snowflake)

### Identify

Identify is the gateway command that logs a [shard](/docs/{{version}}/glossary/#shard) in and starts a new [session](/docs/{{version}}/glossary/#session). Fluxer limits how often a bot may identify, so the SDK spaces the Identify commands of several shards. See [Sharding](/docs/{{version}}/sharding/)

### Intent

The SDK sends no gateway intents when it connects. To ask Fluxer not to send event types the bot does not use, set the client's `gateway.ignoredEvents` option. See [Configuration](/docs/{{version}}/configuration/)

## L

### Log level

Each SDK log record has a level. From least to most severe: Trace and Debug for detail that is off by default, Info for normal milestones such as readiness, Warn for problems the bot survives, such as a dropped event, and Error and Fatal for failures, such as a failed handler. See [Logging](/docs/{{version}}/logging/)

## M

### Member

A member is a user's membership in one [community](/docs/{{version}}/glossary/#guild), including the [roles](/docs/{{version}}/glossary/#role) the user holds there. The same user is a separate member in each community. See [Communities and permissions](/docs/{{version}}/guilds-and-permissions/)

### MFA

MFA means multi-factor authentication. Fluxer checks MFA rules for some moderation actions, such as banning a member. See [Communities and permissions](/docs/{{version}}/guilds-and-permissions/)

### Middleware

Middleware is a function that wraps every later handler or command and decides whether to continue by calling `next`. Add event middleware with `client.use`, and command middleware with the command router's `use` option. See [Commands](/docs/{{version}}/commands/#guard-limit-and-wrap-commands) and the [client reference](/docs/{{version}}/api/interfaces/js-ts.Client/#use)

## O

### OAuth

OAuth lets a person approve an application's access to their account through a consent page, after which the application exchanges the returned code for tokens. A client created with `oauth.create` builds the consent URL and makes the exchange. See [Webhooks and OAuth](/docs/{{version}}/webhooks-and-oauth/)

## P

### PKCE

PKCE is an OAuth safeguard: The application creates a secret verifier and sends only its hash when the consent flow starts, then proves it started the flow by sending the verifier when it exchanges the code. The `oauth.createPkce` helper creates the pair. See [Webhooks and OAuth](/docs/{{version}}/webhooks-and-oauth/)

### Prefix command

A prefix command is a message that starts with a chosen prefix, such as `!ping` with prefix `!`. A [command router](/docs/{{version}}/glossary/#command-router) matches the name after the prefix and runs that command. See [Commands](/docs/{{version}}/commands/)

## R

### Rate limit

A rate limit caps how many requests Fluxer accepts in a period. Fluxer answers HTTP 429 when a limit is reached. The SDK then waits for the delay Fluxer names and sends the request again, logging long waits. A request fails at once instead when that wait would pass its deadline. See [Troubleshooting](/docs/{{version}}/troubleshooting/)

### REST

REST is Fluxer's HTTP API for reading and changing resources, such as sending a message or fetching a community. REST requests work without the [gateway](/docs/{{version}}/glossary/#gateway) connection. HTTP 204 is a successful response without a value. For a route without an SDK method, use `client.rest.request`. See the [client reference](/docs/{{version}}/api/interfaces/js-ts.Client/#rest)

### Result

A Result holds either a success or an expected failure. Check `isErr()`: If it is true, read `error`, otherwise read `value`. The `orThrow` function returns the value or throws the error. See [Reliability](/docs/{{version}}/reliability/)

### ResultAsync

A ResultAsync is a Result that is still being computed. Default API requests return one, start when called and give a [Result](/docs/{{version}}/glossary/#result) when awaited. See [Reliability](/docs/{{version}}/reliability/)

### Resume

A resume continues an existing [session](/docs/{{version}}/glossary/#session) after a lost connection, and Fluxer then sends the events the bot missed. When a session cannot be resumed, the SDK starts a new one with [Identify](/docs/{{version}}/glossary/#identify). See [Reliability](/docs/{{version}}/reliability/)

### Role

A role is a named set of permissions in a [community](/docs/{{version}}/glossary/#guild). A member can hold several roles, and their permissions combine. See [Communities and permissions](/docs/{{version}}/guilds-and-permissions/)

### Role hierarchy

The role hierarchy is the ordering of a community's roles. It limits which members and roles a bot can manage. The `hierarchy` helpers compare roles and members that the bot already has, and `members.fetchCanManage` checks whether the bot, or a moderator given as `actorUserId`, outranks a member. See [Communities and permissions](/docs/{{version}}/guilds-and-permissions/)

## S

### Session

A session is one gateway login of a [shard](/docs/{{version}}/glossary/#shard). It starts with [Identify](/docs/{{version}}/glossary/#identify) and continues with a [resume](/docs/{{version}}/glossary/#resume) after a short connection loss. See [Sharding](/docs/{{version}}/sharding/)

### Shard

A shard is one gateway connection that carries events for part of a bot's communities. Most bots need only one. Setting `sharding: "auto"` picks the number of shards when the bot connects. See [Sharding](/docs/{{version}}/sharding/)

### Snowflake

A snowflake is the format of Fluxer [IDs](/docs/{{version}}/glossary/#id): A 64-bit number that also records when the object was created. The `snowflakes` helper reads the creation time from an ID. See the [snowflakes reference](/docs/{{version}}/api/modules/js-ts/#snowflakes)

### Subscription

A subscription delivers one event type to one [handler](/docs/{{version}}/glossary/#handler) through its own queue. The `client.on` method returns one, and `runBot` creates one per handler. Its `close()` method stops the delivery, and `waitForClose()` waits until it has stopped. See [Events and collectors](/docs/{{version}}/events-and-collectors/)

### Supervisor

A supervisor runs a bot's shards in several child Node.js processes. A supervisor created with `supervisor.create` starts each child with its shard assignment, watches its state, restarts it after a crash and shuts every child down together. See [Sharding](/docs/{{version}}/sharding/)

## T

### Test client

A test client is a real client connected to an in-memory Fluxer instead of the network. The `createTestClient` and `createTestBot` functions create one, and a test uses it to deliver events and check the requests the bot sent. See [Testing](/docs/{{version}}/testing/)

## U

### Uncertain write

An uncertain write is a request that may have succeeded even though the SDK did not receive a clear result, for example when the connection dropped after sending. Check the current state on Fluxer before repeating it, or the action can happen twice. See [Reliability](/docs/{{version}}/reliability/)

## W

### Webhook

A webhook is a URL with its own token that posts messages to one channel, without a bot account or gateway connection. Use `createWebhookClient` to send through it. See [Webhooks and OAuth](/docs/{{version}}/webhooks-and-oauth/)
