import { parse as parseQuery } from "node:querystring"
import { inspect } from "node:util"
import { Cause, Effect, Exit, Logger, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { ApplicationError, ConfigurationError } from "../../src/errors.js"
import { describeError, type FailureReport, type LogRecord } from "../../src/index.js"
import { createTestBot as createDefaultTestBot } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"
import type { LogCode } from "../../src/internal/code-catalogue.js"
import { loggingConfiguration } from "../../src/internal/logging.js"
import { decodeAuditLogEntry } from "../../src/internal/audit-logs.js"
import * as masking from "../../src/internal/masking.js"
import { createPkce } from "../../src/oauth.js"
import { modes, setup, type Mode } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { unmaskedConversions } from "../support/output-boundary.js"
import { settle } from "../support/settle.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

// Every output that turns an application value into text is checked against a corpus of credential shapes that once
// leaked and against a generated matrix of every credential kind in every value shape. A type-aware source check fails
// when another module turns an unknown value into text, so a new output path has to use masking.ts or be listed with
// the reason it is not output text

interface Row {
    /** The thrown or failed value */
    readonly value: unknown
    /** Text that must never appear in any output */
    readonly canary: string
    /** Text around the credential that must stay readable */
    readonly kept: string
}

const short = "Basic sc4nary1"
/** One row per credential shape that an output once printed */
const corpus: Record<string, Row> = {
    "a thrown upload plan object": {
        value: { upload_url: "https://uploads.example.test/a?X-Amz-Signature=row-canary-upload", note: "upload plan" },
        canary: "row-canary-upload",
        kept: "upload plan",
    },
    "a thrown invite object": {
        value: { code: "row-canary-invite", max_uses: 1, note: "invite object" },
        canary: "row-canary-invite",
        kept: "invite object",
    },
    "a thrown object with an X-API-Key header": {
        value: { headers: { "X-API-Key": "row-canary-xapikey" }, note: "api header" },
        canary: "row-canary-xapikey",
        kept: "api header",
    },
    "a header Map with a short Authorization value": {
        value: new Map([
            ["Authorization", `${short}a`],
            ["note", "header map"],
        ]),
        canary: "sc4nary1a",
        kept: "header map",
    },
    "Node rawHeaders with a short Basic value": {
        value: { rawHeaders: ["Host", "raw headers", "Authorization", `${short}b`] },
        canary: "sc4nary1b",
        kept: "raw headers",
    },
    "a header pair list": {
        value: ["Proxy-Authorization", `${short}c`, "Accept", "pair list"],
        canary: "sc4nary1c",
        kept: "pair list",
    },
    "an Error caused by a response object": {
        value: new Error("fetch failed", { cause: { status: 401, headers: { "x-api-key": "row-canary-cause" } } }),
        canary: "row-canary-cause",
        kept: "fetch failed",
    },
    "an Authorization array value in JSON text": {
        value: new Error(`header json ${JSON.stringify({ headers: { Authorization: [`${short}d`] } })}`),
        canary: "sc4nary1d",
        kept: "header json",
    },
    "X-API-Key in a header line": {
        value: new Error("Upstream rejected X-API-Key: row-canary-line"),
        canary: "row-canary-line",
        kept: "Upstream rejected",
    },
    "an api-key assignment": {
        value: new Error("Upstream refused api-key=row-canary-assign"),
        canary: "row-canary-assign",
        kept: "Upstream refused",
    },
    "X-API-Key in JSON text": {
        value: new Error(`Upstream said ${JSON.stringify({ "X-Api-Key": "row-canary-json" })}`),
        canary: "row-canary-json",
        kept: "Upstream said",
    },
    "a thrown string with a quoted password": {
        value: 'setup broke password="row-canary-thrown tail"',
        canary: "row-canary-thrown",
        kept: "setup broke",
    },
    "a JSON body inside a JSON string": {
        value: new Error(
            JSON.stringify({ step: "nested body", body: JSON.stringify({ password: "row-canary-nested" }) }),
        ),
        canary: "row-canary-nested",
        kept: "nested body",
    },
}
const rows = Object.entries(corpus)

/** Handler failure records without onError, and report descriptions with it, for every value in one test bot */
async function handlerOutputs(
    mode: Mode,
    hook: boolean,
    values: readonly unknown[] = rows.map(([, row]) => row.value),
): Promise<string> {
    const index = { next: 0 }
    const records: LogRecord[] = []
    const described: string[] = []
    // Rows that print the same after masking would otherwise count as repeats
    const logging = { dedupe: false as const, sink: (record: LogRecord) => void records.push(record) }
    if (mode === "default") {
        const bot = createDefaultTestBot({
            logging,
            ...(hook && { onError: (report: FailureReport) => void described.push(report.describe()) }),
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
                logging,
                ...(hook && {
                    onError: (report: FailureReport) => Effect.sync(() => void described.push(report.describe())),
                }),
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
    if (hook) {
        expect(described).toHaveLength(values.length)
        return described.join("\n")
    }
    const failed = records.filter((record) => record.code === "events.handlerFailed")
    expect(failed).toHaveLength(values.length)
    return JSON.stringify(failed)
}

function logger(settings: Record<string, unknown>, native = false) {
    const result = loggingConfiguration(settings, native)
    if (result instanceof ConfigurationError) throw result
    return result
}

const input = (error: unknown) =>
    ({ level: "error", category: "events", code: "events.handlerFailed" as LogCode, message: "failed", error }) as const

/** Outputs that are the same in both APIs, each from one value to its text */
const valueSurfaces: Record<string, (value: unknown) => Promise<string> | string> = {
    describeError: (value) => describeError(value),
    "ApplicationError message, toJSON and describeError": (value) => {
        const error = new ApplicationError("runBot setup", value)
        return [error.message, JSON.stringify(error), describeError(error)].join("\n")
    },
    "a native Effect logger's printed cause": async (value) => {
        const printed: string[] = []
        const effectLogger = Logger.make((entry) => void printed.push(Cause.pretty(entry.cause)))
        await Effect.runPromise(logger({}, true).logEffect(input(value)).pipe(Effect.withLogger(effectLogger)))
        return printed.join("\n")
    },
    "the sink failure line on standard error": (value) => {
        const written: string[] = []
        vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
            written.push(String(chunk))
            return true
        })
        try {
            logger({
                sink: () => {
                    throw value
                },
            }).log(input(new Error("record")))
        } finally {
            vi.restoreAllMocks()
        }
        return written.join("")
    },
    "an Effect log call routed into records": async (value) => {
        const records: LogRecord[] = []
        const routed = logger({ sink: (record: LogRecord) => void records.push(record) })
        await Effect.runPromise(routed.provide(Effect.logWarning("routed", value)))
        expect(records).toHaveLength(1)
        return JSON.stringify(records)
    },
}

/** Fail with the row and output names when a canary is printed or the readable text around it is gone */
function expectMasked(surface: string, text: string, only?: readonly (readonly [string, Row])[]) {
    for (const [name, row] of only ?? rows) {
        // Soft, so one run lists every row and output that leaks
        expect.soft(text, `${surface} printed ${name}`).not.toContain(row.canary)
        expect.soft(text, `${surface} hid the readable text of ${name}`).toContain(row.kept)
    }
}

test.each(modes)("%s handler failure records and report descriptions mask every corpus shape", async (mode) => {
    expectMasked(`${mode} records`, await handlerOutputs(mode, false))
    expectMasked(`${mode} describe()`, await handlerOutputs(mode, true))
})

test.each(Object.entries(valueSurfaces))("%s masks every corpus shape", async (surface, output) => {
    // An ApplicationError message only names a thrown non-Error object, so its toJSON cause holds the readable text
    for (const row of rows) expectMasked(surface, await output(row[1].value), [row])
})

/** A seeded pseudo-random source (mulberry32), so the generated matrix is the same on every run */
function seeded(seed: number) {
    let state = seed
    return () => {
        state = (state + 0x6d2b79f5) | 0
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
    }
}

/** One kind of credential: Where it sits in a structured value, in text, and in a header pair list if it is a header */
interface CredentialKind {
    /** An object that holds the credential under its usual key or shape */
    readonly object: (canary: string) => Record<string, unknown>
    /** The credential written into text, labelled as it usually is */
    readonly text: (canary: string) => string
    /** The header name and value of a credential header */
    readonly header?: (canary: string) => readonly [string, string]
    /** Characters per canary, longer for a bare token whose rule needs 40 */
    readonly length?: number
    /** False for a credential known only from its whole object, so Map and entry list shapes do not apply */
    readonly entries?: false
    /** False for text whose credential is recognized only by fields after it, which a cut inside it removes */
    readonly cut?: false
}

/** A PEM private key whose body lines hold the canary */
const pemKey = (canary: string) =>
    `-----BEGIN PRIVATE KEY-----\n${canary.repeat(3)}\n${canary.repeat(3)}\n-----END PRIVATE KEY-----\n`
/** A presigned S3 URL. Its date, expiry and signed headers carry no secret and stay readable */
const signedUrl = (canary: string) =>
    `https://uploads.example.test/a?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=cred${canary}&X-Amz-Date=20261103T000000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=${canary}`
/** A Fluxer attachment link, signed with hm and readable expiry fields ex and is */
const attachmentUrl = (canary: string) =>
    `https://media.example.test/attachments/1/2/cat.png?ex=6a9a7231&is=6a9920b1&hm=${canary}&`
/** A Fluxer upload relay URL, whose t is a signed JSON token: Base64url JSON, a dot and a base64url signature */
const relayUrl = (canary: string) =>
    `https://uploads.example.test/v1/relay/k?t=eyJ1IjoiazEiLCJlIjoxNzAwMDAwMDAwfQ.${canary}&uploadId=u1`
/** An Azure Blob Storage SAS link, as the Azure SDK serializes it. Its version, permissions and expiry stay readable */
const azureUrl = (canary: string) =>
    `https://files.blob.example.test/c/cat.png?sv=2023-11-03&sp=r&se=2026-11-04T00%3A00%3A00Z&sr=b&sig=${canary}`
/** A Google Cloud Storage V2 signed link, the default of its Node signer. Its access ID and expiry stay readable */
const googleV2Url = (canary: string) =>
    `https://storage.example.test/b/cat.png?GoogleAccessId=bot%40example.test&Expires=1793746800&Signature=${canary}`
/** An invite creation audit entry as the SDK decodes it, with camelCase fields such as targetId and newValue */
const decodedInviteAudit = (canary: string) =>
    decodeAuditLogEntry({
        id: "300000000000000001",
        action_type: 40,
        user_id: "300000000000000002",
        target_id: canary,
        changes: [
            { key: "code", new_value: canary },
            { key: "max_uses", new_value: 0 },
        ],
    }) as unknown as Record<string, unknown>
const credentialKinds: Record<string, CredentialKind> = {
    "bot token": {
        object: (canary) => ({ botToken: canary }),
        text: (canary) => `FLUXER_BOT_TOKEN=${canary}`,
    },
    "bare bot token": {
        object: (canary) => ({ value: `123456789012345678.${canary}` }),
        text: (canary) => `sent 123456789012345678.${canary}`,
        length: 43,
    },
    password: { object: (canary) => ({ password: canary }), text: (canary) => `password="${canary} tail"` },
    cookie: {
        object: (canary) => ({ headers: { Cookie: `session=${canary}` } }),
        text: (canary) => `Cookie: session=${canary}; theme=dark`,
        header: (canary) => ["Cookie", `session=${canary}`],
    },
    // Express req.cookies, parsed by name
    "cookies object": {
        object: (canary) => ({ cookies: { sid: canary } }),
        text: (canary) => `cookies: sid=${canary}; theme=dark`,
    },
    // A cookie list written into text as an assignment, such as "cookies=" + req.headers.cookie, where every cookie
    // after the first once stayed readable
    "cookie list": {
        object: (canary) => ({ cookies: [`sid=${canary}; Path=/`] }),
        text: (canary) => `cookies=sid=${canary}; refresh=${canary}`,
    },
    "cookie assignment with a quoted value": {
        object: (canary) => ({ Cookie: `sid="${canary}"; refresh=${canary}` }),
        text: (canary) => `Cookie=sid="${canary}"; refresh=${canary}`,
    },
    // An OAuth token request's PKCE verifier, labelled in a form body or an assignment
    "PKCE verifier": {
        object: (canary) => ({ codeVerifier: canary }),
        text: (canary) => `token request failed: grant_type=authorization_code&code_verifier=${canary}`,
    },
    // The shape oauth.createPkce returns, whose challenge is public
    "PKCE pair": {
        object: (canary) => ({ verifier: canary, challenge: "public-challenge" }),
        text: (canary) => `exchange failed for verifier=${canary}`,
    },
    // An Expires date holds a space and a comma, so the cookie after it once stayed readable
    "set_cookie assignment": {
        object: (canary) => ({ set_cookie: `sid=${canary}` }),
        text: (canary) => `set_cookie=sid=${canary}; Expires=Wed, 21 Oct 2030 07:28:00 GMT; refresh=${canary}`,
    },
    // A Set-Cookie array joined into text with commas, as String(response.headers["set-cookie"]) writes it
    "joined Set-Cookie list": {
        object: (canary) => ({ setCookie: [`sid=${canary}; Path=/`, `refresh=${canary}; Path=/`] }),
        text: (canary) => `set-cookie=sid=${canary}; Path=/,refresh=${canary}; Path=/`,
    },
    // A cookie value or name may hold &, ' } or a backtick, which once ended the list and left later cookies readable
    "cookie list with an ampersand in a value": {
        object: (canary) => ({ cookies: [`sid=first&inside=${canary}; refresh=${canary}`] }),
        text: (canary) => `cookies=sid=first&inside=${canary}; refresh=${canary}`,
    },
    "cookie list with an apostrophe in a value": {
        object: (canary) => ({ cookies: [`sid=first'part; refresh=${canary}`] }),
        text: (canary) => `cookies=sid=first'part; refresh=${canary}`,
    },
    "cookie list with a brace in a value": {
        object: (canary) => ({ cookies: [`sid=first}part; refresh=${canary}`] }),
        text: (canary) => `cookies=sid=first}part; refresh=${canary}`,
    },
    "joined Set-Cookie list with an ampersand in a name": {
        object: (canary) => ({ setCookie: [`sid=${canary}; Path=/`, `&other=${canary}; Path=/`] }),
        text: (canary) => `set-cookie=sid=${canary}; Path=/,&other=${canary}; Path=/`,
    },
    "joined Set-Cookie list with a backtick in a name": {
        object: (canary) => ({ setCookie: [`sid=${canary}; Path=/`, `\`other=${canary}; Path=/`] }),
        text: (canary) => `set-cookie=sid=${canary}; Path=/,\`other=${canary}; Path=/`,
    },
    "Set-Cookie": {
        object: (canary) => ({ "set-cookie": [`sid=${canary}; Path=/`] }),
        text: (canary) => `Set-Cookie: sid=${canary}; Path=/`,
        header: (canary) => ["Set-Cookie", `sid=${canary}; Path=/`],
    },
    Authorization: {
        object: (canary) => ({ authorization: `Bearer ${canary}` }),
        text: (canary) => `Authorization: Bearer ${canary}`,
        header: (canary) => ["Authorization", `Bearer ${canary}`],
    },
    "X-API-Key": {
        object: (canary) => ({ "X-API-Key": canary }),
        text: (canary) => `X-API-Key: ${canary}`,
        header: (canary) => ["X-API-Key", canary],
    },
    // HTTP scheme words ignore case, and Headers.get keeps the case the sender wrote
    "scheme in any letter case": {
        object: (canary) => ({ value: `bearer ${canary}`, upper: `BEARER ${canary}`, basic: `basic ${canary}` }),
        text: (canary) => `sent bearer ${canary}, BEARER ${canary} and basic ${canary}`,
    },
    "invite code": {
        object: (canary) => ({ code: canary, max_uses: 1, uses: 0 }),
        text: (canary) => `https://fluxer.gg/${canary}`,
    },
    "vanity code": {
        object: (canary) => ({ vanity_url_code: canary }),
        text: (canary) => `vanity_url_code=${canary}`,
    },
    "signed upload URL": {
        object: (canary) => ({ upload_url: signedUrl(canary) }),
        text: (canary) => `upload_url=${signedUrl(canary)}`,
    },
    "OAuth code": {
        object: (canary) => ({ callback: new URL(`https://bot.example/cb?code=${canary}&state=s`) }),
        text: (canary) => `https://bot.example/cb?code=${canary}&state=s`,
    },
    "parsed OAuth query": {
        object: (canary) => ({ params: new URL(`https://bot.example/cb?code=${canary}&state=s`).searchParams }),
        text: (canary) => `https://bot.example/cb?code=${canary}&state=s`,
    },
    "bare signed upload URL": {
        object: (canary) => ({ target: signedUrl(canary) }),
        text: (canary) => `PUT ${signedUrl(canary)} failed`,
    },
    // A URL split into an object, as Object.fromEntries(url.searchParams) or Express req.query writes it
    "parsed signing parameters": {
        object: (canary) => Object.fromEntries(new URL(signedUrl(canary)).searchParams),
        text: signedUrl,
    },
    "Fluxer attachment link": {
        object: (canary) => ({ attachments: [{ url: attachmentUrl(canary), proxy_url: attachmentUrl(canary) }] }),
        text: (canary) => `download failed: ${attachmentUrl(canary)}`,
    },
    "parsed attachment signature": {
        object: (canary) => ({ ex: "6a9a7231", is: "6a9920b1", hm: canary }),
        text: (canary) => `ex=6a9a7231&is=6a9920b1&hm=${canary}`,
    },
    "upload relay token": {
        object: (canary) => ({ relay: relayUrl(canary) }),
        text: (canary) => `PUT ${relayUrl(canary)} failed`,
        length: 43,
    },
    // An OAuth callback query parsed by querystring, and the token exchange form body with the code first
    "parsed OAuth callback": {
        object: (canary) => parseQuery(`code=${canary}&state=s`),
        text: (canary) => `code=${canary}&redirect_uri=https://bot.example/cb&grant_type=authorization_code`,
        cut: false,
    },
    // Express req.signedCookies, the cookie values after cookie-parser checked their signatures
    "signed cookies object": {
        object: (canary) => ({ signedCookies: { sid: canary } }),
        text: (canary) => `signedCookies: sid=${canary}; theme=dark`,
    },
    // The AWS SDK credential shape, with a temporary session token
    "AWS credentials": {
        object: (canary) => ({ accessKeyId: "AKIASYNTHETICID", secretAccessKey: canary, sessionToken: canary }),
        text: (canary) => `aws_secret_access_key=${canary}`,
    },
    "Azure SAS link": {
        object: (canary) => ({ url: azureUrl(canary) }),
        text: (canary) => `download failed: ${azureUrl(canary)}`,
    },
    "parsed Azure SAS": {
        object: (canary) => Object.fromEntries(new URL(azureUrl(canary)).searchParams),
        text: azureUrl,
    },
    "Google V2 signed link": {
        object: (canary) => ({ url: googleV2Url(canary) }),
        text: (canary) => `download failed: ${googleV2Url(canary)}`,
    },
    "parsed Google V2 signature": {
        object: (canary) => Object.fromEntries(new URL(googleV2Url(canary)).searchParams),
        text: googleV2Url,
    },
    // Audit context is read from the entry object, as for the raw entry
    "decoded invite audit entry": {
        object: decodedInviteAudit,
        text: (canary) => JSON.stringify(decodedInviteAudit(canary)),
        entries: false,
    },
    // Inspection writes text with both quote kinds in backticks
    "password with both quote kinds": {
        object: (canary) => ({ password: `a "${canary}" isn't it` }),
        text: (canary) => `password="a \\"${canary}\\" isn't it"`,
    },
    // Inspection writes a long text with line breaks as quoted fragments joined by +, and a service account key file
    // escapes them in JSON
    "PEM private key": {
        object: (canary) => ({ privateKey: pemKey(canary) }),
        text: (canary) => `credentials ${JSON.stringify({ type: "service_account", private_key: pemKey(canary) })}`,
    },
}

/** Getter calls and proxy reads, which describing a value must never make */
const reads = { count: 0 }

/** Value shapes, each from a kind, its canary and readable text to a value, or undefined where the shape does not apply */
const valueShapes: Record<string, (kind: CredentialKind, canary: string, kept: string) => unknown> = {
    "plain object": (kind, canary, kept) => ({ note: kept, ...kind.object(canary) }),
    // What querystring.parse returns
    "null-prototype object": (kind, canary, kept) =>
        Object.assign(Object.create(null) as object, { note: kept, ...kind.object(canary) }),
    // A raw gateway dispatch, whose t is the event name
    "gateway payload": (kind, canary, kept) => ({
        op: 0,
        t: "MESSAGE_CREATE",
        d: { note: kept, ...kind.object(canary) },
    }),
    "nested object": (kind, canary, kept) => ({ note: kept, request: { details: kind.object(canary) } }),
    array: (kind, canary, kept) => [kept, kind.object(canary)],
    Map: (kind, canary, kept) =>
        kind.entries === false ? undefined : new Map([["note", kept], ...Object.entries(kind.object(canary))]),
    Set: (kind, canary, kept) => new Set([kept, kind.object(canary)]),
    "entry list": (kind, canary, kept) =>
        kind.entries === false ? undefined : [["note", kept], ...Object.entries(kind.object(canary))],
    "Error with a cause": (kind, canary, kept) => new Error(kept, { cause: kind.object(canary) }),
    "Error with own properties": (kind, canary, kept) => Object.assign(new Error(kept), kind.object(canary)),
    AggregateError: (kind, canary, kept) => new AggregateError([kind.object(canary)], kept),
    "Error retained in an object": (kind, canary, kept) => ({
        note: kept,
        error: new Error("request refused", { cause: kind.object(canary) }),
    }),
    proxy: (kind, canary, kept) =>
        new Proxy(
            { note: kept, ...kind.object(canary) },
            {
                get: (target, key, receiver) => {
                    reads.count++
                    return Reflect.get(target, key, receiver) as unknown
                },
            },
        ),
    "object with its own inspection": (kind, canary, kept) => ({
        [inspect.custom]: () => ({ note: kept, ...kind.object(canary) }),
    }),
    getters: (kind, canary, kept) =>
        Object.defineProperties(
            { note: kept },
            Object.fromEntries(
                [...Object.keys(kind.object(canary)), "key", "t", "action_type"].map((key) => [
                    key,
                    {
                        enumerable: true,
                        get: () => {
                            reads.count++
                            return kind.object(canary)[key] ?? canary
                        },
                    },
                ]),
            ),
        ),
    "thrown string": (kind, canary, kept) => `${kept} ${kind.text(canary)}`,
    "Error message": (kind, canary, kept) => new Error(`${kept} ${kind.text(canary)}`),
    "JSON text": (kind, canary, kept) => new Error(`${kept} ${JSON.stringify(kind.object(canary))}`),
    // Node's inspection writes keys without quotes, as in { hm: 'x' } or [Object: null prototype] { code: 'x' }
    "inspected text": (kind, canary, kept) => new Error(`${kept} ${inspect(kind.object(canary))}`),
    "JSON inside JSON": (kind, canary, kept) =>
        new Error(JSON.stringify({ step: kept, body: JSON.stringify(kind.object(canary)) })),
    "escaped quotes": (kind, canary, kept) => new Error(`${kept} ${JSON.stringify(JSON.stringify(kind.text(canary)))}`),
    "escaped quotes after a stray quote": (kind, canary, kept) =>
        new Error(`${kept} Unexpected " in input: ${JSON.stringify(kind.text(canary))}`),
    "header pair list": (kind, canary, kept) => kind.header && { rawHeaders: ["Host", kept, ...kind.header(canary)] },
    // A key that names a list of header names lets lowercase names such as x-trace-id stay readable, and must not let a
    // credential value through when one is listed after its header name anyway
    "header pair list under a header-name key": (kind, canary, kept) =>
        kind.header && { note: kept, missingHeaders: ["x-trace-id", ...kind.header(canary)] },
    // A thrown string is cut at 200 characters in an ApplicationError message, here 30 characters into the credential
    "cut at 200 characters": (kind, canary, kept) => {
        if (kind.cut === false) return undefined
        const text = kind.text(canary)
        const filler = 200 - `${kept} `.length - text.indexOf(canary) - 30
        return `${kept} ${"lorem ipsum ".repeat(20).slice(0, filler - 1)} ${text}`
    },
}

/** Every kind in every shape that applies, with fresh canaries from a fixed seed */
function generatedMatrix(): {
    readonly name: string
    readonly value: unknown
    readonly canary: string
    readonly kept: string
}[] {
    const next = seeded(0x5eed_2026)
    const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
    const word = (length: number) => Array.from({ length }, () => letters[Math.floor(next() * letters.length)]).join("")
    const cells = []
    for (const [kindName, kind] of Object.entries(credentialKinds))
        for (const [shapeName, shape] of Object.entries(valueShapes)) {
            const canary = word(kind.length ?? 24)
            const kept = `readable ${word(6)} note`
            const value = shape(kind, canary, kept)
            if (value !== undefined) cells.push({ name: `${kindName} in ${shapeName}`, value, canary, kept })
        }
    return cells
}

/** Fail with the cell and output names when any 8 characters of a canary are printed or the readable note is gone */
function expectGeneratedMasked(surface: string, text: string, cells: ReturnType<typeof generatedMatrix>) {
    // Every 8 characters of the text, indexed once, so a long output is not searched again for each canary window
    const printed = new Set(Array.from({ length: Math.max(0, text.length - 7) }, (_, at) => text.slice(at, at + 8)))
    for (const cell of cells) {
        const leaked = Array.from({ length: cell.canary.length - 7 }, (_, at) => cell.canary.slice(at, at + 8)).find(
            (window) => printed.has(window),
        )
        expect.soft(leaked, `${surface} printed ${cell.name}`).toBeUndefined()
        expect.soft(text, `${surface} hid the readable note of ${cell.name}`).toContain(cell.kept)
    }
}

const cells = generatedMatrix()

test("the generated matrix covers every credential kind in every value shape that applies", () => {
    expect(cells.length).toBeGreaterThan(150)
})

// One test per output keeps each well under the default timeout. Each also checks that describing a value ran no getter
// or proxy read
test.each(modes)(
    "%s records and report descriptions mask the generated matrix",
    async (mode) => {
        reads.count = 0
        // A test bot queues at most 256 events, so the values are emitted in smaller batches
        for (let start = 0; start < cells.length; start += 200) {
            const batch = cells.slice(start, start + 200)
            const values = batch.map((cell) => cell.value)
            expectGeneratedMasked(`${mode} records`, await handlerOutputs(mode, false, values), batch)
            expectGeneratedMasked(`${mode} describe()`, await handlerOutputs(mode, true, values), batch)
        }
        expect(reads.count, "getters or proxy reads that describing a value ran").toBe(0)
        // A hang guard sized for the whole generated matrix on a busy runner. The test checks masking, not speed
    },
    30_000,
)

test.each(Object.entries(valueSurfaces))("%s masks the generated matrix", async (surface, output) => {
    reads.count = 0
    for (const cell of cells) expectGeneratedMasked(surface, await output(cell.value), [cell])
    expect(reads.count, "getters or proxy reads that describing a value ran").toBe(0)
})

test.each(modes)("%s scheduled task names with quoted credentials stay masked once quoted", async (mode) => {
    const names = ['sync password="task-canary-double x"', 'report api_key="task-canary-key"']
    const records: LogRecord[] = []
    const described: string[] = []
    const logging = { dedupe: false as const, sink: (record: LogRecord) => void records.push(record) }
    const onError = (report: FailureReport) => void described.push(report.describe())
    const failing = () => Promise.reject(new Error("task broke"))
    for (const hook of [false, true]) {
        if (mode === "default") {
            const bot = createDefaultTestBot({ logging, ...(hook && { onError }) })
            onTestFinished(async () => {
                bot.failures()
                await bot.shutdown()
            })
            await bot.ready()
            for (const name of names) bot.client.schedule(failing, { name })
            await vi.waitFor(() => expect(hook ? described : taskRecords(records)).toHaveLength(names.length))
        } else {
            const scope = Scope.makeUnsafe()
            const bot = await Effect.runPromise(
                createNativeTestBot({
                    logging,
                    ...(hook && { onError: (report: FailureReport) => Effect.sync(() => onError(report)) }),
                }).pipe(Scope.provide(scope)),
            )
            onTestFinished(async () => {
                bot.failures()
                await Effect.runPromise(Scope.close(scope, Exit.void))
            })
            await Effect.runPromise(bot.ready())
            for (const name of names)
                Effect.runSync(
                    bot.client.schedule(Effect.tryPromise({ try: failing, catch: (error) => error }), { name }),
                )
            await vi.waitFor(() => expect(hook ? described : taskRecords(records)).toHaveLength(names.length))
        }
    }
    const output = `${JSON.stringify(taskRecords(records))}\n${described.join("\n")}`
    for (const canary of ["task-canary-double", "task-canary-key"]) expect(output).not.toContain(canary)
    for (const kept of ["The scheduled task", "sync password=", "report api_key="]) expect(output).toContain(kept)
})

const taskRecords = (records: readonly LogRecord[]) =>
    records.filter((record) => record.code === "lifecycle.taskFailed")

// Every credential name that structural masking hides is hidden in text too, in its separator and case variants.
// Signing parameters are hidden only after ? or & by design, so they are left out here
test("credential names hidden in payloads are hidden in labelled text", () => {
    const names = [
        ["authorization"],
        ["proxy", "authorization"],
        ["cookie"],
        ["cookies"],
        ["set", "cookie"],
        ["signed", "cookies"],
        ["vanity", "url", "code"],
        ["upload", "url"],
        ["source", "invite", "code"],
        ["source", "invite", "codes"],
        ["code", "verifier"],
        ["verifier"],
    ]
    const canary = "k3y9canary7value2kept"
    for (const words of names)
        for (const name of [
            words.join("_"),
            words.join("-"),
            words.join(""),
            words.map((word, index) => (index === 0 ? word : word[0]!.toUpperCase() + word.slice(1))).join(""),
            words.join("_").toUpperCase(),
        ]) {
            expect(masking.maskPayload({ [name]: canary }), `${name} in a payload`).not.toContain(canary)
            for (const text of [
                `${name}=${canary}`,
                `${name}: '${canary}'`,
                `${name}: "${canary}"`,
                `state=s&${name}=${canary}&grant=x`,
                `{"${name}":"${canary}"}`,
            ])
                expect.soft(masking.maskText(text), text).not.toContain(canary)
        }
})

test("ordinary words, headers and quoted text stay readable", () => {
    const prose = [
        'The scheduled task "daily report" failed: Could not build',
        "Bot processSignals must be a boolean",
        "Missing token: check config",
        "Authorization header missing, so the cookie policy applies",
        "Set the API key in settings before the upload URL expires",
        "Bot application.commands.update failed, so the basic validation ran",
        "Cookie: not present",
        "Authorization: header missing",
        "Missing Cookie: sign in again, then retry",
        "GET /items?code=404 returned nothing",
        JSON.stringify({ note: 'say "hi" twice', user: "bot" }),
        '"an unclosed quote with \\"escapes\\" inside',
        'Missing "Authorization", check the header',
        'allowed: ["Authorization","Content-Type"] and ["Cookie", "X-API-Key"]',
        String.raw`C:\Users\bot\new\file.txt was not found`,
    ]
    for (const text of prose) expect(masking.maskText(text)).toBe(text)
    // Lists of names hold no credential values
    expect(masking.maskValue({ missingHeaders: ["Authorization", "Cookie", "X-API-Key"] })).toBe(
        "{ missingHeaders: [ 'Authorization', 'Cookie', 'X-API-Key' ] }",
    )
    // A header name outside the known list, after a credential header name
    expect(masking.maskValue({ missingHeaders: ["Authorization", "X-Trace-ID", "Cookie", "X-Custom"] })).toBe(
        "{ missingHeaders: [ 'Authorization', 'X-Trace-ID', 'Cookie', 'X-Custom' ] }",
    )
    // Headers keys are lowercase, so a list built from them names x-trace-id that way
    const missingHeaders = [...new Headers({ Authorization: "synthetic", "X-Trace-ID": "synthetic" }).keys()]
    expect(masking.maskValue({ missingHeaders })).toBe("{ missingHeaders: [ 'authorization', 'x-trace-id' ] }")
    expect(masking.maskValue({ allowedHeaders: ["cookie", "x-request-id", "proxy-authorization", "x-b-c"] })).toBe(
        "{ allowedHeaders: [ 'cookie', 'x-request-id', 'proxy-authorization', 'x-b-c' ] }",
    )
    // Only such a key relaxes the rule, so a lowercase hyphenated value after a credential header name elsewhere stays hidden
    expect(masking.maskValue({ rawHeaders: ["authorization", "alpha-bravo-charlie"] })).not.toContain("alpha-bravo")
    expect(masking.maskValue(new URLSearchParams("state=ok&page=2"))).toBe(
        "URLSearchParams { 'state' => 'ok', 'page' => '2' }",
    )
    expect(masking.maskValue(["password", "username"])).toBe("[ 'password', 'username' ]")
    expect(masking.maskValue(["Authorization", "Content-Type"])).toBe("[ 'Authorization', 'Content-Type' ]")
    // The same details shown twice are shown both times, not as a cycle
    const info = { code: "ECONNRESET", status: 503 }
    expect(masking.maskValue({ request: info, response: info })).toBe(
        "{ request: { code: 'ECONNRESET', status: 503 }, response: { code: 'ECONNRESET', status: 503 } }",
    )
    const readable = { user: "bot", headers: ["Content-Type", "text/plain"], note: "save failed" }
    expect(masking.maskValue(readable)).toBe(
        "{ user: 'bot', headers: [ 'Content-Type', 'text/plain' ], note: 'save failed' }",
    )
    expect(masking.maskValue(new Map([["Accept", "text/plain"]]))).toBe("Map(1) { 'Accept' => 'text/plain' }")
    // Only an invite audit entry's target is an invite code, and an ordinary targetId stays readable
    const banned = decodeAuditLogEntry({ id: "300000000000000001", action_type: 22, target_id: "300000000000000003" })
    expect(masking.maskText(JSON.stringify(banned))).toContain("300000000000000003")
    expect(masking.maskValue({ code: "ECONNRESET", targetId: "300000000000000003" })).toContain("300000000000000003")
})

test("a gateway payload hides every credential kind and keeps its event name", () => {
    for (const [name, kind] of Object.entries(credentialKinds)) {
        const canary = `payload-canary-${name.replaceAll(" ", "-")}`.padEnd(kind.length ?? 24, "x")
        const text = masking.maskPayload({
            op: 0,
            t: "MESSAGE_CREATE",
            d: { note: "payload note", ...kind.object(canary) },
        })
        expect(text, name).not.toContain(canary)
        expect(text, name).toContain('"t":"MESSAGE_CREATE"')
        expect(text, name).toContain("payload note")
    }
})

test("signed links hide only their signatures, in every form", () => {
    const canary = "sig-canary-value"
    const url = new URL(signedUrl(canary))
    const entries = [...url.searchParams]
    const forms = [
        url.href,
        url,
        url.searchParams,
        Object.fromEntries(url.searchParams),
        parseQuery(url.search.slice(1)),
        new Map(entries),
        entries,
        JSON.stringify(Object.fromEntries(url.searchParams)),
    ]
    for (const form of forms) {
        const text = masking.maskValue(form)
        expect(text).not.toContain(canary)
        // The date, expiry and signed headers tell why a link expired, and a rule that hides the whole query fails here
        for (const kept of ["20261103T000000Z", "604800", "host"]) expect(text).toContain(kept)
    }
    const attachment = masking.maskValue({ ex: "6a9a7231", is: "6a9920b1", hm: canary })
    expect(attachment).not.toContain(canary)
    expect(attachment).toContain("6a9a7231")
    expect(masking.maskText(attachmentUrl(canary))).toBe(attachmentUrl("[redacted]"))
    expect(masking.maskText(relayUrl("a".repeat(43)))).toBe(
        "https://uploads.example.test/v1/relay/k?t=[redacted]&uploadId=u1",
    )
    // The word hm in prose, the event name t, a hex hash and a media proxy path signature stay readable
    for (const text of [
        "hm = interesting",
        "hm, the upload was slow",
        JSON.stringify({ t: "MESSAGE_CREATE", s: 4 }),
        "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "https://media.example.test/external/abc123def456/https/example.com/cat.png",
    ])
        expect(masking.maskText(text)).toBe(text)
})

test("storage credentials and signed links of common cloud libraries hide only their secrets", () => {
    const canary = "cloud-canary-value"
    // An AWS key pair keeps its access key ID, and every usual spelling of the secret is hidden
    for (const value of [
        { accessKeyId: "AKIASYNTHETICID", secretAccessKey: canary },
        JSON.stringify({ AccessKeyId: "AKIASYNTHETICID", SecretAccessKey: canary, SessionToken: canary }),
        `AWS_SECRET_ACCESS_KEY=${canary}`,
        `config { credentials: { accessKeyId: 'AKIASYNTHETICID', secretAccessKey: '${canary}' } }`,
        { private_key: `-----BEGIN PRIVATE KEY-----\n${canary}\n-----END PRIVATE KEY-----\n` },
    ]) {
        const text = masking.maskValue(value)
        expect(text).not.toContain(canary)
        if (JSON.stringify(value).includes("AKIA")) expect(text).toContain("AKIASYNTHETICID")
    }
    // The expiry and permissions of a signed link tell why it stopped working, so only the signature is hidden
    for (const [url, kept] of [
        [azureUrl(canary), ["2023-11-03", "2026-11-04"]],
        [googleV2Url(canary), ["example.test", "1793746800"]],
    ] as const)
        for (const form of [
            url,
            new URL(url),
            Object.fromEntries(new URL(url).searchParams),
            [...new URL(url).searchParams],
        ]) {
            const text = masking.maskValue(form)
            expect(text).not.toContain(canary)
            for (const part of kept) expect(text).toContain(part)
        }
    // A signature without a signed link's fields, such as an email signature, and identifier keys in prose stay readable
    for (const value of [
        { signature: "Best regards, the bot team", sig: "v2" },
        new Map([["Signature", "Kind regards"]]),
    ])
        expect(masking.maskValue(value)).toMatch(/regards/)
    for (const text of ["Missing scope, token: check config", "Expected a, b or c, hm: nothing else"])
        expect(masking.maskText(text)).toBe(text)
})

test("inspected text hides credentials under keys written without quotes", () => {
    const canary = "inspect-canary-value"
    for (const text of [
        inspect({ ex: "6a9a7231", is: "6a9920b1", hm: canary }),
        inspect(parseQuery(`code=${canary}&state=saved-state`)),
        inspect(
            new Map([
                ["code", canary],
                ["state", "s"],
            ]),
        ),
        inspect({ code: canary, max_uses: 1, uses: 0 }),
        inspect(decodedInviteAudit(canary)),
    ]) {
        const masked = masking.maskText(`request failed: ${text}`)
        expect(masked, text).not.toContain(canary)
    }
    // Readable fields beside them, missing values and an ordinary error code stay readable
    expect(masking.maskText(inspect({ ex: "6a9a7231", hm: "x".repeat(20) }))).toContain("6a9a7231")
    expect(masking.maskText(inspect(parseQuery("code=abc&state=saved-state")))).toContain("saved-state")
    expect(masking.maskText(inspect({ password: undefined, token: null }))).toBe("{ password: undefined, token: null }")
    expect(masking.maskText(inspect({ code: "ECONNRESET", status: 503 }))).toContain("ECONNRESET")
})

test("a parsed OAuth callback hides its code and keeps an ordinary code readable", () => {
    const canary = "oauth-canary-code"
    for (const value of [
        parseQuery(`code=${canary}&state=s`),
        { query: { code: canary, state: "s" } },
        { code: canary, redirectUri: "https://bot.example/cb", codeVerifier: "verifier-canary" },
        new Map([
            ["code", canary],
            ["state", "s"],
        ]),
        [
            ["code", canary],
            ["state", "s"],
        ],
        JSON.stringify({ code: canary, state: "s" }),
        new URLSearchParams({ code: canary, redirect_uri: "https://bot.example/cb", grant_type: "authorization_code" }),
        String(new URLSearchParams({ code: canary, redirect_uri: "https://bot.example/cb" })),
    ]) {
        const text = masking.maskValue(value)
        expect(text).not.toContain(canary)
        expect(text).not.toContain("verifier-canary")
    }
    expect(masking.maskValue({ code: "ECONNRESET", status: 503 })).toContain("ECONNRESET")
    expect(masking.maskText("code=ECONNRESET&retry=1")).toBe("code=ECONNRESET&retry=1")
})

test("a cookie list assignment hides every cookie and keeps the query and text after it readable", () => {
    const cases = [
        ["cookies=sid=cookie-first; refresh=cookie-second and more", "cookies=[redacted] and more"],
        ['Cookie=sid="cookie-first"; refresh=cookie-second failed', "Cookie=[redacted] failed"],
        [
            "set_cookie=sid=cookie-first; Expires=Wed, 21 Oct 2030 07:28:00 GMT; refresh=cookie-second",
            "set_cookie=[redacted]",
        ],
        [
            "set_cookie=sid=cookie-first; Expires=Wed, 21 Oct 2030 07:28:00 GMT was ignored",
            "set_cookie=[redacted] was ignored",
        ],
        ["set-cookie=sid=cookie-first; Path=/,refresh=cookie-second; Path=/ then", "set-cookie=[redacted] then"],
        ["cookie=a=cookie-first;b=cookie-second", "cookie=[redacted]"],
        // Legal cookie characters in an earlier cookie, which once ended the list
        ["cookies=sid=cookie-first&inside=cookie-second; refresh=cookie-second after", "cookies=[redacted] after"],
        ["cookies=sid=cookie-first'part; refresh=cookie-second after", "cookies=[redacted] after"],
        ["cookies=sid=cookie-first}part; refresh=cookie-second after", "cookies=[redacted] after"],
        ["set-cookie=sid=cookie-first; Path=/,&other=cookie-second; Path=/ after", "set-cookie=[redacted] after"],
        ["set-cookie=sid=cookie-first; Path=/,`other=cookie-second; Path=/ after", "set-cookie=[redacted] after"],
        // A quote that closes the string holding the list stays readable
        [
            "{ note: 'cookies=sid=cookie-first; refresh=cookie-second', step: 'save' }",
            "{ note: 'cookies=[redacted]', step: 'save' }",
        ],
        ["['cookies=sid=cookie-first}part; refresh=cookie-second']", "['cookies=[redacted]']"],
        ["`cookies=sid=cookie-first; refresh=cookie-second`", "`cookies=[redacted]`"],
        [
            "GET /cb?cookie=cookie-first&state=public-state HTTP/1.1",
            "GET /cb?cookie=[redacted]&state=public-state HTTP/1.1",
        ],
        [
            JSON.stringify({ note: "cookies=sid=cookie-first; refresh=cookie-second", step: "save" }),
            JSON.stringify({ note: "cookies=[redacted]", step: "save" }),
        ],
    ] as const
    for (const [text, masked] of cases) {
        expect(masking.maskText(text), text).toBe(masked)
        for (const output of [masking.maskPayload({ note: text }), describeError(new Error(text))])
            expect(output, text).not.toMatch(/cookie-first|cookie-second/)
    }
})

test("the result of oauth.createPkce hides its verifier and keeps its challenge readable", () => {
    const pkce = createPkce()
    for (const output of [
        masking.maskValue(pkce),
        masking.maskPayload(pkce),
        masking.maskValue(new Error("callback failed", { cause: pkce })),
        describeError(new Error("callback failed", { cause: pkce })),
        masking.maskText(`verifier=${pkce.verifier} challenge=${pkce.challenge}`),
    ]) {
        expect(output).not.toContain(pkce.verifier)
        expect(output).toContain(pkce.challenge)
    }
})

test("a missing credential reads as missing, not as hidden", () => {
    expect(masking.maskValue({ headers: { authorization: undefined } })).toBe(
        "{ headers: { authorization: undefined } }",
    )
    expect(masking.maskValue({ apiKey: "", password: null, hasToken: false })).toBe(
        "{ apiKey: '', password: null, hasToken: false }",
    )
    expect(masking.maskValue(new Map([["Authorization", undefined]]))).toBe("Map(1) { 'Authorization' => undefined }")
    expect(masking.maskText(JSON.stringify({ password: null, apiKey: "" }))).toBe('{"password":null,"apiKey":""}')
    for (const text of ["Authorization: missing", "Cookie: absent", "X-API-Key: required", "Authorization: invalid"])
        expect(masking.maskText(text)).toBe(text)
    expect(masking.maskText("Authorization: abcdefgh12")).toBe("Authorization: [redacted]")
    expect(masking.maskText("Cookie: missing; sid=cookie-canary")).not.toContain("cookie-canary")
    expect(masking.maskValue({ apiKey: "key-canary", headers: { authorization: 0 } })).not.toMatch(/key-canary|: 0/)
})

test("the JSON of a decoded invite audit entry hides its invite code", () => {
    const text = masking.maskText(JSON.stringify(decodedInviteAudit("audit-canary-code")))
    expect(text).not.toContain("audit-canary-code")
    expect(text).toContain('"actionType":40')
})

test("an invite link typed with capital letters is masked", () => {
    expect(masking.maskText("Join at Fluxer.GG/AbCdEf12 today")).toBe("Join at Fluxer.GG/[redacted] today")
})

test.each(modes)("%s unsafe member search payloads hide community invite codes", async (mode) => {
    const records: LogRecord[] = []
    const client = await setup(mode, {
        logging: {
            dedupe: false,
            unsafe: { payloads: true, categories: ["rest"] },
            sink: (record: LogRecord) => void records.push(record),
        },
    })
    const member = {
        id: "20_30",
        guild_id: "20",
        user_id: "30",
        username: "member",
        discriminator: "0001",
        global_name: null,
        nickname: null,
        role_ids: [],
        joined_at: 1_700_000_000,
        is_bot: false,
        supplemental: { join_source_type: 1, source_invite_code: "search-canary-response", inviter_id: "40" },
    }
    const page = JSON.stringify({
        guild_id: "20",
        members: [member],
        page_result_count: 1,
        total_result_count: 1,
        indexing: false,
    })
    // The second response is cut off inside the code, as a body over the read limit is logged
    const bodies = [page, page.replace(/search-canary-response.*$/, "search-canary-cut")]
    // Sensitive filters first check that the bot has Manage Guild, here through the everyone role
    const preflight: Record<string, unknown> = {
        "/api/v1/guilds/20/members/@me": {
            user: { id: "30", username: "bot", bot: true },
            roles: [],
            joined_at: "2026-01-01T00:00:00.000Z",
        },
        "/api/v1/guilds/20": { id: "20", owner_id: "40", name: "Fixture guild", features: [] },
        "/api/v1/guilds/20/roles": [
            { id: "20", name: "@everyone", color: 0, position: 0, permissions: "32", hoist: false, mentionable: false },
        ],
    }
    stubFetchWithHostedDiscovery(async (url: string) => {
        const path = new URL(url).pathname
        if (path === "/api/v1/guilds/20/members-search")
            return new Response(bodies.shift(), { headers: { "content-type": "application/json" } })
        if (path in preflight) return Response.json(preflight[path])
        throw new Error(`Unexpected fixture route: ${path}`)
    })
    const filters = { sourceInviteCodes: ["search-canary-request"] }
    expect(await settle(client.members.search("20", filters))).toMatchObject({ pageResultCount: 1 })
    await settle(client.members.search("20", filters)).catch(() => undefined)
    const search = () => records.filter((record) => record.route === "/guilds/:id/members-search")
    await vi.waitFor(() => expect(search().filter((record) => record.code === "rest.payloadReceived")).toHaveLength(2))
    const payloads = search().filter((record) => record.code.startsWith("rest.payload"))
    expect(payloads.map((record) => record.code)).toContain("rest.payloadSent")
    const output = JSON.stringify(payloads)
    for (const canary of ["search-canary-request", "search-canary-response", "search-canary-cut"])
        expect(output, canary).not.toContain(canary)
    expect(output).toContain("join_source_type")
})

/** Conversions of unknown values to text outside masking.ts that are not output text, each with why. A conversion
 * not listed here fails the boundary test, and so does an entry that no longer matches one
 */
const allowedConversions: Record<string, readonly string[]> = {
    // Request bodies, query strings and gateway frames sent to Fluxer, or to the test transport that stands in for it
    "Wire data sent to Fluxer, not output text": [
        "internal/client.ts JSON.stringify data",
        "internal/expressions.ts JSON.stringify body",
        "internal/gateway/commands.ts JSON.stringify { op, d }",
        "internal/guild-settings.ts JSON.stringify wireFields(checked, wireNames)",
        "internal/guilds.ts JSON.stringify body",
        "internal/member-search.ts JSON.stringify wireFields(checked, wireNames)",
        "internal/message.ts JSON.stringify",
        "internal/oauth.ts join request.scopes",
        "internal/rest/owner.ts JSON.stringify payload",
        "internal/rest/request.ts JSON.stringify",
        "internal/testing/gateway.ts JSON.stringify frame",
        "internal/testing/gateway.ts JSON.stringify payload",
        "internal/threads.ts JSON.stringify",
        "internal/threads.ts String item",
        "internal/users.ts JSON.stringify",
        "internal/webhooks.ts JSON.stringify",
    ],
    // The fluxerly command's own errors, whose messages name files in the project folder
    "SDK-written message of a command line error": [
        "cli.ts template error.message",
        "internal/init-command.ts template error.message",
    ],
}

// A type-aware source check, because no runtime test can list an output path that does not exist yet. It fails when a
// module other than masking.ts turns an unknown value, an application Error or its message into text, or imports a
// node:util converter. Its limits are listed on unmaskedConversions
test("only masking.ts turns unknown values into text, and it exports only masked converters", () => {
    const allowed = Object.values(allowedConversions).flat()
    const conversions = unmaskedConversions()
    const unexplained = conversions
        .map((conversion) => `${conversion.file}:${conversion.line} ${conversion.kind} ${conversion.expression}`)
        .filter((found) => !allowed.some((entry) => matches(found, entry)))
    expect(unexplained, "unmasked conversions to text outside masking.ts").toEqual([])
    const stale = allowed.filter((entry) =>
        conversions.every(
            (conversion) => !matches(`${conversion.file}:0 ${conversion.kind} ${conversion.expression}`, entry),
        ),
    )
    expect(stale, "allowed conversions that no longer exist").toEqual([])
    expect(Object.keys(masking).sort()).toEqual([
        "maskPayload",
        "maskText",
        "maskValue",
        "maskedErrorCode",
        "maskedMessage",
        "maskedSummary",
    ])
}, 120_000)

/** Whether a found conversion, file:line kind expression, is the allowed file, kind and expression start */
function matches(found: string, entry: string): boolean {
    const [file, kind, ...expression] = entry.split(" ")
    return found.replace(/:\d+ /, " ").startsWith(`${file} ${kind} ${expression.join(" ")}`)
}
