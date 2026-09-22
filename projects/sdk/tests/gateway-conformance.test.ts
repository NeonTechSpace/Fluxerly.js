import { Effect } from "effect"
import { describe, expect, test, vi } from "vitest"
import * as defaultModule from "../src/index.js"
import * as effectModule from "../src/effect.js"
import {
    assertGatewayCommand,
    assertGatewayFrame,
    createGatewayConformanceDriver,
    runGatewayConformance,
} from "./gateway-conformance-fixture.js"

describe("shared gateway protocol reference", () => {
    test.each(["default", "effect"] as const)(
        "%s covers identify, delivery, resume, reset, terminal close and cleanup",
        async (mode) => {
            const moduleObject = mode === "default" ? defaultModule : effectModule
            await expect(runGatewayConformance(mode, moduleObject)).resolves.toEqual({
                mode,
                commands: 4,
                delivered: 1,
            })
        },
        15_000,
    )

    test("rejects counterfeit frames, resume sequences and credentials", () => {
        expect(() =>
            assertGatewayFrame({ op: 0, s: 8, t: "RESUMED", d: {} }, { op: 0, type: "RESUMED", sequence: 7 }),
        ).toThrow(/sequence 7/)
        expect(() =>
            assertGatewayCommand(
                { op: 6, d: { token: "wrong", session_id: "session-a", seq: 2 } },
                { op: 6, token: "expected", sessionId: "session-a", sequence: 2 },
            ),
        ).toThrow(/credential expected/)
        expect(() =>
            assertGatewayCommand(
                { op: 6, d: { token: "expected", session_id: "session-a", seq: 3 } },
                { op: 6, token: "expected", sessionId: "session-a", sequence: 2 },
            ),
        ).toThrow(/sequence 2/)
    })

    test("releases clients and the Effect scope when subscription construction fails", async () => {
        const failure = new Error("registration-failure")
        const defaultShutdown = vi.fn()
        const defaultClient = {
            on: () => ({
                _unsafeUnwrap() {
                    throw failure
                },
            }),
            shutdown: async () => ({
                _unsafeUnwrap() {
                    defaultShutdown()
                },
            }),
        }
        const defaultSdk = { createClient: () => ({ _unsafeUnwrap: () => defaultClient }) }
        await expect(createGatewayConformanceDriver("default", defaultSdk, "http://127.0.0.1", [])).rejects.toBe(
            failure,
        )
        expect(defaultShutdown).toHaveBeenCalledOnce()

        const effectShutdown = vi.fn()
        const scopeFinalizer = vi.fn()
        const effectClient = {
            on: () => Effect.fail(failure),
            shutdown: () => Effect.sync(effectShutdown),
        }
        const effectSdk = {
            createClient: () =>
                Effect.gen(function* () {
                    yield* Effect.addFinalizer(() => Effect.sync(scopeFinalizer))
                    return effectClient
                }),
        }
        await expect(createGatewayConformanceDriver("effect", effectSdk, "http://127.0.0.1", [])).rejects.toBe(failure)
        expect(effectShutdown).toHaveBeenCalledOnce()
        expect(scopeFinalizer).toHaveBeenCalledOnce()
    })
})
