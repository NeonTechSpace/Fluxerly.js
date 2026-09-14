import assert from "node:assert/strict"
import test from "node:test"
import { deployPreview, previewSettings } from "../scripts/preview-deploy.mjs"

const source = "a".repeat(40)
const id = "11111111-1111-1111-1111-111111111111"
const env = {
    CLOUDFLARE_ACCOUNT_ID: "1".repeat(32),
    CLOUDFLARE_API_TOKEN: "test-only-secret",
    CLOUDFLARE_PAGES_PROJECT: "test-docs",
    CLOUDFLARE_PREVIEW_URL: "https://preview.example.com",
    DOCS_SOURCE_COMMIT: source,
}
const project = { name: "test-docs", id: "project-id", production_branch: "main", domains: ["preview.example.com"] }
const deployment = {
    id,
    project_id: "project-id",
    project_name: "test-docs",
    environment: "preview",
    production_branch: "main",
    deployment_trigger: { metadata: { branch: "docs-preview", commit_hash: source, commit_dirty: false } },
    latest_stage: { name: "deploy", status: "success" },
}
const json = (result, status = 200, headers = {}) => new Response(JSON.stringify(result), { status, headers })

function fixture(options = {}) {
    const calls = []
    let clock = 0
    let reads = 0
    const io = {
        now: () => clock,
        sleep: async (ms) => {
            calls.push(["sleep", ms])
            clock += ms
        },
        readFile: async (path) => {
            calls.push(["file", path])
            return path.endsWith("deployment.json")
                ? JSON.stringify(options.localMarker ?? { sourceCommit: source })
                : (options.headers ?? "/*\n  X-Robots-Tag: noindex, nofollow\n")
        },
        upload: async (settings, commit) => {
            calls.push(["upload", settings.project, settings.account, settings.branch, commit])
            if (options.uploadError) throw options.uploadError
            return options.uploadId ?? id
        },
        fetch: async (url, init) => {
            calls.push(["fetch", url, init])
            if (!url.includes("/deployments/") && url.startsWith("https://api.cloudflare.com/"))
                return json({ success: true, result: options.project ?? project }, options.preflightStatus ?? 200)
            if (url.includes("/deployments/")) {
                reads++
                if (options.readError && reads === 1) throw new Error(env.CLOUDFLARE_API_TOKEN)
                if (options.readStatus && reads === 1) return json({}, options.readStatus, options.readHeaders)
                return json({ success: true, result: options.deployment?.(reads) ?? deployment })
            }
            if (url.endsWith("/docs/dev/"))
                return new Response("Docs", {
                    status: options.routeStatus ?? 200,
                    headers: { "x-robots-tag": options.routeHeader ?? "noindex, nofollow" },
                })
            return json(options.servedMarker?.(reads) ?? { sourceCommit: source }, options.markerStatus ?? 200)
        },
    }
    return { io, calls, reads: () => reads }
}

test("Preview settings reject unsafe origins and configuration without exposing tokens", () => {
    for (const origin of [
        "http://preview.example.com",
        "https://example.com",
        "https://preview.example.com/docs/",
        "https://user:pass@preview.example.com",
        "https://preview.example.com?x=1",
        "https://preview.example.com:443/#x",
    ]) {
        assert.throws(() => previewSettings({ ...env, CLOUDFLARE_PREVIEW_URL: origin }), /preview/i)
    }
    assert.throws(
        () => previewSettings({ ...env, CLOUDFLARE_ACCOUNT_ID: "invalid" }),
        (error) => !error.message.includes(env.CLOUDFLARE_API_TOKEN),
    )
})

test("Local source identity and global noindex are verified before provider reads or upload", async () => {
    for (const options of [
        { localMarker: { sourceCommit: "b".repeat(40) } },
        { headers: "/docs/*\n  X-Robots-Tag: noindex\n" },
        { headers: "/*\n  X-Robots-Tag: not-noindex\n" },
        { headers: "/*\n  X-Robots-Tag: index\n" },
    ]) {
        const { io, calls } = fixture(options)
        await assert.rejects(deployPreview(env, io), /source|noindex/)
        assert.ok(calls.every(([kind]) => kind === "file"))
    }
    const { io, calls } = fixture()
    await assert.rejects(deployPreview({ ...env, DOCS_SOURCE_COMMIT: "main" }, io), /source commit/)
    assert.equal(calls.length, 0)
})

test("Project, Production and Git-auto-production mismatches fail before upload", async () => {
    const projects = [
        { ...project, name: "wrong-project" },
        { ...project, id: undefined },
        { ...project, production_branch: undefined },
        { ...project, production_branch: "docs-preview" },
        { ...project, source: { config: { production_branch: "main", production_deployments_enabled: true } } },
        { ...project, source: { config: { production_branch: "main" } } },
        {
            ...project,
            source: { config: { production_branch: "docs-preview", production_deployments_enabled: false } },
        },
        { ...project, domains: ["wrong.example.com"] },
    ]
    for (const value of projects) {
        const { io, calls } = fixture({ project: value })
        await assert.rejects(deployPreview(env, io))
        assert.equal(calls.filter(([kind]) => kind === "upload").length, 0)
    }
    const { io, calls } = fixture({ preflightStatus: 403 })
    await assert.rejects(deployPreview(env, io), /HTTP 403/)
    assert.equal(calls.filter(([kind]) => kind === "upload").length, 0)
    const unavailable = fixture()
    unavailable.io.fetch = async () => {
        throw new Error(env.CLOUDFLARE_API_TOKEN)
    }
    await assert.rejects(
        deployPreview(env, unavailable.io),
        (error) => error.message === "Cloudflare preview read is unavailable",
    )
    assert.equal(unavailable.calls.filter(([kind]) => kind === "upload").length, 0)
})

test("Orchestration uploads once to the explicit Preview branch and verifies the exact deployment", async () => {
    const { io, calls } = fixture({
        project: {
            ...project,
            source: { config: { production_branch: "main", production_deployments_enabled: false } },
        },
    })
    assert.deepEqual(await deployPreview(env, io), {
        origin: env.CLOUDFLARE_PREVIEW_URL,
        deploymentId: id,
        sourceCommit: source,
    })
    assert.deepEqual(
        calls.filter(([kind]) => kind === "upload"),
        [["upload", "test-docs", env.CLOUDFLARE_ACCOUNT_ID, "docs-preview", source]],
    )
    for (const [, url, init] of calls.filter(([kind]) => kind === "fetch")) {
        assert.equal(init.redirect, "error")
        assert.equal(init.cache, "no-store")
        assert.ok(init.signal instanceof AbortSignal)
        assert.equal(
            init.headers.Authorization,
            url.startsWith("https://api.cloudflare.com/") ? `Bearer ${env.CLOUDFLARE_API_TOKEN}` : undefined,
        )
    }
})

test("Readback waits for deployment completion and custom hostname source convergence without reupload", async () => {
    const { io, calls, reads } = fixture({
        deployment: (count) =>
            count === 1 ? { ...deployment, latest_stage: { name: "deploy", status: "active" } } : deployment,
        servedMarker: (count) => ({ sourceCommit: count < 3 ? "b".repeat(40) : source }),
    })
    await deployPreview(env, io)
    assert.equal(reads(), 3)
    assert.equal(calls.filter(([kind]) => kind === "sleep").length, 2)
    assert.equal(calls.filter(([kind]) => kind === "upload").length, 1)
})

test("Uploaded identity mismatches and provider terminal failure are never accepted", async () => {
    const deployments = [
        { ...deployment, id: "22222222-2222-2222-2222-222222222222" },
        { ...deployment, project_id: "wrong" },
        { ...deployment, project_name: "wrong" },
        { ...deployment, environment: "production" },
        { ...deployment, production_branch: "docs-preview" },
        ...[{ branch: "main" }, { commit_hash: "b".repeat(40) }, { commit_dirty: true }].map((metadata) => ({
            ...deployment,
            deployment_trigger: { metadata: { ...deployment.deployment_trigger.metadata, ...metadata } },
        })),
        { ...deployment, latest_stage: { name: "deploy", status: "failure" } },
        { ...deployment, latest_stage: { name: "deploy", status: "canceled" } },
    ]
    for (const value of deployments) {
        const { io, calls } = fixture({ deployment: () => value })
        await assert.rejects(deployPreview(env, io), /identity|failed or was canceled/)
        assert.equal(calls.filter(([kind]) => kind === "upload").length, 1)
        assert.equal(calls.filter(([kind]) => kind === "sleep").length, 0)
    }
})

test("Transient read failures recover with bounded polling and Retry-After, not upload replay", async () => {
    for (const options of [
        { readError: true },
        { readStatus: 503 },
        { readStatus: 429, readHeaders: { "retry-after": "15" } },
    ]) {
        const { io, calls } = fixture(options)
        await deployPreview(env, io)
        assert.equal(calls.filter(([kind]) => kind === "upload").length, 1)
        assert.deepEqual(
            calls.filter(([kind]) => kind === "sleep"),
            [["sleep", options.readStatus === 429 ? 15_000 : 5_000]],
        )
    }
})

test("Stale source, missing noindex and nonpublic hostname remain failures within the readback bound", async () => {
    for (const options of [
        { servedMarker: () => ({ sourceCommit: "b".repeat(40) }) },
        { routeHeader: "not-noindex" },
        { markerStatus: 404 },
    ]) {
        const { io, calls, reads } = fixture(options)
        await assert.rejects(deployPreview(env, io), /did not converge.*reconcile/)
        assert.equal(reads(), 24)
        assert.equal(calls.filter(([kind]) => kind === "upload").length, 1)
        assert.ok(calls.filter(([kind]) => kind === "sleep").reduce((sum, [, ms]) => sum + ms, 0) <= 120_000)
    }
    for (const options of [{ routeStatus: 403 }, { markerStatus: 401 }]) {
        const { io, calls } = fixture(options)
        await assert.rejects(deployPreview(env, io), /not publicly accessible/)
        assert.equal(calls.filter(([kind]) => kind === "sleep").length, 0)
    }
})

test("Unknown upload acknowledgement does not retry, and excessive read delay exhausts the deadline", async () => {
    const failure = fixture({ uploadId: "unknown" })
    await assert.rejects(deployPreview(env, failure.io), /identity is unknown.*reconcile/)
    assert.equal(failure.calls.filter(([kind]) => kind === "upload").length, 1)
    assert.equal(failure.reads(), 0)
    const lost = fixture({ uploadError: new Error("Upload outcome is unknown; reconcile before another upload") })
    await assert.rejects(deployPreview(env, lost.io), /outcome is unknown/)
    assert.equal(lost.calls.filter(([kind]) => kind === "upload").length, 1)
    assert.equal(lost.reads(), 0)
    const slow = fixture({ readStatus: 429, readHeaders: { "retry-after": "600" } })
    await assert.rejects(deployPreview(env, slow.io), /did not converge/)
    assert.equal(slow.reads(), 1)
    assert.deepEqual(
        slow.calls.filter(([kind]) => kind === "sleep"),
        [["sleep", 120_000]],
    )
})
