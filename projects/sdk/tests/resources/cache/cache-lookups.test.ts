import { Effect } from "effect"
import { expect, test } from "vitest"
import type { Client } from "../../../src/index.js"
import type { Client as NativeClient } from "../../../src/effect.js"
import { defaultApi, nativeApi } from "../../support/both-apis.js"
import { expectDefect, expectThrown } from "../defects.js"

const cache = {
    users: true,
    directMessages: true,
    emojis: true,
    stickers: true,
    guilds: true,
    channels: true,
    members: true,
    roles: true,
    messages: true,
} as const

/** One lookup per cache, with a valid reference that is not cached and a malformed one */
const lookups = [
    {
        kind: "users",
        error: "UserOperationError",
        operation: "users.get",
        run: (client: Client | NativeClient, bad: boolean) => client.users.get(bad ? "bad" : "1"),
    },
    {
        kind: "directMessages",
        error: "UserOperationError",
        operation: "directMessages.get",
        run: (client: Client | NativeClient, bad: boolean) => client.directMessages.get(bad ? "bad" : "1"),
    },
    {
        kind: "emojis",
        error: "GuildOperationError",
        operation: "emojis.get",
        run: (client: Client | NativeClient, bad: boolean) =>
            client.emojis.get({ guildId: "1", id: bad ? "bad" : "2" }),
    },
    {
        kind: "stickers",
        error: "GuildOperationError",
        operation: "stickers.get",
        run: (client: Client | NativeClient, bad: boolean) =>
            client.stickers.get({ guildId: "1", id: bad ? "bad" : "2" }),
    },
    {
        kind: "guilds",
        error: "GuildOperationError",
        operation: "guilds.get",
        run: (client: Client | NativeClient, bad: boolean) => client.guilds.get(bad ? "bad" : "1"),
    },
    {
        kind: "channels",
        error: "ChannelOperationError",
        operation: "channels.get",
        run: (client: Client | NativeClient, bad: boolean) => client.channels.get(bad ? "bad" : "1"),
    },
    {
        kind: "members",
        error: "GuildOperationError",
        operation: "members.get",
        run: (client: Client | NativeClient, bad: boolean) =>
            client.members.get({ guildId: "1", userId: bad ? "bad" : "2" }),
    },
    {
        kind: "roles",
        error: "GuildOperationError",
        operation: "roles.get",
        run: (client: Client | NativeClient, bad: boolean) => client.roles.get({ guildId: "1", id: bad ? "bad" : "2" }),
    },
    {
        kind: "messages",
        error: "MessageOperationError",
        operation: "messages.get",
        run: (client: Client | NativeClient, bad: boolean) =>
            client.messages.get({ channelId: "1", id: bad ? "bad" : "2" }),
    },
] as const

test.each(lookups)(
    "default $kind.get returns undefined on a miss or after shutdown and throws $error for a malformed reference",
    async ({ error, operation, run }) => {
        const client = defaultApi({ cache })
        expect(run(client, false)).toBeUndefined()
        expect(expectThrown(() => run(client, true))).toMatchObject({
            _tag: error,
            operation,
            reason: "input",
            outcome: "notDispatched",
        })
        const closed = await client.shutdown()
        expect(closed.isOk()).toBe(true)
        // A closed client reads nothing instead of reporting ClientClosedError
        expect(run(client, false)).toBeUndefined()
    },
)

test.each(lookups)(
    "native $kind.get succeeds with undefined on a miss or after shutdown and dies with $error for a malformed reference",
    async ({ error, operation, run }) => {
        const client = await nativeApi({ cache })
        const miss = run(client, false) as Effect.Effect<unknown>
        expect(Effect.isEffect(miss)).toBe(true)
        expect(await Effect.runPromise(miss)).toBeUndefined()
        expect(await expectDefect(run(client, true) as Effect.Effect<unknown>)).toMatchObject({
            _tag: error,
            operation,
            reason: "input",
            outcome: "notDispatched",
        })
        await Effect.runPromise(client.shutdown())
        expect(await Effect.runPromise(run(client, false) as Effect.Effect<unknown>)).toBeUndefined()
    },
)
