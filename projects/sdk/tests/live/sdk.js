// Built default/native client connection, shutdown and the read-only modes selected by the second argument.
// Creates no journal and changes no server content. The rate-limit mode injects one synthetic 429 and
// scheduling-header overrides into read-only bot-self and guild requests
import { typedResult } from "./support/results.js"
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import WebSocket from "ws"
import { verifyBucketLearning } from "./support/bucket-learning.js"
import { controlledClock } from "./support/controlled-clock.js"
import { acquireLock, loadSandboxEnvironment, verifySandboxIdentity } from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { readSandbox } from "./support/sandbox-api.js"
import { harnessWatchdogMs, pacedDeadlineMs } from "./support/watchdogs.js"

const mode = process.argv[2]
const cancelRecovery = process.argv[3] === "--cancel-recovery"
const applicationCheck = process.argv[3] === "--application"
const diagnosticsCheck = process.argv[3] === "--diagnostics"
const instanceCheck = process.argv[3] === "--instance"
const qualityCheck = process.argv[3] === "--quality"
const rateLimitsCheck = process.argv[3] === "--rate-limits"
const processId = /^[1-9][0-9]{0,19}$/
const qualityUserId = qualityCheck ? process.env.FLUXER_TEST_DM_USER_ID : undefined
const qualityGroupId = qualityCheck ? process.env.FLUXER_TEST_GROUP_DM_ID : undefined
const report = createReporter({ mode })
// A refused target names only its process variable, never the supplied value
function requireProcessId(value, variable) {
    if (typeof value === "string" && processId.test(value)) return
    report("configuration", { passed: false, variable })
    process.exit(1)
}
if (qualityCheck) {
    requireProcessId(qualityUserId, "FLUXER_TEST_DM_USER_ID")
    requireProcessId(qualityGroupId, "FLUXER_TEST_GROUP_DM_ID")
}
let stage = "configuration"
let lock
let gatewayProbe

function observeGateway() {
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "emit")
    const original = WebSocket.prototype.emit
    const sockets = new Set()
    WebSocket.prototype.emit = function (event, ...args) {
        if (["open", "message", "error", "close"].includes(event)) sockets.add(this)
        return Reflect.apply(original, this, [event, ...args])
    }
    return {
        async interrupt(client) {
            stage = "interrupt_for_cancellation"
            assert.equal(client.state, "Connected")
            assert.equal(sockets.size, 1)
            const [socket] = sockets
            const url = new URL(socket.url)
            assert.equal(url.protocol, "wss:")
            assert.equal(url.host, "gateway.fluxer.com")
            // Terminate only this process's authenticated SDK connection, not the server or host network
            socket.terminate()
            const deadline = performance.now() + 5000
            while (client.state !== "Recovering") {
                assert.ok(client.state !== "Closed" && performance.now() < deadline)
                await sleep(1)
            }
            assert.equal(client.gatewayLatencyMs, null)
            report("recovering_before_cancellation", { passed: true })
        },
        async verifyClosed() {
            const count = sockets.size
            assert.ok(count >= 1)
            // Cover the initial retry ceiling, then require the process to exit naturally
            await sleep(1100)
            assert.equal(sockets.size, count)
            for (const socket of sockets) {
                assert.equal(socket.readyState, WebSocket.CLOSED)
                for (const event of ["open", "message", "error", "close"]) assert.equal(socket.listenerCount(event), 0)
            }
            report("cancelled_recovery_sockets_released", { passed: true })
        },
        restore() {
            if (descriptor) Object.defineProperty(WebSocket.prototype, "emit", descriptor)
            else delete WebSocket.prototype.emit
            sockets.clear()
        },
    }
}

async function waitForReady(client) {
    // Running the client starts its discovery, whose paced slot comes on top of the 35 s
    const deadline = performance.now() + pacedDeadlineMs(35_000, 1, { clients: 1 })
    while (client.state !== "Connected") {
        assert.ok(client.state !== "Closed" && performance.now() < deadline)
        await sleep(10)
    }
}

const get = (path, token) => readSandbox(path, token, { timeout: 10_000 })

function instanceDocument(value) {
    assert.equal(typeof value, "object")
    assert.ok(value !== null && !Array.isArray(value))
    assert.ok(Number.isSafeInteger(value.api_code_version) && value.api_code_version >= 0)
    assert.equal(typeof value.endpoints, "object")
    assert.ok(value.endpoints !== null && !Array.isArray(value.endpoints))
    for (const key of ["api_public", "gateway", "media", "static_cdn", "webapp", "invite"])
        assert.equal(typeof value.endpoints[key], "string")
    assert.equal(typeof value.features, "object")
    assert.ok(value.features !== null && !Array.isArray(value.features))
    assert.equal(typeof value.features.presigned_attachment_uploads, "boolean")
    return {
        endpoints: {
            apiPublic: value.endpoints.api_public,
            gateway: value.endpoints.gateway,
            media: value.endpoints.media,
            staticCdn: value.endpoints.static_cdn,
            webapp: value.endpoints.webapp,
            invite: value.endpoints.invite,
        },
        presignedAttachmentUploads: value.features.presigned_attachment_uploads,
    }
}

async function hostedInstanceDocument() {
    let target = "https://fluxer.com/.well-known/fluxer"
    for (let redirects = 0; redirects <= 3; redirects++) {
        const url = new URL(target)
        assert.equal(url.protocol, "https:")
        assert.equal(url.pathname, "/.well-known/fluxer")
        assert.equal(url.username, "")
        assert.equal(url.password, "")
        assert.equal(url.search, "")
        assert.equal(url.hash, "")
        const response = await fetch(target, {
            redirect: "manual",
            signal: AbortSignal.timeout(pacedDeadlineMs(10_000, 1)),
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel()
            const location = response.headers.get("location")
            assert.ok(location)
            target = new URL(location, target).href
            continue
        }
        if (!response.ok) {
            await response.body?.cancel()
            throw new Error("Hosted instance response failed")
        }
        const reader = response.body?.getReader()
        assert.ok(reader)
        const chunks = []
        let bytes = 0
        let ended = false
        try {
            for (;;) {
                const chunk = await reader.read()
                if (chunk.done) {
                    ended = true
                    break
                }
                bytes += chunk.value.byteLength
                assert.ok(bytes <= 1_048_576)
                chunks.push(chunk.value)
            }
            return instanceDocument(JSON.parse(Buffer.concat(chunks).toString("utf8")))
        } finally {
            try {
                if (!ended) await reader.cancel()
            } finally {
                reader.releaseLock()
            }
        }
    }
    throw new Error("Hosted instance redirect limit")
}

function verifyResolvedInstance(resolved, external) {
    assert.deepEqual(resolved.endpoints, external.endpoints)
    assert.equal(resolved.presignedAttachmentUploads, external.presignedAttachmentUploads)
    assert.ok(Object.isFrozen(resolved) && Object.isFrozen(resolved.endpoints))
}

// A read-only bot-self read through the raw request API, checked against the independently verified bot identity
async function verifyRestRequest(client, userId, run) {
    stage = "rest_request_self_read"
    const response = await run(client.rest.request({ method: "GET", path: "/users/@me" }))
    assert.equal(response.status, 200)
    assert.equal(typeof response.headers, "object")
    assert.equal(response.body?.id, userId)
    report(stage, { passed: true, remoteMutations: false })
}

// The hosted READY user decodes into the local self lookup, matching the independently verified bot identity
async function verifyReadySelf(client, userId) {
    stage = "ready_self_lookup"
    const self = await readLocal(client.users.getSelf())
    assert.equal(self?.id, userId)
    assert.equal(self.isBot, true)
    report(stage, { passed: true, requests: 0 })
}

async function observeHeartbeat(client) {
    stage = "heartbeat"
    const deadline = performance.now() + 65_000
    while (client.gatewayLatencyMs === null) {
        assert.equal(client.state, "Connected")
        assert.ok(performance.now() < deadline)
        await sleep(100)
    }
    assert.ok(Number.isFinite(client.gatewayLatencyMs) && client.gatewayLatencyMs >= 0)
    report(stage, { passed: true, latencyMs: client.gatewayLatencyMs })
}

function verifyCurrentApplication(value, applicationId, response) {
    assert.deepEqual(Object.keys(value), [
        "id",
        "name",
        "icon",
        "description",
        "botPublic",
        "botRequireCodeGrant",
        "ownerId",
    ])
    assert.equal(value.id, applicationId)
    assert.equal(value.name, response.name)
    assert.equal(value.icon, response.icon)
    assert.equal(value.description, response.description)
    assert.equal(value.botPublic, response.bot_public)
    assert.equal(value.botRequireCodeGrant, response.bot_require_code_grant)
    assert.match(value.ownerId, /^[1-9]\d*$/)
    assert.equal(value.ownerId, response.owner.id)
    assert.ok(Object.isFrozen(value))
    assert.equal(Object.hasOwn(value, "owner"), false)
    assert.equal(Object.hasOwn(value, "redirectUris"), false)
    assert.equal(Object.hasOwn(value, "verifyKey"), false)
    assert.equal(Object.hasOwn(value, "bot"), false)
}

async function verifyInstallationLink(link, applicationId) {
    const url = new URL(link)
    assert.equal(url.origin, "https://fluxer.com")
    assert.equal(url.pathname, "/oauth2/authorize")
    assert.equal(url.searchParams.get("client_id"), applicationId)
    assert.equal(url.searchParams.get("scope"), "bot")
    assert.equal(url.searchParams.get("permissions"), "0")
    assert.equal([...url.searchParams.keys()].sort().join(","), "client_id,permissions,scope")
    // The link must be the installation page itself, not a redirect. The web app answers 404 for routes it does not
    // serve. Only the page's HTML is fetched, without credentials, so nothing is authorized
    const response = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(pacedDeadlineMs(10_000, 1)) })
    await response.body?.cancel()
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/)
}

// Local lookups return plain values in the default API and never-failing Effects in the native API
async function readLocal(operation) {
    if (mode === "default") return operation
    const { Effect } = await import("effect")
    return Effect.runPromise(operation)
}

async function verifyDiagnostics(client, guildId, token, run) {
    stage = "diagnostics_live_snapshot"
    const held = await run(client.guilds.fetch(guildId))
    assert.equal(held.id, guildId)
    assert.ok(Object.isFrozen(held))
    assert.equal((await readLocal(client.cache.entries("guilds", { limit: 1 })))[0], held)
    const snapshot = client.diagnostics()
    assert.equal(snapshot.caches.guilds.retainedEntries, 1)
    assert.equal(snapshot.caches.guilds.configured, true)
    assert.ok(snapshot.caches.guilds.accountedBytes > 0)
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.caches.guilds))
    const encoded = JSON.stringify(snapshot)
    assert.ok(!encoded.includes(token) && !encoded.includes(guildId))
    report(stage, { passed: true, remoteMutations: false })

    stage = "diagnostics_clear_during_live_read"
    const originalFetch = globalThis.fetch
    let release
    const barrier = new Promise((resolve) => {
        release = resolve
    })
    let received = false
    let pending
    globalThis.fetch = async (url, init) => {
        const response = await originalFetch(url, init)
        if (new URL(String(url)).pathname === `/api/v1/guilds/${guildId}`) {
            received = true
            await barrier
        }
        return response
    }
    try {
        // Capture failure immediately without logging the upstream error or response
        pending = run(client.guilds.fetch(guildId)).then(
            (value) => ({ value }),
            () => ({ failed: true }),
        )
        // The guild read above may still wait for its paced slot when this deadline starts
        const deadline = performance.now() + pacedDeadlineMs(15_000, 1)
        while (!received) {
            assert.ok(performance.now() < deadline)
            await sleep(5)
        }
        assert.equal(client.diagnostics().rest.activeRequests, 1)
        client.cache.clear()
        assert.deepEqual(await readLocal(client.cache.entries("guilds")), [])
        assert.equal(held.id, guildId)
        release()
        const late = await pending
        assert.equal(late.value?.id, guildId)
        assert.deepEqual(await readLocal(client.cache.entries("guilds")), [])
        assert.equal(client.diagnostics().rest.activeRequests, 0)
    } finally {
        release()
        if (pending) await pending
        globalThis.fetch = originalFetch
    }
    await run(client.guilds.fetch(guildId))
    assert.equal(client.diagnostics().caches.guilds.retainedEntries, 1)
    report(stage, { passed: true, callerSnapshotPreserved: true, staleReadNotRetained: true })
}

async function verifyQuality(client, token, run, fail) {
    stage = "quality_target_identity"
    const userId = qualityUserId
    const groupId = qualityGroupId
    const externalUser = await get(`/users/${userId}`, token)
    const externalGroup = await get(`/channels/${groupId}`, token)
    assert.equal(externalUser.id, userId)
    assert.equal(externalUser.bot ?? false, false)
    assert.equal(externalGroup.id, groupId)
    assert.equal(externalGroup.type, 3)
    assert.equal(externalGroup.owner_id, userId)
    await run(client.instance.resolve())
    report(stage, { passed: true, remoteMutations: false })

    stage = "quality_local_validation_no_dispatch"
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = async () => {
        requests += 1
        throw new Error("Unexpected request during local validation")
    }
    try {
        for (const [operation, path, constraint] of [
            [() => client.users.fetch("private-invalid-user"), "userId", "format"],
            [
                () => client.messages.send("private-invalid-channel", { content: "not dispatched" }),
                "channelId",
                "format",
            ],
            [() => client.directMessages.fetchLatestMessages([groupId, groupId]), "channelIds", "unique"],
        ]) {
            const error = await fail(operation())
            assert.equal(error.reason, "input")
            assert.equal(error.status, null)
            assert.equal(error.apiError, null)
            assert.equal(error.outcome, "notDispatched")
            assert.equal(error.inputValidation?.path, path)
            assert.equal(error.inputValidation?.constraint, constraint)
            assert.ok(Object.isFrozen(error.inputValidation))
            assert.equal(typeof error.inputValidation.explanation, "string")
            const encoded = JSON.stringify(error)
            for (const privateValue of [token, userId, groupId, "private-invalid-user", "private-invalid-channel"])
                assert.ok(!encoded.includes(privateValue))
        }
        assert.equal(requests, 0)
    } finally {
        globalThis.fetch = originalFetch
    }
    report(stage, { passed: true, dispatchedRequests: requests })

    stage = "quality_live_reads_after_rejection"
    const user = await run(client.users.fetch(userId))
    const group = await run(client.directMessages.fetch(groupId))
    assert.equal(user.id, externalUser.id)
    assert.equal(group.id, externalGroup.id)
    assert.equal(await readLocal(client.users.get(userId)), user)
    assert.equal(await readLocal(client.directMessages.get(groupId)), group)
    for (const [resource, value] of [
        ["users", user],
        ["directMessages", group],
    ]) {
        assert.deepEqual(await readLocal(client.cache.entries(resource)), [value])
        assert.equal(client.diagnostics().caches[resource].retainedEntries, 1)
    }
    assert.equal(client.diagnostics().rest.activeRequests, 0)
    report(stage, { passed: true, remoteMutations: false })
}

async function verifyRateLimits(client, guildId, userId, run, fail) {
    stage = "rate_limits_discovery"
    await run(client.instance.resolve())
    const originalFetch = globalThis.fetch
    const retryAfterMs = 1_000
    let injected = 0
    let remoteReads = 0
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input))
        assert.equal(url.origin, "https://fluxer.com")
        assert.equal(init?.method, "GET")
        assert.ok(url.pathname === "/api/v1/users/@me" || url.pathname === `/api/v1/guilds/${guildId}`)
        if (injected === 0) {
            assert.equal(url.pathname, "/api/v1/users/@me")
            injected++
            // A controlled rejection avoids deliberately exhausting the hosted bot's global limit
            return new Response("fixture non-JSON rejection", {
                status: 429,
                headers: { "retry-after": String(retryAfterMs / 1_000), "x-ratelimit-global": "true" },
            })
        }
        remoteReads++
        return originalFetch(input, init)
    }
    // The injected window runs on the controlled clock, so a slow host cannot let it lapse before the queued reads
    const clock = controlledClock()
    try {
        stage = "rate_limits_injected_header_rejection"
        const rejected = await fail(client.users.fetchSelf({ timeoutMs: 500 }))
        assert.equal(rejected.status, 429)
        assert.equal(rejected.reason, "rateLimit")
        // A read whose deadline ends within the learned global pause fails at once with the remaining wait, unsent.
        // The controlled clock stands still, so the whole injected wait remains, up to rounding
        const queued = await fail(client.guilds.fetch(guildId, { timeoutMs: 100 }))
        assert.equal(queued.reason, "rateLimit")
        assert.equal(queued.outcome, "notDispatched")
        assert.ok(Math.abs(queued.retryAfterMs - retryAfterMs) <= 1)
        // Raw requests share the client's admission, so the learned global wait also refuses them
        const rawQueued = await fail(client.rest.request({ method: "GET", path: `/guilds/${guildId}`, timeoutMs: 100 }))
        assert.equal(rawQueued._tag, "RestRequestError")
        assert.equal(rawQueued.reason, "rateLimit")
        assert.equal(rawQueued.outcome, "notDispatched")
        assert.ok(Math.abs(rawQueued.retryAfterMs - retryAfterMs) <= 1)
        assert.equal(remoteReads, 0)
        assert.equal(client.diagnostics().rest.queuedRequests, 0)
        report(stage, { passed: true, injectedRejections: injected, remoteRequests: remoteReads })

        stage = "rate_limits_live_read_recovery"
        // The injected window passes, which ends the global pause
        clock.advance(retryAfterMs)
        await clock.restore()
        assert.equal((await run(client.users.fetchSelf({ timeoutMs: pacedDeadlineMs(10_000, 1) }))).id, userId)
        assert.equal((await run(client.guilds.fetch(guildId, { timeoutMs: pacedDeadlineMs(10_000, 1) }))).id, guildId)
        const raw = await run(
            client.rest.request({ method: "GET", path: "/users/@me", timeoutMs: pacedDeadlineMs(10_000, 1) }),
        )
        assert.equal(raw.status, 200)
        assert.equal(raw.body?.id, userId)
        assert.equal(remoteReads, 3)
        assert.equal(client.diagnostics().rest.activeRequests, 0)
        assert.equal(client.diagnostics().rest.queuedRequests, 0)
        report(stage, { passed: true, remoteReads, remoteMutations: false })
    } finally {
        globalThis.fetch = originalFetch
        await clock.restore()
    }
    await verifyBucketLearning({
        client,
        guildId,
        userId,
        run,
        fail,
        setStage: (next) => {
            stage = next
        },
        report,
    })
}

// A watchdog is failure containment, never evidence of successful cleanup
// Keep it unreferenced so a successful check must exit naturally
setTimeout(() => {
    report("process_timeout", { passed: false, cleanExitVerified: false })
    process.exit(1)
}, harnessWatchdogMs()).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.ok(
        process.argv[3] === undefined ||
            cancelRecovery ||
            applicationCheck ||
            diagnosticsCheck ||
            instanceCheck ||
            qualityCheck ||
            rateLimitsCheck,
    )
    stage = "sandbox_lock"
    lock = acquireLock()
    stage = "configuration"
    const { token, applicationId, guildId } = loadSandboxEnvironment()

    stage = "sandbox_identity"
    const { application, user } = await verifySandboxIdentity((path) => get(path, token), {
        applicationId,
        guildId,
        applicationPath: "/oauth2/applications/@me",
    })
    report(stage, { passed: true, clientSecretUsed: false })
    if (cancelRecovery) gatewayProbe = observeGateway()

    let client
    if (mode === "default") {
        const { createClient, links } = await import("@neontechspace/fluxerly")
        stage = "creation"
        client = createClient({
            token,
            ...(diagnosticsCheck ? { cache: { guilds: true } } : {}),
            ...(qualityCheck ? { cache: { users: true, directMessages: true } } : {}),
        })
        assert.equal(client.state, "Disconnected")
        const controller = new AbortController()
        let running
        try {
            if (rateLimitsCheck) {
                await verifyRateLimits(
                    client,
                    guildId,
                    user.id,
                    async (operation) => {
                        const result = await operation
                        assert.ok(result.isOk())
                        return result.value
                    },
                    async (operation) => {
                        const result = await operation
                        assert.ok(result.isErr())
                        return result.error
                    },
                )
            } else if (qualityCheck) {
                await verifyQuality(
                    client,
                    token,
                    async (operation) => {
                        const result = await operation
                        assert.ok(result.isOk())
                        return result.value
                    },
                    async (operation) => {
                        const result = await operation
                        assert.ok(result.isErr())
                        return result.error
                    },
                )
            } else if (diagnosticsCheck) {
                await verifyDiagnostics(client, guildId, token, async (operation) => {
                    const result = await operation
                    assert.ok(result.isOk())
                    return result.value
                })
            } else if (instanceCheck) {
                stage = "instance_independent_discovery"
                const external = await hostedInstanceDocument()
                stage = "instance_resolve"
                const resolved = await client.instance.resolve()
                assert.ok(resolved.isOk())
                verifyResolvedInstance(resolved.value, external)
                report(stage, { passed: true, unauthenticatedBootstrap: true })
                stage = "instance_fresh_self_read"
                const self = await client.users.fetchSelf()
                assert.ok(self.isOk())
                assert.equal(self.value.id, user.id)
                assert.equal(self.value.isBot, true)
                report(stage, { passed: true, noCache: true })
            } else if (applicationCheck) {
                stage = "current_application"
                const current = await client.application.fetch()
                assert.ok(current.isOk())
                verifyCurrentApplication(current.value, applicationId, application)
                await verifyInstallationLink(links.installation(current.value.id, { permissions: 0n }), applicationId)
                report(stage, { passed: true, noCache: true, clientSecretUsed: false })
            } else {
                stage = "connect"
                if (cancelRecovery) {
                    // Capture defects immediately without printing a credential-bearing rejection
                    running = Promise.resolve(client.run({ signal: controller.signal })).then(
                        (result) => ({ result }),
                        () => ({ defect: true }),
                    )
                    await waitForReady(client)
                } else assert.ok((await client.connect()).isOk())
                assert.equal(client.state, "Connected")
                report("ready", { passed: true })
                await verifyReadySelf(client, user.id)
                await observeHeartbeat(client)
                if (!cancelRecovery)
                    await verifyRestRequest(client, user.id, async (operation) => {
                        const result = await operation
                        assert.ok(result.isOk())
                        return result.value
                    })
                if (cancelRecovery) {
                    await gatewayProbe.interrupt(client)
                    stage = "managed_recovery_cancellation"
                    controller.abort()
                    const outcome = await running
                    assert.ok(outcome.result?.isErr())
                    assert.equal(outcome.result.error._tag, "CancelledError")
                    // Verify cancellation-owned closure before the fallback shutdown in finally
                    assert.equal(client.state, "Closed")
                    report(stage, { passed: true })
                }
            }
        } finally {
            const previous = stage
            stage = "shutdown"
            assert.ok((await client.shutdown()).isOk())
            stage = previous
        }
        stage = "terminal_outcome"
        assert.ok((await client.waitForClose()).isOk())
    } else {
        const { Cause, Effect, Exit, Fiber } = await import("effect")
        const { createClient, links } = await import("@neontechspace/fluxerly/effect")
        const exit = await Effect.runPromiseExit(
            Effect.scoped(
                Effect.gen(function* () {
                    stage = "creation"
                    client = yield* createClient({
                        token,
                        ...(diagnosticsCheck ? { cache: { guilds: true } } : {}),
                        ...(qualityCheck ? { cache: { users: true, directMessages: true } } : {}),
                    })
                    assert.equal(client.state, "Disconnected")
                    if (rateLimitsCheck) {
                        yield* Effect.promise(() =>
                            verifyRateLimits(client, guildId, user.id, Effect.runPromise, async (operation) => {
                                const result = await Effect.runPromise(typedResult(Effect, operation))
                                assert.equal(result._tag, "Failure")
                                return result.failure
                            }),
                        )
                    } else if (qualityCheck) {
                        yield* Effect.promise(() =>
                            verifyQuality(client, token, Effect.runPromise, async (operation) => {
                                const result = await Effect.runPromise(typedResult(Effect, operation))
                                assert.equal(result._tag, "Failure")
                                return result.failure
                            }),
                        )
                    } else if (diagnosticsCheck) {
                        yield* Effect.promise(() => verifyDiagnostics(client, guildId, token, Effect.runPromise))
                    } else if (instanceCheck) {
                        stage = "instance_independent_discovery"
                        const external = yield* Effect.promise(() => hostedInstanceDocument())
                        stage = "instance_resolve"
                        const resolved = yield* client.instance.resolve()
                        verifyResolvedInstance(resolved, external)
                        report(stage, { passed: true, unauthenticatedBootstrap: true })
                        stage = "instance_fresh_self_read"
                        const self = yield* client.users.fetchSelf()
                        assert.equal(self.id, user.id)
                        assert.equal(self.isBot, true)
                        report(stage, { passed: true, noCache: true })
                    } else if (applicationCheck) {
                        stage = "current_application"
                        const current = yield* client.application.fetch()
                        verifyCurrentApplication(current, applicationId, application)
                        yield* Effect.promise(() =>
                            verifyInstallationLink(links.installation(current.id, { permissions: 0n }), applicationId),
                        )
                        report(stage, { passed: true, noCache: true, clientSecretUsed: false })
                    } else {
                        stage = "connect"
                        const running = cancelRecovery ? yield* Effect.forkScoped(client.run()) : undefined
                        if (cancelRecovery) yield* Effect.promise(() => waitForReady(client))
                        else yield* client.connect()
                        assert.equal(client.state, "Connected")
                        report("ready", { passed: true })
                        yield* Effect.promise(() => verifyReadySelf(client, user.id))
                        yield* Effect.promise(() => observeHeartbeat(client))
                        if (!cancelRecovery)
                            yield* Effect.promise(() => verifyRestRequest(client, user.id, Effect.runPromise))
                        if (cancelRecovery) {
                            yield* Effect.promise(() => gatewayProbe.interrupt(client))
                            stage = "managed_recovery_cancellation"
                            yield* Fiber.interrupt(running)
                            const outcome = yield* Effect.exit(Fiber.join(running))
                            assert.ok(Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause))
                            // The managed run, rather than the enclosing scope, must have finished cleanup
                            assert.equal(client.state, "Closed")
                            report(stage, { passed: true })
                        }
                    }
                    stage = "scope_shutdown"
                }),
            ),
        )
        assert.ok(Exit.isSuccess(exit))
        stage = "terminal_outcome"
        assert.ok(Exit.isSuccess(await Effect.runPromiseExit(client.waitForClose())))
    }
    assert.equal(client.state, "Closed")
    assert.equal(client.gatewayLatencyMs, null)
    if (diagnosticsCheck) {
        const closed = client.diagnostics()
        assert.equal(closed.caches.guilds.configured, true)
        assert.equal(closed.caches.guilds.retainedEntries, 0)
        assert.equal(closed.caches.guilds.accountedBytes, 0)
        assert.equal(closed.rest.activeRequests, 0)
        report("diagnostics_closed_release", { passed: true })
    }
    if (qualityCheck) {
        for (const resource of ["users", "directMessages"]) {
            assert.equal(client.diagnostics().caches[resource].retainedEntries, 0)
            assert.equal(client.diagnostics().caches[resource].accountedBytes, 0)
        }
        assert.equal(client.diagnostics().rest.activeRequests, 0)
        report("quality_closed_release", { passed: true })
    }
    if (cancelRecovery) {
        stage = "cancelled_recovery_cleanup"
        await gatewayProbe.verifyClosed()
    }
    report("closed", { passed: true, latencyReset: true })
} catch {
    // Do not print assertions, native causes, HTTP bodies or credential-bearing errors
    report(stage, { passed: false })
    process.exitCode = 1
} finally {
    gatewayProbe?.restore()
    if (lock !== undefined && !lock.release()) {
        report("sandbox_lock_cleanup", { passed: false, lockRetained: true })
        process.exitCode = 1
    }
}
// No success-path process.exit: The invoking shell must observe natural exit
