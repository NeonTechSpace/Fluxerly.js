import { inspect } from "node:util"
import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { describeError, type LogRecord } from "../../src/index.js"
import { createTestBot as createDefaultTestBot } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"
import { fixtureToken, modes, type Mode } from "../support/both-apis.js"

/**
 * A test bot with unsafe REST payload logging on, whose responses are chosen per call. Payload records are written
 * after the response body is read, so each read waits for the record itself rather than for elapsed time
 */
async function payloadBot(mode: Mode, token: string) {
    const records: LogRecord[] = []
    let wake: (() => void) | undefined
    const options = {
        token,
        logging: {
            unsafe: { payloads: true as const, categories: ["rest" as const] },
            sink: (record: LogRecord) => {
                records.push(record)
                wake?.()
            },
        },
    }
    let fetchUser: (id: string) => Promise<unknown>
    let nextId: () => string
    let respond: (response: () => Response) => void
    if (mode === "default") {
        const bot = createDefaultTestBot(options)
        onTestFinished(async () => {
            bot.failures()
            await bot.shutdown()
        })
        fetchUser = async (id) => bot.client.users.fetch(id)
        nextId = () => bot.fixtures.nextId()
        respond = (response) => void bot.rest.respond("GET /users/:id", response)
    } else {
        const scope = Scope.makeUnsafe()
        const bot = await Effect.runPromise(createNativeTestBot(options).pipe(Scope.provide(scope)))
        onTestFinished(async () => {
            bot.failures()
            await Effect.runPromise(Scope.close(scope, Exit.void))
        })
        fetchUser = (id) => Effect.runPromiseExit(bot.client.users.fetch(id))
        nextId = () => bot.fixtures.nextId()
        respond = (response) => void bot.rest.respond("GET /users/:id", response)
    }
    const received = () => records.filter((record) => record.code === "rest.payloadReceived")
    /** The payload record that unsafe logging wrote for one response body, with its text */
    return async (
        body: string | object,
        init: ResponseInit = {},
    ): Promise<{ readonly text: string; readonly record: LogRecord }> => {
        const seen = received().length
        respond(() => new Response(typeof body === "string" ? body : JSON.stringify(body), init))
        // The decoder rejects these bodies as users, which is irrelevant here: The payload record is written first
        await fetchUser(nextId())
        await new Promise<void>((resolve) => {
            wake = () => {
                if (received().length > seen) resolve()
            }
            wake()
        })
        wake = undefined
        const record = received().at(-1)!
        expect(record).toMatchObject({ level: "trace", category: "rest" })
        return { text: String(record.fields?.payload), record }
    }
}

interface Shape {
    /** The response body, as text or as a JSON value */
    readonly body: string | object
    /** Values that must never appear in the logged payload */
    readonly secrets: readonly string[]
    /** Values that are not credentials and stay readable */
    readonly kept?: readonly string[]
}

/** A message-like response whose content field carries text, the way a user pastes a config or a log line */
const pasted = (text: string, secrets: readonly string[], kept: readonly string[] = []): Shape => ({
    body: { id: "10", content: text },
    secrets,
    kept,
})

const credentialKeys: Record<string, Shape> = {
    "credential keys at any depth, in any case, inside arrays": {
        body: {
            data: {
                token: "key-canary-token-1",
                access_token: "key-canary-access-2",
                refresh_token: "key-canary-refresh-3",
                nested: [{ client_secret: "key-canary-client-4" }, { list: [{ PassWord: "key-canary-password-5" }] }],
                Authorization: "Bot key-canary-authorization-6",
            },
            cookie: "key-canary-cookie-7",
            "Set-Cookie": ["key-canary-setcookie-8"],
            vanity_url_code: "key-canary-vanity-9",
            botToken: "key-canary-suffix-10",
            apiSecret: { id: "key-canary-suffix-11" },
        },
        secrets: [
            "key-canary-token-1",
            "key-canary-access-2",
            "key-canary-refresh-3",
            "key-canary-client-4",
            "key-canary-password-5",
            "key-canary-authorization-6",
            "key-canary-cookie-7",
            "key-canary-setcookie-8",
            "key-canary-vanity-9",
            "key-canary-suffix-10",
            "key-canary-suffix-11",
        ],
        // Arrays stay arrays, so the payload remains readable JSON
        kept: ['"nested":[{'],
    },
}

test.each(modes)(
    "%s unsafe REST payload records hide credential keys, invite codes and the client token",
    async (mode) => {
        const token = "fixture-canary-client-token-value"
        const payload = await payloadBot(mode, token)
        const shapes: Record<string, Shape> = {
            ...credentialKeys,
            "invite objects, whose codes are hidden only because of their shape": {
                body: {
                    invites: [
                        { code: "inv-canary-object-1", inviter: { id: "1" }, uses: 1 },
                        { code: "inv-canary-object-2", channel: { id: "2" }, guild: { id: "3" } },
                        { code: "inv-canary-object-3", max_age: 0 },
                    ],
                },
                secrets: ["inv-canary-object-1", "inv-canary-object-2", "inv-canary-object-3"],
            },
            "an ordinary code field and a non-string invite code stay readable": {
                body: { code: "ORDINARY_DIAGNOSTIC_CODE", message: "Unknown channel", inner: { code: 7, uses: 1 } },
                secrets: [],
                kept: ["ORDINARY_DIAGNOSTIC_CODE", '"code":7'],
            },
            "the client token inside plain values": {
                body: { content: `echo ${token}`, embeds: [{ description: [`one ${token}`, "two"] }] },
                secrets: [token],
            },
        }
        for (const [name, shape] of Object.entries(shapes)) {
            const { text: logged } = await payload(shape.body)
            for (const secret of shape.secrets) expect(logged, `${name}: ${secret}`).not.toContain(secret)
            for (const kept of shape.kept ?? []) expect(logged, `${name}: ${kept}`).toContain(kept)
            if (shape.secrets.length > 0) expect(logged, name).toContain("[redacted]")
        }
    },
)

test.each(modes)("%s unsafe REST payload records hide credentials that appear inside pasted text", async (mode) => {
    const payload = await payloadBot(mode, "fixture-canary-client-token-value")
    const shapes: Record<string, Shape> = {
        "a password with spaces and commas": pasted('{"password":"hunter two, three four"}', ["hunter", "three four"]),
        "a token value with spaces and escaped quotes": pasted(
            String.raw`{"token":"split value, with \"quoted\" spaces"}`,
            ["split value", "quoted", "with"],
        ),
        "a nested object under a credential key": pasted(
            '{"cookie":{"session":"nested-canary-session","theme":"dark"}}',
            ["nested-canary-session", "dark"],
        ),
        "an array under a credential key": pasted('{"password":["array-canary-one","array-canary-two"],"n":1}', [
            "array-canary-one",
            "array-canary-two",
        ]),
        "a number and a bare word under credential keys": pasted('{"password":123456789,"cookie":bareword-canary}', [
            "123456789",
            "bareword-canary",
        ]),
        "a value after an escaped quote": pasted(String.raw`{"password":"tail\"canary-after-escape"}`, [
            "tail",
            "canary-after-escape",
        ]),
        "single-quoted keys and values": pasted("{'password': 'single quoted canary', 'x': 1}", [
            "single quoted canary",
        ]),
        "a value cut off before its closing quote": pasted('{"ok":true,"password":"unterminated canary', [
            "unterminated canary",
        ]),
        "a credential key in another case with spacing": pasted('{"PassWord"  :\n  "spaced canary value"}', [
            "spaced canary value",
        ]),
        "objects inside an array": pasted('[{"x":1},{"password":"in-array-canary"}]', ["in-array-canary"]),
        // The invalid key is skipped, so the credential after it is still found by its key, not by free-text masking alone
        "a key with an invalid escape before a credential key": pasted(
            String.raw`{"my\_token": "free-text-canary", "password": "after invalid key, with spaces"}`,
            ["free-text-canary", "after invalid key", "with spaces"],
        ),
        "an unquoted credential value followed by readable text": pasted(
            '{"password":bareword-canary} VISIBLE_AFTER_BRACE',
            ["bareword-canary"],
            ["VISIBLE_AFTER_BRACE"],
        ),
        "a stray closing brace before an invite object": pasted(
            'trailing } then {"code":"inv-canary-stray","uses":1} and {"password":"stray password value"}',
            ["inv-canary-stray", "stray password value"],
        ),
        "braces inside quoted strings before an invite code": pasted(
            "{\"code\":\"inv-canary-brace-double\",\"note\":\"closes } early\",\"uses\":1} {'code': 'inv-canary-brace-single', 'note': 'closes } early', 'uses': 1}",
            ["inv-canary-brace-double", "inv-canary-brace-single"],
        ),
        "key-like text inside a quoted string is not an invite code": pasted(
            `{'uses': 1, 'list': ['say "code": "KEEP_READABLE_IN_STRING"']}`,
            [],
            ["KEEP_READABLE_IN_STRING"],
        ),
        "invite codes before and after the keys that identify the object": pasted(
            '{"code":"inv-canary-before","uses":3} {"channel":{"id":"1"},"guild":{"id":"2"},"code":"inv-canary-after"}',
            ["inv-canary-before", "inv-canary-after"],
        ),
        "an invite code after text with escaped quotes and an apostrophe": pasted(
            String.raw`{"note":"say \"hi it's me","code":"inv-canary-escaped","max_uses":5}`,
            ["inv-canary-escaped"],
        ),
        "single-quoted and cut off invite objects": pasted(
            "{'code': 'inv-canary-single', 'uses': 1} [{\"code\":\"inv-canary-cut\",\"uses\":2",
            ["inv-canary-single", "inv-canary-cut"],
        ),
        "invites in an array and nested in another object": pasted(
            '[{"code":"inv-canary-first","uses":1},{"code":"inv-canary-second","inviter":{}}] {"invite":{"code":"inv-canary-nested","uses":0}}',
            ["inv-canary-first", "inv-canary-second", "inv-canary-nested"],
        ),
        "a nested diagnostic code that belongs to no invite": pasted(
            '{"error":{"code":"VISIBLE_DIAGNOSTIC"},"uses":1,"code":"inv-canary-outer"}',
            ["inv-canary-outer"],
            ["VISIBLE_DIAGNOSTIC"],
        ),
    }
    for (const [name, shape] of Object.entries(shapes)) {
        const { text: logged } = await payload(shape.body)
        for (const secret of shape.secrets) expect(logged, `${name}: ${secret}`).not.toContain(secret)
        for (const kept of shape.kept ?? []) expect(logged, `${name}: ${kept}`).toContain(kept)
        if (shape.secrets.length > 0) expect(logged, name).toContain("[redacted]")
    }
})

test.each(modes)("%s unsafe REST payload records hide credentials in non-JSON response text", async (mode) => {
    const payload = await payloadBot(mode, "fixture-canary-client-token-value")
    const botSecret = "fixtureOnlyNotACredential0123456789abcdefgh"
    const shapes: Record<string, Shape> = {
        "an authorization header with any scheme": {
            body: "Upstream said: Authorization: Bearer free-canary-bearer-1234567890 and authorization=Basic ZnJlZS1jYW5hcnk6cGFzcw==",
            secrets: ["free-canary-bearer", "ZnJlZS1jYW5hcnk6cGFzcw"],
        },
        // Short values and values without a scheme word have no credential shape, so only the header name hides them
        "an authorization header with a short value": {
            body: 'Upstream said: Authorization: Bearer shortcanary, authorization=hunter2canary and "authorization": "custom-scheme-canary"',
            secrets: ["shortcanary", "hunter2canary", "custom-scheme-canary"],
        },
        "assignments to keys that end in token or secret": {
            body: "FLUXER_BOT_TOKEN=free-canary-env-token client_secret=free-canary-client-secret clientSecret: free-canary-123456789",
            secrets: ["free-canary-env-token", "free-canary-client-secret", "free-canary-123456789"],
        },
        "a bot scheme before a token-shaped value": {
            body: "login failed for Bot Mzk0NTQ2.free-canary.token-value",
            secrets: ["free-canary.token-value"],
        },
        "a bare bot token, whose application ID stays readable": {
            body: `login failed for 1456074443980800001.${botSecret}`,
            secrets: [botSecret],
            kept: ["1456074443980800001"],
        },
        "invite URLs": {
            body: "Join https://fluxer.gg/free-canary-invite-one or https://example.test/invite/free-canary-invite-two",
            secrets: ["free-canary-invite-one", "free-canary-invite-two"],
        },
        "a webhook URL": {
            body: "POST https://example.test/api/webhooks/123456789/free-canary-webhook-token failed",
            secrets: ["free-canary-webhook-token"],
            kept: ["123456789"],
        },
        "an OAuth authorization code in a query string": {
            body: "Redirect https://app.example/callback?code=free-canary-oauth-code&state=free-state",
            secrets: ["free-canary-oauth-code"],
        },
        "a query token": {
            body: "GET https://example.test/x?access_token=free-canary-query-token&page=2",
            secrets: ["free-canary-query-token"],
        },
    }
    for (const [name, shape] of Object.entries(shapes)) {
        const { text: logged } = await payload(shape.body, { headers: { "content-type": "text/plain" } })
        for (const secret of shape.secrets) expect(logged, `${name}: ${secret}`).not.toContain(secret)
        for (const kept of shape.kept ?? []) expect(logged, `${name}: ${kept}`).toContain(kept)
        expect(logged, name).toContain("[redacted]")
    }
})

test.each(modes)(
    "%s unsafe REST payload records hide URL user information and keep the rest of the URL readable",
    async (mode) => {
        const payload = await payloadBot(mode, "fixture-canary-client-token-value")
        const text = { headers: { "content-type": "text/plain" } }
        const shapes: Record<string, Shape & { readonly init?: ResponseInit }> = {
            "a user name and password in a string value of a JSON body": {
                body: {
                    id: "10",
                    content: "clone https://url-canary-user:url-canary-pass@git.example.test/team/repo.git",
                },
                secrets: ["url-canary-user", "url-canary-pass"],
                kept: ["https://[redacted]@git.example.test/team/repo.git"],
            },
            "a URL inside JSON text that is itself a string value": pasted(
                '{"remote":"https://url-canary-nested-user:url-canary-nested-pass@git.example.test/team/repo.git","n":1}',
                ["url-canary-nested-user", "url-canary-nested-pass"],
                ["https://[redacted]@git.example.test/team/repo.git"],
            ),
            "a user name and password in plain response text": {
                body: "Upstream refused https://url-canary-plain-user:url-canary-plain-pass@proxy.example.test:8080/relay?x=1 twice",
                init: text,
                secrets: ["url-canary-plain-user", "url-canary-plain-pass"],
                kept: ["https://[redacted]@proxy.example.test:8080/relay?x=1 twice"],
            },
            "only a user name in plain response text": {
                body: "see ssh://url-canary-only-user@git.example.test/team/repo.git",
                init: text,
                secrets: ["url-canary-only-user"],
                kept: ["ssh://[redacted]@git.example.test/team/repo.git"],
            },
            "only a user name in a string value of a JSON body": pasted(
                "connect to wss://url-canary-only-token@gw.example.test",
                ["url-canary-only-token"],
                ["wss://[redacted]@gw.example.test"],
            ),
            "a password that contains an at sign": pasted(
                "https://url-canary-at-user:url-canary-at-left@url-canary-at-right@host.example.test/path",
                ["url-canary-at-user", "url-canary-at-left", "url-canary-at-right"],
                ["https://[redacted]@host.example.test/path"],
            ),
            "an at sign after the host stays readable": {
                body: {
                    id: "10",
                    content:
                        "https://host.example.test/users/@me?contact=ops@example.test#top@x and mail ops@example.test",
                },
                secrets: [],
                kept: ["https://host.example.test/users/@me?contact=ops@example.test#top@x and mail ops@example.test"],
            },
        }
        for (const [name, shape] of Object.entries(shapes)) {
            const { text: logged } = await payload(shape.body, shape.init)
            for (const secret of shape.secrets) expect(logged, `${name}: ${secret}`).not.toContain(secret)
            for (const kept of shape.kept ?? []) expect(logged, `${name}: ${kept}`).toContain(kept)
            if (shape.secrets.length > 0) expect(logged, name).toContain("[redacted]")
        }
    },
)

test.each(modes)(
    "%s unsafe REST payload records stay bounded and hide credentials in long or deep bodies",
    async (mode) => {
        const payload = await payloadBot(mode, "fixture-canary-client-token-value")

        // A body longer than the read limit is logged as its first bytes, cut inside the credential value
        const cut = await payload(`{"access_token":"${"S".repeat(70_000)}`, {
            headers: { "content-type": "application/json" },
        })
        expect(cut.record.fields?.truncated).toBe(true)
        expect(cut.text).not.toContain("SSSSSSSS")
        expect(cut.text).toContain("[redacted]")

        // Text whose JSON form is longer than the output bound is shortened after masking, so the head is hidden and the tail is gone
        const line = 'Authorization: Bearer long-canary-head-1234567890 said "quoted text" here\n'
        const long = await payload(line + 'filler "x"\n'.repeat(7_000) + "long-canary-tail-after-limit")
        expect(long.record.fields?.truncated).toBe(true)
        expect(long.text).not.toContain("long-canary-head")
        expect(long.text).not.toContain("long-canary-tail")
        expect(long.text.length).toBeLessThan(65_536 + 64)
        expect(long.text).toMatch(/\d+ more characters\)$/)

        // Nesting beyond the traversal limit is cut off, with the credentials in it
        const deep = (levels: number) =>
            '{"a":'.repeat(levels) +
            '{"password":"deep-canary-password","note":"deep-canary-note"}' +
            "}".repeat(levels)
        const nested = await payload(deep(40))
        expect(nested.text).not.toContain("deep-canary")
        expect(nested.text.length).toBeLessThan(1_000)
        const shallow = await payload(deep(5))
        expect(shallow.text).not.toContain("deep-canary-password")
        expect(shallow.text).toContain("deep-canary-note")
    },
)

/** Failing handlers, one failure per value, returning the handlerFailed log records the client wrote */
async function failureOf(mode: Mode, values: readonly unknown[]) {
    const index = { next: 0 }
    const records: LogRecord[] = []
    const options = { logging: { sink: (record: LogRecord) => records.push(record) } }
    if (mode === "default") {
        const bot = createDefaultTestBot({
            ...options,
            events: {
                messageCreate: () => {
                    throw values[index.next++]
                },
            },
        })
        onTestFinished(async () => {
            bot.failures()
            await bot.shutdown()
        })
        await bot.ready()
        for (const _ of values) bot.emit("MESSAGE_CREATE", bot.fixtures.message())
        await bot.idle()
    } else {
        const scope = Scope.makeUnsafe()
        const bot = await Effect.runPromise(
            createNativeTestBot({
                ...options,
                events: { messageCreate: () => Effect.fail(values[index.next++]) },
            }).pipe(Scope.provide(scope)),
        )
        onTestFinished(async () => {
            bot.failures()
            await Effect.runPromise(Scope.close(scope, Exit.void))
        })
        await Effect.runPromise(bot.ready())
        for (const _ of values) await Effect.runPromise(bot.emit("MESSAGE_CREATE", bot.fixtures.message()))
        await Effect.runPromise(bot.idle())
    }
    return records.filter((record) => record.code === "events.handlerFailed")
}

test.each(modes)("%s failure records mask credentials in messages, cause chains and thrown values", async (mode) => {
    const chain = (depth: number, canary: string) => {
        let error = new Error(`level ${depth} client_secret=${canary}-${depth}`)
        for (let level = depth - 1; level >= 1; level--)
            error = new Error(`level ${level} client_secret=${canary}-${level}`, { cause: error })
        return error
    }
    const shapes: Record<string, { value: unknown; secrets: readonly string[] }> = {
        "an Error message with credentials in text": {
            value: new Error(
                "POST https://fluxer.gg/error-canary-invite failed with Authorization: Bot error-canary-auth-1234567890abcdef at /webhooks/123456/error-canary-webhook",
            ),
            secrets: ["error-canary-invite", "error-canary-auth", "error-canary-webhook"],
        },
        "causes that are Errors with the client token": {
            value: new Error("outer", {
                cause: new Error("middle client_secret=cause-canary-middle", {
                    cause: new Error(`inner ${fixtureToken} and cause-canary-inner-token=cause-canary-inner-value`),
                }),
            }),
            secrets: [fixtureToken, "cause-canary-middle", "cause-canary-inner-value"],
        },
        "a long chain, whose later causes are not followed": {
            value: chain(7, "chain-canary"),
            secrets: Array.from({ length: 7 }, (_, index) => `chain-canary-${index + 1}`),
        },
        "a thrown object with credential fields": {
            value: {
                token: "object-canary-1234567890",
                nested: { client_secret: "object-canary-abcdefghij12345" },
                header: "Bearer object-canary-bearer-1234567890",
            },
            secrets: ["object-canary"],
        },
        "a thrown string": {
            value: `failed: client_secret=string-canary-123456 using ${fixtureToken}`,
            secrets: ["string-canary", fixtureToken],
        },
        "an Error with credential fields of its own": {
            value: Object.assign(new Error("request failed"), {
                token: "field-canary-1234567890",
                headers: { authorization: "Bot field-canary-header-1234567890" },
            }),
            secrets: ["field-canary"],
        },
    }
    const entries = Object.entries(shapes)
    const failed = await failureOf(
        mode,
        entries.map(([, shape]) => shape.value),
    )
    // Every failure is reported, none is dropped or replaced by a different failure
    expect(failed).toHaveLength(entries.length)
    const output = JSON.stringify(failed)
    for (const [name, { secrets }] of entries)
        for (const secret of secrets) expect(output, `${name}: ${secret}`).not.toContain(secret)
    expect(output).toContain("[redacted]")
    for (const [name, { value, secrets }] of entries)
        for (const secret of secrets.filter((secret) => secret !== fixtureToken))
            expect(describeError(value), `${name}: ${secret}`).not.toContain(secret)
})

test.each(modes)(
    "%s failure records and describeError hide URL user information in messages, causes and thrown strings",
    async (mode) => {
        const shapes: Record<string, { value: unknown; secrets: readonly string[]; kept: string }> = {
            "an Error message with a user name and password": {
                value: new Error("GET https://err-canary-user:err-canary-pass@api.example.test/v1/items?page=2 failed"),
                secrets: ["err-canary-user", "err-canary-pass"],
                kept: "https://[redacted]@api.example.test/v1/items?page=2 failed",
            },
            "a cause with only a user name": {
                value: new Error("outer", {
                    cause: new Error("proxy refused http://err-canary-proxy-user@proxy.example.test:8080/relay"),
                }),
                secrets: ["err-canary-proxy-user"],
                kept: "http://[redacted]@proxy.example.test:8080/relay",
            },
            "a thrown string": {
                value: "failed: wss://err-canary-string-user:err-canary-string-pass@gw.example.test/socket",
                secrets: ["err-canary-string-user", "err-canary-string-pass"],
                kept: "wss://[redacted]@gw.example.test/socket",
            },
        }
        const entries = Object.entries(shapes)
        const failed = await failureOf(
            mode,
            entries.map(([, shape]) => shape.value),
        )
        // Every failure is reported, none is dropped or replaced by a different failure
        expect(failed).toHaveLength(entries.length)
        const output = JSON.stringify(failed)
        for (const [name, { value, secrets, kept }] of entries) {
            const described = describeError(value)
            for (const secret of secrets) {
                expect(output, `${name} in a record: ${secret}`).not.toContain(secret)
                expect(described, `${name} in describeError: ${secret}`).not.toContain(secret)
            }
            expect(output, `${name} in a record`).toContain(kept)
            expect(described, `${name} in describeError`).toContain(kept)
        }
    },
)

test.each(modes)("%s reports a failure whose value cannot be described", async (mode) => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const hostile = {
        get message(): string {
            throw new Error("hostile getter")
        },
        toString() {
            throw new Error("hostile toString")
        },
    }
    // Inspecting these throws, and the second also rejects the type tag that stands in for the description
    const uninspectable = {
        [inspect.custom]: () => {
            throw new Error("hostile inspect")
        },
    }
    const unnamed = {
        [inspect.custom]: () => {
            throw new Error("hostile inspect")
        },
        get [Symbol.toStringTag](): string {
            throw new Error("hostile tag")
        },
    }
    const brokenError = Object.defineProperty(new Error("broken"), "message", {
        enumerable: true,
        get(): string {
            throw new Error("hostile message")
        },
    })
    const values = [
        revoked.proxy,
        Object.create(null),
        hostile,
        Symbol("hostile symbol"),
        12n,
        uninspectable,
        unnamed,
        brokenError,
    ]
    const failed = await failureOf(mode, values)
    // Each failure is still reported, with some description, instead of being lost to the failing description
    expect(failed).toHaveLength(values.length)
    for (const record of failed) {
        expect(record.error).toMatchObject({ origin: "application" })
        expect(record.error?.message).not.toBe("")
    }
    for (const value of values) expect(() => describeError(value)).not.toThrow()
})
