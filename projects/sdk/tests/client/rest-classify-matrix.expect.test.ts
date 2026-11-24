/*
 * Deterministic expect-test matrix for REST response classification.
 * Captures classifyResponse(response, context) across representative (method, status, flags, headers, body)
 * combinations and its side-effect callbacks, stored in a reviewable snapshot fixture
 */
import { expect, test } from "vitest"
import { classifyResponse, RestFailure, type ClassifyContext, type Outcome } from "../../src/internal/rest/classify.js"

interface ClassifyCase {
    readonly name: string
    readonly method: "GET" | "POST" | "DELETE" | "PUT"
    readonly status: number
    readonly retriesAsRead?: boolean
    readonly upload?: boolean
    readonly multipart?: boolean
    readonly preparation?: boolean
    readonly hasFeatureFallback?: boolean
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string | null
}

const fixedNow = 10_000

const cases: readonly ClassifyCase[] = [
    { name: "200-get-ok", method: "GET", status: 200, retriesAsRead: true, body: '{"ok":true}' },
    { name: "204-delete-ok", method: "DELETE", status: 204 },
    {
        name: "400-invalid-form-body",
        method: "POST",
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "INVALID_FORM_BODY", message: "Invalid Form Body" }),
    },
    {
        name: "400-unknown-provider-code",
        method: "POST",
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "CUSTOM_NEW_CODE", message: "Custom error" }),
    },
    {
        name: "400-plain-text",
        method: "POST",
        status: 400,
        headers: { "content-type": "text/plain" },
        body: "Bad Request",
    },
    {
        name: "401-unauthorized-get",
        method: "GET",
        status: 401,
        retriesAsRead: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "UNAUTHORIZED" }),
    },
    {
        name: "403-missing-permissions",
        method: "POST",
        status: 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "MISSING_PERMISSIONS" }),
    },
    {
        name: "403-feature-disabled-fallback",
        method: "POST",
        status: 403,
        hasFeatureFallback: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "FEATURE_TEMPORARILY_DISABLED" }),
    },
    {
        name: "403-feature-disabled-no-fallback",
        method: "POST",
        status: 403,
        hasFeatureFallback: false,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "FEATURE_TEMPORARILY_DISABLED" }),
    },
    {
        name: "404-get-not-found",
        method: "GET",
        status: 404,
        retriesAsRead: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "UNKNOWN_MESSAGE" }),
    },
    {
        name: "404-post-not-found",
        method: "POST",
        status: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "UNKNOWN_CHANNEL" }),
    },
    {
        name: "404-preparation-rejected",
        method: "POST",
        status: 404,
        preparation: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "UNKNOWN_CHANNEL" }),
    },
    {
        name: "429-global-header",
        method: "POST",
        status: 429,
        headers: { "x-ratelimit-global": "true", "retry-after": "2" },
    },
    {
        name: "429-global-scope-and-body",
        method: "GET",
        status: 429,
        retriesAsRead: true,
        headers: { "x-ratelimit-scope": "global", "content-type": "application/json" },
        body: JSON.stringify({ global: true, retry_after: 1.5 }),
    },
    {
        name: "429-route-bucket-header",
        method: "POST",
        status: 429,
        headers: { "x-ratelimit-bucket": "abc123", "retry-after": "1" },
    },
    {
        name: "429-route-scope-user",
        method: "POST",
        status: 429,
        headers: { "x-ratelimit-scope": "user", "content-type": "application/json" },
        body: JSON.stringify({ global: false, retry_after: 0.5 }),
    },
    {
        name: "429-route-body-only",
        method: "POST",
        status: 429,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ global: false, retry_after: 1.25 }),
    },
    {
        name: "429-header-beats-shorter-body",
        method: "POST",
        status: 429,
        headers: { "x-ratelimit-bucket": "abc123", "retry-after": "3", "content-type": "application/json" },
        body: JSON.stringify({ global: false, retry_after: 0.4 }),
    },
    {
        name: "429-body-beats-shorter-header",
        method: "POST",
        status: 429,
        headers: { "x-ratelimit-bucket": "abc123", "retry-after": "1", "content-type": "application/json" },
        body: JSON.stringify({ global: false, retry_after: 2.5 }),
    },
    {
        name: "429-unidentified-proxy",
        method: "POST",
        status: 429,
        headers: { "retry-after": "2", "content-type": "text/plain" },
        body: "429 - Ratelimited",
    },
    {
        name: "429-no-retry-delay",
        method: "POST",
        status: 429,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ global: false }),
    },
    {
        name: "429-signed-upload-put",
        method: "PUT",
        status: 429,
        upload: true,
        headers: { "retry-after": "4" },
    },
    { name: "500-get-retryable", method: "GET", status: 500, retriesAsRead: true },
    { name: "500-post-not-retryable", method: "POST", status: 500 },
    { name: "502-get-retryable", method: "GET", status: 502, retriesAsRead: true },
    { name: "503-get-retryable", method: "GET", status: 503, retriesAsRead: true },
    { name: "504-get-retryable", method: "GET", status: 504, retriesAsRead: true },
    {
        name: "503-multipart-upload-slots-busy",
        method: "POST",
        status: 503,
        multipart: true,
        headers: { "retry-after": "5", "content-type": "application/json" },
        body: JSON.stringify({ code: "SERVICE_UNAVAILABLE" }),
    },
    {
        name: "503-multipart-other-retry-after",
        method: "POST",
        status: 503,
        multipart: true,
        headers: { "retry-after": "1", "content-type": "application/json" },
        body: JSON.stringify({ code: "SERVICE_UNAVAILABLE" }),
    },
]

function pad(value: string, width: number): string {
    return value.padEnd(width, " ")
}

async function runCase(entry: ClassifyCase): Promise<string[]> {
    const effects: string[] = []
    const progress: { outcome: Outcome } = { outcome: "unknown" }
    const controller = new AbortController()
    const context: ClassifyContext = {
        method: entry.method,
        retriesAsRead: entry.retriesAsRead ?? false,
        upload: entry.upload ?? false,
        multipart: entry.multipart ?? false,
        preparation: entry.preparation ?? false,
        hasFeatureFallback: entry.hasFeatureFallback ?? false,
        progress,
        signal: controller.signal,
        cleanupDefects: [],
        now: () => fixedNow,
        pauseGlobal: (until) => effects.push(`pauseGlobal(${until - fixedNow})`),
        pauseClient: (until) => {
            effects.push(`pauseClient(${until - fixedNow})`)
            return until
        },
        responded: () => effects.push("responded"),
        pauseBucket: (until) => effects.push(`pauseBucket(${until - fixedNow})`),
        notFound: () => effects.push("notFound"),
    }
    const response = new Response(entry.body ?? null, {
        status: entry.status,
        ...(entry.headers === undefined ? {} : { headers: entry.headers }),
    })

    try {
        const result = await classifyResponse(response, context)
        if (result.kind === "retry") {
            return [
                entry.name,
                "retry",
                progress.outcome,
                String(entry.status),
                String(result.retry),
                "-",
                result.pause,
                String(result.global),
                "-",
                result.apiError?.code ?? "-",
                result.providerCode ?? "-",
                effects.join(",") || "-",
            ]
        }
        return [
            entry.name,
            result.kind,
            progress.outcome,
            String(entry.status),
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            effects.join(",") || "-",
        ]
    } catch (error) {
        if (!(error instanceof RestFailure)) throw error
        return [
            entry.name,
            `fail:${error.reason}`,
            error.outcome,
            String(error.status ?? "-"),
            String(error.retryAfterMs ?? "-"),
            String(error.retryableRead),
            "-",
            "-",
            String(error.uploadSlotsBusy),
            error.apiError?.code ?? "-",
            error.providerCode ?? "-",
            effects.join(",") || "-",
        ]
    }
}

async function renderMatrix(): Promise<string> {
    const headers = [
        "case",
        "result",
        "outcome",
        "status",
        "retryMs",
        "retryRead",
        "pause",
        "global",
        "slotsBusy",
        "apiCode",
        "providerCode",
        "effects",
    ] as const
    const rows: string[][] = []
    for (const entry of cases) rows.push(await runCase(entry))
    const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]!.length)))
    const format = (cells: readonly string[]) =>
        cells.map((cell, column) => (column === cells.length - 1 ? cell : pad(cell, widths[column]!))).join(" | ")
    const divider = widths.map((width) => "-".repeat(width)).join("-+-")
    return [format(headers), divider, ...rows.map(format)].join("\n") + "\n"
}

test("REST response classification matrix matches snapshot", async () => {
    await expect(await renderMatrix()).toMatchFileSnapshot("./rest-classify-matrix.snapshot.txt")
})
