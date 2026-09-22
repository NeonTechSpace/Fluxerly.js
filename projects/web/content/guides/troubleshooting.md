---
title: Diagnose a bot that is not behaving as expected
navTitle: Troubleshooting
description: Separate command, worker, connection and request problems using safe SDK evidence
---

Start with the failed operation's Result or native Effect failure, then inspect the owning worker and connection. A connected gateway alone does not prove that a command handler is alive or that a reply was permitted

## No reply arrives

Check the command prefix, registration result and attached router first. Registration is immutable, so attach the router returned by `register` or `registerMany`, not the earlier empty router

The maintained starter ignores bot-authored messages, unknown commands and extra arguments. A guard or cooldown can also reject a command before execution. Add deliberate feedback through `onReject` or `onUnmatched` when appropriate for the application, rather than treating every ignored message as an SDK failure

If execution reaches the reply, inspect its Result. The starter logs the safe failure `_tag` for expected failures. Message error details distinguish local validation, provider rejection, timeout and delivery uncertainty. Check the bot's current channel visibility and send permission separately

Returning an `Err` from an ordinary callback does not report that failure automatically. Check it and either handle it explicitly or throw the error inside the handler to use the subscription's error reporting. See [commands](/docs/{{version}}/commands/) and [failure handling](/docs/{{version}}/reliability/)

## The gateway is connected but commands stopped

Observe the critical subscription's `waitForClose()` outcome. An overflowing subscription closes independently of the gateway. An isolated handler failure does not close the subscription and is not retried automatically

The [starter lifetime](/docs/{{version}}/starter-lifetime/) observes critical workers alongside the client. Add every fixed critical subscription to that inventory. The `diagnostics().events` counters show registrations and executing callbacks, but cannot identify whether a particular business workflow is healthy

## A request is slow

Inspect `diagnostics().rest.queuedRequests` and `activeRequests` for this client. Queueing, a provider rate limit, slow transport and response decoding are different stages. A snapshot is local evidence, not proof of the exact cause or a process-wide quota

Enable `logging.measurements` temporarily to distinguish REST queue, network and decode durations. Use the existing structured logger and its safe stage names, as shown in [logging](/docs/{{version}}/logging/#measure-sdk-work). Measurements add no exporter or history store

An operation deadline includes waiting for admission and required SDK cleanup. A timeout after dispatch does not prove that a write failed at the provider. Do not replay it blindly

## The connection is recovering

Inspect client state and enable `logging.development` for safe lifecycle records when needed. Transient recovery differs from terminal authentication or protocol rejection. The retained `run()` or `waitForClose()` outcome supplies the terminal result

Do not create another client or repeat `connect()` merely because the existing client is recovering. The client already owns that recovery lifetime. A closed client requires a new explicitly owned instance

## Shutdown is waiting, or application work finishes afterward

First identify the owner. SDK shutdown waits for SDK-owned resource release. Collector progress work and native scoped finalizers are awaited, so callbacks or finalizers that do not finish can keep those owners pending

Ordinary JavaScript handler Promises are different: The SDK requests cancellation but does not drain arbitrary application work. Database writes or detached Promises can finish after the subscription closes. Use [explicit application tracking](/docs/{{version}}/application-supervision/#drain-application-owned-work) when that work must settle before exit

Avoid `process.exit()` as a cleanup shortcut. Set `process.exitCode` after the application's cleanup boundary instead. Neither cancellation nor a timeout proves rollback of an external mutation

## Keep diagnostics safe and useful

Record the SDK version, supported Node version, operation name, typed failure kind and relevant payload-free counters. Keep tokens, callback codes, signed URLs, raw exception causes and message bodies out of diagnostic output

The default logger accepts safe structured records through `fromStructuredLogger`. Native Effect applications can supply their own logger and services. Both approaches use the existing logging system, and asynchronous delivery or flushing remains application-owned
