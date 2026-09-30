import { EventEmitter } from "node:events"
import { setImmediate as turn } from "node:timers/promises"
import { afterEach, expect, test, vi } from "vitest"
import { createFixtures } from "../../src/testing.js"
import type { WebSocketLike } from "../../src/index.js"
import { describeBothApis, setup } from "../support/both-apis.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"

const gatewayUrl = "wss://gateway.fluxer.app/?v=1&encoding=json"
afterEach(() => vi.useRealTimers())

/** A scripted transport socket with no I/O or host timers */
class ScriptSocket extends EventEmitter implements WebSocketLike {
    readyState = 1
    constructor(private readonly command: (socket: ScriptSocket, op: number) => void) {
        super()
        queueMicrotask(() => this.deliver({ op: 10, d: { heartbeat_interval: 60_000 } }))
    }
    send(data: string, callback: (error?: Error) => void) {
        const { op } = JSON.parse(data) as { op: number }
        queueMicrotask(() => callback())
        if (op === 1) queueMicrotask(() => this.deliver({ op: 11 }))
        else this.command(this, op)
    }
    deliver(frame: unknown) {
        if (this.readyState === 1) this.emit("message", Buffer.from(JSON.stringify(frame)), false)
    }
    close(code: number) {
        if (this.readyState !== 1) return
        this.readyState = 3
        queueMicrotask(() => this.emit("close", code))
    }
    terminate() {
        this.close(1006)
    }
}

/** Drain SDK fibers and advance only the controlled retry clock, with a bounded number of steps */
async function advanceUntil(predicate: () => boolean) {
    for (let step = 0; step < 20 && !predicate(); step++) {
        await turn()
        await vi.advanceTimersByTimeAsync(1_000)
        await turn()
    }
    expect(predicate()).toBe(true)
}

describeBothApis("restored session replay", (mode) => {
    test.each(["invalid-sequence close", "drop then invalid session"] as const)(
        "clears partial replay and outage reads when %s falls back to Identify",
        async (failure) => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
            const fixtures = createFixtures()
            const commands: number[] = []
            let identifySocket: ScriptSocket | undefined
            let replaySocket: ScriptSocket | undefined
            const replayed = Promise.withResolvers<void>()
            const client = await setup(mode, {
                logging: { level: "silent" },
                cache: { guilds: true, roles: true, channels: true, members: true },
                sharding: {
                    totalShards: 1,
                    refillCaches: false,
                    sessions: {
                        load: async () => ({
                            sessionId: "saved-session",
                            sequence: 41,
                            resumeUrl: gatewayUrl,
                            savedAt: Date.now(),
                            totalShards: 1,
                        }),
                        save: async () => {},
                    },
                },
                transport: {
                    fetch: async (url) =>
                        Response.json(url.endsWith("/.well-known/fluxer") ? hostedDiscoveryDocument : fixtures.guild()),
                    webSocket: () =>
                        new ScriptSocket((socket, op) => {
                            commands.push(op)
                            if (op === 2) identifySocket = socket
                            else if (op === 6 && commands.length === 1) {
                                socket.deliver({ op: 0, s: 42, t: "GUILD_CREATE", d: fixtures.guildCreate() })
                                socket.deliver({ op: 0, s: 43, t: "GUILD_MEMBER_ADD", d: fixtures.member() })
                                replaySocket = socket
                                replayed.resolve()
                            } else if (op === 6) socket.deliver({ op: 9, d: false })
                        }),
                },
            })
            const connected = settle(client.connect())
            // Observe startup rejection even when an earlier assertion fails and cleanup interrupts it
            void connected.catch(() => {})
            await replayed.promise
            expect(await settle(client.guilds.get(fixtures.ids.guild))).toBeDefined()
            replaySocket!.close(failure === "invalid-sequence close" ? 4007 : 1006)
            await advanceUntil(() => identifySocket !== undefined)
            expect(commands).toEqual(failure === "invalid-sequence close" ? [6, 2] : [6, 6, 2])
            expect(await settle(client.guilds.get(fixtures.ids.guild))).toBeUndefined()
            expect(await settle(client.channels.get(fixtures.ids.channel))).toBeUndefined()
            expect(
                await settle(client.roles.get({ guildId: fixtures.ids.guild, id: fixtures.ids.guild })),
            ).toBeUndefined()
            expect(
                await settle(client.members.get({ guildId: fixtures.ids.guild, userId: fixtures.ids.user })),
            ).toBeUndefined()
            // A REST observation made while waiting for the new READY is cleared at readiness too
            await settle(client.guilds.fetch(fixtures.ids.guild))
            expect(await settle(client.guilds.get(fixtures.ids.guild))).toBeDefined()
            identifySocket!.deliver({ op: 0, s: 1, t: "READY", d: { session_id: "new-session", shard: [0, 1] } })
            await connected
            expect(await settle(client.guilds.get(fixtures.ids.guild))).toBeUndefined()
        },
    )

    test("retains replayed guild resources when the saved session resumes successfully", async () => {
        const fixtures = createFixtures()
        const client = await setup(mode, {
            logging: { level: "silent" },
            cache: { guilds: true, roles: true, channels: true, members: true },
            sharding: {
                totalShards: 1,
                refillCaches: false,
                sessions: {
                    load: async () => ({
                        sessionId: "saved-session",
                        sequence: 41,
                        resumeUrl: gatewayUrl,
                        savedAt: Date.now(),
                        totalShards: 1,
                    }),
                    save: async () => {},
                },
            },
            transport: {
                fetch: async () => Response.json(hostedDiscoveryDocument),
                webSocket: () =>
                    new ScriptSocket((socket, op) => {
                        if (op !== 6) return
                        socket.deliver({ op: 0, s: 42, t: "GUILD_CREATE", d: fixtures.guildCreate() })
                        socket.deliver({ op: 0, s: 43, t: "GUILD_MEMBER_ADD", d: fixtures.member() })
                        socket.deliver({ op: 0, s: 44, t: "RESUMED", d: {} })
                    }),
            },
        })
        await settle(client.connect())
        expect(await settle(client.guilds.get(fixtures.ids.guild))).toBeDefined()
        expect(await settle(client.channels.get(fixtures.ids.channel))).toBeDefined()
        expect(await settle(client.roles.get({ guildId: fixtures.ids.guild, id: fixtures.ids.guild }))).toBeDefined()
        expect(
            await settle(client.members.get({ guildId: fixtures.ids.guild, userId: fixtures.ids.user })),
        ).toBeDefined()
    })
})
