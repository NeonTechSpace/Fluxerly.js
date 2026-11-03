---
title: "Build a Fluxer bot"
navTitle: "Overview"
---

Fluxerly.js connects Node.js applications to Fluxer.
It supports sending messages, responding to events and building bots in JavaScript or TypeScript


## Start a bot

1. [Create a bot](/docs/create-a-bot/): Create the Fluxer application, copy its token and invite the bot to a server
2. [Quick start](/docs/quick-start/): Install the SDK and make the bot answer !ping
3. [Build a small bot](/docs/small-bot/) with commands, an embed and a welcome message, or copy a complete [example bot](/docs/examples/)

The [core concepts](/docs/core-concepts/) explain the few ideas behind every guide. For an application that already uses Effect, start with [the Effect bot guide](/docs/effect-first-bot/)

## Run it in production

[Configuration](/docs/configuration/), [logging](/docs/logging/), [deploying](/docs/deploying/), [sharding](/docs/sharding/), [supervision](/docs/application-supervision/) and [testing](/docs/testing/) cover a bot that keeps running

## Get unstuck

[Where do I…?](/docs/where-do-i/) finds the guide for a task. [Troubleshooting](/docs/troubleshooting/), the [error and log codes](/docs/codes/) and the [FAQ](/docs/faq/) help when something fails

## Voice

Fluxerly waits for Fluxer's new voice system and does not support voice over LiveKit. Fluxer is replacing LiveKit with its own voice system, which should arrive soon, and bot voice will come with it. Until then, voice states, member voice controls such as move, mute, deafen and disconnect, voice notes, and audio or video attachments work. The [voice controls](/docs/guilds-and-permissions/#voice-controls-versus-a-voice-connection) cover what works today

## Find a method

The [API reference](/docs/api/) lists the available methods and types.
Use search to jump to a name such as `createClient`
