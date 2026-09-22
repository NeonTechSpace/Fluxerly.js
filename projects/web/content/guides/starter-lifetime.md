---
title: Own the starter lifetime
navTitle: Starter lifetime
description: Copy the application-owned lifecycle companion and keep critical command workers observable
---

The [first bot](/docs/{{version}}/quick-start/) separates command behavior from application lifetime. Both files belong to the bot application and can be edited independently. The companion is not another SDK API, runtime or command framework

The installed package includes the same checked files under `examples/starter/`. Copy them into the application rather than importing package-private paths. JavaScript and TypeScript use `lifetime.js`. Native Effect uses `lifetime-effect.ts`

## JavaScript and TypeScript companion

Save this file as `lifetime.js` next to `bot.js` or `bot.ts`. The JSDoc annotations provide optional editor checking without requiring TypeScript for execution

```js
{{starter:lifetime.js}}
```

The installer registers the fixed critical subscriptions before startup. A terminal client failure, failed worker or unexpected successful worker closure stops the application. Individual command failures remain isolated and are not automatically replayed

The companion owns process-signal handlers, observes each critical worker, waits for SDK-owned cleanup and preserves combined failures. It does not forcibly cancel or drain arbitrary handler Promises. External work that must finish needs its own application-owned tracking and drain policy, as described in [application supervision](/docs/{{version}}/application-supervision/)

## Native Effect companion

Save this file as `lifetime-effect.ts` beside the [Effect starter](/docs/{{version}}/effect-first-bot/). The helper returns an Effect and runs inside the caller's services and scope, without a separate runtime

```ts
{{starter:lifetime-effect.ts}}
```

The application executes the final Effect once at its outer boundary. Native interruption waits for owned finalizers. A cleanup failure during interruption remains a failure rather than a successful stop

## Extend the application deliberately

- Add fixed critical subscriptions to the installer's returned array so their closure affects application health
- Keep ordinary command rejection and cooldown feedback in command definitions. No automatic user-facing error messages are installed
- Handle expected operation Results in JavaScript and typed failures in Effect. Do not retry a mutation merely because its response was lost
- Create a new client for a restart, with an application-owned restart budget. A restart does not recover missed events or replay failed command handlers
- Keep dynamic worker limits, persistence and durable jobs in the application. The starter is a fixed worker inventory, not a process-wide admission controller
