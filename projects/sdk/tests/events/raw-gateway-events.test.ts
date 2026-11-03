import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test, vi } from "vitest"
import type { EventMap, EventName, GatewayErrorData } from "../../src/index.js"
import { createTestClient as createDefaultTestClient, type TestClient as DefaultTestClient } from "../../src/testing.js"
import {
    createTestClient as createNativeTestClient,
    type TestClient as NativeTestClient,
} from "../../src/effect-testing.js"
import { describeBothApis, type Mode } from "../support/both-apis.js"

// The raw event reports whether Fluxer's documentation describes each dispatch type, without changing what arrives, and
// an opcode 12 Gateway Error frame reaches gatewayError subscriptions instead of being ignored as an unknown opcode.
// Both run through the in-memory test gateway, which sends real frames to the SDK's socket handling

interface Driver {
    readonly test: DefaultTestClient | NativeTestClient
    ready(): Promise<void>
    emit(type: string, payload: unknown): Promise<void>
    emitGatewayError(data: GatewayErrorData, shardId?: number): Promise<void>
    collect<K extends EventName>(event: K): Promise<EventMap[K][]>
}

async function open(mode: Mode): Promise<Driver> {
    const options = { logging: { level: "debug" as const } }
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        onTestFinished(() => test.shutdown())
        return {
            test,
            ready: () => test.ready(),
            emit: async (type, payload) => test.emit(type, payload),
            emitGatewayError: async (data, shardId) =>
                test.emitGatewayError(data, shardId === undefined ? undefined : { shardId }),
            collect: async (event) => {
                const received: EventMap[typeof event][] = []
                test.client.on(event, (value) => void received.push(value))
                return received
            },
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
    return {
        test,
        ready: () => Effect.runPromise(test.ready()),
        emit: (type, payload) => Effect.runPromise(test.emit(type, payload)),
        emitGatewayError: (data, shardId) =>
            Effect.runPromise(test.emitGatewayError(data, shardId === undefined ? undefined : { shardId })),
        collect: async (event) => {
            const received: EventMap[typeof event][] = []
            await Effect.runPromise(
                test.client
                    .on(event, (value) => Effect.sync(() => void received.push(value)))
                    .pipe(Scope.provide(scope)),
            )
            return received
        },
    }
}

const refusal = { code: "VOICE_CHANNEL_FULL", message: "Voice channel is full" }

describeBothApis("raw gateway events", (mode) => {
    test("marks documented dispatch types and still delivers an unknown type with its body", async () => {
        const driver = await open(mode)
        const raw = await driver.collect("raw")
        await driver.ready()
        const message = driver.test.fixtures.message({ content: "Hello" })
        await driver.emit("MESSAGE_CREATE", message)
        await driver.emit("FIXTURE_ONLY_FUTURE_EVENT", { added_later: [1, 2] })
        await vi.waitFor(() => expect(raw).toHaveLength(3))
        expect(raw.map(({ t, s, documented }) => ({ t, s, documented }))).toEqual([
            { t: "READY", s: 1, documented: true },
            { t: "MESSAGE_CREATE", s: 2, documented: true },
            { t: "FIXTURE_ONLY_FUTURE_EVENT", s: 3, documented: false },
        ])
        expect(raw.every((dispatch) => Object.isFrozen(dispatch))).toBe(true)
        const [, created, future] = raw
        // The body is Fluxer's wire data under its own field names, not a decoded SDK object
        if (!created?.documented || created.t !== "MESSAGE_CREATE")
            return expect.fail("MESSAGE_CREATE was not documented")
        expect(created.d.channel_id).toBe(message.channel_id)
        expect(created.d.content).toBe("Hello")
        expect(future?.d).toEqual({ added_later: [1, 2] })
        expect(driver.test.counters().unknownDispatches).toBe(1)
    })

    test("delivers an opcode 12 frame to gatewayError, not raw, and keeps the session", async () => {
        const driver = await open(mode)
        const raw = await driver.collect("raw")
        const errors = await driver.collect("gatewayError")
        await driver.ready()
        await driver.emitGatewayError(refusal)
        await vi.waitFor(() => expect(errors).toHaveLength(1))
        expect(errors).toEqual([{ shardId: 0, d: refusal }])
        expect(Object.isFrozen(errors[0])).toBe(true)
        // The frame has no sequence, so the next dispatch continues the session's numbering and arrives as usual
        await driver.emit("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 })
        await vi.waitFor(() =>
            expect(raw.map(({ t, s }) => [t, s])).toEqual([
                ["READY", 1],
                ["TYPING_START", 2],
            ]),
        )
        expect(driver.test.client.state).toBe("Connected")
        expect(driver.test.counters()).toMatchObject({ unknownOpcodes: 0, protocolFailures: 0 })
        expect(driver.test.logs().filter((record) => record.code === "gateway.gatewayError")).toEqual([
            expect.objectContaining({
                level: "debug",
                shardId: 0,
                fields: { code: "VOICE_CHANNEL_FULL", bytes: expect.any(Number) },
            }),
        ])
    })

    test("warns about an opcode 12 frame no subscription receives and passes unexpected data through unchanged", async () => {
        const driver = await open(mode)
        const raw = await driver.collect("raw")
        await driver.ready()
        await driver.emitGatewayError(refusal)
        expect(driver.test.logs().filter((record) => record.code === "gateway.gatewayError")).toEqual([
            expect.objectContaining({
                level: "warn",
                fields: { code: "VOICE_CHANNEL_FULL", bytes: expect.any(Number) },
            }),
        ])
        const errors = await driver.collect("gatewayError")
        // Fluxer's data is not validated: A frame whose code is no plain code still arrives, and its log names no code
        const unexpected = { code: 7, message: "Changed shape" } as unknown as GatewayErrorData
        await driver.emitGatewayError(unexpected)
        await vi.waitFor(() => expect(errors).toEqual([{ shardId: 0, d: unexpected }]))
        expect(
            driver.test
                .logs()
                .filter((record) => record.code === "gateway.gatewayError")
                .at(-1),
        ).toMatchObject({
            level: "debug",
            fields: { code: null },
        })
        expect(raw.map(({ t }) => t)).toEqual(["READY"])
    })
})
