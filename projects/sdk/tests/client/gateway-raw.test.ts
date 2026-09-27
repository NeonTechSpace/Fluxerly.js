import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Client, EventMap, EventName, RawDispatch } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { describeBothApis, setup, type Mode } from "../support/both-apis.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs } from "../support/log-capture.js"
import { settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => vi.unstubAllGlobals())

type AnyClient = Client | NativeClient

/** Register a handler in either API style that records each payload */
async function collect<K extends EventName>(mode: Mode, client: AnyClient, event: K): Promise<EventMap[K][]> {
    const received: EventMap[K][] = []
    if (mode === "default") {
        ;(client as Client).on(event, (payload) => {
            received.push(payload as EventMap[K])
        })
        return received
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    await Effect.runPromise(
        (client as NativeClient)
            .on(event, (payload) => Effect.sync(() => void received.push(payload as EventMap[K])))
            .pipe(Scope.provide(scope)),
    )
    return received
}

const typing = { channel_id: "20", user_id: "30", timestamp: 1 }

describeBothApis("raw dispatch delivery", (mode) => {
    test("delivers READY, known and unknown dispatches in wire form alongside decoded events", async () => {
        const server = await startGatewayServer()
        stubFetchWithHostedDiscovery(async () => Response.json({}))
        const logs = captureLogs()
        const client = (await setup(mode, { logging: { ...logs.logging, level: "trace" } })) as AnyClient
        const raw = await collect(mode, client, "raw")
        const typed = await collect(mode, client, "typingStart")
        await settle((client as Client).connect())
        server.dispatch("TYPING_START", typing)
        server.dispatch("FUTURE_EVENT", { anything: [1, 2] })
        await vi.waitFor(() => expect(raw).toHaveLength(3))
        expect(raw).toEqual([
            { shardId: 0, t: "READY", s: 1, d: { session_id: "fixture-session" } },
            { shardId: 0, t: "TYPING_START", s: 2, d: typing },
            { shardId: 0, t: "FUTURE_EVENT", s: 3, d: { anything: [1, 2] } },
        ] satisfies RawDispatch[])
        expect(raw.every((item) => Object.isFrozen(item))).toBe(true)
        await vi.waitFor(() => expect(typed).toEqual([expect.objectContaining({ channelId: "20" })]))
        // Unknown types are still counted as unknown even though raw subscribers received them
        expect((client as Client).diagnostics().counters.unknownDispatches).toBe(1)
        expect(logs.withCode("events.raw").map((record) => [record.level, record.fields?.dispatch])).toEqual([
            ["trace", "READY"],
            ["trace", "TYPING_START"],
            ["trace", "FUTURE_EVENT"],
        ])
    })

    test("builds and logs nothing for raw dispatches without a raw subscriber", async () => {
        const server = await startGatewayServer()
        stubFetchWithHostedDiscovery(async () => Response.json({}))
        const logs = captureLogs()
        const client = (await setup(mode, { logging: { ...logs.logging, level: "trace" } })) as AnyClient
        const typed = await collect(mode, client, "typingStart")
        await settle((client as Client).connect())
        server.dispatch("TYPING_START", typing)
        await vi.waitFor(() => expect(typed).toHaveLength(1))
        expect(logs.withCode("events.raw")).toEqual([])
    })
})
