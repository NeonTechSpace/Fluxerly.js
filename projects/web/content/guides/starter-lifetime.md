---
title: Run a bot with the SDK
navTitle: Bot lifetime
description: What runBot does from start to stop, and what stays with the application
---

The `runBot` function runs a whole bot from one options object. It creates the client, registers every handler and command before connecting, keeps the connection alive and stops cleanly. The [quick start](/docs/{{version}}/quick-start/) bot is a complete example, and no separate lifecycle file is needed

## From start to stop

1. **Check.** The `runBot` call checks every option first. An unknown event name or an invalid command throws `ConfigurationError` before anything connects. A missing token is logged with a hint instead, the run ends with exit code 1, and `runBot` returns the error
2. **Register.** Event handlers and commands are registered, then the optional `setup(client, { signal })` callback runs for other startup work. Timers and background work belong in [scheduled tasks](/docs/{{version}}/starter-lifetime/#run-work-later-or-on-a-schedule), which stop with the bot. For other work, the `signal` aborts when the bot begins stopping. A failed `setup` stops the bot before it connects
3. **Connect.** The client connects to the gateway and handlers start receiving events. Messages written by bots, including the bot's own replies, skip handlers and commands unless `ignoreBots` is `false`
4. **Run.** The SDK reconnects after a lost connection and keeps each [handler](/docs/{{version}}/glossary/#handler) running. A failed handler is not retried and does not stop the bot. Its error is logged in full, or sent to `onError` when one is set. If a handler's subscription closes while the bot is running, the bot stops with `CriticalWorkerStoppedError`
5. **Stop.** Ctrl+C (SIGINT) and SIGTERM stop the bot unless `processSignals` is `false`, while the Effect API handles them only with `processSignals: true`. A `signal` option stops it from application code. Stopping accepts no new events and gives running handlers and scheduled tasks up to 5 seconds to finish, a time the `drainMs` option changes. Then it cancels the work still running through its `signal`, closes the connection and waits for the SDK's cleanup. The stop request and the shutdown duration are logged at Info, and a failed cleanup step is logged at Error and still reported by the run
6. **Report.** After a failure the bot could not recover from, such as a rejected token, the runner logs that failure once and sets `process.exitCode` to 1. A normal stop reports nothing
7. **Return.** The returned [Result](/docs/{{version}}/glossary/#result) is Ok after a normal stop, or an Err with the failure

The [deploying guide](/docs/{{version}}/deploying/#what-happens-on-shutdown) lists each shutdown step. Importing the SDK adds no signal handlers, and `runBot` removes its own when the bot stops. It never exits the process

## What each handler receives

In the default API, each event handler receives one context object with `event`, `client` and `signal`. Effect handlers receive `event` and `client` without a signal, because stopping the bot interrupts their Effect instead. A `messageCreate` handler also receives `message` and `reply`

The `reply` helper accepts a string or full message content and already applies the handler's cancellation signal. Return its Result so a failed reply is reported like a thrown error, as [reliability](/docs/{{version}}/reliability/#return-the-replys-result) explains. In the Effect API, `reply` returns an Effect. Return it or compose it into the handler's Effect so the SDK can run and interrupt it

By default `messageCreate` handlers run up to eight at a time and other events one at a time. A burst that fills a handler's queue drops the oldest waiting event with a Warn record instead of stopping the bot. [Configuration](/docs/{{version}}/configuration/#events-and-the-gateway) shows how to change this for one event

## Run work later or on a schedule

The `client.schedule` method runs a task after a delay or repeatedly, and the bot owns it. Call it from `setup`, an event handler or a command. It returns at once, so a command that schedules a reminder finishes and frees its command slot, as in the [commands guide](/docs/{{version}}/commands/#convert-arguments-before-execution). This function posts a status message every hour once `setup` calls it with the bot's client:

```ts
import type { Client } from "@neontechspace/fluxerly"

export function postHourlyStatus(client: Client, channelId: string) {
    return client.schedule((signal) => client.messages.send(channelId, "Still running", { signal }), {
        intervalMs: 60 * 60 * 1_000,
    })
}
```

Pass `delayMs` to run a task once after a delay, or `intervalMs` to repeat it. Without options the task runs once right away, which suits background work started in `setup`. A repeating task waits `intervalMs` before its first run unless `delayMs` says otherwise, and each later run starts `intervalMs` after the previous one ended, so runs never overlap. The returned task's `close()` cancels its later runs

A task that throws, rejects or returns an Err result is reported to `onError`, or logged at Error with the code `lifecycle.taskFailed`. A repeating task keeps running after a failed run, so one network error does not end it, and a problem that lasts is reported at every run. To stop after a failure, the task can call `close()` itself

When the bot stops, tasks that have not run yet are cancelled. A requested stop lets a run in progress finish within the `drainMs` window, then cancels it through its `signal`. One Info record with the code `lifecycle.tasksCancelled` counts the tasks that stopping cut short. Tasks live in memory only, so a restart loses pending reminders. Keep work that must survive a restart outside the SDK, as in [the reminder recipe](/docs/{{version}}/starter-lifetime/#keep-reminders-across-restarts)

In the Effect API the task is an Effect, as in `client.schedule(client.messages.send(channelId, "Still running"), { intervalMs: 3_600_000 })`, and the call returns an Effect to run. Each run keeps the services of the code that scheduled it, and stopping the bot interrupts a run in progress

### Keep reminders across restarts

The SDK does not own storage, so the application saves each reminder in its own store when it is created and schedules it again after a restart. This example keeps the due time, channel ID and text in a JSON file, and a real bot would use its database. Call `addReminder` from a command, such as the `remind` command in the [commands guide](/docs/{{version}}/commands/#convert-arguments-before-execution), and pass `restoreReminders` as the `setup` option of `runBot`

```ts
import { readFile, writeFile } from "node:fs/promises"
import type { Client } from "@neontechspace/fluxerly"

type Reminder = { id: string; dueAt: number; channelId: string; text: string }

const file = "reminders.json"
const saved = new Map<string, Reminder>()
let writing = Promise.resolve()

// One write at a time, so the file ends with the latest list. A failed write reaches its caller and blocks no later write
function save() {
    writing = writing.catch(() => {}).then(() => writeFile(file, JSON.stringify([...saved.values()])))
    return writing
}

function scheduleReminder(client: Client, reminder: Reminder) {
    client.schedule(
        async (signal) => {
            const sent = await client.messages.send(reminder.channelId, reminder.text, { signal })
            if (sent.isErr()) return sent // The SDK reports the failure and the reminder stays saved
            saved.delete(reminder.id)
            await save()
        },
        { delayMs: Math.max(0, reminder.dueAt - Date.now()) },
    )
    saved.set(reminder.id, reminder)
}

export async function restoreReminders(client: Client) {
    const json = await readFile(file, "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error
        return "[]"
    })
    for (const reminder of JSON.parse(json) as Reminder[]) scheduleReminder(client, reminder)
}

export async function addReminder(client: Client, channelId: string, delayMs: number, text: string) {
    scheduleReminder(client, { id: crypto.randomUUID(), dueAt: Date.now() + delayMs, channelId, text })
    await save()
}
```

On every start, `restoreReminders` schedules each saved reminder with the time left until it is due, or zero when it is already overdue. A reminder leaves the store only after its message was sent. A failed send returns the Err result, so the SDK reports it as a failed run, and the reminder stays saved for the next start to retry. A missing file means no reminders yet, while any other read error stops the bot before it connects

A reminder can be sent twice when the bot stops after sending it and before removing it. The example does not handle several processes sharing one store

In the Effect API the scheduled task is an Effect that sends the message and then removes the reminder, as in `client.messages.send(channelId, text).pipe(Effect.andThen(remove))` with `remove` as an Effect. A failed send skips the removal and is reported like any failed run, and `setup` returns the Effect that restores the saved reminders

## What the application owns

The application supplies the token and handlers and decides how to report errors. It also owns everything outside the SDK:

- Work outside the drain: A returned handler Promise, a running scheduled task and their REST requests get the drain window to finish, 5 seconds by default, set by `drainMs`. Track detached Promises, timers not started with `client.schedule` and work that needs more than that window, as shown in [application supervision](/docs/{{version}}/application-supervision/#drain-application-owned-work)
- Other resources: Close database connections, timers and servers after `runBot` resolves, so the process can exit
- Restarts: A process manager or a new `runBot` call starts a new client. Restarting does not replay missed events or failed handlers
- Durable work: Store data and jobs that must survive a restart outside the SDK

## Choose the API

The JavaScript and TypeScript `runBot` returns a Result for expected failures and reports them itself, so the [quick start](/docs/{{version}}/quick-start/) bot only awaits it. Invalid options still throw `ConfigurationError` at once, and an unexpected SDK defect rejects with `SdkDefect`. Set `reportFailure: false` when the application handles the returned failure and the exit status itself, for example to restart the bot in the same process

The [Effect `runBot`](/docs/{{version}}/effect-first-bot/) returns an Effect and keeps access to application services, scoped resources and failure causes. It reports a failure the same way, so running it with `Effect.runPromiseExit` is enough. Run it once from the application's top-level code instead of starting a separate runtime inside handlers

For prefix commands, pass `commands`, as shown in [commands](/docs/{{version}}/commands/). The lower-level `createClient` and subscription APIs remain available for flows that need direct control of the client's lifetime. See [application supervision](/docs/{{version}}/application-supervision/) for watching required subscriptions in application code
