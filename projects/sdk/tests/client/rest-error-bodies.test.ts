import { Cause, Effect, Exit } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { SdkDefect, describeError, type Client as DefaultClient } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { fixtureToken, modes, setup } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"

// Shared REST error-body handling: Bounded, cancellable reads of rejected responses and their cleanup

const target = { id: "10", channelId: "20" }

afterEach(() => {
    vi.unstubAllGlobals()
})

/** A 403 JSON response whose body never finishes, recording its cancellation */
function stalledRejection(cancel: () => void | Promise<void>, reading?: () => void) {
    return new Response(
        new ReadableStream({
            pull() {
                reading?.()
                return new Promise<void>(() => undefined)
            },
            cancel,
        }),
        { status: 403, headers: { "content-type": "application/json" } },
    )
}

test.each(modes)("%s classifies a finite chunked API error without Content-Length", async (mode) => {
    stubFetchWithHostedDiscovery(
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode(`{"code":"MISSING_PERMISSIONS"}`))
                            controller.close()
                        },
                    }),
                    { status: 403, headers: { "content-type": "application/json" } },
                ),
        ),
    )
    const client = await setup(mode)
    await expect(settle(client.messages.fetch(target))).rejects.toMatchObject({
        reason: "rejected",
        outcome: "rejected",
        status: 403,
        apiError: { code: "missingPermissions", providerCode: "MISSING_PERMISSIONS" },
    })
})

test.each(modes)("%s drops deceptively short oversized API error bodies", async (mode) => {
    let cancelled = false
    stubFetchWithHostedDiscovery(
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode(
                                    `{"code":"MISSING_PERMISSIONS","private":"${"x".repeat(9_000)}"}`,
                                ),
                            )
                        },
                        cancel() {
                            cancelled = true
                        },
                    }),
                    { status: 403, headers: { "content-length": "1", "content-type": "application/json" } },
                ),
        ),
    )
    const client = await setup(mode)
    await expect(settle(client.messages.fetch(target))).rejects.toMatchObject({
        apiError: null,
        outcome: "rejected",
    })
    expect(cancelled).toBe(true)
})

test.each(modes)("%s bounds stalled API error reads and releases their body", async (mode) => {
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
        reading = resolve
    })
    let cancelled = false
    stubFetchWithHostedDiscovery(
        vi.fn(async () =>
            stalledRejection(() => {
                cancelled = true
            }, reading),
        ),
    )
    const client = await setup(mode)
    const operation = settle(client.messages.fetch(target))
    await started
    await expect(operation).rejects.toMatchObject({
        _tag: "MessageOperationError",
        outcome: "rejected",
        status: 403,
        apiError: null,
    })
    expect(cancelled).toBe(true)
})

test.each(modes)("%s cancels stalled API error reads without retaining their body", async (mode) => {
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
        reading = resolve
    })
    let cancelled = false
    const controller = new AbortController()
    stubFetchWithHostedDiscovery(
        vi.fn(async () =>
            stalledRejection(() => {
                cancelled = true
            }, reading),
        ),
    )
    const client = await setup(mode)
    if (mode === "default") {
        const operation = settle((client as DefaultClient).messages.fetch(target, { signal: controller.signal }))
        await started
        controller.abort()
        await expect(operation).rejects.toMatchObject({ _tag: "CancelledError" })
    } else {
        const operation = Effect.runPromiseExit((client as NativeClient).messages.fetch(target), {
            signal: controller.signal,
        })
        await started
        controller.abort()
        const exit = await operation
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
    expect(cancelled).toBe(true)
})

test.each(modes)(
    "%s retains a rejected outcome with the API error body cleanup defect and masks its credentials",
    async (mode) => {
        const cleanup = new Error(`API error cleanup marker authorization: Bot ${fixtureToken}`)
        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown) => unhandled.push(reason)
        process.on("unhandledRejection", onUnhandled)
        onTestFinished(() => {
            process.off("unhandledRejection", onUnhandled)
        })
        stubFetchWithHostedDiscovery(vi.fn(async () => stalledRejection(() => Promise.reject(cleanup))))
        const client = await setup(mode)
        const rejected = expect.objectContaining({ _tag: "MessageOperationError", outcome: "rejected", status: 403 })
        let defect: unknown
        if (mode === "default") {
            const error = await settle((client as DefaultClient).messages.fetch(target)).catch((failure) => failure)
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).toMatchObject({
                operation: "fetch",
                reasons: [
                    { kind: "Failure", failure: rejected },
                    { kind: "Defect", defect: expect.objectContaining({ name: "ApiErrorBodyCleanupError" }) },
                ],
            })
            defect = (error as SdkDefect).cause
            const text = describeError(error)
            expect(text).toContain("API error cleanup marker")
            expect(text).not.toContain(fixtureToken)
            expect(JSON.stringify(error)).not.toContain(fixtureToken)
        } else {
            const exit = await Effect.runPromiseExit((client as NativeClient).messages.fetch(target))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(exit.cause.reasons).toEqual([
                    expect.objectContaining({ _tag: "Fail", error: rejected }),
                    expect.objectContaining({
                        _tag: "Die",
                        defect: expect.objectContaining({ name: "ApiErrorBodyCleanupError" }),
                    }),
                ])
                const die = exit.cause.reasons.find((reason) => reason._tag === "Die")
                defect = die?._tag === "Die" ? die.defect : undefined
            }
            const text = describeError(defect)
            expect(text).toContain("API error cleanup marker")
            expect(text).not.toContain(fixtureToken)
        }
        // Both APIs keep the original cleanup failure as the cause of the SDK's cleanup defect
        expect((defect as Error).cause).toBe(cleanup)
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(unhandled).toEqual([])
    },
)

test.each(modes)("%s freezes API error detail independently for each rejection", async (mode) => {
    stubFetchWithHostedDiscovery(vi.fn(async () => Response.json({ code: "MISSING_ACCESS" }, { status: 403 })))
    const client = await setup(mode)
    const rejection = async () =>
        (await settle(client.messages.fetch(target)).catch((failure) => failure)) as {
            readonly apiError: { readonly explanation: string } | null
        }
    const first = await rejection()
    expect(first.apiError).toMatchObject({ code: "missingAccess" })
    const detail = { ...first.apiError }
    expect(Object.isFrozen(first.apiError)).toBe(true)
    expect(() => Object.assign(first.apiError!, { explanation: "poisoned" })).toThrow()
    const second = await rejection()
    expect(second.apiError).toEqual(detail)
    expect(second.apiError).not.toBe(first.apiError)
    expect(second.apiError?.explanation).not.toBe("poisoned")
})
