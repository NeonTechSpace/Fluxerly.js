---
name: fluxerly
description: Build, configure and test Fluxer bots with @neontechspace/fluxerly (Fluxerly.js) in JavaScript, TypeScript or Effect on Node.js
---

# Fluxerly.js bot skill

Use this skill when building, updating or debugging a Fluxer bot or application with `@neontechspace/fluxerly` (Fluxerly.js)

## Requirements

- Runtime: Node.js 26.13 or newer, ESM only (`"type": "module"` in `package.json`)
- TypeScript: TypeScript 7 with `@types/node` (JavaScript needs no compiler)
- Native Effect API (`@neontechspace/fluxerly/effect`): Effect 4 matching the installed package's `peerDependencies.effect` range

## Fast start and commands

Scaffold a runnable bot project with tests in one command:

```sh
pnpm dlx @neontechspace/fluxerly init --template ts --dir my-bot
# or --template js | --template effect, add --no-install to skip package installation
```

Verify an existing bot project offline (Node.js version, ESM, `tsconfig.json`, TypeScript 7, Effect peer, installed `node_modules` drift, `AGENTS.md`, `.gitignore`, `.env` presence without printing secrets):

```sh
pnpm exec fluxerly doctor --json
```

Start an agent-assisted triage session (or print a redacted triage brief with Fluxerly's triage playbook) to separate bot setup, Fluxer behavior and SDK bugs:

```sh
pnpm exec fluxerly triage
pnpm exec fluxerly triage --print
```

Add or refresh project agent instructions (`AGENTS.md`, `.agents/skills/fluxerly/SKILL.md`, `.cursor/rules/fluxerly.mdc`, `CLAUDE.md` or `GEMINI.md`):

```sh
pnpm exec fluxerly agents --target all
pnpm exec fluxerly agents --check
```

Generate a Fluxer bot installation URL offline:

```sh
pnpm exec fluxerly invite <applicationId> --permissions ViewChannel,SendMessages,ReadMessageHistory
```

## Non-negotiable SDK rules

1. Import only from `@neontechspace/fluxerly`, `@neontechspace/fluxerly/effect`, `@neontechspace/fluxerly/testing` or `@neontechspace/fluxerly/effect/testing`
2. Use `defineBot` and `runBot` for bots, starting only under `if (import.meta.main)` so tests can import `bot` without a token or network
3. In the default API, every network call returns `ResultAsync`. Always `await` and check `result.isErr()`, use `orThrow(await ...)`, or return the `ResultAsync` from a handler so the SDK reports expected failures
4. Read the bot token from `process.env.FLUXER_BOT_TOKEN` and never hardcode or log it
5. Use only methods declared in `node_modules/@neontechspace/fluxerly/dist/api/default/*.d.ts` (or `dist/api/effect/*.d.ts`)
6. Test every bot behavior with `createTestBot` from `@neontechspace/fluxerly/testing` (or `/effect/testing`) before running live

## Patterns that do not exist in Fluxerly

- No `new Client()` or `client.login(token)`: Use `runBot({ token, ...bot })`, or `createClient({ token })` followed by `client.run()`
- No intents: Fluxer delivers events by permissions, visibility and subscriptions (member presence updates use `client.presence.setMembers`)
- No slash commands or interactions: Commands are prefix commands under `runBot({ commands: { prefix, commands } })`
- Messages and channels are read-only data without methods: No `message.reply()`, `message.delete()` or `channel.send()`. Use handler `{ reply }` or `client.messages.send(channelId, content)`
- Event handlers receive a context object `{ message, reply, client, signal }`, not a bare message
- Bot authors use `message.author.isBot`, not `message.author.bot` (`runBot` already skips bot messages unless `ignoreBots: false`)
- Communities are named guilds in SDK identifiers such as `guildId`

## Minimal testable TypeScript bot

```ts
import { defineBot, guards, runBot } from "@neontechspace/fluxerly"

export const bot = defineBot({
    commands: {
        prefix: "!",
        commands: {
            ping: {
                description: "Reply with Pong",
                execute: ({ reply }) => reply("Pong!"),
            },
            say: {
                guard: guards.guildOnly(),
                arguments: { text: { type: "text", rest: true } },
                execute: ({ values, reply }) => reply(values.text),
            },
        },
    },
})

if (import.meta.main) await runBot({ token: process.env.FLUXER_BOT_TOKEN, ...bot })
```

## Zero-network bot test

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestBot } from "@neontechspace/fluxerly/testing"
import { bot } from "./bot.ts"

test("commands answer as expected", async () => {
    await using testBot = createTestBot(bot)
    await testBot.ready()

    const replies = await testBot.say("!ping")
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(replies.map((message) => message.content), ["Pong!"])
})
```

Run tests with a timeout and forced exit: `node --test --test-timeout=30000 --test-force-exit`

## Error handling and raw access

- Inspect failures with `errors.apiCode(error)`, `errors.isNotFound(error, resource?)` (Fluxer also returns HTTP 404 `UNKNOWN_CHANNEL` for channels hidden from the bot), `errors.isRetryable(error)`, `errors.retryAfterMs(error)`, `errors.outcome(error)` and `errors.match(error, handlers)`
- Check `errors.outcome(error)` (`"notDispatched"`, `"rejected"`, `"unknown"` or `undefined`): Never repeat a write whose outcome is `"unknown"` or `undefined` without reconciling Fluxer's current state first, because the change may already have applied
- Print any failure with `describeError(error)` and read `error.hint`, `error.inputValidation` (`path`, `constraint`, `explanation`), `error.apiError` (`code`, `providerCode`, `validationErrors`), `error.details.requiredPermissions` and `error.details.streamUsed` (needs a fresh stream or bytes)
- Wait `errors.retryAfterMs(error)` milliseconds before retrying when it returns a number, and create a new client after a failed `client.run()` because `run()` permanently closes its client
- For multi-step command handlers, use `orThrow(await client.messages.send(...))` and handle failures centrally via `runBot({ onError })`
- Debug live runs with `FLUXERLY_DEBUG=rest,gateway`, run `pnpm exec fluxerly doctor --json` for static offline setup checks, or run `pnpm exec fluxerly triage --print` for a redacted SDK and bot triage brief
- For Fluxer REST endpoints without a dedicated namespace method, use `client.rest.call("METHOD /path/{param}", { params, query, body })`
- For raw gateway dispatches, listen to `client.on("raw", ({ event }) => ...)` and check `event.documented` before narrowing on `event.t`

## Reference map

Read installed declarations first under `node_modules/@neontechspace/fluxerly/agents/AGENTS.md` and `dist/api/default/*.d.ts`. Online AI docs live at:

- Index: `https://fluxerly.neontechspace.com/docs/llms.txt`
- Task lookup: `https://fluxerly.neontechspace.com/docs/where-do-i.md`
- Client methods by task: `https://fluxerly.neontechspace.com/docs/api/tasks-js.md`, `https://fluxerly.neontechspace.com/docs/api/tasks-effect.md` and `https://fluxerly.neontechspace.com/docs/api/tasks.md`
