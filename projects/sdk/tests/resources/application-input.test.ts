// A throw while the SDK reads caller-supplied options or input, such as from a property getter or an AbortSignal
// listener method, is application code. Each surface must report it with origin application, as SdkDefect code
// application.defect in the default API and as a marked Die in the native Cause, keeping the thrown value itself
import { Effect, Exit, Stream } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
    commands,
    createWebhookClient,
    oauth,
    SdkDefect,
    supervisor,
    type Attachment,
    type Client,
    type Operation,
} from "../../src/index.js"
import {
    commands as nativeCommands,
    createWebhookClient as createNativeWebhookClient,
    oauth as nativeOauth,
    supervisor as nativeSupervisor,
    type Client as NativeClient,
} from "../../src/effect.js"
import { causeReasons } from "../../src/internal/defects.js"
import { ClientLogger } from "../../src/internal/logging.js"
import { createClient } from "../../src/index.js"
import { defaultApi, fixtureToken, nativeApi } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/** An object whose one field throws when read. Enumerable, so key checks and JSON encoding reach the getter */
const throwing = (key: string, failure: unknown): never =>
    Object.defineProperty({}, key, {
        enumerable: true,
        get() {
            throw failure
        },
    }) as never

/** A one-entry array whose entry throws when read */
const throwingArray = (failure: unknown): never => {
    const value = ["1"]
    Object.defineProperty(value, 0, {
        get() {
            throw failure
        },
    })
    return value as never
}

/** An AbortSignal-shaped value whose listener registration throws */
const throwingSignal = (failure: unknown) => ({
    aborted: false,
    addEventListener: () => {
        throw failure
    },
    removeEventListener: () => {},
})

const attachment = {
    id: "1",
    filename: "fixture.png",
    size: 1,
    url: "https://fluxerusercontent.com/attachments/1/fixture.png",
} as unknown as Attachment

/** Run a default call that must throw or reject, draining async iterables, and return what it raised */
async function raised(run: () => unknown): Promise<unknown> {
    try {
        const value = run()
        if (value !== null && typeof value === "object" && Symbol.asyncIterator in value)
            for await (const _ of value as AsyncIterable<unknown>);
        else await value
    } catch (error) {
        return error
    }
    return expect.fail("Expected the call to throw or reject")
}

function expectApplicationDefect(error: unknown, operation: Operation, failure: Error) {
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        code: "application.defect",
        operation,
        reasons: [{ kind: "Defect", origin: "application", defect: failure }],
    })
    expect((error as SdkDefect).cause).toBe(failure)
}

/** Run a native Effect that must die and return its Cause entries as the default API classifies them */
async function nativeReasons(effect: Effect.Effect<unknown, unknown, never>) {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return expect.fail("Expected the Effect to fail")
    return causeReasons(exit.cause)
}

describe("default API", () => {
    const clientCases: readonly (readonly [Operation, (client: Client, failure: Error) => unknown])[] = [
        ["presence.set", (client, failure) => client.presence.set(throwing("status", failure))],
        ["presence.setMembers", (client, failure) => client.presence.setMembers("40", throwingArray(failure))],
        ["gateway.send", (client, failure) => client.gateway.send(0, 15, throwing("guild_ids", failure))],
        ["rest.request", (client, failure) => client.rest.request(throwing("method", failure))],
        ["cache.entries", (client, failure) => client.cache.entries("messages", throwing("limit", failure))],
        [
            "cache.onChange",
            (client, failure) => client.cache.onChange(() => undefined, throwing("concurrency", failure)),
        ],
        ["deleteMany", (client, failure) => client.messages.deleteMany("20", throwingArray(failure))],
        ["guilds.fetchCounts", (client, failure) => client.guilds.fetchCounts(throwingArray(failure))],
        [
            "channels.fetchMemberCounts",
            (client, failure) => client.channels.fetchMemberCounts("40", throwingArray(failure)),
        ],
        ["members.search", (client, failure) => client.members.search("40", throwing("query", failure))],
        [
            "members.iterateSearch",
            (client, failure) => client.members.iterateSearch("40", {}, throwing("maxItems", failure)),
        ],
        [
            "messages.iterateSearch",
            (client, failure) => client.messages.iterateSearch({ guildId: "40" }, {}, throwing("maxItems", failure)),
        ],
        ["iterateHistory", (client, failure) => client.messages.iterateHistory("20", throwing("maxItems", failure))],
        [
            "iterateHistory",
            (client, failure) => client.messages.iterateHistory("20", { maxItems: 1 }, throwing("signal", failure)),
        ],
        ["auditLogs.iterate", (client, failure) => client.auditLogs.iterate("40", throwing("userId", failure))],
        ["instance.resolve", (client, failure) => client.instance.resolve(throwing("timeoutMs", failure))],
        [
            "attachments.download",
            (client, failure) => client.attachments.download(attachment, throwing("maxBytes", failure)),
        ],
        ["attachments.stream", (client, failure) => client.attachments.stream(attachment, throwing("signal", failure))],
        [
            "attachments.stream",
            (client, failure) =>
                client.attachments.stream(attachment, { maxBytes: 1, signal: throwingSignal(failure) }),
        ],
        ["members.iterateChunks", (client, failure) => client.members.iterateChunks("40", throwing("all", failure))],
        ["previewCleanup", (client, failure) => client.messages.previewCleanup("20", throwing("authorId", failure))],
        [
            "cleanup",
            (client, failure) =>
                client.messages.cleanup(throwing("channelId", failure), throwing("timeoutMs", failure)),
        ],
        ["permissions.calculate", (client, failure) => client.permissions.calculate(throwing("guild", failure))],
        ["permissions.fetch", (client, failure) => client.permissions.fetch(throwing("guildId", failure))],
        ["members.fetchCanManage", (client, failure) => client.members.fetchCanManage(throwing("guildId", failure))],
        [
            "fetch",
            (client, failure) =>
                client.messages.fetch({ id: "10", channelId: "20" }, { signal: throwingSignal(failure) }),
        ],
        [
            "commands",
            (client, failure) => commands.create({ prefix: "!" }).attach(client, throwing("onError", failure)),
        ],
    ]

    test.each(clientCases)("%s reports a throwing caller read as an application defect", async (operation, call) => {
        stubFetchWithHostedDiscovery(vi.fn())
        const client = defaultApi()
        const failure = new Error(`fixture ${operation} read failure`)
        expectApplicationDefect(await raised(() => call(client, failure)), operation, failure)
    })

    const standaloneCases: readonly (readonly [Operation, (failure: Error) => unknown])[] = [
        ["oauth.create", (failure) => oauth.create(throwing("clientId", failure))],
        ["createWebhookClient", (failure) => createWebhookClient(throwing("id", failure))],
        ["supervisor.create", (failure) => supervisor.create(throwing("entry", failure))],
        ["supervisor.child.run", (failure) => supervisor.child.run(throwing("clientOptions", failure))],
    ]

    test.each(standaloneCases)(
        "%s reports a throwing option read as an application defect",
        async (operation, call) => {
            const failure = new Error(`fixture ${operation} read failure`)
            expectApplicationDefect(await raised(() => call(failure)), operation, failure)
        },
    )

    test("OAuth operations and supervisor readiness report throwing input, option and signal reads", async () => {
        const client = oauth.create({ clientId: "1", clientSecret: "fixture-secret" })
        const running = supervisor.create({
            entry: "/fixture/child.js",
            totalShards: 1,
            assignments: [{ id: "one", shardIds: [0] }],
        })
        try {
            const failures = [0, 1, 2].map((index) => new Error(`fixture read failure ${index}`))
            const errors = [
                await raised(() => client.authorizationUrl(throwing("redirectUri", failures[0]))),
                await raised(() => client.refresh("fixture-refresh-token", throwing("timeoutMs", failures[1]))),
                await raised(() => running.waitForReady(throwing("signal", failures[2]))),
            ]
            expectApplicationDefect(errors[0], "oauth.authorizationUrl", failures[0]!)
            expectApplicationDefect(errors[1], "oauth.refresh", failures[1]!)
            expectApplicationDefect(errors[2], "supervisor.waitForReady", failures[2]!)
        } finally {
            await client.shutdown()
            await running.shutdown()
        }
    })
})

describe("native API", () => {
    const clientCases: readonly (readonly [
        string,
        (client: NativeClient, failure: Error) => Effect.Effect<unknown, unknown, never>,
    ])[] = [
        ["presence.set", (client, failure) => client.presence.set(throwing("status", failure))],
        ["presence.setMembers", (client, failure) => client.presence.setMembers("40", throwingArray(failure))],
        ["gateway.send", (client, failure) => client.gateway.send(0, 15, throwing("guild_ids", failure))],
        ["rest.request", (client, failure) => client.rest.request(throwing("method", failure))],
        ["cache.entries", (client, failure) => client.cache.entries("messages", throwing("limit", failure))],
        [
            "cache.onChange",
            (client, failure) =>
                Effect.scoped(client.cache.onChange(() => Effect.void, throwing("maxPendingChanges", failure))),
        ],
        ["deleteMany", (client, failure) => client.messages.deleteMany("20", throwingArray(failure))],
        ["guilds.fetchCounts", (client, failure) => client.guilds.fetchCounts(throwingArray(failure))],
        ["members.search", (client, failure) => client.members.search("40", throwing("query", failure))],
        [
            "members.iterateSearch",
            (client, failure) => Stream.runDrain(client.members.iterateSearch("40", {}, throwing("maxItems", failure))),
        ],
        [
            "messages.iterateSearch",
            (client, failure) =>
                Stream.runDrain(client.messages.iterateSearch({ guildId: "40" }, {}, throwing("maxItems", failure))),
        ],
        [
            "iterateHistory",
            (client, failure) => Stream.runDrain(client.messages.iterateHistory("20", throwing("maxItems", failure))),
        ],
        [
            "auditLogs.iterate",
            (client, failure) => Stream.runDrain(client.auditLogs.iterate("40", throwing("userId", failure))),
        ],
        ["instance.resolve", (client, failure) => client.instance.resolve(throwing("timeoutMs", failure))],
        [
            "attachments.download",
            (client, failure) => client.attachments.download(attachment, throwing("maxBytes", failure)),
        ],
        [
            "attachments.stream",
            (client, failure) => Stream.runDrain(client.attachments.stream(attachment, throwing("maxBytes", failure))),
        ],
        [
            "members.iterateChunks",
            (client, failure) => Stream.runDrain(client.members.iterateChunks("40", throwing("all", failure))),
        ],
        ["previewCleanup", (client, failure) => client.messages.previewCleanup("20", throwing("authorId", failure))],
        ["permissions.fetch", (client, failure) => client.permissions.fetch(throwing("guildId", failure))],
        ["members.fetchCanManage", (client, failure) => client.members.fetchCanManage(throwing("guildId", failure))],
        ["collect", (client, failure) => Effect.scoped(client.messages.collect("20", throwing("onMessage", failure)))],
        [
            "commands",
            (client, failure) =>
                Effect.scoped(nativeCommands.create({ prefix: "!" }).attach(client, throwing("onError", failure))),
        ],
    ]

    test.each(clientCases)("%s marks a throwing caller read as an application defect", async (_name, call) => {
        stubFetchWithHostedDiscovery(vi.fn())
        const client = await nativeApi()
        const failure = new Error("fixture native read failure")
        expect(await nativeReasons(call(client, failure))).toEqual([
            { kind: "Defect", origin: "application", defect: failure },
        ])
    })

    const standaloneCases: readonly (readonly [string, (failure: Error) => Effect.Effect<unknown, unknown, never>])[] =
        [
            ["oauth.create", (failure) => Effect.scoped(nativeOauth.create(throwing("clientId", failure)))],
            [
                "oauth.refresh",
                (failure) =>
                    Effect.scoped(
                        nativeOauth
                            .create({ clientId: "1", clientSecret: "fixture-secret" })
                            .pipe(
                                Effect.flatMap((client) =>
                                    client.refresh("fixture-token", throwing("timeoutMs", failure)),
                                ),
                            ),
                    ),
            ],
            ["createWebhookClient", (failure) => Effect.scoped(createNativeWebhookClient(throwing("id", failure)))],
            ["supervisor.create", (failure) => nativeSupervisor.create(throwing("entry", failure))],
            [
                "supervisor.child.run",
                (failure) => Effect.scoped(nativeSupervisor.child.run(throwing("clientOptions", failure))) as never,
            ],
        ]

    test.each(standaloneCases)("%s marks a throwing option read as an application defect", async (_name, call) => {
        const failure = new Error("fixture native read failure")
        expect(await nativeReasons(call(failure))).toEqual([{ kind: "Defect", origin: "application", defect: failure }])
    })

    test("permissions.calculate throws an application SdkDefect for a throwing input read", async () => {
        const client = await nativeApi()
        const failure = new Error("fixture calculation read failure")
        expectApplicationDefect(
            await raised(() => client.permissions.calculate(throwing("guild", failure))),
            "permissions.calculate",
            failure,
        )
    })
})

// Marking covers only the caller reads: a fault in the SDK work around them stays an SDK fault
describe("SDK faults beside marked reads", () => {
    test.each([
        ["default", () => commands.create({ prefix: "!" })],
        ["native", () => nativeCommands.create({ prefix: "!" })],
    ] as const)("%s command setup reports a registry fault as an sdk.defect", (_mode, create) => {
        const fault = new Error("fixture registry fault")
        const set = Map.prototype.set
        // Only registering this command name faults, after the definition was read and validated
        vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
            if (typeof key === "string" && key.includes("sdk-fault-marker")) throw fault
            return set.call(this, key, value)
        })
        const router = create() as unknown as { register(command: unknown): unknown }
        let error: unknown
        try {
            router.register({ name: "sdk-fault-marker", execute: () => Effect.void })
        } catch (thrown) {
            error = thrown
        }
        expect(error).toBeInstanceOf(SdkDefect)
        expect(error).toMatchObject({
            code: "sdk.defect",
            operation: "commands",
            reasons: [{ kind: "Defect", origin: "sdk", defect: fault }],
        })
    })

    test("client creation reports a fault while creating the logger as an sdk.defect", () => {
        const fault = new Error("fixture logger fault")
        vi.spyOn(ClientLogger.prototype, "addSecret").mockImplementation(() => {
            throw fault
        })
        let error: unknown
        try {
            createClient({ token: fixtureToken })
        } catch (thrown) {
            error = thrown
        }
        expect(error).toBeInstanceOf(SdkDefect)
        expect(error).toMatchObject({
            code: "sdk.defect",
            operation: "createClient",
            reasons: [{ kind: "Defect", origin: "sdk", defect: fault }],
        })
    })

    test("gateway.send keeps data JSON cannot encode a typed input failure, not a defect", async () => {
        const client = defaultApi()
        const circular: Record<string, unknown> = {}
        circular.self = circular
        const result = await client.gateway.send(0, 15, circular)
        expect(result.isErr() && result.error).toMatchObject({
            _tag: "GatewaySendError",
            reason: "input",
            inputValidation: { path: "d" },
        })
    })
})
