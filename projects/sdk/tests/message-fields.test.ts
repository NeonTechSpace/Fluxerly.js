import { once } from "node:events"
import { setImmediate as turn } from "node:timers/promises"
import { Cause, Effect, Exit, Scope, Stream } from "effect"
import type { Result, ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import { createClient, createWebhookClient, SdkDefect, type MessageField, type MessageCore } from "../src/index.js"
import { createClient as createNative, createWebhookClient as createNativeWebhook } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "", sockets: [] as import("ws").WebSocket[] }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(url: string, options: import("ws").ClientOptions) {
                expect(url).toBe("wss://gateway.fluxer.app/?v=1&encoding=json")
                super(transport.url, options)
                transport.sockets.push(this)
            }
        },
    }
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    transport.sockets = []
})
const modes = ["default", "native"] as const
type Mode = (typeof modes)[number]
const target = { id: "10", channelId: "20" }
const coreKeys = ["id", "channelId", "content", "author", "guildId"]
const optionalKeys: MessageField[] = [
    "nonce",
    "webhookId",
    "pinned",
    "createdAt",
    "editedAt",
    "type",
    "flags",
    "mentionedEveryone",
    "embeds",
    "attachments",
    "stickers",
    "mentions",
    "mentionRoleIds",
    "mentionChannels",
    "reactions",
    "messageReference",
    "messageSnapshots",
    "referencedMessage",
]
const selected: MessageField[] = ["messageSnapshots", "messageReference", "editedAt", "mentions", "id", "author"]
const attachment = { id: "34", filename: "captured.txt", size: 1, flags: 0 }
const wire = (id = "10") => ({
    id,
    channel_id: "20",
    guild_id: "40",
    content: "rich fixture",
    author: { id: "30", username: "fixture", bot: true },
    nonce: null,
    webhook_id: "50",
    pinned: false,
    timestamp: "2026-09-10T12:00:00.000Z",
    edited_timestamp: null,
    type: 19,
    flags: 4,
    mention_everyone: false,
    embeds: [{ type: "rich", title: "Title", fields: [{ name: "Name", value: "Value", inline: true }] }],
    attachments: [attachment],
    stickers: [{ id: "35", name: "Sticker", animated: false }],
    mentions: [{ id: "31", username: "mentioned", bot: false }],
    mention_roles: ["32"],
    mention_channels: null,
    reactions: [{ emoji: { name: "👍", id: null }, count: 2, me: false }],
    message_reference: { message_id: "70", channel_id: "71", type: 1 },
    referenced_message: { id: "70", channel_id: "71", content: "not retained" },
    message_snapshots: [
        {
            content: "captured",
            timestamp: "2026-09-10T12:00:00.000Z",
            attachments: [attachment],
            embeds: [{ type: "rich", title: "Snapshot" }],
            stickers: [{ id: "35", name: "Sticker", animated: false }],
            type: 0,
            flags: 0,
        },
    ],
})

async function settle<A>(input: Result<A, unknown> | ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(input)) return Effect.runPromise(input)
    const result = await input
    if (result.isErr()) throw result.error
    return result.value
}

async function setup(
    mode: Mode,
    messageFields: readonly MessageField[] | undefined,
    policy?: (message: MessageCore) => number | null,
    maxBytes?: number,
) {
    const scope = Scope.makeUnsafe()
    const options = {
        token: "fixture-only-not-a-credential",
        messageFields,
        cache: {
            messages: { ...(policy ? { maxAgeMs: policy } : {}), ...(maxBytes === undefined ? {} : { maxBytes }) },
        },
    }
    const defaultApi = mode === "default" ? createClient(options)._unsafeUnwrap() : undefined
    const native =
        mode === "native" ? await Effect.runPromise(createNative(options).pipe(Scope.provide(scope))) : undefined
    const client = defaultApi ?? native!
    onTestFinished(async () => {
        await settle(client.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return { client, defaultApi, native, scope }
}

function expectProjection(message: MessageCore | undefined | null, fields: readonly MessageField[] | undefined) {
    expect(message).toBeDefined()
    if (!message) throw new Error("Expected message observation")
    const keys = fields === undefined ? [...coreKeys, ...optionalKeys] : [...new Set([...coreKeys, ...fields])]
    expect(Object.keys(message).sort()).toEqual(keys.sort())
    expect(message.author).toEqual({ id: "30", username: "fixture", isBot: true })
    expect(message.guildId).toBe("40")
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.author)).toBe(true)
    if ("messageSnapshots" in message) {
        const snapshots = message.messageSnapshots as import("../src/index.js").Message["messageSnapshots"]
        expect(snapshots?.[0]?.attachments).toEqual([attachment])
        expect(snapshots?.[0]?.embeds?.[0]?.title).toBe("Snapshot")
        expect(Object.isFrozen(snapshots?.[0]?.attachments?.[0])).toBe(true)
    }
    if ("editedAt" in message) expect(message.editedAt).toBeNull()
}

test.each(modes)("%s snapshots and validates configuration before any request", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    for (const messageFields of ["attachments", {}, ["unknown"], [null], new Array(1)]) {
        if (mode === "default")
            expect(createClient({ token: "fixture", messageFields } as never)._unsafeUnwrapErr()).toMatchObject({
                _tag: "ConfigurationError",
                field: "messageFields",
            })
        else {
            const scope = Scope.makeUnsafe()
            const result = await Effect.runPromise(
                Effect.result(createNative({ token: "fixture", messageFields } as never).pipe(Scope.provide(scope))),
            )
            expect(result).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "ConfigurationError", field: "messageFields" },
            })
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
    const fields: MessageField[] = ["attachments"]
    const api = await setup(mode, fields)
    fields.splice(0, 1, "embeds")
    expect(fetch).not.toHaveBeenCalled()
    stubFetchWithHostedDiscovery(async () => Response.json(wire()))
    const message = await settle(api.client.messages.fetch(target))
    expectProjection(message, ["attachments"])
})

test("default configuration getter defects remain sanitized", () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const options = Object.defineProperty({ token: "fixture" }, "messageFields", {
        get() {
            throw new Error("private getter detail")
        },
    })
    expect(() => createClient(options)).toThrow(SdkDefect)
    try {
        createClient(options)
    } catch (error) {
        expect(JSON.stringify(error)).not.toContain("private getter detail")
    }
    expect(fetch).not.toHaveBeenCalled()
})

test("native configuration getter defects retain their Cause without making requests", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const scope = Scope.makeUnsafe()
    const defect = new Error("fixture getter defect")
    const options = Object.defineProperty({ token: "fixture" }, "messageFields", {
        get() {
            throw defect
        },
    })
    const exit = await Effect.runPromiseExit(createNative(options).pipe(Scope.provide(scope)))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    await Effect.runPromise(Scope.close(scope, Exit.void))
})

test.each(
    modes.flatMap((mode) =>
        [undefined, [], selected].map((fields) => ({
            mode,
            fields,
            label: fields === undefined ? "full" : fields.length ? "subset" : "core",
        })),
    ),
)("$mode $label projects REST operations, nested carriers and cache policy", async ({ mode, fields }) => {
    const observed: MessageCore[] = []
    const api = await setup(mode, fields, (message) => {
        observed.push(message)
        return null
    })
    let response: unknown = wire()
    const requests: string[] = []
    stubFetchWithHostedDiscovery(async (url) => {
        requests.push(new URL(url).pathname)
        return Response.json(response)
    })
    const operations = [
        ["send", () => settle(api.client.messages.send("20", { content: "send" }))],
        ["reply", () => settle(api.client.messages.reply(target, { content: "reply" }))],
        ["forward", () => settle(api.client.messages.forward("20", { source: target }))],
        ["fetch", () => settle(api.client.messages.fetch(target))],
        ["edit", () => settle(api.client.messages.edit(target, { content: "edit" }))],
    ] as const
    for (const [name, operation] of operations) {
        const result = await operation()
        expectProjection(result, fields)
        expectProjection(await settle(api.client.messages.get(target)), fields)
        expect(observed.at(-1), name).toBe(result)
    }
    response = [wire()]
    const history = await settle(api.client.messages.fetchHistory("20", { limit: 1 }))
    expectProjection(history[0], fields)
    expectProjection((await settle(api.client.cache.entries("messages")))[0], fields)
    const filtered: MessageCore[] = []
    const preview = await settle(
        api.client.messages.previewCleanup("20", {
            maxScanned: 1,
            maxSelected: 1,
            filter: (message) => {
                filtered.push(message)
                return true
            },
        }),
    )
    expectProjection(preview.selectedMessages[0], fields)
    expect(filtered).toEqual(preview.selectedMessages)
    response = {
        items: [{ message: { ...wire(), pinned: true }, pinned_at: "2026-09-10T12:00:00.000Z" }],
        has_more: false,
    }
    expectProjection((await settle(api.client.messages.fetchPins("20"))).items[0]?.message, fields)
    response = { messages: [wire()], channels: [], total: 1, hits_per_page: 25, page: 1 }
    const search = await settle(api.client.messages.search({ guildId: "40" }, { content: "rich" }))
    if (search.indexing) throw new Error("Expected indexed messages")
    expectProjection(search.messages[0], fields)
    response = { "20": wire(), "21": null }
    const latest = await settle(api.client.directMessages.fetchLatestMessages(["20", "21", "22"]))
    expectProjection(latest.messages["20"], fields)
    expect(latest.messages["21"]).toBeNull()
    expect(latest.omittedChannelIds).toEqual(["22"])
    expect(requests).toHaveLength(10)
    expect(observed).toHaveLength(7)
    observed.forEach((message) => expectProjection(message, fields))
})

async function gateway() {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing gateway address")
    transport.url = `ws://127.0.0.1:${address.port}`
    let sequence = 0
    server.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString())
            if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }))
            if (packet.op === 2)
                socket.send(JSON.stringify({ op: 0, s: ++sequence, t: "READY", d: { session_id: "fixture" } }))
        })
    })
    onTestFinished(async () => {
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    stubFetchWithHostedDiscovery(async () => Response.json({ url: "wss://gateway.fluxer.app" }))
    return (event: string, payload: unknown) => {
        transport.sockets
            .at(-1)!
            .emit("message", Buffer.from(JSON.stringify({ op: 0, s: ++sequence, t: event, d: payload })), false)
    }
}

test.each(modes)(
    "%s projects gateway callbacks, waiters, pull events, collectors and cache replacements",
    async (mode) => {
        const dispatch = await gateway()
        const observed: MessageCore[] = []
        const api = await setup(mode, selected, (message) => {
            observed.push(message)
            return null
        })
        await settle(api.client.connect())
        const callbacks: MessageCore[] = []
        if (api.defaultApi) {
            api.defaultApi
                .on("messageCreate", (message) => {
                    callbacks.push(message)
                })
                ._unsafeUnwrap()
            api.defaultApi
                .on("messageUpdate", (message) => {
                    callbacks.push(message)
                })
                ._unsafeUnwrap()
        } else {
            await Effect.runPromise(
                api
                    .native!.on("messageCreate", (message) =>
                        Effect.sync(() => {
                            callbacks.push(message)
                        }),
                    )
                    .pipe(Scope.provide(api.scope)),
            )
            await Effect.runPromise(
                api
                    .native!.on("messageUpdate", (message) =>
                        Effect.sync(() => {
                            callbacks.push(message)
                        }),
                    )
                    .pipe(Scope.provide(api.scope)),
            )
        }
        const filter: MessageCore[] = []
        const options = {
            filter: (message: MessageCore) => {
                filter.push(message)
                return true
            },
        }
        const collector = api.defaultApi
            ? api.defaultApi.messages.collect("20", options)._unsafeUnwrap()
            : await Effect.runPromise(api.native!.messages.collect("20", options).pipe(Scope.provide(api.scope)))
        const wait = settle(
            api.client.waitFor("messageCreate", {
                filter: (message) => {
                    filter.push(message)
                    return true
                },
            }),
        )
        const pull = api.defaultApi
            ? settle(api.defaultApi.events("messageCreate")._unsafeUnwrap().next())
            : Effect.runPromise(Stream.runCollect(api.native!.events("messageCreate").pipe(Stream.take(1)))).then(
                  (messages) => messages[0],
              )
        await turn()
        dispatch("MESSAGE_CREATE", wire())
        expectProjection(await wait, selected)
        expectProjection(await pull, selected)
        expectProjection((await settle(collector.waitForClose())).messages[0], selected)
        await vi.waitFor(() => expect(callbacks).toHaveLength(1))
        expectProjection(callbacks[0], selected)
        expect(filter).toHaveLength(2)
        filter.forEach((message) => expectProjection(message, selected))
        const changed = { ...wire(), content: "updated" }
        dispatch("MESSAGE_UPDATE", changed)
        await vi.waitFor(() => expect(callbacks).toHaveLength(2))
        expectProjection(callbacks[1], selected)
        expect(callbacks[1]?.content).toBe("updated")
        const cached = await settle(api.client.messages.get(target))
        expect(cached).toBe(observed.at(-1))
        expect(cached?.content).toBe("updated")
        expectProjection(cached, selected)
        expectProjection((await settle(api.client.cache.entries("messages")))[0], selected)
    },
)

test.each(modes)("%s excluded malformed REST fields still reject the response", async (mode) => {
    const api = await setup(mode, [])
    stubFetchWithHostedDiscovery(async () => Response.json({ ...wire(), attachments: [{ ...attachment, size: -1 }] }))
    await expect(settle(api.client.messages.fetch(target))).rejects.toMatchObject({ reason: "response" })
    expect(await settle(api.client.messages.get(target))).toBeUndefined()
})

test.each(modes)("%s retained cache and collector budgets account for the selected projection", async (mode) => {
    const dispatch = await gateway()
    const core = {
        ...target,
        content: "rich fixture",
        guildId: "40",
        author: { id: "30", username: "fixture", isBot: true },
    }
    const maxBytes = Buffer.byteLength(JSON.stringify(core))
    const api = await setup(mode, [], undefined, maxBytes)
    stubFetchWithHostedDiscovery(async (url) =>
        Response.json(url.endsWith("/gateway/bot") ? { url: "wss://gateway.fluxer.app" } : wire()),
    )
    const fetched = await settle(api.client.messages.fetch(target))
    expect(fetched).toEqual(core)
    expect(await settle(api.client.messages.get(target))).toBe(fetched)
    await settle(api.client.connect())
    const collector = api.defaultApi
        ? api.defaultApi.messages.collect("20", { maxBytes })._unsafeUnwrap()
        : await Effect.runPromise(api.native!.messages.collect("20", { maxBytes }).pipe(Scope.provide(api.scope)))
    dispatch("MESSAGE_CREATE", wire())
    expect((await settle(collector.waitForClose())).messages).toEqual([core])
    const pending = api.defaultApi
        ? api.defaultApi.messages.collect("20", { maxPendingBytes: maxBytes })._unsafeUnwrap()
        : await Effect.runPromise(
              api.native!.messages.collect("20", { maxPendingBytes: maxBytes }).pipe(Scope.provide(api.scope)),
          )
    dispatch("MESSAGE_CREATE", wire("11"))
    await expect(settle(pending.waitForClose())).rejects.toMatchObject({ reason: "overflow", limit: "maxPendingBytes" })
})

test.each(modes)("%s excluded malformed gateway fields retain the terminal rejection policy", async (mode) => {
    const dispatch = await gateway()
    const api = await setup(mode, [])
    await settle(api.client.connect())
    const received: MessageCore[] = []
    if (api.defaultApi)
        api.defaultApi
            .on("messageCreate", (message) => {
                received.push(message)
            })
            ._unsafeUnwrap()
    else
        await Effect.runPromise(
            api
                .native!.on("messageCreate", (message) =>
                    Effect.sync(() => {
                        received.push(message)
                    }),
                )
                .pipe(Scope.provide(api.scope)),
        )
    const closed = settle(api.client.waitForClose())
    dispatch("MESSAGE_CREATE", { ...wire(), attachments: [{ ...attachment, size: -1 }] })
    await expect(closed).rejects.toMatchObject({ reason: "protocol" })
    expect(received).toEqual([])
    expect(api.client.diagnostics().caches.messages.retainedEntries).toBe(0)
})

test.each(modes)("%s standalone webhook messages remain full beside a core-only bot client", async (mode) => {
    await setup(mode, [])
    const scope = Scope.makeUnsafe()
    const options = { id: "50", token: "fixture-only-webhook" }
    const webhook =
        mode === "default"
            ? createWebhookClient(options)._unsafeUnwrap()
            : await Effect.runPromise(createNativeWebhook(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        await settle(webhook.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    stubFetchWithHostedDiscovery(async () => Response.json(wire()))
    expectProjection(await settle(webhook.send({ content: "webhook" })), undefined)
})
