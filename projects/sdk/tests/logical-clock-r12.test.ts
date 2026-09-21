import { Cause, Clock, Deferred, Effect, Exit, Fiber, Logger, Scope } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, expect, test, vi } from "vitest"
import { nativeCommands } from "../src/native-commands.js"
import type { Message } from "../src/messages.js"
import { createClient as createNative } from "../src/effect.js"
import { MessageCache } from "../src/internal/cache.js"
import { collect } from "../src/internal/collector.js"
import { EventBus, waitForEvent } from "../src/internal/events.js"
import { GatewayRequestBudget } from "../src/internal/gateway-requests.js"
import { LogicalScheduler, makeLogicalScheduler } from "../src/internal/logical-scheduler.js"
import { MemberChunkOwner } from "../src/internal/member-chunks.js"
import type { ClientOwner } from "../src/internal/client.js"
import { fetchPermissions } from "../src/internal/permissions.js"
import { PresenceOwner } from "../src/internal/presence.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

afterEach(() => vi.unstubAllGlobals())

const withTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" }))))

test("logical scheduler wakes for an earlier deadline and skips cleared due callbacks", async () => {
    await withTestClock(
        Effect.gen(function* () {
            const scope = Scope.makeUnsafe()
            const scheduler = yield* makeLogicalScheduler(scope)
            const observed: string[] = []
            scheduler.set(() => observed.push("late"), 100, "test late")
            yield* Effect.yieldNow
            scheduler.set(() => observed.push("early"), 10, "test early")
            yield* TestClock.adjust(10)
            expect(observed).toEqual(["early"])
            yield* TestClock.adjust(90)
            expect(observed).toEqual(["early", "late"])

            let cancelled: object
            scheduler.set(() => scheduler.clear(cancelled), 10, "test canceller")
            cancelled = scheduler.set(() => observed.push("cancelled"), 10, "test cancelled")
            yield* TestClock.adjust(10)
            expect(observed).toEqual(["early", "late"])

            const first = scheduler.set(() => observed.push("cleared"), 10, "test cleared")
            scheduler.set(() => observed.push("next"), 20, "test next")
            scheduler.clear(first)
            yield* TestClock.adjust(10)
            expect(observed).toEqual(["early", "late"])
            yield* TestClock.adjust(10)
            expect(observed).toEqual(["early", "late", "next"])

            scheduler.set(
                () => {
                    throw new Error("private callback defect")
                },
                10,
                "test defective",
            )
            scheduler.set(() => observed.push("same-due survivor"), 10, "test survivor")
            scheduler.set(() => observed.push("later survivor"), 20, "test later survivor")
            yield* TestClock.adjust(10)
            expect(observed).toEqual(["early", "late", "next", "same-due survivor"])
            yield* TestClock.adjust(10)
            expect(observed).toEqual(["early", "late", "next", "same-due survivor", "later survivor"])

            yield* Scope.close(scope, Exit.void)
            scheduler.set(() => observed.push("after-close"), 1, "test after close")
            yield* TestClock.adjust(1)
            expect(observed).toEqual(["early", "late", "next", "same-due survivor", "later survivor"])
        }).pipe(
            Effect.provide(
                Logger.layer([
                    Logger.make(() => {
                        throw new Error("private logger defect")
                    }),
                ]),
            ),
        ),
    )
})

test("TestClock expires cache TTLs in the background and diagnostics report released accounting", async () => {
    await withTestClock(
        Effect.gen(function* () {
            const scope = Scope.makeUnsafe()
            const logical = yield* makeLogicalScheduler(scope)
            let reads = 0
            const cache = new MessageCache<Message>(
                { maxEntries: 2, maxBytes: 10_000, maxAgeMs: 50, onError: undefined },
                () => undefined,
                () => {
                    reads++
                    return logical.now()
                },
                logical,
            )
            cache.observe({
                id: "10",
                channelId: "20",
                content: "fixture",
                embeds: [],
                attachments: [],
                stickers: [],
                author: { id: "30", username: "fixture", isBot: false },
            } as Message)
            const readsAfterAdmission = reads
            expect(cache.diagnostics()).toMatchObject({ retainedEntries: 1 })
            yield* TestClock.adjust(50)
            expect(reads).toBeGreaterThan(readsAfterAdmission)
            expect(cache.diagnostics()).toMatchObject({ retainedEntries: 0, accountedBytes: 0 })
            cache.close()
            yield* Scope.close(scope, Exit.void)
        }),
    )
})

test("TestClock advances presence pacing and member-subscription scheduling", async () => {
    await withTestClock(
        Effect.gen(function* () {
            const scope = Scope.makeUnsafe()
            const logical = yield* makeLogicalScheduler(scope)
            const presenceUpdates: unknown[] = []
            const timer = {
                now: () => logical.now(),
                set: (callback: () => void, delay: number) => logical.set(callback, delay, "test presence"),
                clear: (timer: unknown) => logical.clear(timer as object),
            }
            const presence = new PresenceOwner(timer, () => 0)
            presence.attach((update) => {
                presenceUpdates.push(update)
            })
            expect(presence.set({ status: "online" })).toBeUndefined()
            yield* TestClock.adjust(0)
            expect(presenceUpdates).toHaveLength(1)
            expect(presence.set({ status: "idle" })).toBeUndefined()
            yield* TestClock.adjust(3_999)
            expect(presenceUpdates).toHaveLength(1)
            yield* TestClock.adjust(1)
            expect(presenceUpdates).toHaveLength(2)
            presence.close()

            const memberUpdates: unknown[] = []
            const members = new PresenceOwner(timer, () => 0)
            expect(members.setMembers("20", ["30"])).toBeUndefined()
            members.attach(
                () => undefined,
                (update) => {
                    memberUpdates.push(update)
                },
            )
            yield* TestClock.adjust(0)
            expect(memberUpdates).toHaveLength(1)
            members.close()
            yield* Scope.close(scope, Exit.void)
        }),
    )
})

test("composed owner workflows decrement one creation-Clock budget", async () => {
    await withTestClock(
        Effect.gen(function* () {
            const clock = yield* Clock.Clock
            const logical = new LogicalScheduler(clock)
            const timeouts: number[] = []
            const owner = {
                logical,
                guild: (operation: string, _request: unknown, options: { timeoutMs?: number }) =>
                    Effect.gen(function* () {
                        timeouts.push(options.timeoutMs!)
                        yield* TestClock.adjust(10)
                        if (operation === "guilds.fetch")
                            return { id: "20", ownerId: "99", name: "fixture", features: [], icon: null }
                        if (operation === "members.fetch")
                            return {
                                guildId: "20",
                                userId: "30",
                                username: "fixture",
                                isBot: true,
                                roleIds: ["40"],
                                joinedAt: "2026-09-08T12:00:00Z",
                                nickname: null,
                                avatar: null,
                            }
                        return [
                            {
                                guildId: "20",
                                id: "20",
                                name: "everyone",
                                color: 0,
                                position: 0,
                                permissions: 0n,
                                hoist: false,
                                mentionable: false,
                            },
                            {
                                guildId: "20",
                                id: "40",
                                name: "member",
                                color: 0,
                                position: 1,
                                permissions: 4n,
                                hoist: false,
                                mentionable: false,
                            },
                        ]
                    }),
                channel: (_operation: string, _request: unknown, options: { timeoutMs?: number }) =>
                    Effect.gen(function* () {
                        timeouts.push(options.timeoutMs!)
                        yield* TestClock.adjust(10)
                        return { id: "50", guildId: "20", type: 0, permissionOverwrites: [] }
                    }),
            } as unknown as Pick<ClientOwner, "channel" | "guild" | "logical">
            expect(
                yield* fetchPermissions(owner, { guildId: "20", userId: "30", channelId: "50" }, { timeoutMs: 100 }),
            ).toBe(4n)
            expect(timeouts).toEqual([100, 90, 80, 70])
        }),
    )
})

test("native cooldown claims use the caller Clock", async () => {
    await withTestClock(
        Effect.gen(function* () {
            const store = yield* nativeCommands.memoryCooldowns({ maxEntries: 1 })
            expect(yield* store.claim({ key: "command:user", durationMs: 100 })).toMatchObject({
                _tag: "CooldownAcquired",
                retryAtMs: 100,
            })
            yield* TestClock.adjust(99)
            expect(yield* store.claim({ key: "command:user", durationMs: 100 })).toMatchObject({
                _tag: "CooldownActive",
                retryAtMs: 100,
            })
            yield* TestClock.adjust(1)
            expect(yield* store.claim({ key: "command:user", durationMs: 100 })).toMatchObject({
                _tag: "CooldownAcquired",
                retryAtMs: 200,
            })
        }),
    )
})

test("TestClock advances event waits and releases their subscription", async () => {
    await withTestClock(
        Effect.gen(function* () {
            const bus = new EventBus()
            const fiber = yield* Effect.forkChild(waitForEvent(bus, "messageCreate", { timeoutMs: 100 }))
            yield* Effect.yieldNow
            expect(bus.diagnostics().subscriptions).toBe(1)
            yield* TestClock.adjust(100)
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit))
                expect(exit.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({ _tag: "EventWaitError", reason: "timeout" }),
                    }),
                )
            expect(bus.diagnostics().subscriptions).toBe(0)
        }),
    )
})

test("TestClock advances collector and member-stream deadlines without host waiting", async () => {
    await withTestClock(
        Effect.gen(function* () {
            const scope = Scope.makeUnsafe()
            const logical = yield* makeLogicalScheduler(scope)
            const events = new EventBus()
            const owner = {
                state: "Connected",
                logical,
                events,
                shardIdForGuild: () => 0,
                gatewayState: () => "Connected",
                subscribe: () => () => undefined,
                subscribeGateway: () => () => undefined,
            } as unknown as ClientOwner
            const collector = yield* collect(owner, "20", { timeoutMs: 50 })
            const collected = yield* Effect.forkChild(Deferred.await(collector.closed))
            yield* TestClock.adjust(50)
            expect(yield* Fiber.join(collected)).toEqual({ messages: [], reason: "timeout" })
            expect(events.diagnostics().messageCollectors).toBe(0)

            const members = new MemberChunkOwner(new GatewayRequestBudget(), logical)
            members.attach(() => undefined)
            const source = yield* members.open("20", { all: true }, { timeoutMs: 75 })
            const next = yield* Effect.forkChild(Effect.exit(source.next))
            yield* TestClock.adjust(75)
            const memberExit = yield* Fiber.join(next)
            expect(Exit.isFailure(memberExit)).toBe(true)
            if (Exit.isFailure(memberExit)) {
                expect(Cause.hasInterrupts(memberExit.cause)).toBe(false)
                expect(memberExit.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({ _tag: "MemberChunkError", reason: "timeout" }),
                    }),
                )
            }
            yield* Scope.close(scope, Exit.void)
        }),
    )
})

test("TestClock advances queued REST deadlines and interruption removes queued work", async () => {
    let calls = 0
    stubFetchWithHostedDiscovery(async () =>
        ++calls === 1
            ? new Response(null, {
                  status: 429,
                  headers: {
                      "retry-after": new Date(Date.now() + 2_000).toUTCString(),
                      "x-ratelimit-scope": "global",
                  },
              })
            : new Response(null, { status: 204 }),
    )
    await withTestClock(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const rejected = yield* Effect.exit(client.messages.typing("20", { timeoutMs: 500 }))
                expect(Exit.isFailure(rejected)).toBe(true)

                const timed = yield* Effect.forkScoped(
                    Effect.exit(client.messages.delete({ channelId: "21", id: "10" }, { timeoutMs: 100 })),
                )
                yield* Effect.yieldNow
                yield* TestClock.adjust(100)
                const timedExit = yield* Fiber.join(timed)
                expect(Exit.isFailure(timedExit)).toBe(true)
                if (Exit.isFailure(timedExit))
                    expect(timedExit.cause.reasons).toContainEqual(
                        expect.objectContaining({
                            _tag: "Fail",
                            error: expect.objectContaining({ reason: "timeout", outcome: "notDispatched" }),
                        }),
                    )
                expect(calls).toBe(1)

                const interrupted = yield* Effect.forkScoped(client.messages.delete({ channelId: "22", id: "11" }))
                yield* Effect.yieldNow
                yield* Fiber.interrupt(interrupted)
                const interruptedExit = yield* Fiber.await(interrupted)
                expect(Exit.isFailure(interruptedExit) && Cause.hasInterrupts(interruptedExit.cause)).toBe(true)
                yield* TestClock.adjust(1_900)
                yield* client.messages.typing("23")
                expect(calls).toBe(2)
                yield* client.shutdown()
            }),
        ),
    )
})

test("REST admission and total deadline remain bound to the client creation Clock", async () => {
    let calls = 0
    stubFetchWithHostedDiscovery(async () =>
        ++calls === 1
            ? new Response(null, {
                  status: 429,
                  headers: { "retry-after": "1", "x-ratelimit-scope": "global" },
              })
            : new Response(null, { status: 204 }),
    )
    await withTestClock(
        Effect.scoped(
            Effect.gen(function* () {
                const creationClock = yield* TestClock.testClockWith(Effect.succeed)
                const operationClock = yield* TestClock.make({ warningDelay: "10 seconds" })
                const scope = Scope.makeUnsafe()
                const client = yield* createNative({ token: "fixture-only-not-a-credential" }).pipe(
                    Scope.provide(scope),
                    Effect.provideService(Clock.Clock, creationClock),
                )
                yield* Effect.exit(client.messages.typing("20", { timeoutMs: 500 })).pipe(
                    Effect.provideService(Clock.Clock, operationClock),
                )
                let settled = false
                const queued = yield* Effect.forkChild(
                    Effect.exit(client.messages.delete({ channelId: "21", id: "10" }, { timeoutMs: 100 })).pipe(
                        Effect.provideService(Clock.Clock, operationClock),
                        Effect.ensuring(Effect.sync(() => (settled = true))),
                    ),
                )
                yield* Effect.yieldNow
                yield* operationClock.adjust(100)
                expect(settled).toBe(false)
                yield* creationClock.adjust(100)
                const exit = yield* Fiber.join(queued)
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit))
                    expect(exit.cause.reasons).toContainEqual(
                        expect.objectContaining({
                            _tag: "Fail",
                            error: expect.objectContaining({ reason: "timeout", outcome: "notDispatched" }),
                        }),
                    )
                expect(calls).toBe(1)
                yield* client.shutdown()
                yield* Scope.close(scope, Exit.void)
            }),
        ),
    )
})
