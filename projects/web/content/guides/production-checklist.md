---
title: Production checklist
navTitle: Production checklist
description: Check a bot before it runs unattended, with the guide section that explains each item
---

## Before the first start

- Run Node.js 24.15 or newer
- Read the token from `process.env.FLUXER_BOT_TOKEN`, never from a source file or an image

Explained in: [Runtime requirements](/docs/support-and-compatibility/#runtime-and-upgrade-requirements) · [Preparing the bot](/docs/deploying/#prepare-the-bot)

## Failures

- Return or check every [Result](/docs/glossary/#result), the success or failure each request gives, so a failed send is reported instead of lost
- Send failures somewhere someone reads, with an `onError` hook or a log sink
- Do not resend a write whose outcome is unknown
- Leave rate limits to the SDK, which waits for HTTP 429 on its own

Explained in: [Returning the Result](/docs/reliability/#return-the-replys-result) · [Failures in one place](/docs/logging/#handle-failures-in-one-place) · [An existing logger](/docs/logging/#send-records-to-an-existing-logger) · [Sending once](/docs/reliability/#send-once-when-the-outcome-is-uncertain) · [Retry rules](/docs/reliability/#limits-and-retry-rules)

## Running unattended

- Turn on only the caches the bot reads, and size them for its communities
- Give the process manager a stop timeout of about 30 seconds
- Restart after a crash with a delay
- Add a session store, so a quick restart resumes and gets the events it missed
- Watch the connection and each event subscription the bot cannot work without, which `runBot` already does

Explained in: [Cache settings](/docs/configuration/#cache) · [Shutdown](/docs/deploying/#what-happens-on-shutdown) · [Restart policy](/docs/deploying/#restart-policy) · [Resuming after a restart](/docs/sharding/#resume-after-a-restart) · [Watching the connection](/docs/application-supervision/#watch-the-connection-and-subscription)

## Before each deploy

- Run offline tests, as in [writing a first test](/docs/testing/#write-a-first-test)
