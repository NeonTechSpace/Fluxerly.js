import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import {
    deploymentOrigin,
    deployPreview,
    measureLocalArtifact,
    previewSettings,
    runSilentProcess,
} from "../scripts/preview-deploy.js"

const source = "a".repeat(40)
const id = "11111111-1111-1111-1111-111111111111"
const env = {
    CLOUDFLARE_ACCOUNT_ID: "1".repeat(32),
    CLOUDFLARE_API_TOKEN: "test-only-secret",
    CLOUDFLARE_PAGES_PROJECT: "test-docs",
    CLOUDFLARE_PREVIEW_URL: "https://preview.example.com",
    DOCS_SOURCE_COMMIT: source,
}
const project = { name: "test-docs", id: "project-id", subdomain: "test-docs.pages.dev", production_branch: "main", domains: ["preview.example.com"] }
const deploymentUrl = "https://01234567.test-docs.pages.dev"
const deployment = {
    id,
    url: deploymentUrl,
    project_id: "project-id",
    project_name: "test-docs",
    environment: "preview",
    production_branch: "main",
    deployment_trigger: { metadata: { branch: "preview", commit_hash: source, commit_dirty: false } },
    latest_stage: { name: "deploy", status: "success" },
}
const json = (result, status = 200, headers = {}) => new Response(JSON.stringify(result), { status, headers })

function fixture(options = {}) {
    const calls = []
    let clock = 0
    let reads = 0
    let docsListed = false
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
        readdir: async (path) => {
            calls.push(["directory", path])
            if (/[\\/]dist[\\/]docs$/.test(path)) {
                if (!docsListed) clock += options.localMs ?? 0
                docsListed = true
                return options.docsEntries ?? ["latest", "1000.0.0-canary.0"]
            }
            if (/[\\/]dist$/.test(path)) return ["deployment.json", "_headers", "docs"]
            return ["index.html"]
        },
        lstat: async (path) => {
            calls.push(["stat", path])
            const directory = /[\\/](?:docs|latest|1000\.0\.0-canary\.0)$/.test(path)
            const size = path.endsWith("deployment.json") ? 100 : path.endsWith("_headers") ? 20 : 30
            return { size, isDirectory: () => directory, isFile: () => !directory }
        },
        upload: async (settings, commit) => {
            calls.push(["upload", settings.project, settings.account, settings.branch, commit])
            clock += options.wranglerMs ?? 0
            if (options.uploadError) throw options.uploadError
            return options.uploadId ?? id
        },
        fetch: async (url, init) => {
            calls.push(["fetch", url, init])
            if (!url.includes("/deployments/") && url.startsWith("https://api.cloudflare.com/")) {
                clock += options.targetMs ?? 0
                return json({ success: true, result: options.project ?? project }, options.preflightStatus ?? 200)
            }
            if (url.includes("/deployments/")) {
                reads++
                clock += options.readbackMs ?? 0
                if (options.readError && reads === 1) throw new Error(env.CLOUDFLARE_API_TOKEN)
                if (options.readStatus && reads === 1) return json({}, options.readStatus, options.readHeaders)
                return json({ success: true, result: options.deployment?.(reads) ?? deployment })
            }
            const custom = url.startsWith(env.CLOUDFLARE_PREVIEW_URL)
            if (url.endsWith("/docs/latest/"))
                return new Response("Docs", {
                    status: (custom ? options.customRouteStatus : options.routeStatus) ?? 200,
                    headers: { "x-robots-tag": options.routeHeader ?? "noindex, nofollow", "content-type": options.routeContentType ?? "text/html; charset=utf-8",
                        ...((custom ? options.customChallenge : options.deploymentChallenge) ? { "cf-mitigated": "challenge" } : {}),
                    },
                })
            return json(options.servedMarker?.(reads) ?? { sourceCommit: source },
                (custom ? options.customMarkerStatus : options.markerStatus) ?? 200,
                custom && options.customMarkerChallenge ? { "cf-mitigated": "challenge" } : {})
        },
    }
    return { io, calls, reads: () => reads }
}

test("Local artifact metrics count regular files without exposing names or following symlinks", async () => {
    const names = {
        root: ["safe.html", "nested"],
        "root/nested": ["secret-token-like-name.js"],
    }
    const stats = {
        "root/safe.html": { size: 12, isDirectory: () => false, isFile: () => true },
        "root/nested": { size: 0, isDirectory: () => true, isFile: () => false },
        "root/nested/secret-token-like-name.js": { size: 34, isDirectory: () => false, isFile: () => true },
    }
    const io = {
        readdir: async (path) => names[path.replaceAll("\\", "/")],
        lstat: async (path) => stats[path.replaceAll("\\", "/")],
    }
    assert.deepEqual(await measureLocalArtifact("root", io), { fileCount: 2, totalBytes: 46, largestFileBytes: 34 })
    stats["root/nested/secret-token-like-name.js"] = { size: 34, isDirectory: () => false, isFile: () => false }
    await assert.rejects(measureLocalArtifact("root", io), (error) =>
        !error.message.includes("secret-token-like-name") && /unsafe/.test(error.message))
})

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

test("Upload rejects local source routes and missing published latest before provider reads", async () => {
    for (const docsEntries of [["preview"], ["latest", "preview"], ["latest", "dev"]]) {
        const { io, calls } = fixture({ docsEntries })
        await assert.rejects(deployPreview(env, io), /published-only documentation/)
        assert.ok(calls.every(([kind]) => kind === "file" || kind === "directory"))
    }
})

test("Project, Production and Git-auto-production mismatches fail before upload", async () => {
    const projects = [
        { ...project, name: "wrong-project" },
        { ...project, id: undefined },
        { ...project, subdomain: undefined },
        { ...project, production_branch: undefined },
        { ...project, production_branch: "preview" },
        { ...project, source: { config: { production_branch: "main", production_deployments_enabled: true } } },
        { ...project, source: { config: { production_branch: "main" } } },
        {
            ...project,
            source: { config: { production_branch: "preview", production_deployments_enabled: false } },
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
        deploymentUrl,
        customDomainStatus: "verified",
    })
    assert.deepEqual(
        calls.filter(([kind]) => kind === "upload"),
        [["upload", "test-docs", env.CLOUDFLARE_ACCOUNT_ID, "preview", source]],
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

test("Deployment progress names each phase and reports elapsed waits without exposing credentials", async () => {
    const { io } = fixture({
        deployment: (count) =>
            count === 1 ? { ...deployment, latest_stage: { name: "deploy", status: "active" } } : deployment,
    })
    const messages = []
    io.progress = (message) => messages.push(message)
    await deployPreview(env, io)
    assert.ok(messages.some((message) => /local Preview artifact/i.test(message)))
    assert.ok(messages.some((message) => /Cloudflare Pages Preview target/i.test(message)))
    assert.ok(messages.some((message) => /Uploading.*Wrangler/i.test(message)))
    assert.ok(messages.some((message) => /acknowledged.*verifying/i.test(message)))
    assert.ok(messages.some((message) => /Waiting.*\(0s elapsed\)/i.test(message)))
    assert.ok(messages.every((message) => !message.includes(env.CLOUDFLARE_API_TOKEN)))
})

test("Deployment progress separates local bytes and phase timings from network transfer", async () => {
    const { io } = fixture({ localMs: 2_000, targetMs: 3_000, wranglerMs: 105_000, readbackMs: 6_000 })
    const messages = []
    io.progress = (message) => messages.push(message)
    await deployPreview(env, io)
    assert.ok(messages.some((message) => /4 files, 180 bytes.*largest file 100 bytes.*local preflight 2s/i.test(message)))
    assert.ok(messages.some((message) => /target verified in 3s/i.test(message)))
    assert.ok(messages.some((message) => /Wrangler completed in 105s.*not a network transfer measurement/i.test(message)))
    assert.ok(messages.some((message) => /Preview readback verified in 6s/i.test(message)))
    assert.ok(messages.every((message) => !message.includes(env.CLOUDFLARE_API_TOKEN)))
})

test("Silent child progress suppresses output and resolves only after the child closes", async () => {
    const child = new EventEmitter()
    const messages = []
    const secret = env.CLOUDFLARE_API_TOKEN
    let clock = 0
    let heartbeat
    let deadline
    let heartbeatCleared = false
    let deadlineCleared = false
    const result = runSilentProcess("node", ["wrangler.js"], {
        env: { CLOUDFLARE_API_TOKEN: secret },
        timeout: 300_000,
    }, {
        spawn: (_file, _args, options) => {
            assert.equal(options.stdio, "ignore")
            return child
        },
        now: () => clock,
        progress: (message) => messages.push(message),
        setInterval: (callback, milliseconds) => {
            assert.equal(milliseconds, 30_000)
            heartbeat = callback
            return "heartbeat"
        },
        clearInterval: (handle) => {
            assert.equal(handle, "heartbeat")
            heartbeatCleared = true
        },
        setTimeout: (callback, milliseconds) => {
            assert.equal(milliseconds, 300_000)
            deadline = callback
            return "deadline"
        },
        clearTimeout: (handle) => {
            assert.equal(handle, "deadline")
            deadlineCleared = true
        },
    })
    clock = 30_000
    heartbeat()
    child.emit("close", 0, null)
    assert.deepEqual(await result, { status: "exited", timedOut: false, code: 0, signal: null })
    assert.equal(typeof deadline, "function")
    assert.deepEqual(messages, ["Wrangler upload is still running (30s elapsed)"])
    assert.ok(messages.every((message) => !message.includes(secret)))
    assert.equal(heartbeatCleared, true)
    assert.equal(deadlineCleared, true)
})

test("Silent child errors are consumed but cannot settle the process before close", async () => {
    const child = new EventEmitter()
    const secret = env.CLOUDFLARE_API_TOKEN
    let resolved = false
    const result = runSilentProcess("node", [], { timeout: 300_000 }, {
        spawn: () => child,
        setInterval: () => "heartbeat",
        clearInterval: () => {},
        setTimeout: () => "deadline",
        clearTimeout: () => {},
        progress: (message) => assert.ok(!message.includes(secret)),
    }).then((outcome) => {
        resolved = true
        return outcome
    })
    child.emit("error", new Error(secret))
    child.emit("error", new Error(secret))
    await Promise.resolve()
    assert.equal(resolved, false)
    child.emit("close", null, null)
    assert.deepEqual(await result, { status: "spawn-error", timedOut: false, code: null, signal: null })

    const failed = await runSilentProcess("node", [], { timeout: 1 }, {
        spawn: () => { throw new Error(secret) },
        progress: (message) => assert.ok(!message.includes(secret)),
    })
    assert.deepEqual(failed, { status: "spawn-error", timedOut: false })
})

test("Silent child timeout escalates termination and awaits close", async () => {
    const child = new EventEmitter()
    const secret = env.CLOUDFLARE_API_TOKEN
    const kills = []
    const messages = []
    let clock = 0
    let heartbeat
    let deadline
    let forceKill
    let resolved = false
    child.kill = (signal) => {
        kills.push(signal)
        return true
    }
    const result = runSilentProcess("node", [], { timeout: 1, killGrace: 5 }, {
        spawn: () => child,
        now: () => clock,
        setInterval: (callback) => {
            heartbeat = callback
            return "heartbeat"
        },
        clearInterval: () => {},
        setTimeout: (callback, milliseconds) => {
            if (milliseconds === 1) deadline = callback
            if (milliseconds === 5) forceKill = callback
            return milliseconds
        },
        clearTimeout: () => {},
        progress: (message) => messages.push(message),
    }).then((outcome) => {
        resolved = true
        return outcome
    })
    clock = 1
    deadline()
    await Promise.resolve()
    assert.equal(resolved, false)
    assert.deepEqual(kills, ["SIGTERM"])
    clock = 2
    heartbeat()
    clock = 6
    forceKill()
    await Promise.resolve()
    assert.equal(resolved, false)
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"])
    child.emit("close", null, "SIGKILL")
    assert.deepEqual(await result, { status: "timed-out", timedOut: true, code: null, signal: "SIGKILL" })
    assert.ok(messages.some((message) => /timed out.*Stopping the child process/i.test(message)))
    assert.ok(messages.some((message) => /Waiting for Wrangler child cleanup/i.test(message)))
    assert.ok(messages.some((message) => /still stopping.*Forcing cleanup/i.test(message)))
    assert.ok(messages.every((message) => !message.includes(secret)))
    assert.ok(messages.every((message) => !/upload is still running/i.test(message)))
})

test("Deployment readback trusts only the verified project's unique Pages origin", () => {
    assert.equal(deploymentOrigin(project, deployment), deploymentUrl)
    for (const url of [undefined, "https://other.pages.dev", "https://test-docs.pages.dev",
        "https://hash.test-docs.pages.dev.attacker.example", "http://hash.test-docs.pages.dev",
        "https://user:password@hash.test-docs.pages.dev", `${deploymentUrl}/path`, `${deploymentUrl}?token=x`,
        "https://hash.test-docs.pages.dev:8443", "https://nested.hash.test-docs.pages.dev"]) {
        assert.throws(() => deploymentOrigin(project, { ...deployment, url }), /not verified/)
    }
    assert.throws(() => deploymentOrigin({ ...project, subdomain: "attacker.example" }, deployment), /not verified/)
})

test("A positively identified custom-domain challenge does not invalidate verified deployment content", async () => {
    for (const options of [
        { customRouteStatus: 403, customChallenge: true },
        { customMarkerStatus: 403, customMarkerChallenge: true },
    ]) {
        const { io, calls } = fixture(options)
        const result = await deployPreview(env, io)
        assert.equal(result.customDomainStatus, "challenged")
        assert.equal(result.deploymentUrl, deploymentUrl)
        assert.equal(result.sourceCommit, source)
        const urls = calls.filter(([kind]) => kind === "fetch").map(([, url]) => url)
        assert.ok(urls.indexOf(`${deploymentUrl}/deployment.json`) < urls.indexOf(`${env.CLOUDFLARE_PREVIEW_URL}/docs/latest/`))
        assert.equal(calls.filter(([kind]) => kind === "upload").length, 1)
    }
    for (const options of [{ customRouteStatus: 403 }, { customMarkerStatus: 401 }, { routeStatus: 403, deploymentChallenge: true }]) {
        await assert.rejects(deployPreview(env, fixture(options).io), /not publicly accessible/)
    }
    const stale = fixture({ customChallenge: true, servedMarker: () => ({ sourceCommit: "b".repeat(40) }) })
    await assert.rejects(deployPreview(env, stale.io), /did not converge/)
    assert.ok(stale.calls.every(([kind, url]) => kind !== "fetch" || !url.startsWith(env.CLOUDFLARE_PREVIEW_URL)))
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
        { ...deployment, production_branch: "preview" },
        ...[{ branch: "main" }, { branch: "docs-preview" }, { commit_hash: "b".repeat(40) }, { commit_dirty: true }].map((metadata) => ({
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
        { routeContentType: "application/json" },
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
    const providerBody = `provider body ${env.CLOUDFLARE_API_TOKEN}`
    const lost = fixture({ uploadError: new Error(providerBody) })
    const messages = []
    lost.io.progress = (message) => messages.push(message)
    await assert.rejects(deployPreview(env, lost.io), (error) =>
        /outcome is unknown/.test(error.message) && !error.message.includes(providerBody))
    assert.ok(messages.every((message) => !message.includes(providerBody)))
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
