import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    ConfigurationError,
    SdkDefect,
    createClient,
    createWebhookClient,
    oauth,
    supervisor,
    type OperationOptions,
} from "../src/index.js"

afterEach(() => vi.unstubAllGlobals())

function client() {
    const value = createClient({ token: "fixture-not-a-credential" })._unsafeUnwrap()
    onTestFinished(async () => {
        await value.shutdown()
    })
    return value
}

const attachment = {
    id: "40",
    filename: "fixture.bin",
    size: 1,
    flags: 0,
    url: "https://fluxerusercontent.com/attachments/20/40/fixture.bin",
}

test("default malformed signals return configuration failures before work across execution owners", async () => {
    const fetch = vi.fn(() => {
        throw Error("Unexpected request")
    })
    vi.stubGlobal("fetch", fetch)
    const c = client()
    const hook = createWebhookClient({ id: "100", token: "fixture" })._unsafeUnwrap()
    const auth = oauth.create({ clientId: "1", clientSecret: "fixture" })._unsafeUnwrap()
    const parent = supervisor
        .create({
            entry: new URL("./supervisor-child.mjs", import.meta.url),
            totalShards: 1,
            assignments: [{ id: "one", shardIds: [0] }],
        })
        ._unsafeUnwrap()
    onTestFinished(async () => {
        await hook.shutdown()
        await auth.shutdown()
        await parent.shutdown()
    })
    const events = c.events("messageCreate")._unsafeUnwrap()
    onTestFinished(() => events.unsubscribe())
    const calls = [
        (o: OperationOptions) => c.users.fetch("20", o),
        (o: OperationOptions) => c.messages.send("20", { content: "fixture" }, o),
        (o: OperationOptions) => c.roles.fetchAll("20", o),
        (o: OperationOptions) => c.instance.resolve(o),
        (o: OperationOptions) => c.connect(o),
        (o: OperationOptions) => c.run(o),
        (o: OperationOptions) => c.waitForClose(o),
        (o: OperationOptions) => c.waitFor("messageCreate", o),
        (o: OperationOptions) => events.next(o),
        (o: OperationOptions) => events.waitForClose(o),
        (o: OperationOptions) => hook.fetch(o),
        (o: OperationOptions) => auth.fetchIdentity("fixture", o),
        (o: OperationOptions) => parent.waitForReady(o),
        (o: OperationOptions) => c.attachments.download(attachment, { ...o, maxBytes: 1 }),
    ]
    for (const signal of [
        {},
        null,
        false,
        1,
        { aborted: true },
        { aborted: "yes", addEventListener() {}, removeEventListener() {} },
    ]) {
        for (const call of calls) {
            const result = await call({ signal } as OperationOptions)
            expect(result.isErr()).toBe(true)
            if (result.isErr()) expect(result.error).toMatchObject({ _tag: "ConfigurationError", field: "signal" })
        }
        const options = { signal } as OperationOptions
        const iterables = [
            c.messages.iterateHistory("20", { maxItems: 1 }, options),
            c.members.iterateChunks("20", { userIds: ["30"] }, options),
            c.attachments.stream(attachment, { ...options, maxBytes: 1 }),
        ]
        for (const iterable of iterables) {
            const iterator = iterable[Symbol.asyncIterator]()
            const first = await iterator.next()
            expect(first.done).toBe(false)
            expect(first.value).toMatchObject({ error: { _tag: "ConfigurationError", field: "signal" } })
            expect((await iterator.next()).done).toBe(true)
        }
    }
    expect(c.state).toBe("Disconnected")
    expect(parent.status().children.every((child) => child.pid === null)).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
})

test("valid cancellation remains distinct and listener defects stay sanitized with cleanup", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const c = client()
    const controller = new AbortController()
    controller.abort()
    const result = await c.users.fetch("20", { signal: controller.signal })
    expect(result).toMatchObject({ error: { _tag: "CancelledError" } })
    const remove = vi.fn()
    const signal = {
        aborted: false,
        addEventListener() {
            throw Error("private-fixture-detail")
        },
        removeEventListener: remove,
    }
    await expect(c.users.fetch("20", { signal })).rejects.toBeInstanceOf(SdkDefect)
    expect(remove).toHaveBeenCalledOnce()
    try {
        await c.users.fetch("20", { signal })
    } catch (error) {
        expect(String(error)).not.toContain("private-fixture-detail")
        expect(error).not.toBeInstanceOf(ConfigurationError)
    }
    expect(fetch).not.toHaveBeenCalled()
})
