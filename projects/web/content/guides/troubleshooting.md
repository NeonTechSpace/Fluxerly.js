---
title: Diagnose a bot that is not behaving as expected
navTitle: Troubleshooting
description: Separate command, worker, connection and request problems using safe SDK evidence
---

Start with the operation's Result or native Effect error. Then check whether its handler and the bot's connection are still running. A connected bot may still have a stopped handler or lack permission to reply

## No reply arrives

For the first-bot example, send exactly `!ping` from a non-bot account. For a command router, check the prefix, registration result and attached router. Registration is immutable, so attach the router returned by `register` or `registerMany`, not the earlier empty router

The starter ignores bot-authored messages and content other than `!ping`. In a command router, a guard or cooldown can also reject a command before execution. Add deliberate feedback through `onReject` or `onUnmatched` when appropriate for the application, rather than treating every ignored message as an SDK failure

If execution reaches the reply, inspect its Result. The starter logs the safe failure `_tag` for expected failures. Message error details distinguish local validation, provider rejection, timeout and delivery uncertainty. Check the bot's current channel visibility and send permission separately

Returning an `Err` from an ordinary callback does not report that failure automatically. Check it and either handle it explicitly or throw the error inside the handler to use the subscription's error reporting. See [commands](/docs/{{version}}/commands/) and [failure handling](/docs/{{version}}/reliability/)

## The gateway is connected but commands stopped

Observe the critical subscription's `waitForClose()` outcome. An overflowing subscription closes independently of the gateway. An isolated handler failure does not close the subscription and is not retried automatically

The [SDK runner](/docs/{{version}}/starter-lifetime/) watches the subscriptions returned by its installer and the client connection. Return every subscription the bot needs in that array. The `diagnostics().events` counters show registrations and running callbacks, but cannot tell whether a particular application task is working

## A request is slow

Inspect `diagnostics().rest.queuedRequests` and `activeRequests` for this client. A request may wait in the queue, hit a provider rate limit, wait on the network or take time to decode. These counters cover one client and do not identify the cause by themselves

Enable `logging.measurements` temporarily to distinguish REST queue, network and decode durations. Use the existing structured logger and its safe stage names, as shown in [logging](/docs/{{version}}/logging/#measure-sdk-work). Measurements add no exporter or history store

An operation deadline includes waiting for admission and required SDK cleanup. A timeout after dispatch does not prove that a write failed at the provider. Do not replay it blindly

## The connection is recovering

Inspect client state and enable `logging.development` for safe lifecycle records when needed. Transient recovery differs from terminal authentication or protocol rejection. The retained `run()` or `waitForClose()` outcome supplies the terminal result

Do not create another client or repeat `connect()` merely because the existing client is recovering. The client already owns that recovery lifetime. A closed client requires a new explicitly owned instance

## Shutdown is waiting, or application work finishes afterward

Check which work is still running. SDK shutdown waits for its own resources to close. It also waits for collector progress callbacks and native scoped finalizers, so one of those that never finishes can hold up shutdown

Ordinary JavaScript handler Promises are different: The SDK requests cancellation but does not drain arbitrary application work. Database writes or detached Promises can finish after the subscription closes. Use [explicit application tracking](/docs/{{version}}/application-supervision/#drain-application-owned-work) when that work must settle before exit

Avoid `process.exit()` as a cleanup shortcut. Set `process.exitCode` after application cleanup instead. Neither cancellation nor a timeout proves rollback of an external mutation

## Keep diagnostics safe and useful

Record the SDK version, supported Node version, operation name, typed failure kind and relevant payload-free counters. Keep tokens, callback codes, signed URLs, raw exception causes and message bodies out of diagnostic output

The default logger accepts safe structured records through `fromStructuredLogger`. Native Effect applications can supply their own logger and services. Both approaches use the existing logging system, and asynchronous delivery or flushing remains application-owned
