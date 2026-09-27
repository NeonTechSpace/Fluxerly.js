import { setImmediate as turn } from "node:timers/promises"
import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import {
    CancelledError,
    createClient,
    createWebhookClient,
    type Client as DefaultClient,
    type LogRecord,
    type SdkDefect,
} from "../../../src/index.js"
import {
    createClient as createNative,
    createWebhookClient as createNativeWebhook,
    type Client as NativeClient,
} from "../../../src/effect.js"
import { modes, setup, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"
import { expectDefect, expectThrown } from "../defects.js"

const selected = "https://community.example"
const redirected = "https://discovery.community.example"

const document = (overrides: Record<string, unknown> = {}) => ({
    api_code_version: 7,
    endpoints: {
        api_public: "https://api.community.example/root",
        // Third-party clients must use api_public, not the first-party api_client endpoint
        api_client: "http://first-party.community.example/private",
        gateway: "wss://gateway.community.example/socket",
        media: "https://media.community.example",
        static_cdn: "https://static.community.example",
        webapp: "https://app.community.example",
        invite: "https://join.community.example",
    },
    features: { presigned_attachment_uploads: false },
    ...overrides,
})

/** Create a client for one API style with a selected instance, or hosted defaults for null */
function client(
    mode: Mode,
    selection: { readonly url: string; readonly allowInsecure?: boolean } | null = { url: selected },
) {
    return setup(mode, selection ? { instance: selection } : {})
}

function heldDiscovery() {
    let markRequest!: () => void
    const requestStarted = new Promise<void>((resolve) => {
        markRequest = resolve
    })
    let markCleanup!: () => void
    const cleanupStarted = new Promise<void>((resolve) => {
        markCleanup = resolve
    })
    let resolveResponse: ((response: Response) => void) | undefined
    let rejectResponse: ((reason: unknown) => void) | undefined
    let aborts = 0
    return {
        fetch: vi.fn(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((resolve, reject) => {
                    resolveResponse = resolve
                    rejectResponse = reject
                    const abort = () => {
                        markCleanup()
                        if (!init.signal?.aborted) return
                        // The owner must wait until this test-owned request settles after abort
                        aborts += 1
                    }
                    if (init.signal?.aborted) abort()
                    else init.signal?.addEventListener("abort", abort, { once: true })
                    markRequest()
                }),
        ),
        requestStarted,
        cleanupStarted,
        releaseCleanup: () => rejectResponse!(undefined),
        complete: () => resolveResponse!(Response.json(document())),
        get aborts() {
            return aborts
        },
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

test.each(modes)(
    "%s follows only unauthenticated well-known bootstrap redirects and freezes one pure result",
    async (mode) => {
        const requests: { readonly url: string; readonly init: RequestInit }[] = []
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
            requests.push({ url, init })
            return url === `${selected}/.well-known/fluxer`
                ? new Response(null, {
                      status: 308,
                      headers: { location: `${redirected}/.well-known/fluxer` },
                  })
                : Response.json(document())
        })
        const value = await client(mode)
        const resolved = await settle(value.instance.resolve())
        const again = await settle(value.instance.resolve())

        expect(again).toBe(resolved)
        expect(requests).toHaveLength(2)
        expect(requests.map((request) => request.url)).toEqual([
            `${selected}/.well-known/fluxer`,
            `${redirected}/.well-known/fluxer`,
        ])
        for (const request of requests) {
            expect(request.init.redirect).toBe("manual")
            expect([...new Headers(request.init.headers).keys()]).toEqual(["user-agent"])
            expect(request.init.method).toBe("GET")
        }
        expect(resolved).toMatchObject({
            apiCodeVersion: 7,
            endpoints: {
                apiPublic: "https://api.community.example/root",
                gateway: "wss://gateway.community.example/socket",
                media: "https://media.community.example",
                staticCdn: "https://static.community.example",
                webapp: "https://app.community.example",
                invite: "https://join.community.example",
            },
            presignedAttachmentUploads: false,
        })
        expect(Object.isFrozen(resolved) && Object.isFrozen(resolved.endpoints)).toBe(true)
        expect(resolved.assets.defaultAvatar("0")).toBe("https://static.community.example/avatars/0.png")
        expect(resolved.assets.emoji({ id: "1", animated: false })).toBe(
            "https://media.community.example/emojis/1.webp",
        )
        expect(resolved.links.channel({ id: "2" })).toBe("https://app.community.example/channels/@me/2")
        expect(resolved.links.installation("3")).toBe(
            "https://app.community.example/oauth2/authorize?client_id=3&scope=bot",
        )
        expect(expectThrown(() => resolved.links.channel({ id: "02" }))).toMatchObject({
            _tag: "HelperError",
            operation: "links.channel",
            reason: "id",
        })
        expect(expectThrown(() => resolved.assets.defaultAvatar("02"))).toMatchObject({
            _tag: "AssetUrlError",
            operation: "assets.defaultAvatar",
            reason: "id",
        })
        expect(requests).toHaveLength(2)
    },
)

test.each(modes)(
    "%s resolves hosted defaults through the provider bootstrap redirect without credentials",
    async (mode) => {
        const requests: { readonly url: string; readonly init: RequestInit }[] = []
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
            requests.push({ url, init })
            return url === "https://fluxer.app/.well-known/fluxer"
                ? new Response(null, {
                      status: 308,
                      headers: { location: "https://api.fluxer.app/.well-known/fluxer" },
                  })
                : Response.json(document())
        })
        const value = await client(mode, null)
        expect((await settle(value.instance.resolve())).apiCodeVersion).toBe(7)
        expect(requests.map((request) => request.url)).toEqual([
            "https://fluxer.app/.well-known/fluxer",
            "https://api.fluxer.app/.well-known/fluxer",
        ])
        expect(
            requests.every(
                (request) =>
                    request.init.method === "GET" &&
                    request.init.redirect === "manual" &&
                    [...new Headers(request.init.headers).keys()].join() === "user-agent",
            ),
        ).toBe(true)
    },
)

test.each(modes)("%s retries a failed discovery instead of caching its failure", async (mode) => {
    let attempts = 0
    vi.stubGlobal("fetch", async () => {
        attempts += 1
        return attempts === 1 ? Response.json({}) : Response.json(document())
    })
    const value = await client(mode)
    await expect(settle(value.instance.resolve())).rejects.toMatchObject({
        _tag: "ConnectionError",
        reason: "protocol",
    })
    expect((await settle(value.instance.resolve())).apiCodeVersion).toBe(7)
    expect(attempts).toBe(2)
})

test.each(modes)("%s rejects an oversized selected-instance document", async (mode) => {
    vi.stubGlobal(
        "fetch",
        async () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(1_048_577))
                    },
                }),
            ),
    )
    const value = await client(mode)
    await expect(settle(value.instance.resolve())).rejects.toMatchObject({
        _tag: "ConnectionError",
        reason: "protocol",
    })
})

for (const status of [200, 429])
    test.each(modes)(
        `%s retains bounded discovery failure and both reader cleanup defects for HTTP ${status}`,
        async (mode) => {
            const cancellation = new Error("reader cancellation marker")
            const release = new Error("reader release marker")
            const reader = {
                read: vi.fn(async () => ({ done: false, value: new Uint8Array(1_048_577) })),
                cancel: vi.fn(async () => {
                    throw cancellation
                }),
                releaseLock: vi.fn(() => {
                    throw release
                }),
            }
            vi.stubGlobal("fetch", async () => ({
                status,
                ok: status === 200,
                bodyUsed: true,
                headers: new Headers({ "retry-after": "2" }),
                body: { getReader: () => reader },
            }))
            const value = await client(mode)
            const expected =
                status === 200
                    ? { _tag: "ConnectionError", reason: "protocol", status: 200 }
                    : { _tag: "RateLimitError", retryAfterMs: 2000 }
            if (mode === "default") {
                const error = await Promise.resolve((value as DefaultClient).instance.resolve()).catch(
                    (error: unknown) => error,
                )
                expect(error).toMatchObject({
                    name: "SdkDefect",
                    reasons: [
                        { kind: "Failure", failure: expect.objectContaining(expected) },
                        { kind: "Defect", defect: expect.any(AggregateError) },
                    ],
                })
                const defect = (error as SdkDefect).reasons.find((reason) => reason.kind === "Defect")
                if (defect?.kind === "Defect")
                    expect((defect.defect as AggregateError).errors).toEqual([cancellation, release])
            } else {
                const exit = await Effect.runPromiseExit((value as NativeClient).instance.resolve())
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit)) {
                    expect(exit.cause.reasons).toEqual([
                        expect.objectContaining({ _tag: "Fail", error: expect.objectContaining(expected) }),
                        expect.objectContaining({ _tag: "Die", defect: expect.any(AggregateError) }),
                    ])
                    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
                    if (defect?._tag === "Die")
                        expect((defect.defect as AggregateError).errors).toEqual([cancellation, release])
                }
            }
            expect(reader.read).toHaveBeenCalledTimes(1)
            expect(reader.cancel).toHaveBeenCalledTimes(1)
            expect(reader.releaseLock).toHaveBeenCalledTimes(1)
        },
    )

test.each(modes)("%s keeps cancellation and response-cleanup defects together", async (mode) => {
    let entered!: () => void
    const enteredFetch = new Promise<void>((resolve) => {
        entered = resolve
    })
    vi.stubGlobal("fetch", async () => {
        entered()
        return new Response(
            new ReadableStream({
                cancel: () => {
                    throw new Error("fixture response cleanup defect")
                },
            }),
        )
    })
    const value = await client(mode)
    const controller = new AbortController()
    if (mode === "default") {
        const pending = value.instance.resolve({ signal: controller.signal })
        await enteredFetch
        controller.abort()
        await expect(settle(pending)).rejects.toMatchObject({
            name: "SdkDefect",
            operation: "instance.resolve",
            reasons: expect.arrayContaining([{ kind: "Interruption" }, expect.objectContaining({ kind: "Defect" })]),
        })
        return
    }
    const pending = Effect.runPromiseExit((value as NativeClient).instance.resolve(), { signal: controller.signal })
    await enteredFetch
    controller.abort()
    const exit = await pending
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(Cause.hasDies(exit.cause)).toBe(true)
    }
})

test.each(modes)(
    "%s defaults only an undefined instance deadline and rejects malformed options before fetch",
    async (mode) => {
        const fetch = vi.fn(async () => Response.json(document()))
        vi.stubGlobal("fetch", fetch)
        const value = await client(mode)
        const malformed = [null, 1, { timeoutMs: 0 }, { timeoutMs: null }, { timeoutMs: "soon" }, { unexpected: true }]
        for (const options of malformed) {
            if (mode === "default") {
                const result = await (value as DefaultClient).instance.resolve(options as never)
                expect(result.isErr() && result.error).toMatchObject({ _tag: "ConfigurationError", field: "timeoutMs" })
            } else {
                const exit = await Effect.runPromiseExit((value as NativeClient).instance.resolve(options as never))
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit)) {
                    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                    expect(failure?._tag === "Fail" && failure.error).toMatchObject({
                        _tag: "ConfigurationError",
                        field: "timeoutMs",
                    })
                }
            }
        }
        expect(fetch).not.toHaveBeenCalled()
        if (mode === "default") {
            const signal = new AbortController().signal
            const result = await (value as DefaultClient).instance.resolve({ signal })
            expect(result.isOk()).toBe(true)
        } else
            expect(
                Exit.isSuccess(await Effect.runPromiseExit((value as NativeClient).instance.resolve(undefined))),
            ).toBe(true)
        expect(fetch).toHaveBeenCalledTimes(1)
    },
)

test.each(modes)("%s keeps throwing resolve-option access inside its public failure boundary", async (mode) => {
    const fetch = vi.fn(async () => Response.json(document()))
    vi.stubGlobal("fetch", fetch)
    const value = await client(mode)
    const options = Object.defineProperty({}, "timeoutMs", {
        get() {
            throw new Error("fixture timeout getter")
        },
    })
    if (mode === "default") {
        const defaultApi = value as DefaultClient
        let pending: ReturnType<typeof defaultApi.instance.resolve> | undefined
        expect(() => {
            pending = defaultApi.instance.resolve(options as never)
        }).not.toThrow()
        await expect(settle(pending!)).rejects.toMatchObject({
            name: "SdkDefect",
            operation: "instance.resolve",
            reasons: [expect.objectContaining({ kind: "Defect" })],
        })
    } else {
        const native = value as NativeClient
        let operation: ReturnType<typeof native.instance.resolve> | undefined
        expect(() => {
            operation = native.instance.resolve(options as never)
        }).not.toThrow()
        const exit = await Effect.runPromiseExit(operation!)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
    }
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s awaits final deadline discovery cleanup before returning its timeout", async (mode) => {
    vi.useFakeTimers({ now: 0, toFake: ["Date", "performance", "setTimeout", "clearTimeout"] })
    const held = heldDiscovery()
    vi.stubGlobal("fetch", held.fetch)
    const value = await client(mode)
    const pending =
        mode === "default"
            ? (value as DefaultClient).instance.resolve({ timeoutMs: 1_000 })
            : Effect.runPromiseExit((value as NativeClient).instance.resolve({ timeoutMs: 1_000 }))
    await held.requestStarted
    await vi.advanceTimersByTimeAsync(1_000)
    await held.cleanupStarted
    let completed = false
    void Promise.resolve(pending).then(() => {
        completed = true
    })
    await Promise.resolve()
    expect(held.aborts).toBe(1)
    expect(completed).toBe(false)
    held.releaseCleanup()

    if (mode === "default") {
        const result = await (pending as ReturnType<DefaultClient["instance"]["resolve"]>)
        expect(result.isErr() && result.error).toMatchObject({ _tag: "ConnectionTimeoutError", timeoutMs: 1_000 })
    } else {
        const exit = await (pending as Promise<Exit.Exit<{ readonly apiCodeVersion: number }, unknown>>)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
            expect(failure?._tag === "Fail" && failure.error).toMatchObject({
                _tag: "ConnectionTimeoutError",
                timeoutMs: 1_000,
            })
        }
    }

    vi.stubGlobal("fetch", async () => Response.json(document()))
    expect((await settle(value.instance.resolve())).apiCodeVersion).toBe(7)
})

test.each(modes)("%s leaves coalesced discovery alive when one caller deadline expires", async (mode) => {
    vi.useFakeTimers({ now: 0, toFake: ["Date", "performance", "setTimeout", "clearTimeout"] })
    const held = heldDiscovery()
    vi.stubGlobal("fetch", held.fetch)
    const value = await client(mode)
    const first =
        mode === "default"
            ? (value as DefaultClient).instance.resolve({ timeoutMs: 1_000 })
            : Effect.runPromiseExit((value as NativeClient).instance.resolve({ timeoutMs: 1_000 }))
    await held.requestStarted
    const second =
        mode === "default"
            ? (value as DefaultClient).instance.resolve({ timeoutMs: 5_000 })
            : Effect.runPromiseExit((value as NativeClient).instance.resolve({ timeoutMs: 5_000 }))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)

    if (mode === "default") {
        const result = await (first as ReturnType<DefaultClient["instance"]["resolve"]>)
        expect(result.isErr() && result.error).toMatchObject({ _tag: "ConnectionTimeoutError", timeoutMs: 1_000 })
    } else {
        const exit = await (first as Promise<Exit.Exit<{ readonly apiCodeVersion: number }, unknown>>)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
            expect(failure?._tag === "Fail" && failure.error).toMatchObject({
                _tag: "ConnectionTimeoutError",
                timeoutMs: 1_000,
            })
        }
    }
    expect(held.aborts).toBe(0)
    held.complete()

    if (mode === "default") {
        const result = await (second as ReturnType<DefaultClient["instance"]["resolve"]>)
        expect(result.isOk() && result.value.apiCodeVersion).toBe(7)
    } else {
        const exit = await (second as Promise<Exit.Exit<{ readonly apiCodeVersion: number }, unknown>>)
        expect(Exit.isSuccess(exit) && exit.value.apiCodeVersion).toBe(7)
    }
    expect(held.fetch).toHaveBeenCalledTimes(1)
})

test.each(modes)("%s accepts explicit insecure local discovery only with opt-in", async (mode) => {
    const insecure = { ...document(), endpoints: { ...document().endpoints, api_public: "http://127.0.0.1:8080" } }
    vi.stubGlobal("fetch", async () => Response.json(insecure))
    if (mode === "default") {
        expect(
            expectThrown(() => createClient({ token: "fixture", instance: { url: "http://127.0.0.1:3000" } })),
        ).toMatchObject({ _tag: "ConfigurationError", field: "instance" })
        const allowed = createClient({
            token: "fixture",
            instance: { url: "http://127.0.0.1:3000", allowInsecure: true },
        })
        try {
            expect((await settle(allowed.instance.resolve())).endpoints.apiPublic).toBe("http://127.0.0.1:8080")
        } finally {
            ;(await allowed.shutdown())._unsafeUnwrap()
        }
        return
    }
    const rejectedScope = Scope.makeUnsafe()
    expect(
        await expectDefect(
            createNative({ token: "fixture", instance: { url: "http://127.0.0.1:3000" } }).pipe(
                Scope.provide(rejectedScope),
            ),
        ),
    ).toMatchObject({ _tag: "ConfigurationError", field: "instance" })
    await Effect.runPromise(Scope.close(rejectedScope, Exit.void))
    const scope = Scope.makeUnsafe()
    const allowed = await Effect.runPromise(
        createNative({ token: "fixture", instance: { url: "http://127.0.0.1:3000", allowInsecure: true } }).pipe(
            Scope.provide(scope),
        ),
    )
    try {
        expect((await settle(allowed.instance.resolve())).endpoints.apiPublic).toBe("http://127.0.0.1:8080")
    } finally {
        await Effect.runPromise(allowed.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
})

test.each(modes)("%s rejects bootstrap downgrade and non-canonical redirect targets", async (mode) => {
    for (const location of ["http://community.example/.well-known/fluxer", "https://community.example/other"]) {
        vi.stubGlobal("fetch", async () => new Response(null, { status: 308, headers: { location } }))
        const value = await client(mode)
        await expect(settle(value.instance.resolve())).rejects.toMatchObject({
            _tag: "ConnectionError",
            reason: "protocol",
        })
        vi.unstubAllGlobals()
    }
})

test.each(modes)(
    "%s keeps shared discovery alive for another waiter and cleans it after the last cancellation",
    async (mode) => {
        let entered!: () => void
        let aborted = 0
        const started = new Promise<void>((resolve) => {
            entered = resolve
        })
        vi.stubGlobal(
            "fetch",
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    const abort = () => {
                        aborted += 1
                        reject(init.signal?.reason)
                    }
                    if (init.signal?.aborted) abort()
                    else init.signal?.addEventListener("abort", abort, { once: true })
                    entered()
                }),
        )
        const value = await client(mode)
        const first = new AbortController()
        const second = new AbortController()
        if (mode === "default") {
            const defaultApi = value as DefaultClient
            const one = defaultApi.instance.resolve({ signal: first.signal })
            await started
            const two = defaultApi.instance.resolve({ signal: second.signal })
            first.abort()
            const firstResult = await one
            expect(firstResult.isErr()).toBe(true)
            if (firstResult.isErr()) expect(firstResult.error._tag).toBe("CancelledError")
            expect(aborted).toBe(0)
            second.abort()
            const secondResult = await two
            expect(secondResult.isErr()).toBe(true)
            if (secondResult.isErr()) expect(secondResult.error._tag).toBe("CancelledError")
        } else {
            const native = value as NativeClient
            const one = Effect.runPromiseExit(native.instance.resolve(), { signal: first.signal })
            await started
            const two = Effect.runPromiseExit(native.instance.resolve(), { signal: second.signal })
            first.abort()
            expect(Exit.isFailure(await one)).toBe(true)
            expect(aborted).toBe(0)
            second.abort()
            expect(Exit.isFailure(await two)).toBe(true)
        }
        await vi.waitFor(() => expect(aborted).toBe(1))
        vi.stubGlobal("fetch", async () => Response.json(document()))
        expect((await settle(value.instance.resolve())).apiCodeVersion).toBe(7)
    },
)

test.each(modes)(
    "%s admits held discovery through the local request limit and removes cancelled waiters",
    async (mode) => {
        let release!: () => void
        const held = new Promise<void>((resolve) => (release = resolve))
        let discoveryCalls = 0
        let messages = 0
        vi.stubGlobal("fetch", async (url: string) => {
            if (url === `${selected}/.well-known/fluxer`) {
                discoveryCalls++
                await held
                return Response.json(document())
            }
            messages++
            return Response.json({ id: "10", channel_id: "20", content: "", author: { id: "30", username: "fixture" } })
        })
        const value = await client(mode)
        const admitted = Array.from({ length: 4 }, () =>
            settle(value.messages.send("20", { content: "held discovery" })),
        )
        try {
            await vi.waitFor(() => expect(discoveryCalls).toBe(1))
            const controller = new AbortController()
            const input = { content: "cancelled discovery waiter" }
            const queued =
                mode === "default"
                    ? settle((value as DefaultClient).messages.send("20", input, { signal: controller.signal }))
                    : Effect.runPromiseExit((value as NativeClient).messages.send("20", input), {
                          signal: controller.signal,
                      })
            await turn()
            controller.abort()
            if (mode === "default") await expect(queued).rejects.toBeInstanceOf(CancelledError)
            else {
                const exit = (await queued) as Exit.Exit<unknown, unknown>
                expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
            }
            expect(messages).toBe(0)
        } finally {
            release()
            await Promise.all(admitted)
        }
        expect(messages).toBe(4)
    },
)

test.each(modes)("%s coalesces shutdown while a final discovery waiter is cleaning up", async (mode) => {
    let entered!: () => void
    let aborted = 0
    const enteredFetch = new Promise<void>((resolve) => {
        entered = resolve
    })
    vi.stubGlobal(
        "fetch",
        (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                const abort = () => {
                    aborted += 1
                    reject(init.signal?.reason)
                }
                if (init.signal?.aborted) abort()
                else init.signal?.addEventListener("abort", abort, { once: true })
                entered()
            }),
    )
    const value = await client(mode)
    const pending =
        mode === "default"
            ? (value as DefaultClient).instance.resolve()
            : Effect.runPromiseExit((value as NativeClient).instance.resolve())
    await enteredFetch
    if (mode === "default") {
        const defaultApi = value as DefaultClient
        const shutdowns = await Promise.all([defaultApi.shutdown(), defaultApi.shutdown()])
        for (const shutdown of shutdowns) shutdown._unsafeUnwrap()
        const result = await pending
        expect("isErr" in result && result.isErr() && result.error._tag).toBe("ClientClosedError")
    } else {
        await Effect.runPromise(Effect.all([(value as NativeClient).shutdown(), (value as NativeClient).shutdown()]))
        const exit = await (pending as Promise<Exit.Exit<unknown, unknown>>)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
            expect(failure?._tag === "Fail" && failure.error).toMatchObject({ _tag: "ClientClosedError" })
        }
    }
    expect(aborted).toBe(1)
})

test.each(modes)("%s gives webhook-only clients the same credential-free instance resolver", async (mode) => {
    const fetch = vi.fn(async () => Response.json(document()))
    vi.stubGlobal("fetch", fetch)
    const scope = Scope.makeUnsafe()
    const value =
        mode === "default"
            ? createWebhookClient({ id: "1", token: "fixture", instance: { url: selected } })
            : await Effect.runPromise(
                  createNativeWebhook({ id: "1", token: "fixture", instance: { url: selected } }).pipe(
                      Scope.provide(scope),
                  ),
              )
    const resolved = await settle(value.instance.resolve())
    expect(resolved.links.message({ id: "3", channelId: "2" }, { id: "2" })).toBe(
        "https://app.community.example/channels/@me/2/3",
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    const closed = value.shutdown()
    if (Effect.isEffect(closed)) await Effect.runPromise(closed)
    else await closed
    await Effect.runPromise(Scope.close(scope, Exit.void))
})

test.each(modes)("%s reads an announced web domain migration and records it once", async (mode) => {
    const records: LogRecord[] = []
    const fetch = vi.fn(async () =>
        Response.json(
            document({
                endpoints: { ...document().endpoints, webapp: "https://web.community.example" },
                domain_migration: {
                    enabled: true,
                    anonymous_rollout_basis_points: 2_500,
                    rollout_salt: "domain-migration-v1",
                    standalone_forwarding: false,
                },
            }),
        ),
    )
    vi.stubGlobal("fetch", fetch)
    const value = await setup(mode, {
        instance: { url: selected },
        logging: { sink: (record: LogRecord) => records.push(record) },
    })
    const resolved = await settle(value.instance.resolve())
    await settle(value.instance.resolve())
    expect(resolved.domainMigration).toEqual({
        enabled: true,
        anonymousRolloutBasisPoints: 2_500,
        standaloneForwarding: false,
    })
    expect(resolved.links.channel({ id: "20", guildId: "10" })).toBe("https://web.community.example/channels/10/20")
    expect(records.filter((record) => record.code === "lifecycle.domainMigration")).toEqual([
        expect.objectContaining({
            level: "info",
            fields: expect.objectContaining({ enabled: true, webapp: "web.community.example" }),
        }),
    ])
})

test.each([undefined, null, { enabled: "yes" }, []])(
    "a malformed or absent domain migration %j is null",
    async (migration) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json(document(migration === undefined ? {} : { domain_migration: migration }))),
        )
        const value = await client("default")
        const resolved = await settle(value.instance.resolve())
        expect(resolved.domainMigration).toBeNull()
    },
)
